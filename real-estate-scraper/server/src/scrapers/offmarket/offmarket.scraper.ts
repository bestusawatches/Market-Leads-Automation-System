// src/scrapers/offmarket/offmarket.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// offmarket.com — ListingPro WordPress theme, Wordfence + rate limiting.
//
// What we learned from the real HTML:
//   ✓ Working URL:   https://www.offmarket.com/listing-category/residential/
//   ✓ Cards use:     data-posturl, data-raw-price, data-bed, data-bath, data-buildingsqft
//   ✓ Pagination:    AJAX "Load More" button — NOT page URLs
//                    POSTs to /wp-admin/admin-ajax.php with action=ajax_listing_load_more
//   ✓ Ohio filter:   applied after load via URL params or JS — handled by
//                    setting OFFMARKET_SEARCH_URL in .env after manual filtering
//
// .env:
//   PROXY_URL=http://user:pass@us-proxy-host:port   (US proxy strongly recommended)
//   OFFMARKET_SEARCH_URL=https://www.offmarket.com/listing-category/residential/
//                        (or the filtered URL from your browser after choosing Ohio + $300k max)
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
} from "./offmarket.parser";
import * as fs from "fs";
import * as path from "path";

const HOME_URL = "https://www.offmarket.com";
const AJAX_URL = "https://www.offmarket.com/wp-admin/admin-ajax.php";

// The confirmed working URL from the real HTML
const DEFAULT_SEARCH_URL =
  process.env.OFFMARKET_SEARCH_URL ||
  "https://www.offmarket.com/listing-category/residential/";

const DETAIL_DELAY_MS = 4_000;
const MAX_RETRIES = 3;

export class OffmarketScraper extends BaseScraper {
  readonly sourceName = "offmarket";

  private cookiesWarmed = false;

  constructor(options: ScraperOptions = {}) {
    super(options);

    if (!process.env.PROXY_URL) {
      logger.warn(
        "[offmarket] ⚠️  No PROXY_URL — offmarket.com may geo-block non-US IPs.\n" +
          "  Add: PROXY_URL=http://user:pass@us-host:port",
      );
    }

    logger.info(`[offmarket] Search URL: ${DEFAULT_SEARCH_URL}`);
  }

  // ── Cookie + session warm-up ──────────────────────────────────────────────

  private async warmSession(page: Page): Promise<void> {
    logger.info("[offmarket] Warming session…");
    try {
      // Visit homepage first
      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await sleep(4000 + Math.random() * 2000);
      for (const y of [300, 600, 400, 0]) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(300 + Math.random() * 200);
      }

      // Visit category index before the target page
      try {
        await page.goto(
          "https://www.offmarket.com/listing-category/real-estate/",
          {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          },
        );
        await sleep(3000 + Math.random() * 2000);
      } catch {
        // non-fatal
      }

      // Buffer before hitting the listing page
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
    if (lower.includes("too many requests") || lower.includes("rate-limited")) {
      return "rate_limit";
    }
    if (
      lower.includes("wordfence") ||
      lower.includes("your access to this site has been limited") ||
      lower.includes("access from your area has been temporarily limited")
    ) {
      return "wordfence";
    }
    return "none";
  }

  // ── Fetch search page ──────────────────────────────────────────────────────

  private async fetchSearchPage(
    page: Page,
    url: string,
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        // Wait for ListingPro cards
        try {
          await page.waitForSelector("[data-posturl]", { timeout: 15_000 });
        } catch {
          // may be empty or end of results
        }

        // Gentle scroll to trigger lazy load
        for (const y of [400, 900, 1400, 900, 400]) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          await sleep(250 + Math.random() * 250);
        }
        await sleep(1500);

        const html = await page.content();
        const blockType = this.detectBlock(html);

        if (blockType === "wordfence") {
          logger.error(
            "[offmarket] ❌ Wordfence block. Your proxy IP is not a valid US residential IP.\n" +
              "  Fix: PROXY_URL=http://user:pass@us-residential-host:port",
          );
          this.saveDebug(html, "wordfence_block");
          return null;
        }

        if (blockType === "rate_limit") {
          const wait = 90_000 * attempt;
          logger.warn(
            `[offmarket] 429 rate limit on attempt ${attempt}. Waiting ${wait / 1000}s…`,
          );
          this.saveDebug(html, `rate_limit_${attempt}`);
          if (attempt < MAX_RETRIES) await sleep(wait);
          continue;
        }

        return html;
      } catch (err) {
        logger.warn(
          `[offmarket] Fetch attempt ${attempt}/${MAX_RETRIES}: ${err}`,
        );
        if (attempt < MAX_RETRIES) await sleep(5000 * attempt);
      }
    }
    return null;
  }

  // ── AJAX Load More ─────────────────────────────────────────────────────────
  // offmarket.com paginates via ListingPro's AJAX endpoint.
  // We POST to wp-admin/admin-ajax.php with the nonce + listed IDs.

  private async fetchLoadMore(
    page: Page,
    nonce: string,
    listedIds: string,
    ajaxPage: number,
    termId: string,
  ): Promise<string | null> {
    logger.info(`[offmarket] AJAX Load More — page ${ajaxPage}`);

    try {
      // Use Playwright's evaluate to POST via fetch() inside the browser context
      // (so session cookies are automatically included)
      const result = await page.evaluate(
        async ({ url, nonce, listedIds, ajaxPage, termId }) => {
          const body = new URLSearchParams({
            action: "ajax_listing_load_more",
            nonce,
            listed_listing_id: listedIds,
            page: String(ajaxPage),
            term_id: termId,
          });
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body.toString(),
            });
            return res.ok ? await res.text() : null;
          } catch {
            return null;
          }
        },
        { url: AJAX_URL, nonce, listedIds, ajaxPage, termId },
      );

      if (!result) {
        logger.warn("[offmarket] AJAX Load More returned null");
        return null;
      }

      logger.debug(`[offmarket] AJAX response length: ${result.length}`);
      return result;
    } catch (err) {
      logger.warn(`[offmarket] AJAX Load More error: ${err}`);
      return null;
    }
  }

  // ── BaseScraper implementation ─────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number,
  ): Promise<RawListing[]> {
    // Page 1: navigate to the search URL and parse what's there
    // Pages 2+: use AJAX Load More to get additional cards
    const page = await handle.newPage();

    try {
      if (!this.cookiesWarmed) {
        await this.warmSession(page);
      }

      if (pageNumber === 1) {
        logger.info(`[offmarket] Fetching page 1: ${DEFAULT_SEARCH_URL}`);
        await sleep(3000 + Math.random() * 2000);

        const html = await this.fetchSearchPage(page, DEFAULT_SEARCH_URL);
        if (!html) return [];

        this.saveDebug(html, "page_1");
        const items = parseOffmarketSearchPage(html);
        logger.info(`[offmarket] Page 1: ${items.length} listings parsed`);

        // Store pagination metadata for use in page 2+
        const pagInfo = extractPaginationInfo(html);
        logger.info(
          `[offmarket] Total available: ${pagInfo.totalRecords} | ` +
            `Shown: ${items.length} | Has more: ${pagInfo.hasMore}`,
        );

        // Store on instance for subsequent pages
        (this as any)._pagInfo = pagInfo;
        (this as any)._page = page; // keep page open for AJAX calls

        const enriched = await this.enrichListings(handle, items);
        return enriched;
      }

      // Pages 2+ — AJAX
      const pagInfo = (this as any)._pagInfo;
      const existingPage: Page | null = (this as any)._page ?? null;

      if (!pagInfo?.hasMore) {
        logger.info("[offmarket] No more pages (Load More not present)");
        return [];
      }

      // Derive term_id from the original page's hidden input
      const termId = "53"; // Residential category — confirmed from the HTML: value="53"

      const ajaxPage = pagInfo.loadMorePage + (pageNumber - 1);
      const ajaxHtml = await this.fetchLoadMore(
        existingPage ?? page,
        pagInfo.randNumber,
        pagInfo.listedIds,
        ajaxPage,
        termId,
      );

      if (!ajaxHtml) return [];

      this.saveDebug(ajaxHtml, `ajax_page_${pageNumber}`);
      // AJAX response is raw HTML fragments — wrap in a container for parsing
      const wrappedHtml = `<html><body><div id="content-grids">${ajaxHtml}</div></body></html>`;
      const items = parseOffmarketSearchPage(wrappedHtml);
      logger.info(
        `[offmarket] AJAX page ${pageNumber}: ${items.length} listings`,
      );

      return this.enrichListings(handle, items);
    } finally {
      // Don't close page on page 1 — we keep it for AJAX calls
      if (pageNumber > 1) {
        await page.close().catch(() => {});
      }
    }
  }

  // ── Enrich listings with detail pages ─────────────────────────────────────

  private async enrichListings(
    handle: BrowserHandle,
    rawItems: Omit<RawListing, "source">[],
  ): Promise<RawListing[]> {
    const enriched: RawListing[] = [];

    for (const item of rawItems) {
      if (this.results.length + enriched.length >= this.options.maxListings)
        break;

      let detail = {};
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

      enriched.push({ source: this.sourceName, ...detail, ...item });
    }

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
        "utf-8",
      );
      logger.debug(`[offmarket] Debug → logs/offmarket_${label}.html`);
    } catch {
      // non-critical
    }
  }
}
