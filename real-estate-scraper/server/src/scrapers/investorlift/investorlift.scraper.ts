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

  /**
   * InvestorLift blocks proxy headers (X-Forwarded-For, Via, etc.)
   * and returns blank pages or empty API responses when detected.
   * Bypass the proxy entirely and connect directly.
   */
  protected getEffectiveProxy(): string | null {
    logger.info(
      `[investorlift] Proxy explicitly disabled — connecting direct to bypass proxy header detection`,
    );
    return null;
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

        logger.debug(`[investorlift] Intercepted JSON response: ${url}`);

        const p = response
          .json()
          .then((json) => {
            const parsed = parseApiResponse(json, this.sourceName);
            if (parsed.length > 0) {
              logger.info(
                `[investorlift] API hit → ${parsed.length} listings from ${url}`,
              );
            }
            for (const listing of parsed) {
              if (!listing.url || seenUrls.has(listing.url)) continue;
              seenUrls.add(listing.url);
              apiListings.push(listing);
            }
          })
          .catch((err) => {
            logger.debug(
              `[investorlift] Failed to parse response from ${url}: ${err}`,
            );
          });

        responsePromises.push(p);
      });

      // ── LOAD PAGE ────────────────────────────────────────────────────
      await page.goto(MARKETPLACE_URL, {
        waitUntil: "networkidle",
        timeout: 60_000,
      });

      // ── IP BLOCK / CAPTCHA DETECTION ─────────────────────────────────
      // Render's server IP can get soft-blocked after repeated scrapes.
      // Detect this early so logs clearly show the cause of failure.
      const landedUrl = page.url();
      const pageTitle = await page.title();
      logger.info(
        `[investorlift] Landed on: ${landedUrl} | title: "${pageTitle}"`,
      );

      if (
        pageTitle.toLowerCase().includes("access denied") ||
        pageTitle.toLowerCase().includes("captcha") ||
        pageTitle.toLowerCase().includes("just a moment") || // Cloudflare
        pageTitle.toLowerCase().includes("attention required") || // Cloudflare
        landedUrl.includes("challenge") ||
        landedUrl.includes("blocked")
      ) {
        logger.error(
          `[investorlift] IP blocked or CAPTCHA detected — aborting page ${pageNumber}`,
        );
        return [];
      }

      // ── SETTLE PROMISES FROM INITIAL PAGE LOAD ───────────────────────
      // CLI logs show 3294 listings arrive on load BEFORE any scrolling.
      // Settle these first so we can short-circuit and skip the scroll loop
      // when the API responds immediately (the common case).
      await sleep(2000);
      await Promise.allSettled([...responsePromises]);

      if (apiListings.length > 0) {
        logger.info(
          `[investorlift] Got ${apiListings.length} listings from initial page load — skipping scroll`,
        );
        return apiListings;
      }

      // ── SCROLL TO TRIGGER PAGINATION API CALLS ───────────────────────
      // Only reached when the initial load yielded nothing (e.g. slow server,
      // lazy-loaded first batch). Slightly longer per-scroll delay vs before
      // to give XHRs more time to complete on resource-constrained hosts.
      logger.info(
        `[investorlift] No listings on initial load — scrolling to trigger API calls`,
      );
      for (let i = 0; i < 5; i++) {
        logger.info(`[investorlift] Scrolling batch ${i + 1}`);
        await page.mouse.wheel(0, 5000);
        await sleep(2500);
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
          `[investorlift] Collected ${apiListings.length} listings from API (after scroll)`,
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