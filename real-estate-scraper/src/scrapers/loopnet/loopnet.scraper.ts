// src/scrapers/loopnet/loopnet.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// LoopNet scraper
//
// LoopNet (owned by CoStar) is aggressively bot-protected:
//   • Cloudflare + CoStar's own fingerprinting layer
//   • Headless browser detection via navigator.webdriver
//   • Residential proxy strongly recommended (datacenter IPs are blocked)
//
// Page structure:
//   • Search results are server-side rendered (not a SPA like Crexi)
//   • Each listing card is an <article> or <li> element
//   • Structured data is embedded as JSON-LD in <script type="application/ld+json">
//   • Pagination via ?page=N query param
//
// URL format:
//   https://www.loopnet.com/search/{property-type}/{location}/for-sale/
//   https://www.loopnet.com/search/{property-type}/{location}/for-sale/?page=2
//
// Examples:
//   https://www.loopnet.com/search/multifamily-properties/oh/for-sale/
//   https://www.loopnet.com/search/apartment-buildings/oh/for-sale/
//   https://www.loopnet.com/search/multifamily-properties/cleveland-oh/for-sale/
//   https://www.loopnet.com/search/multifamily-properties/milwaukee-wi/for-sale/
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseLoopNetListings } from "./loopnet.parser";
import { config } from "../../config";
import * as fs from "fs";
import * as path from "path";

// ── Config ─────────────────────────────────────────────────────────────────

const SEARCH_URLS: string[] = config.sources.loopnet.searchUrls;
const MAX_PAGES_PER_URL: number = config.sources.loopnet.maxPagesPerUrl;

// ── Scraper ────────────────────────────────────────────────────────────────

export class LoopNetScraper extends BaseScraper {
  readonly sourceName = "loopnet";

  constructor(options: ScraperOptions = {}) {
    super(options);
    logger.info(
      `[loopnet] ${SEARCH_URLS.length} target URL(s), up to ${MAX_PAGES_PER_URL} page(s) each:\n` +
        SEARCH_URLS.map((u) => `  • ${u}`).join("\n")
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Anti-bot evasion setup
  // ─────────────────────────────────────────────────────────────

  private async setupPage(page: Page): Promise<void> {
    // Override navigator.webdriver — the #1 headless browser detection signal
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Spoof plugins array (empty in headless)
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      // Spoof languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    });

    // Realistic browser headers
    await page.setExtraHTTPHeaders({
      "Accept-Language":          "en-US,en;q=0.9",
      "Accept":                   "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding":          "gzip, deflate, br",
      "Sec-Fetch-Dest":           "document",
      "Sec-Fetch-Mode":           "navigate",
      "Sec-Fetch-Site":           "none",
      "Sec-Fetch-User":           "?1",
      "Upgrade-Insecure-Requests":"1",
      "Cache-Control":            "max-age=0",
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Check if LoopNet blocked us (Cloudflare / access denied page)
  // ─────────────────────────────────────────────────────────────

  private isBlocked(html: string, url: string): boolean {
    const lower = html.toLowerCase();
    if (
      lower.includes("access denied") ||
      lower.includes("cloudflare") ||
      lower.includes("ray id") ||
      lower.includes("please enable cookies") ||
      lower.includes("checking your browser") ||
      lower.includes("enable javascript and cookies") ||
      url.includes("blocked") ||
      url.includes("captcha")
    ) {
      return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Wait for listing cards to appear
  // ─────────────────────────────────────────────────────────────

  private async waitForCards(page: Page): Promise<boolean> {
    const selectors = [
      // LoopNet's main listing card containers
      "[data-testid='listing-card']",
      "article.listingCard",
      "article[class*='listing']",
      "li[class*='listingCard']",
      "li[class*='listing-card']",
      // Fallback: any link to a /Listing/ page
      "a[href*='/Listing/']",
    ];

    for (const sel of selectors) {
      try {
        await page.waitForSelector(sel, { timeout: 12_000 });
        logger.info(`[loopnet] Cards detected via: ${sel}`);
        return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Scrape a single paginated page of results
  // ─────────────────────────────────────────────────────────────

  private async scrapeSinglePage(
    page: Page,
    url: string,
    pageNum: number
  ): Promise<{ listings: RawListing[]; hasMore: boolean }> {
    const pageUrl = pageNum > 1 ? `${url}?page=${pageNum}` : url;
    logger.info(`[loopnet] Fetching: ${pageUrl}`);

    try {
      await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      // Human-like pause after navigation
      await sleep(2500 + Math.random() * 1500);

      const currentUrl = page.url();
      const html       = await page.content();

      // Check for block page
      if (this.isBlocked(html, currentUrl)) {
        logger.warn(`[loopnet] Blocked on page ${pageNum} of ${url} — stopping pagination`);
        this.saveDebug(html, `blocked_p${pageNum}_${this.slugify(url)}`);
        return { listings: [], hasMore: false };
      }

      // Wait for card elements
      const cardsFound = await this.waitForCards(page);
      if (!cardsFound) {
        const noResults =
          html.includes("Your search did not match") ||
          html.includes("no properties") ||
          html.includes("0 properties");

        if (noResults || pageNum > 1) {
          logger.info(`[loopnet] No more results at page ${pageNum}`);
          return { listings: [], hasMore: false };
        }

        logger.warn(`[loopnet] No cards found on page ${pageNum} — saving debug`);
        this.saveDebug(html, `no_cards_p${pageNum}_${this.slugify(url)}`);
        return { listings: [], hasMore: false };
      }

      // Scroll to trigger lazy-loaded images / any deferred content
      await page.evaluate("window.scrollBy(0, 600)");
      await sleep(800);
      await page.evaluate("window.scrollTo(0, 0)");
      await sleep(400);

      const finalHtml = await page.content();
      this.saveDebug(finalHtml, `page_${pageNum}_${this.slugify(url)}`);

      const listings = parseLoopNetListings(finalHtml, url, "loopnet");

      // Determine if there's a next page
      const hasMore =
        listings.length > 0 &&
        pageNum < MAX_PAGES_PER_URL &&
        (finalHtml.includes(`page=${pageNum + 1}`) ||
          finalHtml.includes('aria-label="Next"') ||
          finalHtml.includes('rel="next"'));

      logger.info(
        `[loopnet] Page ${pageNum}: ${listings.length} listings | hasMore: ${hasMore}`
      );
      return { listings, hasMore };
    } catch (err: any) {
      logger.error(`[loopnet] Error on ${pageUrl}: ${err.message}`);
      this.saveDebug(await page.content().catch(() => ""), `error_p${pageNum}`);
      return { listings: [], hasMore: false };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Scrape all pages for a single search URL
  // ─────────────────────────────────────────────────────────────

  private async scrapeSearchUrl(
    page: Page,
    searchUrl: string
  ): Promise<RawListing[]> {
    const allListings: RawListing[] = [];

    for (let pageNum = 1; pageNum <= MAX_PAGES_PER_URL; pageNum++) {
      const { listings, hasMore } = await this.scrapeSinglePage(
        page,
        searchUrl,
        pageNum
      );
      allListings.push(...listings);

      if (!hasMore) break;

      // Respectful pause between pages
      const pause = 3000 + Math.random() * 2000;
      logger.info(`[loopnet] Pausing ${Math.round(pause / 1000)}s before page ${pageNum + 1}…`);
      await sleep(pause);
    }

    return allListings;
  }

  // ─────────────────────────────────────────────────────────────
  // Main scrape — all URLs in one browser session
  // ─────────────────────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (pageNumber !== 1) return [];

    // Create a fresh context for LoopNet
    // The proxy is already set at the browser level by BaseScraper/BrowserHandle
    const context = await handle.browser.newContext({
      viewport:   { width: 1440, height: 900 },
      locale:     "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    await this.setupPage(page);

    const allListings: RawListing[] = [];

    try {
      for (let i = 0; i < SEARCH_URLS.length; i++) {
        const url = SEARCH_URLS[i];
        logger.info(`[loopnet] ── URL ${i + 1}/${SEARCH_URLS.length}: ${url}`);

        const listings = await this.scrapeSearchUrl(page, url);
        allListings.push(...listings);
        logger.info(`[loopnet] ${url} → ${listings.length} listings`);

        if (i < SEARCH_URLS.length - 1) {
          const pause = 4000 + Math.random() * 3000;
          logger.info(`[loopnet] Pausing ${Math.round(pause / 1000)}s before next URL…`);
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

      logger.info(`[loopnet] Total: ${deduped.length} unique listings across all URLs`);
      return deduped;
    } finally {
      await context.close();
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private slugify(url: string): string {
    return url
      .replace(/https?:\/\/[^/]+\/search\//, "")
      .replace(/\//g, "_")
      .slice(0, 50);
  }

  private saveDebug(html: string, label: string) {
    try {
      const dir = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `loopnet_${label}.html`), html);
    } catch {}
  }
}