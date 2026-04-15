// src/scrapers/facebook/marketplace.scraper.ts

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import {
  parseMarketplaceSearchPage,
  parseMarketplaceDetailPage,
} from "./marketplace.parser";
import * as fs from "fs";
import * as path from "path";

const FB_BASE = "https://www.facebook.com";
const LOGIN_URL = `${FB_BASE}/login`;
const MAX_PRICE = parseInt(process.env.FB_MARKETPLACE_MAX_PRICE ?? "300000", 10);

const TARGET_CITIES: Array<{ slug: string; label: string }> = [
  { slug: "columbus",   label: "Columbus, OH" },
  { slug: "cleveland",  label: "Cleveland, OH" },
  { slug: "toledo",     label: "Toledo, OH" },
  { slug: "cincinnati", label: "Cincinnati, OH" },
  { slug: "akron",      label: "Akron, OH" },
  { slug: "dayton",     label: "Dayton, OH" },
  { slug: "milwaukee",  label: "Milwaukee, WI" },
];

const PROPERTY_TYPES = ["house", "apartment"];
const DETAIL_DELAY_MS = 3_500;
const SCROLL_PASSES = 6;

export class MarketplaceScraper extends BaseScraper {
  readonly sourceName = "facebook_marketplace";

  private loggedIn = false;
  private readonly targets: Array<{ city: typeof TARGET_CITIES[0]; propertyType: string }>;

  constructor(options: ScraperOptions = {}) {
    super(options);

    this.targets = TARGET_CITIES.flatMap((city) =>
      PROPERTY_TYPES.map((propertyType) => ({ city, propertyType }))
    );

    logger.info(
      `[marketplace] ${this.targets.length} search targets ` +
        `(${TARGET_CITIES.length} cities × ${PROPERTY_TYPES.length} property types)`
    );

    if (!process.env.FACEBOOK_USERNAME || !process.env.FACEBOOK_PASSWORD) {
      logger.error(
        "[marketplace] FACEBOOK_USERNAME and FACEBOOK_PASSWORD must be set in .env"
      );
    }

    if (!process.env.PROXY_URL) {
      logger.warn(
        "[marketplace] No PROXY_URL — Facebook is more likely to trigger\n" +
          "  checkpoints without a US residential proxy."
      );
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  private async login(page: Page): Promise<boolean> {
    const username = process.env.FACEBOOK_USERNAME;
    const password = process.env.FACEBOOK_PASSWORD;
    if (!username || !password) return false;

    logger.info("[marketplace] Logging in to Facebook…");

    try {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(2000 + Math.random() * 1500);

      try {
        const cookieBtn = await page.$(
          '[data-cookiebanner="accept_button"], button:has-text("Accept All"), [aria-label*="Accept"]'
        );
        if (cookieBtn) {
          await cookieBtn.click();
          await sleep(1000);
        }
      } catch {
        // no banner
      }

      // Facebook's login field accepts username, email, or phone — field id is always #email
      await page.fill("#email", username);
      await sleep(400 + Math.random() * 400);

      await page.fill("#pass", "");
      for (const char of password) {
        await page.type("#pass", char, { delay: 75 + Math.random() * 75 });
      }
      await sleep(700 + Math.random() * 500);

      await page.click('[name="login"]');
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(3000 + Math.random() * 2000);

      const url = page.url();
      const html = await page.content();

      if (url.includes("checkpoint") || html.toLowerCase().includes("confirm your identity")) {
        logger.error(
          "[marketplace] ⚠️  Checkpoint detected — manual verification required.\n" +
            "  Set headless: false in browser.ts, complete the checkpoint, then re-run."
        );
        this.saveDebug(html, "checkpoint");
        return false;
      }

      if (url.includes("login")) {
        logger.error("[marketplace] Login failed — check FACEBOOK_USERNAME / FACEBOOK_PASSWORD");
        this.saveDebug(html, "login_failed");
        return false;
      }

      logger.info("[marketplace] ✓ Logged in");
      this.loggedIn = true;
      return true;
    } catch (err) {
      logger.error(`[marketplace] Login error: ${err}`);
      return false;
    }
  }

  // ── Build search URL ───────────────────────────────────────────────────────

  private buildSearchUrl(citySlug: string, propertyType: string): string {
    const params = new URLSearchParams({
      minPrice: "0",
      maxPrice: String(MAX_PRICE),
      propertyType,
      daysSinceListed: "7",
    });
    return `${FB_BASE}/marketplace/${citySlug}/propertyforsale/?${params}`;
  }

  // ── Scroll feed ────────────────────────────────────────────────────────────

  private async scrollFeed(page: Page): Promise<void> {
    let lastHeight = 0;
    let stableCount = 0;

    for (let pass = 0; pass < SCROLL_PASSES; pass++) {
      for (let i = 0; i < 3; i++) {
        await page.evaluate(`window.scrollBy(0, ${700 + Math.random() * 300})`);
        await sleep(350 + Math.random() * 250);
      }
      await sleep(1800 + Math.random() * 1200);

      const h = (await page.evaluate("document.body.scrollHeight")) as number;
      const cardCount = (await page.evaluate(
        `document.querySelectorAll("a[href*='/marketplace/item/']").length`
      )) as number;

      logger.debug(`[marketplace] Scroll pass ${pass + 1}: ${cardCount} cards, height ${h}`);

      if (h === lastHeight) {
        stableCount++;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
      }
      lastHeight = h;
    }
  }

  // ── Block detection ────────────────────────────────────────────────────────

  private isBlocked(html: string): boolean {
    const lower = html.toLowerCase();
    return (
      lower.includes("you must log in") ||
      lower.includes("log in to continue") ||
      lower.includes("checkpoint") ||
      lower.includes("confirm your identity") ||
      lower.includes("this content isn") ||
      lower.includes("too many requests")
    );
  }

  // ── BaseScraper implementation ─────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    const targetIndex = pageNumber - 1;
    if (targetIndex >= this.targets.length) return [];

    const { city, propertyType } = this.targets[targetIndex];
    const searchUrl = this.buildSearchUrl(city.slug, propertyType);
    const page = await handle.newPage();

    try {
      if (!this.loggedIn) {
        const ok = await this.login(page);
        if (!ok) return [];
        await sleep(4000 + Math.random() * 2000);
      }

      logger.info(
        `[marketplace] [${targetIndex + 1}/${this.targets.length}] ` +
          `${city.label} — ${propertyType}: ${searchUrl}`
      );

      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(3000 + Math.random() * 2000);

      const initHtml = await page.content();
      if (this.isBlocked(initHtml)) {
        logger.warn(`[marketplace] Blocked on ${city.label}/${propertyType} — skipping`);
        this.saveDebug(initHtml, `blocked_${city.slug}_${propertyType}`);
        return [];
      }

      try {
        await page.waitForSelector("a[href*='/marketplace/item/']", { timeout: 12_000 });
      } catch {
        logger.info(`[marketplace] No listings found for ${city.label} / ${propertyType}`);
        this.saveDebug(await page.content(), `empty_${city.slug}_${propertyType}`);
        return [];
      }

      await this.scrollFeed(page);

      const html = await page.content();
      this.saveDebug(html, `search_${city.slug}_${propertyType}`);

      const rawItems = parseMarketplaceSearchPage(html);
      logger.info(`[marketplace] ${city.label} / ${propertyType}: ${rawItems.length} listings`);

      if (rawItems.length === 0) return [];

      return this.enrichListings(handle, rawItems);
    } catch (err) {
      logger.error(`[marketplace] scrapePage error for ${city.label}: ${err}`);
      return [];
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ── Enrich with detail pages ───────────────────────────────────────────────

  private async enrichListings(
    handle: BrowserHandle,
    rawItems: Omit<RawListing, "source">[]
  ): Promise<RawListing[]> {
    const enriched: RawListing[] = [];

    for (const item of rawItems) {
      if (this.results.length + enriched.length >= (this.options.maxListings ?? Infinity)) break;

      let detail = {};
      try {
        await sleep(DETAIL_DELAY_MS + Math.random() * 2000);
        const detailPage = await handle.newPage();
        try {
          await detailPage.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await sleep(1500 + Math.random() * 1000);
          const detailHtml = await detailPage.content();
          if (!this.isBlocked(detailHtml)) {
            detail = parseMarketplaceDetailPage(detailHtml);
            logger.debug(`[marketplace] Enriched: ${item.url}`);
          }
        } finally {
          await detailPage.close().catch(() => {});
        }
      } catch (err) {
        logger.debug(`[marketplace] Detail failed for ${item.url}: ${err}`);
      }

      enriched.push({ source: this.sourceName, ...item, ...detail });
    }

    return enriched;
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= this.targets.length;
  }

  private saveDebug(html: string, label: string): void {
    try {
      const logDir = path.resolve(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `marketplace_${label}.html`), html, "utf-8");
      logger.debug(`[marketplace] Debug → logs/marketplace_${label}.html`);
    } catch {
      // non-critical
    }
  }
}