// src/scrapers/offmarket/offmarket.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// offmarket.com — WordPress/ListingPro theme site with Wordfence + rate limiting.
//
// The real listing URL is /listing-category/real-estate/ (found in site nav).
// Cards use the ListingPro theme class: .classic-view-grid-container
//
// Requirements:
//   1. US proxy recommended — set PROXY_URL in .env
//   2. OFFMARKET_SEARCH_URL in .env — paste the URL from your browser after
//      filtering Ohio + max price. Without it, the scraper tries known URLs.
//
// .env additions:
//   PROXY_URL=http://user:pass@us-host:port
//   OFFMARKET_SEARCH_URL=https://www.offmarket.com/listing-category/real-estate/?...
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import {
  parseOffmarketSearchPage,
  parseOffmarketDetailPage,
} from "./offmarket.parser";
import * as fs from "fs";
import * as path from "path";

const HOME_URL = "https://www.offmarket.com";

// Correct URLs discovered from site navigation HTML.
// The site uses /listing-category/ not /real-estate/ or /search/
const SEARCH_URL_CANDIDATES = [
  // Ohio residential listings (primary target)
  "https://www.offmarket.com/listing-category/residential/?state_field=Ohio",
  "https://www.offmarket.com/listing-category/real-estate/?state_field=Ohio",
  "https://www.offmarket.com/listing-category/residential/",
  "https://www.offmarket.com/listing-category/real-estate/",
  // Milwaukee fallback
  "https://www.offmarket.com/listing-category/residential/?state_field=Wisconsin",
];

// Generous delay between candidate attempts — site rate-limits aggressively
const CANDIDATE_DELAY_MS = 20_000;
const DETAIL_DELAY_MS = 4_000;
const MAX_RETRIES = 3;

export class OffmarketScraper extends BaseScraper {
  readonly sourceName = "offmarket";

  private cookiesWarmed = false;
  private confirmedSearchUrl: string | null = null;

  constructor(options: ScraperOptions = {}) {
    super(options);

    if (!process.env.PROXY_URL) {
      logger.warn(
        "[offmarket] ⚠️  No PROXY_URL set. offmarket.com may geo-block non-US IPs.\n" +
          "  Add to .env: PROXY_URL=http://user:pass@us-proxy-host:port",
      );
    }
    const OFFMARKET_SEARCH_URL =
      "https://www.offmarket.com/listing-category/residential/";
    if (OFFMARKET_SEARCH_URL) {
      this.confirmedSearchUrl = OFFMARKET_SEARCH_URL;
      logger.info(
        `[offmarket] Using OFFMARKET_SEARCH_URL from .env: ${this.confirmedSearchUrl}`,
      );
    } else {
      logger.warn(
        "[offmarket] OFFMARKET_SEARCH_URL not set.\n" +
          "  Will try candidate URLs with 20s delays between each.\n" +
          "  For reliable runs: visit offmarket.com, filter by Ohio, copy the URL,\n" +
          "  and add OFFMARKET_SEARCH_URL=<url> to .env.",
      );
    }
  }

  // ── Cookie warming ──────────────────────────────────────────────────────────

  private async warmCookies(page: Page): Promise<void> {
    logger.info("[offmarket] Warming session via homepage…");
    try {
      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await sleep(5000 + Math.random() * 3000);

      // Scroll the homepage like a real visitor
      for (const y of [300, 700, 1200, 900, 400, 0]) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(400 + Math.random() * 300);
      }

      // Visit one intermediate page before jumping to the filtered listing page.
      // Real users navigate — they don't deep-link. Wordfence scores request patterns.
      logger.debug("[offmarket] Warming interior nav page…");
      try {
        await page.goto("https://www.offmarket.com/listing-category/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await sleep(4000 + Math.random() * 3000);
        for (const y of [300, 600, 300, 0]) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          await sleep(300 + Math.random() * 200);
        }
      } catch {
        // non-fatal — continue even if this page 404s
      }

      // Longer post-warm buffer before the caller hits the real listing URL
      const extraWait = 8000 + Math.random() * 7000; // 8–15s
      logger.debug(
        `[offmarket] Post-warm buffer: ${Math.round(extraWait / 1000)}s`,
      );
      await sleep(extraWait);

      this.cookiesWarmed = true;
      logger.debug("[offmarket] Session warmed");
    } catch (err) {
      logger.warn(`[offmarket] Cookie warm failed (non-fatal): ${err}`);
    }
  }

  // ── Block detection ─────────────────────────────────────────────────────────

  private detectBlock(
    html: string,
  ): "wordfence" | "rate_limit" | "captcha" | "not_found" | "none" {
    const lower = html.toLowerCase();
    if (
      lower.includes("too many requests") ||
      lower.includes("rate-limited") ||
      lower.includes("rate limited")
    ) {
      return "rate_limit";
    }
    if (
      lower.includes("wordfence") ||
      lower.includes("your access to this site has been limited")
    ) {
      return "wordfence";
    }
    if (
      lower.includes("captcha") ||
      lower.includes("are you human") ||
      lower.includes("recaptcha")
    ) {
      // Check if it's a real captcha challenge vs just a page that has recaptcha loaded
      if (
        (lower.includes("captcha") && lower.includes("challenge")) ||
        lower.includes("are you human")
      ) {
        return "captcha";
      }
    }
    if (
      (lower.includes("404") && lower.includes("page not found")) ||
      lower.includes("ooops, ghost here")
    ) {
      return "not_found";
    }
    return "none";
  }

  // ── URL discovery ───────────────────────────────────────────────────────────

  private async discoverSearchUrl(page: Page): Promise<string | null> {
    logger.info(
      `[offmarket] Trying ${SEARCH_URL_CANDIDATES.length} candidate URLs with ${CANDIDATE_DELAY_MS / 1000}s delays…`,
    );

    for (let i = 0; i < SEARCH_URL_CANDIDATES.length; i++) {
      const url = SEARCH_URL_CANDIDATES[i];

      if (i > 0) {
        logger.info(
          `[offmarket] Waiting ${CANDIDATE_DELAY_MS / 1000}s before next candidate…`,
        );
        await sleep(CANDIDATE_DELAY_MS);
      }

      logger.info(
        `[offmarket] Trying candidate ${i + 1}/${SEARCH_URL_CANDIDATES.length}: ${url}`,
      );

      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await sleep(3000 + Math.random() * 2000);

        // Scroll to trigger lazy content
        for (const y of [400, 800, 1200, 800, 400]) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          await sleep(300);
        }

        const html = await page.content();
        const blockType = this.detectBlock(html);
        this.saveDebug(html, `candidate_${i}_${blockType}`);

        if (blockType === "rate_limit") {
          logger.warn(
            `[offmarket] 429 rate limited on candidate ${i + 1}. Waiting 90s…`,
          );
          await sleep(90_000);
          // Retry once after backoff
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await sleep(4000);
          const retryHtml = await page.content();
          if (this.detectBlock(retryHtml) !== "none") {
            logger.warn("[offmarket] Still blocked after retry, skipping");
            continue;
          }
          const items = parseOffmarketSearchPage(retryHtml);
          if (items.length > 0) {
            logger.info(
              `[offmarket] ✓ Working URL after retry: ${url} (${items.length} listings)`,
            );
            this.saveDebug(retryHtml, "page_1_confirmed");
            return url;
          }
          continue;
        }

        if (blockType === "wordfence") {
          logger.error(
            "[offmarket] ❌ Wordfence geo-block. Switch to a US residential proxy.\n" +
              `  Debug: logs/offmarket_candidate_${i}_wordfence.html`,
          );
          return null;
        }

        if (blockType === "not_found") {
          logger.debug(
            `[offmarket] 404 on candidate ${i + 1} — URL doesn't exist on this site`,
          );
          continue;
        }

        if (blockType === "captcha") {
          logger.warn(
            `[offmarket] CAPTCHA challenge on candidate ${i + 1} — skipping`,
          );
          continue;
        }

        const items = parseOffmarketSearchPage(html);
        if (items.length > 0) {
          logger.info(
            `[offmarket] ✓ Working URL: ${url} (${items.length} listings)`,
          );
          this.saveDebug(html, "page_1_confirmed");
          return url;
        }

        // No listings but no block — log the title so we know what loaded
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        logger.debug(
          `[offmarket] No listings at candidate ${i + 1}. ` +
            `Page title: "${titleMatch?.[1] ?? "unknown"}". ` +
            `See logs/offmarket_candidate_${i}_none.html`,
        );
      } catch (err) {
        logger.debug(
          `[offmarket] Error on candidate ${i + 1} (${url}): ${err}`,
        );
      }
    }

    logger.error(
      "[offmarket] ❌ No working search URL found.\n" +
        "  Action required:\n" +
        "  1. Visit https://www.offmarket.com/listing-category/real-estate/ in your browser\n" +
        "  2. Use the filters to narrow to Ohio / ≤$300k\n" +
        "  3. Copy the resulting URL and add it to .env:\n" +
        "     OFFMARKET_SEARCH_URL=https://www.offmarket.com/listing-category/real-estate/?...\n" +
        "  4. Re-run the scraper",
    );
    return null;
  }

  // ── Fetch with retry ────────────────────────────────────────────────────────
  // FIX: accepts a Page, but callers are responsible for the page's lifecycle.
  // Detail fetches now open their own page via fetchHtmlFresh().

  private async fetchHtml(page: Page, url: string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        try {
          await page.waitForSelector(
            ".classic-view-grid-container, .lp-grid-box-contianer, article.hentry, .lp-listing",
            { timeout: 8_000 },
          );
        } catch {
          // may just be empty results or a detail page
        }

        for (const y of [400, 800, 1200, 800, 400]) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          await sleep(250 + Math.random() * 250);
        }

        const html = await page.content();
        const blockType = this.detectBlock(html);

        if (blockType === "wordfence") {
          logger.error("[offmarket] Wordfence block during scrape");
          return null;
        }
        if (blockType === "rate_limit") {
          // Wordfence blocks last ~60s minimum. 90s / 150s gives headroom.
          const waitMs = attempt === 1 ? 90_000 : 150_000;
          logger.warn(
            `[offmarket] 429 on attempt ${attempt}/${MAX_RETRIES}. ` +
              `Waiting ${waitMs / 1000}s (Wordfence block window)…`,
          );
          if (attempt < MAX_RETRIES) await sleep(waitMs);
          continue;
        }
        if (blockType === "captcha") {
          logger.warn(`[offmarket] CAPTCHA on attempt ${attempt}`);
          if (attempt < MAX_RETRIES) await sleep(15_000);
          continue;
        }

        return html;
      } catch (err) {
        logger.warn(
          `[offmarket] Fetch attempt ${attempt}/${MAX_RETRIES} failed: ${err}`,
        );
        if (attempt < MAX_RETRIES) await sleep(5000 * attempt);
      }
    }
    return null;
  }

  // ── FIX: fresh page per detail fetch ───────────────────────────────────────
  // The root cause of "Target page, context or browser has been closed":
  // The search page was closed in scrapePage's finally{} while parseAndEnrich
  // was still using the same Page object for detail fetches. Now each detail
  // fetch opens its own page and closes it when done, independent of the
  // search page lifecycle.

  private async fetchHtmlFresh(
    handle: BrowserHandle,
    url: string,
  ): Promise<string | null> {
    const page = await handle.newPage();
    try {
      return await this.fetchHtml(page, url);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ── BaseScraper implementation ──────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number,
  ): Promise<RawListing[]> {
    const page = await handle.newPage();

    try {
      if (!this.cookiesWarmed) {
        await this.warmCookies(page);
      }

      if (!this.confirmedSearchUrl) {
        this.confirmedSearchUrl = await this.discoverSearchUrl(page);
        if (!this.confirmedSearchUrl) return [];

        if (pageNumber === 1) {
          const html = await page.content();
          this.saveDebug(html, "page_1");
          // FIX: close search page before detail fetches begin
          await page.close().catch(() => {});
          return this.parseAndEnrich(handle, html, pageNumber);
        }
      } else if (pageNumber === 1) {
        logger.info(`[offmarket] Fetching page 1: ${this.confirmedSearchUrl}`);

        // Guard delay: warmCookies() adds a buffer, but if warming was skipped
        // (cookiesWarmed already true) we still need a small gap so we never
        // hit the listing page cold.
        await sleep(3000 + Math.random() * 2000);

        const html = await this.fetchHtml(page, this.confirmedSearchUrl);
        if (!html) return [];
        this.saveDebug(html, "page_1");
        // FIX: close search page before detail fetches begin
        await page.close().catch(() => {});
        return this.parseAndEnrich(handle, html, pageNumber);
      }

      const pageUrl = this.buildPageUrl(this.confirmedSearchUrl, pageNumber);
      logger.info(`[offmarket] Fetching page ${pageNumber}: ${pageUrl}`);
      await sleep(6000 + Math.random() * 3000);

      const html = await this.fetchHtml(page, pageUrl);
      if (!html) return [];

      this.saveDebug(html, `page_${pageNumber}`);
      // FIX: close search page before detail fetches begin
      await page.close().catch(() => {});
      return this.parseAndEnrich(handle, html, pageNumber);
    } finally {
      // Safe to call close() multiple times — Playwright ignores it if already closed
      await page.close().catch(() => {});
    }
  }

  // ── Parse and enrich ────────────────────────────────────────────────────────
  // FIX: now takes BrowserHandle instead of Page so it can open fresh pages
  // for each detail fetch without depending on the (already-closed) search page.

  private async parseAndEnrich(
    handle: BrowserHandle,
    html: string,
    pageNumber: number,
  ): Promise<RawListing[]> {
    const rawItems = parseOffmarketSearchPage(html);
    logger.info(
      `[offmarket] Page ${pageNumber}: ${rawItems.length} raw listings`,
    );

    if (rawItems.length === 0) {
      logger.info(
        "[offmarket] 0 listings parsed. Check logs/offmarket_page_1.html —\n" +
          "  open it in a browser, find a property card in DevTools,\n" +
          "  and share the class names so the parser can be updated.",
      );
      return [];
    }

    const enriched: RawListing[] = [];
    for (const item of rawItems) {
      if (
        this.results.length + enriched.length >=
        (this.options.maxListings ?? Infinity)
      )
        break;

      let detail = {};
      try {
        await sleep(DETAIL_DELAY_MS + Math.random() * 2000);
        // FIX: open a brand-new page for every detail fetch
        const detailHtml = await this.fetchHtmlFresh(handle, item.url);
        if (detailHtml) {
          detail = parseOffmarketDetailPage(detailHtml);
          logger.debug(`[offmarket] Enriched: ${item.url}`);
        }
      } catch (err) {
        logger.debug(`[offmarket] Detail failed for ${item.url}: ${err}`);
      }

      enriched.push({ source: this.sourceName, ...detail, ...item });
    }

    return enriched;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private buildPageUrl(baseUrl: string, pageNumber: number): string {
    const url = new URL(baseUrl);
    if (pageNumber > 1) url.searchParams.set("page", String(pageNumber));
    return url.toString();
  }

  private saveDebug(html: string, label: string): void {
    try {
      const logDir = path.resolve(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      if (html) {
        fs.writeFileSync(
          path.join(logDir, `offmarket_${label}.html`),
          html,
          "utf-8",
        );
      }
      logger.debug(`[offmarket] Debug → logs/offmarket_${label}.html`);
    } catch {
      // non-critical
    }
  }
}
