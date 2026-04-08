// src/scrapers/craigslist/craigslist.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// To add a new Craigslist city, just call:
//   new CraigslistScraper("https://cleveland.craigslist.org/search/rea")
// Everything else is handled by the base class and the runner.
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import {
  parseCraigslistSearchPage,
  parseCraigslistDetailPage,
} from "./craigslist.parser";

const PER_PAGE = 120; // Craigslist shows 120 results per offset
const MAX_RETRIES = 3;

export class CraigslistScraper extends BaseScraper {
  readonly sourceName: string;
  private readonly baseUrl: string;

  constructor(baseUrl: string, options: ScraperOptions = {}) {
    super(options);
    this.baseUrl = baseUrl.split("?")[0]; // strip any existing query string
    // Derive a readable source name from the subdomain, e.g. "craigslist_milwaukee"
    const subdomain =
      new URL(baseUrl).hostname.split(".")[0] ?? "craigslist";
    this.sourceName = `craigslist_${subdomain}`;
  }

  // ── Page URL ────────────────────────────────────────────────────────────

  private buildPageUrl(pageNumber: number): string {
    const offset = (pageNumber - 1) * PER_PAGE;
    return `${this.baseUrl}?s=${offset}`;
  }

  // ── Fetch with retry ────────────────────────────────────────────────────

  private async fetchWithRetry(
    browserPage: Page,
    url: string
  ): Promise<string> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await browserPage.goto(url, {
          timeout: 90_000,
          waitUntil: "domcontentloaded",
        });

        // Human-like scroll
        await browserPage.mouse.wheel(0, 600);
        await sleep(500 + Math.random() * 800);
        await browserPage.mouse.wheel(0, -600);

        const html = await browserPage.content();

        // Block detection
        const lower = html.toLowerCase();
        const blocked =
          lower.includes("your ip has been blocked") ||
          lower.includes("access denied") ||
          (lower.includes("403 forbidden") && html.length < 2000) ||
          (html.length < 500 &&
            (lower.includes("blocked") || lower.includes("forbidden")));

        if (blocked) {
          logger.warn(`[${this.sourceName}] Blocked on attempt ${attempt}: ${url}`);
          if (attempt < MAX_RETRIES) await sleep(5000 * attempt);
          continue;
        }

        return html;
      } catch (err) {
        logger.warn(
          `[${this.sourceName}] Fetch error attempt ${attempt}/${MAX_RETRIES}: ${err}`
        );
        if (attempt < MAX_RETRIES) await sleep(3000 * attempt);
      }
    }
    throw new Error(`[${this.sourceName}] All ${MAX_RETRIES} fetch attempts failed for ${url}`);
  }

  // ── BaseScraper implementation ───────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    const url = this.buildPageUrl(pageNumber);
    const browserPage = await handle.newPage();

    try {
      const html = await this.fetchWithRetry(browserPage, url);
      const rawItems = parseCraigslistSearchPage(html, this.baseUrl);

      if (rawItems.length === 0) return [];

      // Fetch detail pages for enrichment (beds/baths/address)
      const enriched: RawListing[] = [];
      for (const item of rawItems) {
        // Skip detail fetch if we'd blow past the listing limit
        if (this.results.length + enriched.length >= this.options.maxListings) {
          break;
        }

        let detail = {};
        try {
          const detailHtml = await this.fetchWithRetry(browserPage, item.url);
          detail = parseCraigslistDetailPage(detailHtml);
        } catch (err) {
          logger.debug(
            `[${this.sourceName}] Could not fetch detail for ${item.url}: ${err}`
          );
        }

        const itemFields = item;
        enriched.push({
          ...detail,
          ...itemFields,
          source: this.sourceName,
        });

        await sleep(800 + Math.random() * 1200); // polite inter-detail delay
      }

      return enriched;
    } finally {
      await browserPage.close();
    }
  }

  // If the page returned 0 items, we've hit the end of results
  protected hasMorePages(
    _pageNumber: number,
    lastPageResults: RawListing[]
  ): boolean {
    return lastPageResults.length > 0;
  }
}
