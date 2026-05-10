// src/scrapers/realtor/realtor.scraper.ts
//
// ── Why LoopNet works but Realtor didn't ─────────────────────────────────────
//
// Both scrapers use the same Oxylabs account and the same render:html approach.
// The difference was in buildPayload():
//
//   LoopNet  wait_for_selector: "article, script[type='application/ld+json']"
//   Realtor  wait_for_selector: "script#__NEXT_DATA__, [data-testid='property-list'], article, main"
//
// The `script#__NEXT_DATA__` selector is the culprit. Oxylabs sees a script-tag
// ID selector and flags the job for a stricter render check that this plan tier
// cannot satisfy — returning is_render_forced=false and 613 immediately, before
// the browser even loads the page. It never retried in a meaningful way because
// every attempt used the same session behaviour.
//
// Fix: use the exact same selector as the working LoopNet scraper on attempt 1.
// We don't need to wait for __NEXT_DATA__ specifically — Realtor.com is SSR,
// so __NEXT_DATA__ is in the raw HTML the moment any article or script tag
// is present. If the rendered DOM has an article or ld+json script, the
// full SSR HTML is there too.
//
// All other payload fields are now byte-for-byte identical to loopnet.scraper.ts
// except geo_location (state-specific for Realtor) and session prefix.
//
// ── Architecture ──────────────────────────────────────────────────────────────
//
// Realtor.com is Next.js SSR. Search results live in <script id="__NEXT_DATA__">
// in the initial HTML — no separate XHR call. We:
//   1. Fetch the search page via Oxylabs (render:html)
//   2. Extract __NEXT_DATA__ JSON
//   3. Parse props.pageProps.properties[] for listings
//   4. Fetch each detail page the same way for the Realtor Estimate
//
// ── Required .env ─────────────────────────────────────────────────────────────
//   OXYLABS_USERNAME=your_api_user
//   OXYLABS_PASSWORD=your_api_password
//
// ── Optional .env ─────────────────────────────────────────────────────────────
//   REALTOR_SEARCH_URLS      — comma-separated search URLs
//   REALTOR_MAX_PAGES        — per-URL page cap (default 10)
//   REALTOR_MAX_LISTINGS     — hard cap per run (default 200)
//   REALTOR_FETCH_ESTIMATES  — set "false" to skip detail fetches
//   REALTOR_RESIDENTIAL      — set "true" to use residential proxies
//   REALTOR_FETCH_TIMEOUT    — ms timeout per request (default 90000)
//

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions }  from "../base.scraper";
import { BrowserHandle, sleep, jitter } from "../../utils/browser";
import { RawListing }                   from "../../types/listing";
import { logger }                       from "../../utils/logger";
import {
  parseRealtorResults,
  extractEstimateFromDetailNextData,
  MAX_DAYS_OLD,
} from "./realtor.parser";

// ── Config ────────────────────────────────────────────────────────────────────

const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME   ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD   ?? "";
const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";

const USE_RESIDENTIAL    = process.env.REALTOR_RESIDENTIAL    === "true";
const FETCH_ESTIMATES    = process.env.REALTOR_FETCH_ESTIMATES !== "false";
const REQUEST_TIMEOUT_MS = Number(process.env.REALTOR_FETCH_TIMEOUT) || (USE_RESIDENTIAL ? 180_000 : 90_000);
const BETWEEN_PAGE_MS    = 3_000;
const DETAIL_CONCURRENCY = 3;
const DEBUG_PAGES        = 3;
const MAX_RETRIES        = 3;

// ── Default search URLs ───────────────────────────────────────────────────────

const DEFAULT_SEARCH_URLS: string[] = [
  "https://www.realtor.com/realestateandhomes-search/Columbus_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Cleveland_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Toledo_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Milwaukee_WI/?price_max=300000&type=single_family,multi_family",
];

function getSearchUrls(): string[] {
  const env     = process.env.REALTOR_SEARCH_URLS ?? "";
  const fromEnv = env.split(",").map((u) => u.trim()).filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_SEARCH_URLS;
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildPageUrl(baseUrl: string, pageNumber: number): string {
  if (pageNumber <= 1) return baseUrl;
  try {
    const u         = new URL(baseUrl);
    const cleanPath = u.pathname.replace(/\/pg-\d+\/?$/, "").replace(/\/$/, "");
    u.pathname      = `${cleanPath}/pg-${pageNumber}`;
    return u.toString();
  } catch {
    const [base, qs] = baseUrl.split("?");
    const cleanBase  = base.replace(/\/pg-\d+\/?$/, "").replace(/\/$/, "");
    return qs
      ? `${cleanBase}/pg-${pageNumber}?${qs}`
      : `${cleanBase}/pg-${pageNumber}`;
  }
}

// ── Geo state ─────────────────────────────────────────────────────────────────

const STATE_MAP: Record<string, string> = {
  AL: "Alabama",       AK: "Alaska",        AZ: "Arizona",       AR: "Arkansas",
  CA: "California",    CO: "Colorado",      CT: "Connecticut",   DE: "Delaware",
  FL: "Florida",       GA: "Georgia",       HI: "Hawaii",        ID: "Idaho",
  IL: "Illinois",      IN: "Indiana",       IA: "Iowa",          KS: "Kansas",
  KY: "Kentucky",      LA: "Louisiana",     ME: "Maine",         MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan",      MN: "Minnesota",     MS: "Mississippi",
  MO: "Missouri",      MT: "Montana",       NE: "Nebraska",      NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey",    NM: "New Mexico",    NY: "New York",
  NC: "North Carolina",ND: "North Dakota",  OH: "Ohio",          OK: "Oklahoma",
  OR: "Oregon",        PA: "Pennsylvania",  RI: "Rhode Island",  SC: "South Carolina",
  SD: "South Dakota",  TN: "Tennessee",     TX: "Texas",         UT: "Utah",
  VT: "Vermont",       VA: "Virginia",      WA: "Washington",    WV: "West Virginia",
  WI: "Wisconsin",     WY: "Wyoming",
};

function geoStateFromUrl(url: string): string {
  const match = url.match(/_([A-Z]{2})[/?]/);
  if (match?.[1] && STATE_MAP[match[1]]) {
    return `${STATE_MAP[match[1]]}, United States`;
  }
  return "United States";
}

// ── Session ID ────────────────────────────────────────────────────────────────

function freshSessionId(): string {
  return `rlt_${Date.now()}_${Math.floor(Math.random() * 99_999)}`;
}

// ── Decompression ─────────────────────────────────────────────────────────────

async function decompressBuffer(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (err, r) => (err ? reject(err) : resolve(r)));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (err, r) => {
        if (err) zlib.inflateRaw(buf, (e2, r2) => (e2 ? reject(e2) : resolve(r2)));
        else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (err, r) => (err ? reject(err) : resolve(r)));
    } else {
      resolve(buf);
    }
  });
}

// ── Oxylabs POST ──────────────────────────────────────────────────────────────

function oxylabsPost(
  bodyStr:   string,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

    const deadline = setTimeout(
      () => reject(new Error(`Oxylabs request timeout after ${timeoutMs / 1000}s`)),
      timeoutMs + 5_000
    );

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers: {
          "Content-Type":    "application/json",
          "Authorization":   `Basic ${authStr}`,
          "Content-Length":  Buffer.byteLength(bodyStr).toString(),
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", async () => {
          clearTimeout(deadline);
          const rawBuf   = Buffer.concat(chunks);
          const encoding = (res.headers["content-encoding"] ?? "").trim();
          let dec: Buffer;
          try { dec = encoding ? await decompressBuffer(rawBuf, encoding) : rawBuf; }
          catch { dec = rawBuf; }
          resolve({ status: res.statusCode ?? 0, body: dec.toString("utf-8") });
        });
        res.on("error", (err) => { clearTimeout(deadline); reject(err); });
      }
    );

    req.on("error", (err) => { clearTimeout(deadline); reject(err); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Payload builder ───────────────────────────────────────────────────────────
//
// IDENTICAL structure to loopnet.scraper.ts buildPayload() — the only
// differences are the session prefix and geo_location (state-specific).
//
// Critically: wait_for_selector on attempt 1 uses the same broad selector
// as LoopNet: "article, script[type='application/ld+json']"
//
// DO NOT use "script#__NEXT_DATA__" as a selector — Oxylabs treats script-tag
// ID selectors as a trigger for a stricter render mode that this plan cannot
// satisfy, producing is_render_forced=false + 613 immediately.
//
// Realtor.com is SSR: once any article or ld+json script exists in the DOM,
// __NEXT_DATA__ is already present in the HTML. No need to wait for it directly.

function buildPayload(
  targetUrl:   string,
  sessionId:   string,
  useSelector: boolean = true
): Record<string, unknown> {
  const timeoutS = Math.max(30, Math.floor(REQUEST_TIMEOUT_MS / 1_000) - 10);

  const payload: Record<string, unknown> = {
    source:          "universal",
    url:             targetUrl,
    render:          "html",
    geo_location:    geoStateFromUrl(targetUrl),  // state-specific, e.g. "Ohio, United States"
    user_agent_type: "desktop_chrome",
    locale:          "en-US",
    session_id:      sessionId,
    timeout_s:       timeoutS,
    context: [
      { key: "follow_redirects", value: true },
      { key: "load_images",      value: false },
    ],
  };

  // Same selector as LoopNet — broad, always resolves, never triggers
  // the strict render-mode check that caused is_render_forced=false.
  if (useSelector) {
    payload.wait_for_selector = "article, script[type='application/ld+json']";
  }

  if (USE_RESIDENTIAL) {
    payload.residential = true;
  }

  return payload;
}

// ── Retry delay ───────────────────────────────────────────────────────────────

function retryDelayMs(attempt: number): number {
  return Math.min(8_000 * Math.pow(2, attempt - 1) + Math.random() * 4_000, 45_000);
}

// ── Block detection ───────────────────────────────────────────────────────────

function isActuallyBlocked(html: string, title: string): boolean {
  const lower      = html.toLowerCase();
  const titleLower = title.toLowerCase();

  const blockSignals: { label: string; hit: boolean }[] = [
    {
      label: "Akamai error reference",
      hit:   lower.includes("errors.edgesuite.net") || lower.includes("reference #"),
    },
    {
      label: "Akamai JS challenge",
      hit:   lower.includes("please enable cookies") ||
             lower.includes("enable cookies to continue"),
    },
    {
      label: "Cloudflare challenge",
      hit:   lower.includes("challenges.cloudflare.com") ||
             lower.includes("cf-browser-verification") ||
             lower.includes("__cf_chl_"),
    },
    {
      label: "PerimeterX / Kasada captcha",
      hit:   lower.includes('id="px-captcha"')  ||
             lower.includes('id="_pxcaptcha"')  ||
             lower.includes("__kasada__")        ||
             lower.includes("kasada.io"),
    },
    {
      label: "Generic bot challenge",
      hit:   lower.includes("verifying you are human") ||
             lower.includes("checking your browser")   ||
             lower.includes("ddos-guard"),
    },
    {
      label: "Challenge page title",
      hit:   [
        "access denied", "access to this page has been denied",
        "just a moment", "attention required", "please wait",
        "security check", "are you a robot",
      ].some((s) => titleLower.includes(s)),
    },
    {
      label: "Page too short",
      hit:   html.length < 5_000,
    },
  ];

  const triggered = blockSignals.filter((s) => s.hit);
  if (triggered.length > 0) {
    logger.warn(
      `[realtor] Blocked — signals: ${triggered.map((s) => s.label).join(", ")}`
    );
    return true;
  }
  return false;
}

// ── Content check ─────────────────────────────────────────────────────────────

function hasRealtorContent(html: string): boolean {
  return (
    html.includes("__NEXT_DATA__") ||
    html.includes("realtor.com")
  );
}

// ── File helpers ──────────────────────────────────────────────────────────────

function saveFile(filename: string, content: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
    logger.debug(`[realtor] Saved → logs/${filename}`);
  } catch (e) {
    logger.warn(`[realtor] Could not save ${filename}: ${e}`);
  }
}

function saveDebugJson(data: unknown, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `realtor_${label}.json`),
      JSON.stringify(data, null, 2),
      "utf-8"
    );
    logger.debug(`[realtor] Debug JSON → logs/realtor_${label}.json`);
  } catch {}
}

// ── Core fetch ────────────────────────────────────────────────────────────────
//
// Retry loop identical to loopnet.scraper.ts oxylabsFetch():
//   attempt 1 → with wait_for_selector
//   attempt 2 → no selector (DOMContentLoaded)
//   attempt 3 → no selector, fresh session
//   613 → soft retry with backoff

async function oxylabsFetch(targetUrl: string): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error("[realtor] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    return null;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const sessionId   = freshSessionId();
    const useSelector = attempt === 1;
    const payload     = buildPayload(targetUrl, sessionId, useSelector);
    const bodyStr     = JSON.stringify(payload);

    logger.debug(
      `[realtor] Oxylabs attempt ${attempt}/${MAX_RETRIES} | ` +
      `session=${sessionId} | residential=${USE_RESIDENTIAL} | ` +
      `selector=${useSelector} | timeout=${REQUEST_TIMEOUT_MS / 1_000}s → ${targetUrl}`
    );

    let resp: { status: number; body: string };
    try {
      resp = await oxylabsPost(bodyStr, REQUEST_TIMEOUT_MS);
    } catch (err: any) {
      logger.warn(`[realtor] Transport error (attempt ${attempt}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = retryDelayMs(attempt);
        logger.debug(`[realtor] Retrying in ${Math.round(delay / 1_000)}s…`);
        await sleep(delay);
        continue;
      }
      logger.error(`[realtor] All ${MAX_RETRIES} attempts failed for ${targetUrl}`);
      return null;
    }

    const { status, body } = resp;

    if (status === 401) {
      logger.error("[realtor] Oxylabs 401 — invalid credentials");
      throw new Error("OXYLABS_AUTH_FAILED");
    }
    if (status === 429) {
      logger.warn("[realtor] Oxylabs 429 — rate limited");
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }
    if (status !== 200) {
      logger.warn(`[realtor] Oxylabs HTTP ${status}`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    let envelope: any;
    try { envelope = JSON.parse(body); }
    catch {
      logger.warn(`[realtor] Failed to parse Oxylabs envelope (attempt ${attempt})`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const result0 = envelope?.results?.[0];
    if (!result0) {
      logger.warn(`[realtor] No results[0] in envelope (attempt ${attempt})`);
      saveDebugJson(envelope, `no_results_${attempt}_${Date.now()}`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const innerStatus: number = result0.status_code ?? result0.statusCode ?? 200;
    const isRenderForced      = result0.is_render_forced;

    logger.debug(
      `[realtor] inner=${innerStatus} | ` +
      `is_render_forced=${isRenderForced ?? "n/a"} | ` +
      `attempt=${attempt}`
    );

    if (innerStatus === 401) {
      logger.error("[realtor] Oxylabs inner 401");
      throw new Error("OXYLABS_AUTH_FAILED");
    }

    // 613 = "page not ready" — soft retry, same as loopnet
    if (innerStatus === 613) {
      logger.warn(
        `[realtor] Inner 613 (attempt ${attempt}) — page not ready, retrying…`
      );
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      logger.error(
        `[realtor] All ${MAX_RETRIES} attempts returned 613 for ${targetUrl}.\n` +
        `  is_render_forced=${isRenderForced} on every attempt.\n` +
        `  This is a persistent render block on this Oxylabs account for realtor.com.\n` +
        `  Reply to the open Oxylabs support ticket:\n` +
        `    "We are still getting 613 + is_render_forced=false for realtor.com\n` +
        `     using render:html with the same payload that works for loopnet.com\n` +
        `     on the same account. Please investigate why rendering is being\n` +
        `     suppressed for this domain on our plan."`
      );
      return null;
    }

    if (innerStatus !== 200 && innerStatus !== 0) {
      logger.warn(`[realtor] Inner status ${innerStatus} (attempt ${attempt})`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const content: string =
      result0.content               ??
      result0.html                  ??
      result0.results?.[0]?.content ??
      result0.results?.[0]?.html    ??
      "";

    logger.debug(`[realtor] Content length: ${content.length} chars`);

    if (content.length < 5_000) {
      logger.warn(`[realtor] Short content (${content.length} chars) — attempt ${attempt}`);
      saveFile(`realtor_short_${attempt}_${Date.now()}.html`, content);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const title = content.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ?? "";
    logger.debug(`[realtor] Page title: "${title}"`);

    if (isActuallyBlocked(content, title)) {
      saveFile(`realtor_blocked_${attempt}_${Date.now()}.html`, content);
      if (attempt < MAX_RETRIES) {
        logger.debug(`[realtor] Blocked on attempt ${attempt} — retrying…`);
        await sleep(retryDelayMs(attempt));
        continue;
      }
      if (!USE_RESIDENTIAL) {
        logger.warn("[realtor] Blocked on all attempts. Try REALTOR_RESIDENTIAL=true in .env");
      }
      return null;
    }

    if (!hasRealtorContent(content)) {
      logger.warn(
        `[realtor] Page has no __NEXT_DATA__ or realtor.com content (attempt ${attempt}).\n` +
        `[realtor] Title: "${title}" | Length: ${content.length}`
      );
      saveFile(`realtor_no_nextdata_${attempt}_${Date.now()}.html`, content);
      return content;  // caller decides whether to stop
    }

    logger.debug(`[realtor] ✓ ${content.length} chars, has __NEXT_DATA__`);
    return content;
  }

  return null;
}

// ── __NEXT_DATA__ extractor ───────────────────────────────────────────────────

function extractNextData(html: string): any | null {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    logger.warn(`[realtor] Failed to parse __NEXT_DATA__: ${e}`);
    return null;
  }
}

// ── Concurrent detail-page estimate fetcher ───────────────────────────────────

async function attachEstimates(listings: RawListing[]): Promise<void> {
  if (!FETCH_ESTIMATES || listings.length === 0) return;

  logger.info(
    `[realtor] Fetching estimates for ${listings.length} listing(s) ` +
    `(concurrency=${DETAIL_CONCURRENCY})…`
  );

  let hit = 0, miss = 0;

  for (let i = 0; i < listings.length; i += DETAIL_CONCURRENCY) {
    const batch = listings.slice(i, i + DETAIL_CONCURRENCY);

    await Promise.all(
      batch.map(async (listing) => {
        const html = await oxylabsFetch(listing.url);
        if (!html) { miss++; return; }

        const title = html.match(/<title[^>]*>([^<]+)/i)?.[1] ?? "";
        if (isActuallyBlocked(html, title)) {
          miss++;
          logger.warn(`[realtor] Detail blocked: ${listing.url}`);
          return;
        }

        const nextData = extractNextData(html);
        if (!nextData) { miss++; return; }

        const est = extractEstimateFromDetailNextData(
          nextData,
          listing.address ?? listing.url
        );

        if (est) {
          (listing as any).zestimate      = est.estimate;
          (listing as any).zestimateLow   = est.estimateLow;
          (listing as any).zestimateHigh  = est.estimateHigh;
          (listing as any).estimateSource = est.provider ?? "realtor";
          hit++;
          logger.info(
            `[realtor] ✓ Estimate ${listing.address}: ` +
            `$${est.estimate.toLocaleString()}` +
            (est.estimateLow
              ? ` ($${est.estimateLow.toLocaleString()} – $${est.estimateHigh?.toLocaleString()})`
              : "")
          );
        } else {
          miss++;
        }
      })
    );

    if (i + DETAIL_CONCURRENCY < listings.length) {
      await sleep(800 + Math.random() * 400);
    }
  }

  logger.info(
    `[realtor] Estimates: ${hit} found, ${miss} missing out of ${listings.length}`
  );
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class RealtorScraper extends BaseScraper {
  readonly sourceName = "realtor";

  private stopPaging  = false;
  private knownPages  = 0;
  private allListings: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);

    const urls = getSearchUrls();
    logger.info(
      `[realtor] ${urls.length} search URL(s), up to ${this.options.maxPages} page(s) each\n` +
      urls.map((u) => `  • ${u}`).join("\n")
    );
    logger.info(
      `[realtor] Oxylabs | render:html | ` +
      `residential:${USE_RESIDENTIAL} | ` +
      `timeout:${REQUEST_TIMEOUT_MS / 1_000}s | retries:${MAX_RETRIES} | ` +
      `fetchEstimates:${FETCH_ESTIMATES}`
    );

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error("[realtor] OXYLABS_USERNAME / OXYLABS_PASSWORD not set — add to .env");
    }
  }

  override async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting`);
    this.visited.clear();
    this.results     = [];
    this.allListings = [];
    this.stopPaging  = false;

    const searchUrls = getSearchUrls();
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    for (let urlIdx = 0; urlIdx < searchUrls.length; urlIdx++) {
      const baseUrl = searchUrls[urlIdx];
      logger.info(`[realtor] ── URL ${urlIdx + 1}/${searchUrls.length}: ${baseUrl}`);

      this.stopPaging = false;
      this.knownPages = 0;

      for (let page = 1; page <= this.options.maxPages; page++) {
        if (this.results.length >= this.options.maxListings) {
          logger.info(`[realtor] maxListings (${this.options.maxListings}) reached`);
          break;
        }

        logger.info(`[realtor] Page ${page}`);

        let pageListings: RawListing[] = [];
        try {
          pageListings = await this.scrapeOnePage(baseUrl, page);
        } catch (err: any) {
          if (err?.message === "OXYLABS_AUTH_FAILED") {
            logger.error("[realtor] Auth failed — aborting");
            return this.results;
          }
          logger.error(`[realtor] Page ${page} error: ${err}`);
          break;
        }

        logger.info(`[realtor] Page ${page}: ${pageListings.length} raw listing(s)`);
        this.allListings.push(...pageListings);

        await attachEstimates(pageListings);

        for (const listing of pageListings) {
          if (this.results.length >= this.options.maxListings) break;

          if (!listing.url) {
            rejected.push({ listing, reason: "no_url" });
            continue;
          }
          if (this.visited.has(listing.url)) {
            rejected.push({ listing, reason: "duplicate" });
            continue;
          }
          if (!this.passesFilter(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(`[realtor] ✗ Filtered: ${listing.address} @ ${listing.price}`);
            continue;
          }

          this.visited.add(listing.url);
          this.results.push(listing);

          const est = (listing as any).zestimate as number | undefined;
          logger.info(
            `[realtor] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${listing.address ?? listing.title} @ ` +
            `$${listing.price?.toLocaleString() ?? "?"} ` +
            (est ? `| Estimate $${est.toLocaleString()}` : "| no estimate")
          );
        }

        if (!this.shouldContinuePaging(page, pageListings)) {
          logger.info(`[realtor] No more pages for this URL`);
          break;
        }

        await sleep(jitter(BETWEEN_PAGE_MS));
      }

      if (urlIdx < searchUrls.length - 1) {
        const pause = 5_000 + Math.random() * 3_000;
        logger.debug(`[realtor] Pausing ${Math.round(pause / 1_000)}s before next URL…`);
        await sleep(pause);
      }
    }

    const withEstimate = this.results.filter(
      (l) => (l as any).zestimate != null
    ).length;

    logger.info(
      `[realtor] Finished — ${this.results.length} accepted, ` +
      `${rejected.length} rejected | ` +
      `${withEstimate}/${this.results.length} have an estimate`
    );

    saveFile(
      "realtor.json",
      JSON.stringify(
        {
          accepted:    this.results,
          rejected,
          allListings: this.allListings,
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    return this.results;
  }

  private async scrapeOnePage(
    baseUrl:    string,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (this.stopPaging) return [];

    const pageUrl = buildPageUrl(baseUrl, pageNumber);
    logger.info(`[realtor] Fetching → ${pageUrl}`);

    const html = await oxylabsFetch(pageUrl);
    if (!html) {
      logger.warn(`[realtor] No HTML for page ${pageNumber} — stopping`);
      this.stopPaging = true;
      return [];
    }

    if (pageNumber <= DEBUG_PAGES) {
      const slug = baseUrl
        .replace(/https?:\/\/[^/]+\/[^/]+\//, "")
        .replace(/\W+/g, "_")
        .slice(0, 30);
      saveFile(`realtor_html_p${pageNumber}_${slug}.html`, html);
    }

    const title = html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ?? "";

    if (isActuallyBlocked(html, title)) {
      logger.error(`[realtor] Blocked on page ${pageNumber}`);
      saveFile(`realtor_blocked_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    if (!html.includes("__NEXT_DATA__")) {
      logger.warn(
        `[realtor] No __NEXT_DATA__ on page ${pageNumber}.\n` +
        `  Title: "${title}" | Length: ${html.length}\n` +
        `  Saved to logs/realtor_no_nextdata_p${pageNumber}.html`
      );
      saveFile(`realtor_no_nextdata_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    const nextData = extractNextData(html);
    if (!nextData) {
      logger.warn(`[realtor] Could not parse __NEXT_DATA__ on page ${pageNumber}`);
      this.stopPaging = true;
      return [];
    }

    if (pageNumber <= DEBUG_PAGES) {
      const slug = baseUrl
        .replace(/https?:\/\/[^/]+\/[^/]+\//, "")
        .replace(/\W+/g, "_")
        .slice(0, 30);
      saveFile(
        `realtor_json_p${pageNumber}_${slug}.json`,
        JSON.stringify(nextData, null, 2)
      );
    }

    const { listings, allStale, totalPages } = parseRealtorResults(nextData);

    if (pageNumber === 1 && totalPages > 0) {
      this.knownPages = Math.min(totalPages, this.options.maxPages);
      logger.info(
        `[realtor] ${totalPages} total page(s) (capped at ${this.knownPages})`
      );
    }

    logger.info(
      `[realtor] Page ${pageNumber}: ${listings.length} listing(s) within ${MAX_DAYS_OLD}d` +
      (allStale ? " — all stale" : "")
    );

    if (allStale) this.stopPaging = true;

    return listings.map((l) => ({ ...l, source: this.sourceName }));
  }

  private shouldContinuePaging(page: number, last: RawListing[]): boolean {
    if (this.stopPaging)                                  return false;
    if (last.length === 0)                                return false;
    if (page >= this.options.maxPages)                    return false;
    if (this.knownPages > 0 && page >= this.knownPages)   return false;
    return true;
  }

  protected async scrapePage(
    _h: BrowserHandle,
    _p: number
  ): Promise<RawListing[]> {
    return [];
  }

  protected shouldContinue(_p: number): boolean {
    return false;
  }
}