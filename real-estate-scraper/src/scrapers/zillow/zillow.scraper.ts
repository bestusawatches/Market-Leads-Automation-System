// src/scrapers/zillow/zillow.scraper.ts
//
// Fetches Zillow pages via ScraperAPI's synchronous render endpoint.
// ScraperAPI runs real Chrome on US residential IPs on their end —
// no local browser, no proxy configuration needed for Zillow.
//
// Credit cost per page: 25 credits (render=true + premium=true)
// ScraperAPI docs: https://docs.scraperapi.com/making-requests/customizing-requests

import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseZillowResults, MAX_DAYS_OLD } from "./zillow.parser";
import { config } from "../../config";
import * as fs   from "fs";
import * as path from "path";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PAGES        = 20;
const BETWEEN_PAGE_MS  = 3_000;
// ScraperAPI docs recommend 70 s timeout for hard-to-scrape domains
const REQUEST_TIMEOUT  = 70_000;
// Retry config — ScraperAPI occasionally returns 5xx on overloaded nodes
const MAX_RETRIES      = 3;
const RETRY_DELAY_MS   = 8_000;

const SCRAPER_API_KEY  = process.env.SCRAPER_API_KEY ?? "";

if (!SCRAPER_API_KEY) {
  logger.warn("[zillow] SCRAPER_API_KEY is not set — requests will fail (401)");
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildPageUrl(baseUrl: string, pageNumber: number): string {
  const [basePath] = baseUrl.split("?");

  const state: Record<string, any> = {
    filterState:   { price: { max: 300_000 } },
    sortSelection: { value: "days" },
  };

  if (pageNumber > 1) {
    state.pagination = { currentPage: pageNumber };
  }

  return `${basePath}?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
}

// ── ScraperAPI fetch ──────────────────────────────────────────────────────────
//
// Parameters used:
//   render=true      — full JS rendering via headless Chrome on their end
//   premium=true     — forces residential IP pool (required for Zillow/PerimeterX)
//   country_code=us  — US exit node
//   wait_for_selector=%23__NEXT_DATA__ — waits for Next.js data script before returning

async function fetchViaScraperApi(targetUrl: string): Promise<string | null> {
  const apiUrl = "https://api.scraperapi.com/";

  const params = new URLSearchParams({
    api_key:           SCRAPER_API_KEY,
    url:               targetUrl,
    render:            "true",
    premium:           "true",
    country_code:      "us",
    device_type:       "desktop",
    // Tell ScraperAPI to wait until __NEXT_DATA__ exists before returning HTML
    wait_for_selector: "#__NEXT_DATA__",
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(
        `[zillow:fetcher] ScraperAPI attempt ${attempt}/${MAX_RETRIES} → ${targetUrl}`
      );

      const response = await axios.get<string>(`${apiUrl}?${params.toString()}`, {
        timeout:        REQUEST_TIMEOUT,
        validateStatus: () => true, // handle all status codes ourselves
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (response.status === 200) {
        const html = response.data;
        if (typeof html !== "string" || html.length < 5_000) {
          logger.warn(
            `[zillow:fetcher] Response suspiciously short (${String(html).length} chars) on attempt ${attempt}`
          );
          if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
          return null;
        }
        logger.info(`[zillow:fetcher] Got ${html.length} chars`);
        return html;
      }

      if (response.status === 401) {
        logger.error("[zillow:fetcher] 401 — invalid SCRAPER_API_KEY");
        return null; // no point retrying auth failures
      }

      if (response.status === 403) {
        logger.error("[zillow:fetcher] 403 — account out of credits or plan too low for premium");
        return null;
      }

      logger.warn(`[zillow:fetcher] HTTP ${response.status} on attempt ${attempt}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);

    } catch (err) {
      const msg = err instanceof AxiosError ? err.message : String(err);
      logger.warn(`[zillow:fetcher] Request error on attempt ${attempt}: ${msg}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }

  logger.error(`[zillow:fetcher] All ${MAX_RETRIES} attempts failed for: ${targetUrl}`);
  return null;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class ZillowScraper extends BaseScraper {
  readonly sourceName = "zillow";
  private readonly baseUrl: string;
  private stopPaging = false;

  constructor(options: ScraperOptions = {}) {
    super(options);
    this.baseUrl = String(config.sources.zillow);
  }

  // BrowserHandle is still required by BaseScraper's signature but unused here —
  // Zillow fetches go through ScraperAPI's HTTP API instead of a local browser.
  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (this.stopPaging) return [];

    const pageUrl = buildPageUrl(this.baseUrl, pageNumber);
    logger.info(`[zillow] Page ${pageNumber}/${MAX_PAGES} → ${pageUrl}`);

    // ── Fetch via ScraperAPI ───────────────────────────────────────────────
    const html = await fetchViaScraperApi(pageUrl);

    if (!html) {
      logger.error(`[zillow] Fetch failed for page ${pageNumber} — stopping pagination`);
      this.stopPaging = true;
      return [];
    }

    // ── Verify it's a real Zillow page ────────────────────────────────────
    if (!html.includes("zillowstatic.com") && !html.includes("__NEXT_DATA__")) {
      logger.error(`[zillow] Page ${pageNumber} response doesn't look like Zillow`);
      this.saveDebug(html, `unexpected_p${pageNumber}`);
      this.stopPaging = true;
      return [];
    }

    // ── Check for PerimeterX block page ───────────────────────────────────
    // ScraperAPI's premium tier should bypass this, but log it if it slips through
    const BLOCK_SIGNALS = [
      'id="px-captcha"',
      'id="_pxCaptcha"',
      "Access to this page has been denied",
      "challenges.cloudflare.com",
    ];
    if (BLOCK_SIGNALS.some((s) => html.includes(s))) {
      logger.error(
        `[zillow] Page ${pageNumber} returned a PerimeterX block page despite ScraperAPI premium — ` +
        `check your credit balance at dashboard.scraperapi.com`
      );
      this.saveDebug(html, `blocked_p${pageNumber}`);
      this.stopPaging = true;
      return [];
    }

    // ── Extract __NEXT_DATA__ ─────────────────────────────────────────────
    const $            = cheerio.load(html);
    const nextDataText = $("#__NEXT_DATA__").text().trim();

    if (!nextDataText) {
      logger.warn(`[zillow] No __NEXT_DATA__ on page ${pageNumber} — stopping pagination`);
      this.saveDebug(html, `no_next_data_p${pageNumber}`);
      this.stopPaging = true;
      return [];
    }

    // ── Parse JSON ────────────────────────────────────────────────────────
    let json: any;
    try {
      json = JSON.parse(nextDataText);
    } catch (err) {
      logger.warn(`[zillow] Failed to parse __NEXT_DATA__ on page ${pageNumber}: ${err}`);
      this.saveDebug(html, `parse_error_p${pageNumber}`);
      this.stopPaging = true;
      return [];
    }

    const searchJson = json?.props?.pageProps?.searchPageState ?? json;
    const { listings, allStale } = parseZillowResults(searchJson);

    logger.info(
      `[zillow] Page ${pageNumber}: ${listings.length} listings within ${MAX_DAYS_OLD} days` +
        (allStale ? " — all stale, stopping pagination" : "")
    );

    if (allStale) this.stopPaging = true;

    if (!this.stopPaging) {
      await sleep(BETWEEN_PAGE_MS + Math.random() * 2_000);
    }

    return listings.map((l) => ({ ...l, source: this.sourceName }));
  }

  protected hasMorePages(
    pageNumber: number,
    lastPageResults: RawListing[]
  ): boolean {
    if (this.stopPaging)              return false;
    if (pageNumber >= MAX_PAGES)      return false;
    if (lastPageResults.length === 0) return false;
    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private saveDebug(html: string, label: string): void {
    try {
      const dir  = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `zillow_${label}.html`);
      fs.writeFileSync(file, html);
      logger.debug(`[zillow] Debug HTML → ${file}`);
    } catch {}
  }
}