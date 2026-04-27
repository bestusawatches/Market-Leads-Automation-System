// src/scrapers/zillow/zillow.scraper.ts
//
// Changes in this revision:
//   1. Raw HTML from Oxylabs saved to logs/zillow_html_p<N>.html for every
//      page — open this in a browser to find where the Zestimate lives.
//   2. __NEXT_DATA__ JSON saved to logs/zillow_json_p<N>.json — grep for
//      "zestimate" to see exactly which fields Zillow populates.
//   3. isRelevant() is bypassed for Zillow. Results are already geo+price
//      filtered at the URL level — keyword filtering adds nothing and was
//      discarding every listing.
//   4. ALL listings (including those that fail passesFilter) are collected
//      and written to logs/zillow.json so nothing is silently dropped.
//   5. Price field now arrives as a number (fixed in parser).
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { RawListing }                  from "../../types/listing";
import { logger }                      from "../../utils/logger";
import { sleep, jitter }               from "../../utils/browser";
import { parseZillowResults, MAX_DAYS_OLD } from "./zillow.parser";
import { config }                      from "../../config";

// ── Constants ─────────────────────────────────────────────────────────────────

const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";
const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD ?? "";

const REQUEST_TIMEOUT_MS = 120_000;
const BETWEEN_PAGE_MS    = 3_000;
const MAX_PAGES          = 20;

// Save HTML/JSON for the first N pages only — enough to inspect Zestimate
// location without filling disk. Set to 0 to disable.
const DEBUG_PAGES = 3;

// ── Oxylabs HTTP client ───────────────────────────────────────────────────────

interface OxylabsPayload {
  source:          string;
  url:             string;
  render:          string;
  geo_location:    string;
  user_agent_type: string;
  session_id?:     string;
}

interface OxylabsResponse {
  results: Array<{
    content:     string;
    status_code: number;
    url:         string;
    job_id:      string;
  }>;
}

function oxylabsFetch(targetUrl: string, sessionId?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error(
        "[zillow] Oxylabs credentials missing — add to .env:\n" +
        "[zillow]   OXYLABS_USERNAME=your_api_user\n" +
        "[zillow]   OXYLABS_PASSWORD=your_api_password"
      );
      resolve(null);
      return;
    }

    const payload: OxylabsPayload = {
      source:          "universal",
      url:             targetUrl,
      render:          "html",
      geo_location:    "United States",
      user_agent_type: "desktop",
      ...(sessionId ? { session_id: sessionId } : {}),
    };

    const bodyStr = JSON.stringify(payload);
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers:  {
          "Content-Type":   "application/json",
          "Authorization":  `Basic ${authStr}`,
          "Content-Length": Buffer.byteLength(bodyStr).toString(),
        },
      },
      (res: http.IncomingMessage) => {
        const enc    = (res.headers["content-encoding"] ?? "").toLowerCase();
        const chunks: Buffer[] = [];
        const stream =
          enc === "gzip"    ? res.pipe(zlib.createGunzip())           :
          enc === "deflate" ? res.pipe(zlib.createInflate())          :
          enc === "br"      ? res.pipe(zlib.createBrotliDecompress()) :
          res as any;

        (stream as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
        (stream as NodeJS.ReadableStream).on("end", () => {
          const raw    = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;

          if (status === 401) { logger.error("[zillow] Oxylabs 401"); resolve(null); return; }
          if (status === 429) { logger.warn("[zillow] Oxylabs 429");  resolve(null); return; }
          if (status !== 200) {
            logger.warn(`[zillow] Oxylabs HTTP ${status}`);
            logger.debug(`[zillow] Body snippet: ${raw.slice(0, 300)}`);
            resolve(null); return;
          }

          let parsed: OxylabsResponse;
          try { parsed = JSON.parse(raw); } catch {
            logger.warn("[zillow] Could not parse Oxylabs envelope");
            resolve(null); return;
          }

          const result      = parsed?.results?.[0];
          const content     = result?.content ?? "";
          const innerStatus = result?.status_code ?? 0;

          if (innerStatus === 403 || innerStatus === 429) {
            logger.warn(`[zillow] Zillow HTTP ${innerStatus} via Oxylabs`);
            resolve(null); return;
          }
          if (!content || content.length < 5_000) {
            logger.warn(`[zillow] Short content (${content.length} chars) — possible block`);
            resolve(null); return;
          }

          logger.debug(`[zillow] Oxylabs OK — ${content.length} chars, inner ${innerStatus}`);
          resolve(content);
        });

        (stream as NodeJS.ReadableStream).on("error", (err: any) => {
          logger.warn(`[zillow] Stream error: ${err.message}`);
          resolve(null);
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.warn(`[zillow] Oxylabs timed out after ${REQUEST_TIMEOUT_MS / 1_000}s`);
      req.destroy(); resolve(null);
    });

    req.on("error", (err: any) => {
      logger.error(`[zillow] Request error: [${err.code ?? "?"}] ${err.message}`);
      resolve(null);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── __NEXT_DATA__ extractor ───────────────────────────────────────────────────

function extractNextData(html: string): any | null {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try { return JSON.parse(match[1]); } catch (err) {
    logger.warn(`[zillow] Failed to parse __NEXT_DATA__: ${err}`);
    return null;
  }
}

// ── Block detection ───────────────────────────────────────────────────────────

const BLOCK_TITLES       = ["access to this page has been denied","access denied","attention required","just a moment","security check"];
const BLOCK_BODY_SIGNALS = ['id="px-captcha"','id="_pxCaptcha"',"challenges.cloudflare.com","cf-browser-verification","errors.edgesuite.net","Enable JavaScript and cookies to continue","Verifying you are human. Please stand by"];

function detectBlock(html: string): { blocked: boolean; reason: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").toLowerCase().trim();
  if (BLOCK_TITLES.some(t => title.includes(t)))          return { blocked: true, reason: `block title: "${title}"` };
  const sig = BLOCK_BODY_SIGNALS.find(s => html.includes(s));
  if (sig)                                                 return { blocked: true, reason: `body signal: ${sig}` };
  if (html.length < 3_000 && !html.includes("__NEXT_DATA__") && !html.includes("zillowstatic.com"))
                                                           return { blocked: true, reason: `too short (${html.length} chars)` };
  return { blocked: false, reason: "" };
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildPageUrl(baseUrl: string, pageNumber: number): string {
  const [basePath] = baseUrl.split("?");
  const state: Record<string, any> = {
    filterState:   { price: { max: 300_000 } },
    sortSelection: { value: "days" },
  };
  if (pageNumber > 1) state.pagination = { currentPage: pageNumber };
  return `${basePath}?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
}

// ── File helpers ──────────────────────────────────────────────────────────────

function ensureLogDir(): string {
  const dir = path.resolve("logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveFile(filename: string, content: string): void {
  try {
    const file = path.join(ensureLogDir(), filename);
    fs.writeFileSync(file, content, "utf-8");
    logger.info(`[zillow] Saved → logs/${filename}`);
  } catch (err) {
    logger.warn(`[zillow] Could not save ${filename}: ${err}`);
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class ZillowScraper extends BaseScraper {
  readonly sourceName = "zillow";

  private readonly baseUrl:   string;
  private stopPaging = false;
  private readonly sessionId = `zillow_${Date.now()}_${Math.floor(Math.random() * 9_999)}`;

  // Accumulate ALL listings across pages regardless of filter outcome
  private allListings: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);
    this.baseUrl = String(config.sources.zillow);
  }

  // ── Override run() — no Playwright, no isRelevant() filter ───────────────
  //
  // Zillow results are already filtered by price (≤ $300k) and geography at
  // the URL level.  Applying the keyword-based isRelevant() check on top of
  // that discards every single listing because residential addresses don't
  // contain words like "motivated seller" or "as-is". We skip it here and
  // accept every listing that passes the price/location passesFilter() check.

  override async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting scrape (Oxylabs — no local browser)`);
    this.visited.clear();
    this.results     = [];
    this.allListings = [];
    this.stopPaging  = false;

    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    for (let page = 1; page <= this.options.maxPages; page++) {
      if (this.results.length >= this.options.maxListings) {
        logger.info(`[${this.sourceName}] maxListings (${this.options.maxListings}) reached`);
        break;
      }

      logger.info(`[${this.sourceName}] Scraping page ${page}`);

      let pageListings: RawListing[] = [];
      try {
        pageListings = await this.scrapePage(null as any, page);
      } catch (err) {
        logger.error(`[${this.sourceName}] Page ${page} error: ${err}`);
        continue;
      }

      logger.info(`[${this.sourceName}] Page ${page}: ${pageListings.length} raw listings`);

      // Track every listing for the full JSON output
      this.allListings.push(...pageListings);

      for (const listing of pageListings) {
        if (this.results.length >= this.options.maxListings) break;

        if (!listing.url) {
          rejected.push({ listing, reason: "no_url" }); continue;
        }
        if (this.visited.has(listing.url)) {
          rejected.push({ listing, reason: "already_seen" }); continue;
        }

        // passesFilter checks price range and location — keep this.
        // isRelevant() (keyword check) is intentionally NOT called here.
        if (!this.passesFilter(listing)) {
          rejected.push({ listing, reason: "filtered" });
          logger.debug(`[${this.sourceName}] ✗ Filtered: ${listing.address} @ ${listing.price}`);
          continue;
        }

        this.visited.add(listing.url);
        this.results.push(listing);
        logger.info(
          `[${this.sourceName}] ✓ [${this.results.length}/${this.options.maxListings}] ` +
          `${listing.address ?? listing.title} @ $${listing.price?.toLocaleString()} ` +
          (listing.zestimate ? `| Zestimate $${listing.zestimate.toLocaleString()}` : "| no Zestimate")
        );
      }

      if (!this.hasMorePages(page, pageListings)) {
        logger.info(`[${this.sourceName}] No more pages`);
        break;
      }

      await sleep(jitter(BETWEEN_PAGE_MS));
    }

    logger.info(`[${this.sourceName}] Finished — ${this.results.length} accepted, ${rejected.length} rejected`);

    // Write full JSON including ALL listings and rejected ones
    saveFile(
      `${this.sourceName}.json`,
      JSON.stringify(
        {
          accepted:     this.results,
          rejected,
          allListings:  this.allListings,   // every listing regardless of filter
          generatedAt:  new Date().toISOString(),
        },
        null,
        2
      )
    );

    return this.results;
  }

  // ── scrapePage ────────────────────────────────────────────────────────────

  protected async scrapePage(_handle: any, pageNumber: number): Promise<RawListing[]> {
    if (this.stopPaging) return [];

    const pageUrl = buildPageUrl(this.baseUrl, pageNumber);
    logger.info(`[zillow] Page ${pageNumber}/${MAX_PAGES} → ${pageUrl}`);

    const html = await oxylabsFetch(pageUrl, this.sessionId);
    if (!html) {
      logger.warn(`[zillow] No HTML for page ${pageNumber} — stopping`);
      this.stopPaging = true;
      return [];
    }

    // ── Save raw HTML for inspection ──────────────────────────────────────
    // Open logs/zillow_html_p1.html in your browser to see the rendered page.
    // Search for "zestimate" to find where Zillow puts the value in the markup.
    if (pageNumber <= DEBUG_PAGES) {
      saveFile(`zillow_html_p${pageNumber}.html`, html);
    }

    const { blocked, reason } = detectBlock(html);
    if (blocked) {
      logger.error(`[zillow] Blocked on page ${pageNumber}: ${reason}`);
      saveFile(`zillow_blocked_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    if (!html.includes("zillowstatic.com") && !html.includes("__NEXT_DATA__")) {
      logger.error(`[zillow] Page ${pageNumber} doesn't look like Zillow`);
      saveFile(`zillow_unexpected_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    const json = extractNextData(html);
    if (!json) {
      logger.warn(`[zillow] No __NEXT_DATA__ on page ${pageNumber}`);
      saveFile(`zillow_no_next_data_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    // ── Save the raw __NEXT_DATA__ JSON ───────────────────────────────────
    // Run:  grep -i "zestimate" logs/zillow_json_p1.json
    // to see every field name containing "zestimate" and its value.
    if (pageNumber <= DEBUG_PAGES) {
      saveFile(`zillow_json_p${pageNumber}.json`, JSON.stringify(json, null, 2));
    }

    const searchJson             = json?.props?.pageProps?.searchPageState ?? json;
    const { listings, allStale } = parseZillowResults(searchJson);

    logger.info(
      `[zillow] Page ${pageNumber}: ${listings.length} listing(s) within ${MAX_DAYS_OLD} days` +
      (allStale ? " — all stale" : "")
    );

    // Log Zestimate hit rate for this page
    const withZestimate = listings.filter(l => (l as any).zestimate != null).length;
    logger.info(`[zillow] Page ${pageNumber}: ${withZestimate}/${listings.length} listings have a Zestimate`);

    if (allStale) this.stopPaging = true;
    return listings.map(l => ({ ...l, source: this.sourceName }));
  }

  protected hasMorePages(pageNumber: number, lastPageResults: RawListing[]): boolean {
    if (this.stopPaging)              return false;
    if (pageNumber >= MAX_PAGES)      return false;
    if (lastPageResults.length === 0) return false;
    return true;
  }
}