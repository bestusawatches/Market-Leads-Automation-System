// src/scrapers/loopnet/loopnet.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// LoopNet Scraper — Oxylabs Realtime API (residential) edition
//
// Changes from previous version:
//   • Switched to residential proxy routing (residential: true in payload)
//   • Fresh session ID per URL per attempt — prevents Akamai session tracking
//   • Increased retry delay with exponential backoff + jitter
//   • Increased retries to 3
//   • Added premium browser headers to payload
//   • Removed wait_for_element (adds latency, Oxylabs handles it internally)
//   • Increased timeout to 240s for residential (slower than datacenter)
//   • Added oxylabs_headers for geo and device targeting
//   • Block detection now saves envelope for diagnosis, not just HTML
//   • Fallback: on Akamai block, retries with a fresh session automatically
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import * as http from "http";
import * as zlib from "zlib";
import * as fs from "fs";
import * as path from "path";

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { sleep, jitter } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseLoopNetListings } from "./loopnet.parser";
import { config } from "../../config";

// ── Oxylabs Config ───────────────────────────────────────────────────────────

const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME  ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD  ?? "";
const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";

// Residential proxies are slower than datacenter — 240s is the safe ceiling.
const REQUEST_TIMEOUT_MS = Number(process.env.LOOPNET_FETCH_TIMEOUT) || 240_000;
const BETWEEN_PAGE_MS    = 6_000;
const MAX_RETRIES        = 3;

// ── Search URLs ──────────────────────────────────────────────────────────────

function getSearchUrls(): string[] {
  const env     = process.env.LOOPNET_SEARCH_URLS ?? "";
  const fromEnv = env.split(",").map((u) => u.trim()).filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : (config.sources.loopnet.searchUrls ?? []);
}

// ── Session ID ────────────────────────────────────────────────────────────────
// Fresh session per attempt — Akamai tracks session IDs across requests and
// will block a session that previously triggered a challenge.

function freshSessionId(): string {
  return `ln_${Date.now()}_${Math.floor(Math.random() * 99_999)}`;
}

// ── Decompression ─────────────────────────────────────────────────────────────

async function decompressBuffer(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (err, result) => {
        if (err) {
          zlib.inflateRaw(buf, (err2, result2) => (err2 ? reject(err2) : resolve(result2)));
        } else {
          resolve(result);
        }
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (err, result) => (err ? reject(err) : resolve(result)));
    } else {
      resolve(buf);
    }
  });
}

// ── Oxylabs POST ─────────────────────────────────────────────────────────────

function oxylabsPost(bodyStr: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

    const deadline = setTimeout(() => {
      req.destroy(new Error("Oxylabs request timeout"));
    }, REQUEST_TIMEOUT_MS);

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers:  {
          "Content-Type":    "application/json",
          "Authorization":   `Basic ${authStr}`,
          "Content-Length":  Buffer.byteLength(bodyStr).toString(),
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", async () => {
          clearTimeout(deadline);
          const rawBuf   = Buffer.concat(chunks);
          const encoding = (res.headers["content-encoding"] ?? "").trim();
          let decompressed: Buffer;
          try {
            decompressed = encoding ? await decompressBuffer(rawBuf, encoding) : rawBuf;
          } catch (e) {
            logger.warn(`[loopnet] Decompression failed (${encoding}): ${e}`);
            decompressed = rawBuf;
          }
          resolve({
            status: res.statusCode ?? 0,
            body:   decompressed.toString("utf-8"),
          });
        });
        res.on("error", (err) => {
          clearTimeout(deadline);
          reject(err);
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Socket idle timeout")));

    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── Build Oxylabs Payload ────────────────────────────────────────────────────
//
// Key changes vs old version:
//   • residential: true   — routes through real residential IPs, not datacenter
//   • fresh sessionId per call — prevents Akamai session fingerprinting
//   • Removed wait_for_element — Oxylabs residential already waits for render;
//     the extra wait_for_element just adds wall-clock time
//   • scroll_to_bottom kept — triggers lazy-load of listing cards
//   • Added realistic browser context headers

function buildPayload(targetUrl: string, sessionId: string): Record<string, unknown> {
  return {
    source:          "universal",
    url:             targetUrl,
    render:          "html",
    geo_location:    "Ohio, United States",   // state-level geo = more relevant IPs
    user_agent_type: "desktop_chrome",
    locale:          "en-US",
    residential:     true,                    // ← KEY: residential proxy routing
    session_id:      sessionId,               // fresh per attempt
    context: [
      { key: "follow_redirects",  value: true  },
      { key: "load_images",       value: false }, // faster, we only need HTML
    ],
    browser_instructions: [
      // Scroll to trigger lazy-loaded listing cards
      {
        type:        "scroll_to_bottom",
        timeout_s:   20,
      },
      // Brief settle after scroll
      {
        type:        "wait",
        wait_time_s: 3,
      },
    ],
  };
}

// ── Retry delay with exponential backoff ─────────────────────────────────────
// Attempt 1 fail → wait ~10s
// Attempt 2 fail → wait ~20s
// Attempt 3 fail → no wait (last attempt)

function retryDelayMs(attempt: number): number {
  const base  = 10_000;
  const exp   = Math.pow(2, attempt - 1); // 1, 2, 4
  const noise = Math.random() * 5_000;    // 0–5s jitter
  return Math.min(base * exp + noise, 60_000);
}

// ── Core Fetch Function ──────────────────────────────────────────────────────

async function oxylabsFetch(targetUrl: string): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error("[loopnet] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    return null;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Fresh session ID every attempt — prevents Akamai from tracking the session
    const sessionId = freshSessionId();
    const payload   = buildPayload(targetUrl, sessionId);
    const bodyStr   = JSON.stringify(payload);

    logger.debug(`[loopnet] Oxylabs attempt ${attempt}/${MAX_RETRIES} | session=${sessionId} → ${targetUrl}`);

    let resp: { status: number; body: string };
    try {
      resp = await oxylabsPost(bodyStr);
    } catch (err: any) {
      logger.warn(`[loopnet] Transport error (attempt ${attempt}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = retryDelayMs(attempt);
        logger.debug(`[loopnet] Waiting ${Math.round(delay / 1000)}s before retry...`);
        await sleep(delay);
        continue;
      }
      logger.error(`[loopnet] All ${MAX_RETRIES} attempts failed for ${targetUrl}`);
      return null;
    }

    const { status, body } = resp;

    if (status === 401) {
      logger.error("[loopnet] Oxylabs 401 — invalid credentials");
      throw new Error("OXYLABS_AUTH_FAILED");
    }

    if (status === 429) {
      logger.warn(`[loopnet] Oxylabs 429 — rate limited`);
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return null;
    }

    if (status !== 200) {
      logger.warn(`[loopnet] Oxylabs HTTP ${status} for ${targetUrl}`);
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return null;
    }

    // ── Parse envelope ──────────────────────────────────────────────────────

    let envelope: any;
    try {
      envelope = JSON.parse(body);
    } catch {
      logger.warn(`[loopnet] Failed to parse Oxylabs envelope (attempt ${attempt})`);
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return null;
    }

    const result0 = envelope?.results?.[0];
    if (!result0) {
      logger.warn(`[loopnet] No results[0] in Oxylabs response (attempt ${attempt})`);
      // Save envelope for diagnosis
      saveDebugJson(envelope, `no_results_${attempt}_${Date.now()}`);
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return null;
    }

    const innerStatus = result0.status_code ?? result0.statusCode ?? 200;
    if (innerStatus === 401) {
      logger.error("[loopnet] Oxylabs inner 401");
      throw new Error("OXYLABS_AUTH_FAILED");
    }
    if (innerStatus !== 200 && innerStatus !== 0) {
      logger.warn(`[loopnet] Inner status ${innerStatus} (attempt ${attempt})`);
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return null;
    }

    const content: string =
      result0.content          ??
      result0.html             ??
      result0.results?.[0]?.content ??
      result0.results?.[0]?.html    ??
      "";

    if (content.length < 5_000) {
      logger.warn(`[loopnet] Short content (${content.length} chars) on attempt ${attempt} — likely block page`);
      saveDebugHtml(content, `short_${attempt}_${Date.now()}`);
      // Short content = block page — retry with a fresh session
      if (attempt < MAX_RETRIES) {
        const delay = retryDelayMs(attempt);
        logger.debug(`[loopnet] Retrying with fresh session in ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
        continue;
      }
      return null;
    }

    return content;
  }

  return null;
}

// ── Block Detection ───────────────────────────────────────────────────────────

function isAkamaiBlocked(html: string, url: string, title: string): boolean {
  const lower = html.toLowerCase();
  const conditions = [
    { label: "access denied",         hit: lower.includes("access denied")         },
    { label: "edgesuite.net",         hit: lower.includes("edgesuite.net")         },
    { label: "akamai",                hit: lower.includes("akamai")                },
    { label: "cloudflare",            hit: lower.includes("cloudflare")            },
    { label: "please enable cookies", hit: lower.includes("please enable cookies") },
    { label: "checking your browser", hit: lower.includes("checking your browser") },
    { label: "just a moment",         hit: lower.includes("just a moment")         },
    { label: "robot or human",        hit: lower.includes("robot or human")        },
    { label: "unusual traffic",       hit: lower.includes("unusual traffic")       },
    {
      label: "challenge page title",
      hit: ["just a moment", "attention required", "please wait", "security check", "access denied"]
        .some((s) => title.toLowerCase().includes(s)),
    },
  ];

  const triggered = conditions.filter((c) => c.hit);
  if (triggered.length > 0) {
    logger.warn(`[loopnet] Block conditions triggered: ${triggered.map((c) => c.label).join(", ")}`);
    return true;
  }
  return false;
}

// ── Debug Helpers ─────────────────────────────────────────────────────────────

function saveDebugHtml(html: string, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `loopnet_${label}.html`), html, "utf-8");
    logger.debug(`[loopnet] Debug HTML saved → logs/loopnet_${label}.html`);
  } catch {}
}

function saveDebugJson(data: unknown, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `loopnet_${label}.json`), JSON.stringify(data, null, 2), "utf-8");
    logger.debug(`[loopnet] Debug JSON saved → logs/loopnet_${label}.json`);
  } catch {}
}

// ── Scraper Class ────────────────────────────────────────────────────────────

export class LoopNetScraper extends BaseScraper {
  readonly sourceName = "loopnet";

  constructor(options: ScraperOptions = {}) {
    super(options);

    const urls = getSearchUrls();
    logger.info(`[loopnet] ${urls.length} search URL(s), max ${this.options.maxPages} pages each`);
    logger.info(`[loopnet] Using Oxylabs Realtime API (residential + render:html)`);
    logger.info(`[loopnet] Timeout: ${REQUEST_TIMEOUT_MS}ms | Retries: ${MAX_RETRIES}`);

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error(
        "[loopnet] Oxylabs credentials missing — add OXYLABS_USERNAME and OXYLABS_PASSWORD to .env"
      );
    }
  }

  private async fetchPageHtml(url: string): Promise<string | null> {
    let html: string | null;
    try {
      html = await oxylabsFetch(url);
    } catch (err: any) {
      if (err?.message === "OXYLABS_AUTH_FAILED") {
        logger.error("[loopnet] Auth failed — aborting run");
        throw err;
      }
      logger.error(`[loopnet] Unexpected fetch error: ${err.message}`);
      return null;
    }

    if (!html) return null;

    const titleMatch = html.match(/<title[^>]*>([^<]+)/i);
    const title      = titleMatch?.[1]?.trim() ?? "";

    if (isAkamaiBlocked(html, url, title)) {
      logger.warn(`[loopnet] Akamai block detected on ${url}`);
      saveDebugHtml(html, `blocked_${Date.now()}`);
      return null;
    }

    return html;
  }

  private async scrapeSearchUrl(searchUrl: string): Promise<RawListing[]> {
    const allListings: RawListing[] = [];

    for (let pageNum = 1; pageNum <= this.options.maxPages; pageNum++) {
      const pageUrl = this.buildPageUrl(searchUrl, pageNum);
      logger.info(`[loopnet] Fetching page ${pageNum}: ${pageUrl}`);

      const html = await this.fetchPageHtml(pageUrl);
      if (!html) {
        logger.warn(`[loopnet] No HTML for page ${pageNum} — stopping`);
        break;
      }

      const slug = searchUrl
        .replace(/https?:\/\/[^/]+\/search\//, "")
        .replace(/\//g, "_")
        .slice(0, 40);

      saveDebugHtml(html, `p${pageNum}_${slug}`);

      const listings = parseLoopNetListings(html, searchUrl, "loopnet");
      logger.info(`[loopnet] Page ${pageNum}: ${listings.length} listings parsed`);

      allListings.push(...listings);

      const hasMore =
        listings.length > 0 &&
        pageNum < this.options.maxPages &&
        (html.includes(`page=${pageNum + 1}`) || html.includes('aria-label="Next"'));

      if (!hasMore) {
        logger.debug(`[loopnet] No more pages after ${pageNum}`);
        break;
      }

      await sleep(jitter(BETWEEN_PAGE_MS));
    }

    return allListings;
  }

  private buildPageUrl(baseUrl: string, pageNum: number): string {
    if (pageNum <= 1) return baseUrl;
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}page=${pageNum}`;
  }

  protected async scrapePage(
    _handle: any,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (pageNumber !== 1) return [];

    const allListings: RawListing[] = [];
    const searchUrls = getSearchUrls();

    for (let i = 0; i < searchUrls.length; i++) {
      const url = searchUrls[i];
      logger.info(`[loopnet] Scraping search URL ${i + 1}/${searchUrls.length}: ${url}`);

      try {
        const listings = await this.scrapeSearchUrl(url);
        allListings.push(...listings);
      } catch (err: any) {
        if (err?.message === "OXYLABS_AUTH_FAILED") {
          logger.error("[loopnet] Auth failed — aborting all remaining URLs");
          break;
        }
        throw err;
      }

      if (i < searchUrls.length - 1) {
        // Longer pause between different search URLs — reduces burst pattern detection
        const pause = 10_000 + Math.random() * 8_000;
        logger.debug(`[loopnet] Pausing ${Math.round(pause / 1000)}s before next URL...`);
        await sleep(pause);
      }
    }

    // Deduplicate by URL
    const seen    = new Set<string>();
    const deduped = allListings.filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });

    logger.info(`[loopnet] Total unique listings: ${deduped.length}`);
    return deduped;
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }
}