// src/scrapers/zillow/zillow.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Zillow scraper stub — shows exactly what you implement to add a new source.
// Only scrapePage() needs to be filled in; all filtering, dedup, DB storage,
// and pagination are handled by BaseScraper + the runner.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import * as cheerio from "cheerio";

export class ZillowScraper extends BaseScraper {
  readonly sourceName = "zillow";

  private readonly baseUrl: string;
  private readonly queryState: string;

  constructor(baseUrl: string, options: ScraperOptions = {}) {
    super(options);
    const parsed = new URL(baseUrl);
    this.baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    this.queryState = parsed.searchParams.get("searchQueryState") ?? "";
  }

  private buildPageUrl(page: number): string {
    const qs = new URLSearchParams({
      searchQueryState: this.queryState,
      currentPage: String(page),
    });
    return `${this.baseUrl}?${qs.toString()}`;
  }

  // ── __NEXT_DATA__ extraction ─────────────────────────────────────────────

  private extractNextData(html: string): Record<string, unknown> {
    const $ = cheerio.load(html);
    const script = $('script#__NEXT_DATA__').html();
    if (!script) return {};
    try {
      return JSON.parse(script) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private isBotWall(html: string): boolean {
    const $ = cheerio.load(html);
    const hasNextData = $('script#__NEXT_DATA__').length > 0;
    if (hasNextData) return false;
    const lower = html.toLowerCase();
    return (
      lower.includes("captcha") ||
      lower.includes("are you a human") ||
      lower.includes("access denied") ||
      html.length < 2000
    );
  }

  // ── BaseScraper implementation ───────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    const url = this.buildPageUrl(pageNumber);
    const page = await handle.newPage();

    try {
      await page.goto(url, { timeout: 120_000, waitUntil: "domcontentloaded" });

      try {
        await page.waitForSelector('script#__NEXT_DATA__', { timeout: 30_000 });
      } catch {
        // parse whatever loaded
      }

      // Gentle human-like scroll
      for (const y of [300, 700, 1100, 1500, 1100, 700]) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(200 + Math.random() * 400);
      }

      const html = await page.content();

      if (this.isBotWall(html)) {
        logger.warn(`[${this.sourceName}] Bot wall on page ${pageNumber}`);
        return [];
      }

      const data = this.extractNextData(html);

      // Navigate the Zillow JSON tree
      const pageProps = (data as any)?.props?.pageProps ?? {};
      const listResults: unknown[] =
        pageProps?.searchPageState?.cat1?.searchResults?.listResults ??
        pageProps?.initialData?.cat1?.searchResults?.listResults ??
        [];

      logger.debug(`[${this.sourceName}] __NEXT_DATA__ yielded ${listResults.length} items`);

      return listResults
        .filter((item: any) => item?.detailUrl || item?.hdpData)
        .map((item: any): RawListing => {
          const hdp = item?.hdpData?.homeInfo ?? {};
          let itemUrl: string = item?.detailUrl ?? "";
          if (itemUrl && !itemUrl.startsWith("http")) {
            itemUrl = `https://www.zillow.com${itemUrl}`;
          }

          let price: number | undefined;
          const priceRaw = item?.price ?? item?.unformattedPrice;
          if (typeof priceRaw === "number") price = priceRaw;
          else if (typeof priceRaw === "string") {
            const m = priceRaw.replace(/[$,]/g, "").match(/\d+/);
            if (m) price = parseInt(m[0], 10);
          }

          return {
            url: itemUrl,
            source: this.sourceName,
            title: item?.address ?? hdp?.streetAddress,
            address: item?.address ?? hdp?.streetAddress,
            price,
            location: [item?.addressCity, item?.addressState]
              .filter(Boolean)
              .join(", ") || undefined,
            bedrooms: item?.beds ?? hdp?.bedrooms,
            bathrooms: item?.baths ?? hdp?.bathrooms,
            squareFeet: item?.area ?? hdp?.livingArea,
            propertyType: this.normalizePropertyType(hdp?.homeType),
            zestimate: hdp?.zestimate,
          };
        });
    } finally {
      await page.close();
    }
  }
}
