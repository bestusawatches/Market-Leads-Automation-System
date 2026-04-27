// src/scrapers/investorlift/investorlift.scraper.ts

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseApiResponse, parseDomListings } from "./investorlift.parser";

const MARKETPLACE_URL = "https://investorlift.com/marketplace/";

export class InvestorLiftScraper extends BaseScraper {
  readonly sourceName = "investorlift";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number,
  ): Promise<RawListing[]> {
    const page = await handle.newPage();

    const seenUrls = new Set<string>();
    const apiListings: RawListing[] = [];
    const responsePromises: Promise<void>[] = [];

    try {
      logger.info(`[investorlift] Opening marketplace (API mode)`);

      // ── INTERCEPT API RESPONSES ──────────────────────────────────────
      // IMPORTANT: the handler must be synchronous. Awaiting response.json()
      // inside it causes the promise to outlive networkidle, so results are
      // never ready when we check apiListings. Collect promises; settle later.
      page.on("response", (response) => {
        const url = response.url();

        if (
          !url.includes("/api") &&
          !url.includes("properties") &&
          !url.includes("marketplace")
        )
          return;

        const contentType = response.headers()["content-type"] || "";
        if (!contentType.includes("application/json")) return;

        const p = response
          .json()
          .then((json) => {
            const parsed = parseApiResponse(json, this.sourceName);
            if (parsed.length > 0) {
              logger.info(`[investorlift] API hit → ${parsed.length} listings`);
            }
            for (const listing of parsed) {
              if (!listing.url || seenUrls.has(listing.url)) continue;
              seenUrls.add(listing.url);
              apiListings.push(listing);
            }
          })
          .catch(() => {
            /* ignore non-JSON / network errors */
          });

        responsePromises.push(p);
      });

      // ── LOAD PAGE ────────────────────────────────────────────────────
      await page.goto(MARKETPLACE_URL, {
        waitUntil: "networkidle",
        timeout: 60_000,
      });

      // ── SCROLL TO TRIGGER PAGINATION API CALLS ───────────────────────
      for (let i = 0; i < 5; i++) {
        logger.info(`[investorlift] Scrolling batch ${i + 1}`);
        await page.mouse.wheel(0, 5000);
        await sleep(2000);
      }

      // ── WAIT FOR ALL IN-FLIGHT JSON PROMISES TO SETTLE ───────────────
      // Sleep first: the last scroll fires XHRs slightly after the loop
      // exits, so we must let them land before snapshotting the queue.
      await sleep(3000);
      // Snapshot with spread to avoid the live-array race — Promise.allSettled
      // reads array length at call time, so any promise pushed after this line
      // (but before the microtask runs) would be missed without the snapshot.
      await Promise.allSettled([...responsePromises]);

      // ── RETURN API RESULTS IF WE GOT ANY ─────────────────────────────
      if (apiListings.length > 0) {
        logger.info(
          `[investorlift] Collected ${apiListings.length} listings from API`,
        );
        return apiListings;
      }

      // ── FALLBACK TO DOM ──────────────────────────────────────────────
      logger.warn(`[investorlift] No API data captured — falling back to DOM`);
      const html = await page.content();
      return parseDomListings(html, this.sourceName);
    } finally {
      await page.close();
    }
  }
}
