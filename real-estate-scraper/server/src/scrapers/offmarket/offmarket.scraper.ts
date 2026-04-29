// src/scrapers/offmarket/offmarket.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// offmarket.com — ListingPro WordPress theme, Wordfence + rate limiting.
//
// What we learned from the real HTML:
//   ✓ Working URL:   https://www.offmarket.com/listing-category/residential/
//   ✓ Cards use:     data-posturl, data-raw-price, data-bed, data-bath, data-buildingsqft
//   ✓ Pagination:    AJAX "Load More" button — NOT page URLs
//                    POSTs to /wp-admin/admin-ajax.php with action=ajax_listing_load_more
//
// Fixes in this version:
//   ✓ AJAX Load More — listedIds and nonce are now re-read directly from the
//     live page DOM (not from the HTML snapshot) to ensure they are always
//     up-to-date and correctly escaped.
//   ✓ Location filter — now checks state + city + address + URL slug so that
//     listings without a parsed address are not incorrectly dropped.
//   ✓ No maxListings cap — scrapes all available pages.
//   ✓ 30-day date filter — fail-open when date is missing/unparseable.
//
// .env:
//   PROXY_URL=http://user:pass@us-proxy-host:port   (US proxy strongly recommended)
//   OFFMARKET_SEARCH_URL=https://www.offmarket.com/listing-category/residential/
//   OFFMARKET_STATES=OH,WI          (comma-separated state codes to keep)
//   OFFMARKET_CITIES=Cleveland,Columbus,Milwaukee   (optional city filter)
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import {
  parseOffmarketSearchPage,
  parseOffmarketDetailPage,
  extractPaginationInfo,
  extractStateFromUrl,
  OffmarketDetail,
} from "./offmarket.parser";
import * as fs from "fs";
import * as path from "path";

const HOME_URL  = "https://www.offmarket.com";
const AJAX_URL  = "https://www.offmarket.com/wp-admin/admin-ajax.php";

const DEFAULT_SEARCH_URL =
  process.env.OFFMARKET_SEARCH_URL ||
  "https://www.offmarket.com/listing-category/residential/";

// State/city filters — read from .env
// e.g.  OFFMARKET_STATES=OH,WI
//       OFFMARKET_CITIES=Cleveland,Columbus,Milwaukee,Toledo,Akron
const FILTER_STATES: string[] = process.env.OFFMARKET_STATES
  ? process.env.OFFMARKET_STATES.split(",").map((s) => s.trim().toUpperCase())
  : ["OH", "WI"];

const FILTER_CITIES: string[] = process.env.OFFMARKET_CITIES
  ? process.env.OFFMARKET_CITIES.split(",").map((s) => s.trim().toLowerCase())
  : [];

const DETAIL_DELAY_MS = 4_000;
const MAX_RETRIES     = 3;

// ── 30-day date filter ─────────────────────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Returns true when the listing should be kept.
 * Fail-open: if the date is missing or unparseable the listing is included.
 */
function isWithinThirtyDays(dateStr: string | number | undefined): boolean {
  if (dateStr === undefined || dateStr === "") return true;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return true;
  return Date.now() - parsed.getTime() <= THIRTY_DAYS_MS;
}

// ── Location filter ────────────────────────────────────────────────────────

/**
 * Returns true when the listing matches the configured state (and optionally
 * city) filters.
 *
 * Matching strategy (fail-open when nothing can be determined):
 *   1. Check parsed `state` field from parser
 *   2. Fall back to state extracted from the listing URL slug
 *   3. If still unknown → INCLUDE (we never silently drop uncertain data)
 *
 * City filter (OFFMARKET_CITIES) is purely additive — only applied when
 * FILTER_CITIES is non-empty. A listing passes if ANY city keyword is a
 * case-insensitive substring of the address, location, city, or URL.
 */
function passesLocationFilter(listing: Partial<RawListing> & { url: string }): boolean {
  // Determine state from parsed field or URL slug
  const state =
    (listing as any).state ??
    extractStateFromUrl(listing.url);

  if (!state) {
    // Can't determine state — include and let downstream decide
    logger.debug(`[offmarket] Location unknown (fail-open): ${listing.url}`);
    return true;
  }

  if (!FILTER_STATES.includes(state.toUpperCase())) {
    return false;
  }

  // State matches — now apply city filter if configured
  if (FILTER_CITIES.length === 0) return true;

  const haystack = [
    (listing as any).city,
    listing.address,
    (listing as any).location,
    listing.url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return FILTER_CITIES.some((city) => haystack.includes(city));
}

// ── Scraper ────────────────────────────────────────────────────────────────

export class OffmarketScraper extends BaseScraper {
  readonly sourceName = "offmarket";

  private cookiesWarmed = false;

  constructor(options: ScraperOptions = {}) {
    super(options);

    if (!process.env.PROXY_URL) {
      logger.warn(
        "[offmarket] ⚠️  No PROXY_URL — offmarket.com may geo-block non-US IPs.\n" +
          "  Add: PROXY_URL=http://user:pass@us-host:port"
      );
    }

    logger.info(`[offmarket] Search URL:    ${DEFAULT_SEARCH_URL}`);
    logger.info(`[offmarket] State filter:  ${FILTER_STATES.join(", ")}`);
    if (FILTER_CITIES.length) {
      logger.info(`[offmarket] City filter:   ${FILTER_CITIES.join(", ")}`);
    }
  }

  // ── Cookie + session warm-up ──────────────────────────────────────────────

  private async warmSession(page: Page): Promise<void> {
    logger.info("[offmarket] Warming session…");
    try {
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(4000 + Math.random() * 2000);
      for (const y of [300, 600, 400, 0]) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(300 + Math.random() * 200);
      }

      try {
        await page.goto(
          "https://www.offmarket.com/listing-category/real-estate/",
          { waitUntil: "domcontentloaded", timeout: 30_000 }
        );
        await sleep(3000 + Math.random() * 2000);
      } catch {
        // non-fatal
      }

      await sleep(8000 + Math.random() * 5000);
      this.cookiesWarmed = true;
      logger.debug("[offmarket] Session warmed");
    } catch (err) {
      logger.warn(`[offmarket] Warm failed (non-fatal): ${err}`);
    }
  }

  // ── Block detection ────────────────────────────────────────────────────────

  private detectBlock(html: string): "wordfence" | "rate_limit" | "none" {
    const lower = html.toLowerCase();
    if (lower.includes("too many requests") || lower.includes("rate-limited"))
      return "rate_limit";
    if (
      lower.includes("wordfence") ||
      lower.includes("your access to this site has been limited") ||
      lower.includes("access from your area has been temporarily limited")
    )
      return "wordfence";
    return "none";
  }

  // ── Fetch search page ──────────────────────────────────────────────────────

  private async fetchSearchPage(page: Page, url: string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

        try {
          await page.waitForSelector("[data-posturl]", { timeout: 15_000 });
        } catch {
          // may be empty or end of results
        }

        for (const y of [400, 900, 1400, 900, 400]) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          await sleep(250 + Math.random() * 250);
        }
        await sleep(1500);

        const html = await page.content();
        const blockType = this.detectBlock(html);

        if (blockType === "wordfence") {
          logger.error(
            "[offmarket] ❌ Wordfence block. Use a US residential proxy.\n" +
              "  Fix: PROXY_URL=http://user:pass@us-residential-host:port"
          );
          this.saveDebug(html, "wordfence_block");
          return null;
        }

        if (blockType === "rate_limit") {
          const wait = 90_000 * attempt;
          logger.warn(`[offmarket] 429 on attempt ${attempt}. Waiting ${wait / 1000}s…`);
          this.saveDebug(html, `rate_limit_${attempt}`);
          if (attempt < MAX_RETRIES) await sleep(wait);
          continue;
        }

        return html;
      } catch (err) {
        logger.warn(`[offmarket] Fetch attempt ${attempt}/${MAX_RETRIES}: ${err}`);
        if (attempt < MAX_RETRIES) await sleep(5000 * attempt);
      }
    }
    return null;
  }

  // ── AJAX Load More ─────────────────────────────────────────────────────────
  //
  // KEY FIX: We read listedIds and randNumber directly from the live page DOM
  // rather than from the HTML snapshot stored in _pagInfo. This ensures we
  // always have the current values (the page may update them after load).

  private async fetchLoadMore(
    page: Page,
    ajaxPage: number,
    termId: string
  ): Promise<string | null> {
    logger.info(`[offmarket] AJAX Load More — ajax page ${ajaxPage}`);

    try {
      const result = await page.evaluate(
        async ({ ajaxUrl, ajaxPage, termId }) => {
          // Read nonce and listedIds live from the DOM — more reliable than
          // values captured from the initial HTML snapshot.
          const btn = document.querySelector(".loadMoreListing") as HTMLElement | null;
          const nonce = btn?.getAttribute("data-rand-number") ?? "";

          const listedInput =
            (document.getElementById("listed_listing_id") as HTMLInputElement | null) ??
            (document.querySelector("input[name='listed_listing_id']") as HTMLInputElement | null);
          const listedIds = listedInput?.value ?? "";

          if (!nonce) {
            console.warn("[offmarket] AJAX: no nonce found in DOM");
          }

          const body = new URLSearchParams({
            action:             "ajax_listing_load_more",
            nonce,
            listed_listing_id:  listedIds,
            page:               String(ajaxPage),
            term_id:            termId,
          });

          try {
            const res = await fetch(ajaxUrl, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body.toString(),
            });
            return res.ok ? await res.text() : null;
          } catch {
            return null;
          }
        },
        { ajaxUrl: AJAX_URL, ajaxPage, termId }
      );

      if (!result || result.trim() === "" || result.trim() === "0") {
        logger.warn(
          `[offmarket] AJAX Load More returned empty/null for page ${ajaxPage}`
        );
        return null;
      }

      logger.debug(`[offmarket] AJAX response length: ${result.length} chars`);
      return result;
    } catch (err) {
      logger.warn(`[offmarket] AJAX Load More error: ${err}`);
      return null;
    }
  }

  // ── BaseScraper implementation ─────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    const page = await handle.newPage();

    try {
      if (!this.cookiesWarmed) {
        await this.warmSession(page);
      }

      // ── Page 1: navigate and parse ────────────────────────────────────────
      if (pageNumber === 1) {
        logger.info(`[offmarket] Fetching page 1: ${DEFAULT_SEARCH_URL}`);
        await sleep(3000 + Math.random() * 2000);

        const html = await this.fetchSearchPage(page, DEFAULT_SEARCH_URL);
        if (!html) return [];

        this.saveDebug(html, "page_1");
        const items = parseOffmarketSearchPage(html);
        logger.info(`[offmarket] Page 1: ${items.length} listings parsed`);

        const pagInfo = extractPaginationInfo(html);
        logger.info(
          `[offmarket] Total available: ${pagInfo.totalRecords} | ` +
          `Shown: ${items.length} | Has more: ${pagInfo.hasMore}`
        );

        // Store pagination info and keep the page open for subsequent AJAX calls
        (this as any)._pagInfo  = pagInfo;
        (this as any)._ajaxPage = page;  // intentionally kept open

        return this.enrichAndFilter(handle, items);
      }

      // ── Pages 2+: AJAX Load More ──────────────────────────────────────────
      const pagInfo  = (this as any)._pagInfo;
      const ajaxPage: Page | null = (this as any)._ajaxPage ?? null;

      if (!pagInfo?.hasMore) {
        logger.info("[offmarket] No more pages (Load More exhausted)");
        return [];
      }

      // ajaxPage offset: page 2 → loadMorePage+1, page 3 → loadMorePage+2, …
      const ajaxPageNum = pagInfo.loadMorePage + (pageNumber - 1);
      const termId      = "53"; // Residential — confirmed from HTML value="53"

      const ajaxHtml = await this.fetchLoadMore(
        ajaxPage ?? page,
        ajaxPageNum,
        termId
      );

      if (!ajaxHtml) return [];

      this.saveDebug(ajaxHtml, `ajax_page_${pageNumber}`);

      // AJAX response is raw HTML fragments — wrap for cheerio
      const wrapped = `<html><body><div id="content-grids">${ajaxHtml}</div></body></html>`;
      const items   = parseOffmarketSearchPage(wrapped);
      logger.info(`[offmarket] AJAX page ${pageNumber}: ${items.length} listings`);

      // Update hasMore by checking whether the Load More button is still in
      // the DOM of the page we're reusing for AJAX calls
      if (ajaxPage) {
        const stillHasMore = await ajaxPage
          .evaluate(() => !!document.querySelector(".loadMoreListing"))
          .catch(() => false);
        if (!stillHasMore) {
          (this as any)._pagInfo = { ...pagInfo, hasMore: false };
          logger.info("[offmarket] Load More button gone — no further pages");
        }
      }

      return this.enrichAndFilter(handle, items);
    } finally {
      // Keep page 1 open for AJAX reuse; close all other pages
      if (pageNumber > 1) {
        await page.close().catch(() => {});
      }
    }
  }

  // ── Enrich + filter ────────────────────────────────────────────────────────
  //
  // 1. Visit each detail page to get full address, state, city, and date.
  // 2. Merge detail data over card data (detail is more reliable).
  // 3. Apply 30-day date filter (fail-open when date unknown).
  // 4. Apply state/city location filter (fail-open when state unknown).

  private async enrichAndFilter(
    handle: BrowserHandle,
    rawItems: Omit<RawListing, "source">[]
  ): Promise<RawListing[]> {
    const enriched: RawListing[] = [];

    for (const item of rawItems) {
      let detail: OffmarketDetail = {};

      try {
        await sleep(DETAIL_DELAY_MS + Math.random() * 2000);
        const detailPage = await handle.newPage();

        try {
          await detailPage.goto(item.url, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await sleep(1500);
          const detailHtml = await detailPage.content();

          if (this.detectBlock(detailHtml) === "none") {
            detail = parseOffmarketDetailPage(detailHtml);
            logger.debug(`[offmarket] Enriched: ${item.url}`);
          }
        } finally {
          await detailPage.close().catch(() => {});
        }
      } catch (err) {
        logger.debug(`[offmarket] Detail failed for ${item.url}: ${err}`);
      }

      // Merge — detail page wins, card is the fallback
      const merged: RawListing = {
        source: this.sourceName,
        ...item,
        ...detail,
        // For these fields specifically, prefer detail page but keep card value
        // when detail page came back empty
        listedDate: detail.listedDate ?? (item as any).listedDate,
        state:      detail.state      ?? (item as any).state ?? extractStateFromUrl(item.url),
        city:       detail.city       ?? (item as any).city,
      };

      // ── 30-day date filter ───────────────────────────────────────────────
      if (!isWithinThirtyDays(merged.listedDate)) {
        logger.debug(
          `[offmarket] ✗ Date filtered (${merged.listedDate}): ${item.url}`
        );
        continue;
      }

      // ── Location filter ──────────────────────────────────────────────────
      if (!passesLocationFilter(merged)) {
        logger.debug(
          `[offmarket] ✗ Location filtered (state:${(merged as any).state}): ${item.url}`
        );
        continue;
      }

      logger.debug(
        `[offmarket] ✓ Kept (state:${(merged as any).state} city:${(merged as any).city}): ${item.url}`
      );
      enriched.push(merged);
    }

    logger.info(
      `[offmarket] ${enriched.length} / ${rawItems.length} listings passed filters`
    );

    return enriched;
  }

  // ── Debug ──────────────────────────────────────────────────────────────────

  private saveDebug(html: string, label: string): void {
    try {
      const logDir = path.resolve(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, `offmarket_${label}.html`),
        html,
        "utf-8"
      );
      logger.debug(`[offmarket] Debug → logs/offmarket_${label}.html`);
    } catch {
      // non-critical
    }
  }
}