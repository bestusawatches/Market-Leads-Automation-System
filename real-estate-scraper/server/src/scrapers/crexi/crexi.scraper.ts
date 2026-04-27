// src/scrapers/crexi/crexi.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Crexi.com scraper
//
// Requires a RESIDENTIAL proxy — datacenter IPs are blocked by Cloudflare.
// Set CREXI_PROXY_URL in .env to override the global proxy for this scraper.
// If not set, falls back to the global config proxyUrl.
//
// Anti-bot approach:
//   • playwright-extra + stealth plugin (patches 20+ detection vectors)
//   • Cloudflare challenge auto-wait (waits up to 25s for JS challenge to pass)
//   • API response interception — captures Crexi's XHR JSON before Angular renders
//   • Realistic headers + navigator overrides
//   • Human-like timing with random jitter
//
// NOTE on Cloudflare detection:
//   We intentionally DO NOT treat bare <crx-app> as "Crexi content" — it is
//   always present as an empty Angular shell even on CF challenge pages.
//   Only rendered listing elements (tiles, price, header toolbar) count.
//
// NOTE on Angular hydration:
//   After CF clears we wait for networkidle before polling for tiles, giving
//   Angular time to bootstrap and fire its search XHR. The XHR responses are
//   also intercepted directly so we get JSON data even if tiles render slowly.
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Page, Browser, Response } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseCrxiListings } from "./crexi.parser";
import { config } from "../../config";
import * as fs from "fs";
import * as path from "path";

// Apply stealth plugin — must be done before any launch() call
chromium.use(StealthPlugin());

// ── Config ─────────────────────────────────────────────────────────────────

// Prefer a dedicated residential proxy for Crexi; fall back to global proxy
const CREXI_PROXY_URL =
  process.env.CREXI_PROXY_URL ||
  (config as any).crexiProxyUrl ||
  config.proxyUrl ||
  "";

const SEARCH_URLS: string[] = config.sources.crexi.searchUrls;

const SCROLL_PASSES   = 8;
const SCROLL_STEP     = 900;
const SCROLL_DELAY_MS = 2200;

// How long to wait for Cloudflare to auto-resolve (ms)
const CF_TIMEOUT_MS = 25_000;

// How long to wait for Angular listing tiles to appear after CF clears (ms)
const LISTINGS_WAIT_MS = 45_000;

// Crexi API URL substrings to intercept for JSON data
const CREXI_API_PATTERNS = [
  "api.crexi.com/assets",
  "api.crexi.com/properties",
  "/assets/search",
  "/properties/search",
  "aggregates",
];

export class CrexiScraper extends BaseScraper {
  readonly sourceName = "crexi";

  constructor(options: ScraperOptions = {}) {
    super(options);
    logger.info(
      `[crexi] ${SEARCH_URLS.length} target URL(s):\n` +
        SEARCH_URLS.map((u) => `  • ${u}`).join("\n")
    );
    if (!CREXI_PROXY_URL) {
      logger.warn(
        "[crexi] No proxy configured. Crexi requires a RESIDENTIAL proxy to bypass Cloudflare.\n" +
          "  Set CREXI_PROXY_URL=http://user:pass@host:port in .env"
      );
    } else {
      // Mask credentials in log
      const masked = CREXI_PROXY_URL.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
      logger.info(`[crexi] Using proxy: ${masked}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Launch a dedicated stealth browser for Crexi
  // (separate from the shared BrowserHandle so we control proxy independently)
  // ─────────────────────────────────────────────────────────────────────────

  private async launchBrowser(): Promise<Browser> {
    const launchOptions: any = {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      headless:       true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--window-size=1440,900",
      ],
    };

    if (CREXI_PROXY_URL) {
      launchOptions.proxy = { server: CREXI_PROXY_URL };
    }

    return chromium.launch(launchOptions) as unknown as Browser;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Anti-detection page setup
  // ─────────────────────────────────────────────────────────────────────────

  private async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Realistic plugin count
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      // Realistic languages
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // Chrome runtime present
      (window as any).chrome = { runtime: {} };
      // Permissions API patch
      const origQuery = window.navigator.permissions?.query;
      if (origQuery) {
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === "notifications"
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : origQuery(parameters);
      }
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language":           "en-US,en;q=0.9",
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding":           "gzip, deflate, br",
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Sec-Fetch-User":            "?1",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control":             "max-age=0",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wait for Cloudflare challenge to auto-resolve.
  //
  // Cloudflare's "managed" challenge runs JS and resolves automatically
  // in ~3-8 seconds if the browser passes fingerprinting checks.
  //
  // We consider CF CLEARED when no active CF signals are present, OR when
  // rendered Crexi listing content is already visible.
  //
  // IMPORTANT: bare <crx-app> is intentionally excluded from hasCrexiContent.
  // It is always present as an empty Angular shell even on CF challenge pages,
  // which caused a false-positive "cleared at 0s" before Angular hydrated.
  // ─────────────────────────────────────────────────────────────────────────

  private async waitForCloudflare(page: Page): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < CF_TIMEOUT_MS) {
      const title = await page.title().catch(() => "");
      const url   = page.url();

      // Definite CF challenge signals in page title
      const cfChallengeTitleSignals = [
        "Just a moment",
        "Attention Required",
        "Please wait",
        "Security check",
      ];
      const isCFTitle = cfChallengeTitleSignals.some(s => title.includes(s));

      // Check for CF challenge elements in DOM
      const hasCFContent = await page.evaluate(() => {
        const body = document.body?.innerHTML ?? "";
        return (
          body.includes("challenges.cloudflare.com") ||
          body.includes("Performing security verification") ||
          body.includes("cf-turnstile") ||
          document.querySelector("#challenge-form") !== null ||
          document.querySelector(".cf-browser-verification") !== null
        );
      }).catch(() => false);

      // NOTE: crx-app intentionally excluded — it is always present as an
      // empty Angular shell and caused false "cleared" signals before hydration.
      const hasCrexiContent = await page.evaluate(() => {
        return (
          document.querySelector("[data-cy='propertyPrice']") !== null ||
          document.querySelector("crx-sales-property-tile") !== null ||
          document.querySelector("crx-header-toolbar") !== null
        );
      }).catch(() => false);

      const urlHasCF = url.includes("__cf_chl");

      // Cleared if: no CF signals present, OR rendered Crexi content already visible
      const isChallenge = (isCFTitle || hasCFContent || urlHasCF) && !hasCrexiContent;

      if (!isChallenge) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        logger.info(`[crexi] Cloudflare cleared after ${elapsed}s (hasCrexiContent: ${hasCrexiContent})`);
        return true;
      }

      logger.info(
        `[crexi] Cloudflare challenge active (${Math.round((Date.now() - start) / 1000)}s elapsed)…`
      );
      await sleep(2000);
    }

    logger.warn(`[crexi] Cloudflare challenge did not resolve after ${CF_TIMEOUT_MS / 1000}s`);
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wait for Crexi Angular listing tiles to appear.
  //
  // Uses waitForFunction to race all selectors simultaneously rather than
  // trying them sequentially (which wasted up to 15s per selector on failure).
  // Extended to 45s to allow Angular time to bootstrap and complete its
  // initial search XHR after CF clears.
  // ─────────────────────────────────────────────────────────────────────────

  private async waitForListings(page: Page): Promise<boolean> {
    try {
      await page.waitForFunction(
        () =>
          document.querySelector("crx-sales-property-tile") !== null ||
          document.querySelector("[data-cy='propertyPrice']") !== null ||
          document.querySelector("[data-cy='propertyName']") !== null ||
          document.querySelector("crx-property-tile-aggregate") !== null,
        { timeout: LISTINGS_WAIT_MS, polling: 1000 }
      );
      logger.info("[crexi] Listings detected via waitForFunction");
      return true;
    } catch {
      logger.warn("[crexi] waitForFunction timed out — no listing tiles appeared");
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scroll to trigger infinite scroll / lazy-loaded content
  // ─────────────────────────────────────────────────────────────────────────

  private async scrollToLoadMore(page: Page): Promise<void> {
    logger.info(`[crexi] Scrolling (${SCROLL_PASSES} passes)…`);
    for (let i = 0; i < SCROLL_PASSES; i++) {
      await page.evaluate(`window.scrollBy(0, ${SCROLL_STEP})`);
      await sleep(SCROLL_DELAY_MS + Math.random() * 800);
      try {
        await page.waitForLoadState("networkidle", { timeout: 4_000 });
      } catch {
        // fine — no pending requests
      }
    }
    await page.evaluate("window.scrollTo(0, 0)");
    await sleep(800);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Extract __NEXT_DATA__ JSON (not expected on Crexi/Angular but kept for
  // forward compatibility)
  // ─────────────────────────────────────────────────────────────────────────

  private async extractNextData(page: Page): Promise<any | null> {
    try {
      const json = await page.evaluate(() => {
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : null;
      });
      if (!json) return null;
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scrape a single search URL
  //
  // Strategy (in priority order):
  //   1. API interception — listen for Crexi's XHR search responses and parse
  //      the JSON directly. Most reliable: no dependency on Angular rendering.
  //   2. HTML / cheerio — parse the fully-rendered Angular DOM after scrolling.
  //   3. Parser falls back to href stubs if no tile elements are found.
  // ─────────────────────────────────────────────────────────────────────────

  private async scrapeUrl(page: Page, searchUrl: string): Promise<RawListing[]> {
    logger.info(`[crexi] → ${searchUrl}`);

    // Accumulate listings captured from intercepted API responses.
    // Must be declared before attaching the listener so the closure captures it.
    const interceptedListings: RawListing[] = [];

    // Set up response interception BEFORE navigating so we don't miss early XHRs
    const responseHandler = async (response: Response) => {
      const responseUrl = response.url();
      const isCrexiApi  = CREXI_API_PATTERNS.some(p => responseUrl.includes(p));
      if (!isCrexiApi) return;

      try {
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("application/json")) return;

        const json = await response.json().catch(() => null);
        if (!json) return;

        logger.debug(`[crexi] Intercepted API response: ${responseUrl}`);
        const listings = parseCrxiListings("", json, searchUrl, "crexi");
        if (listings.length > 0) {
          logger.info(`[crexi] API interception captured ${listings.length} listings from ${responseUrl}`);
          interceptedListings.push(...listings);
        }
      } catch {
        // Non-JSON or parse error — silently ignore
      }
    };

    page.on("response", responseHandler);

    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout:   60_000,
      });

      // Wait for Cloudflare challenge to clear (if present)
      const cfCleared = await this.waitForCloudflare(page);
      if (!cfCleared) {
        this.saveDebug(await page.content(), `cf_timeout_${this.slugify(searchUrl)}`);
        logger.error(
          "[crexi] ✗ Cloudflare not bypassed. Ensure you are using a RESIDENTIAL proxy.\n" +
            "  Datacenter IPs (including most Webshare IPs) are blocked by Cloudflare."
        );
        return [];
      }

      // Wait for Angular to bootstrap and fire its initial search XHR.
      // networkidle is more reliable than a fixed sleep — it signals that
      // Angular has finished its first data fetch.
      try {
        await page.waitForLoadState("networkidle", { timeout: 20_000 });
      } catch {
        // networkidle may never fire on ad-heavy pages — that's fine, continue
        logger.debug("[crexi] networkidle timeout after CF clear — proceeding anyway");
      }
      await sleep(1500 + Math.random() * 500);

      // If API interception already has listings, skip DOM polling entirely
      if (interceptedListings.length > 0) {
        logger.info(`[crexi] Using ${interceptedListings.length} intercepted API listings — skipping DOM wait`);
      } else {
        const cardsFound = await this.waitForListings(page);
        if (!cardsFound) {
          this.saveDebug(await page.content(), `no_cards_${this.slugify(searchUrl)}`);
          logger.warn(`[crexi] No cards found for ${searchUrl} — will still attempt HTML parse`);
        }
      }

      await this.scrollToLoadMore(page);

      // Give any scroll-triggered API calls a moment to resolve
      if (interceptedListings.length > 0) {
        await sleep(1000);
        logger.info(`[crexi] Final intercepted count after scroll: ${interceptedListings.length}`);
        return this.dedupeListings(interceptedListings);
      }

      // Fall back to HTML parsing
      const html     = await page.content();
      const nextData = await this.extractNextData(page);

      this.saveDebug(html, `page_${this.slugify(searchUrl)}`);

      const listings = parseCrxiListings(html, nextData, searchUrl, "crexi");
      logger.info(`[crexi] ${searchUrl} → ${listings.length} listings (HTML path)`);
      return listings;

    } catch (err: any) {
      logger.error(`[crexi] Error on ${searchUrl}: ${err.message}`);
      this.saveDebug(await page.content().catch(() => ""), `error_${Date.now()}`);
      return [];
    } finally {
      // Always remove the listener to prevent handler leaks across URLs
      page.off("response", responseHandler);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main scrape
  // ─────────────────────────────────────────────────────────────────────────

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (pageNumber !== 1) return [];

    // Launch a dedicated stealth browser — separate from the shared handle
    // so we can control the proxy and stealth settings independently
    let browser: Browser | undefined;

    try {
      browser = await this.launchBrowser();

      const context = await browser.newContext({
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

      for (let i = 0; i < SEARCH_URLS.length; i++) {
        const url = SEARCH_URLS[i];
        logger.info(`[crexi] URL ${i + 1}/${SEARCH_URLS.length}`);

        const listings = await this.scrapeUrl(page, url);
        allListings.push(...listings);

        if (i < SEARCH_URLS.length - 1) {
          const pause = 4000 + Math.random() * 3000;
          logger.info(`[crexi] Pausing ${Math.round(pause / 1000)}s before next URL…`);
          await sleep(pause);
        }
      }

      await context.close();

      // Deduplicate by URL across all search URLs
      const deduped = this.dedupeListings(allListings);
      logger.info(`[crexi] Total: ${deduped.length} unique listings`);
      return deduped;
    } finally {
      await browser?.close();
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private dedupeListings(listings: RawListing[]): RawListing[] {
    const seen = new Set<string>();
    return listings.filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
  }

  private slugify(url: string): string {
    return url
      .replace(/https?:\/\/[^/]+\/properties\//, "")
      .replace(/\//g, "_")
      .slice(0, 40);
  }

  private saveDebug(html: string, label: string) {
    try {
      const dir = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `crexi_${label}.html`), html);
    } catch {}
  }
}