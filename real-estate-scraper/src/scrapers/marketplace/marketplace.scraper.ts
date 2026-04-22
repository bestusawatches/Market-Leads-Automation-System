// src/scrapers/facebook/marketplace.scraper.ts

import { chromium, Page } from "playwright";
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

const FB_BASE      = "https://www.facebook.com";
const SESSION_FILE = "facebook-session.json"; // shared with facebook.scraper

const MAX_PRICE = parseInt(process.env.FB_MARKETPLACE_MAX_PRICE ?? "300000", 10);

const TARGET_CITIES: Array<{ slug: string; label: string }> = [
  { slug: "columbus",   label: "Columbus, OH"   },
  { slug: "cleveland",  label: "Cleveland, OH"  },
  { slug: "toledo",     label: "Toledo, OH"     },
  { slug: "cincinnati", label: "Cincinnati, OH" },
  { slug: "akron",      label: "Akron, OH"      },
  { slug: "dayton",     label: "Dayton, OH"     },
  { slug: "milwaukee",  label: "Milwaukee, WI"  },
];

const PROPERTY_TYPES  = ["house", "apartment"];
const DETAIL_DELAY_MS = 3_500;
const SCROLL_PASSES   = 6;

// How long to wait for listing cards to appear after page load (ms).
// Facebook Marketplace renders cards via JS — 12s was too short. 40s gives
// the React bundle time to hydrate and fire its GraphQL fetch.
const CARD_WAIT_MS = 40_000;

// Selectors for listing item links — FB uses both formats
const ITEM_LINK_SELECTORS = [
  "a[href*='/marketplace/item/']",
  "a[href*='marketplace/item']",
];

const MODAL_CLOSE_SELECTORS = [
  '[aria-label="Close"]',
  '[aria-label="close"]',
  "div[role='dialog'] div[role='button']:has-text('Not Now')",
  "div[role='dialog'] div[role='button']:has-text('Not now')",
  "div[role='dialog'] div[role='button']:has-text('Close')",
  "div[role='dialog'] [data-testid='dialog-close-button']",
];

export class MarketplaceScraper extends BaseScraper {
  readonly sourceName = "facebook_marketplace";

  private loggedIn = false;

  private readonly targets: Array<{
    city: (typeof TARGET_CITIES)[0];
    propertyType: string;
  }>;

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
  }

  // ─────────────────────────────────────────────────────────────
  // Session helpers
  // ─────────────────────────────────────────────────────────────

  private sessionExists(): boolean {
    return fs.existsSync(SESSION_FILE);
  }

  // ─────────────────────────────────────────────────────────────
  // Login
  // ─────────────────────────────────────────────────────────────

  private async login(page: Page): Promise<boolean> {
    const username = process.env.FACEBOOK_USERNAME;
    const password = process.env.FACEBOOK_PASSWORD;
    if (!username || !password) return false;

    logger.info("[marketplace] Logging in to Facebook…");

    try {
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout:   60_000,
      });
      await sleep(2500 + Math.random() * 1500);

      this.saveDebug(await page.content(), "mp_homepage_loaded");

      await page.waitForSelector(
        '#email, input[name="email"], input[type="email"], input[autocomplete="username"], ' +
        'button[title="Accept All"], [aria-label="Allow all cookies"], [data-cookiebanner="accept_button"]',
        { timeout: 30_000 }
      );

      for (const selector of [
        '[data-cookiebanner="accept_button"]',
        'button[title="Accept All"]',
        'button[title="Allow all cookies"]',
        '[aria-label="Allow all cookies"]',
        "button:has-text('Accept All')",
        "button:has-text('Allow essential and optional cookies')",
        "button:has-text('Allow essential')",
      ]) {
        try {
          const btn = await page.$(selector);
          if (btn) {
            await btn.click();
            logger.info(`[marketplace] Dismissed consent dialog via: ${selector}`);
            await sleep(2000);
            break;
          }
        } catch {}
      }

      await page.waitForSelector(
        '#email, input[name="email"], input[type="email"], input[autocomplete="username"]',
        { timeout: 20_000 }
      );
      await sleep(500 + Math.random() * 400);

      const emailField =
        (await page.$("#email")) ??
        (await page.$('input[name="email"]')) ??
        (await page.$('input[type="email"]')) ??
        (await page.$('input[autocomplete="username"]'));

      if (!emailField) {
        logger.error("[marketplace] Could not find email input");
        return false;
      }
      await emailField.fill(username);
      await sleep(600 + Math.random() * 500);

      const passField =
        (await page.$("#pass")) ??
        (await page.$('input[name="pass"]')) ??
        (await page.$('input[type="password"]'));

      if (!passField) {
        logger.error("[marketplace] Could not find password input");
        return false;
      }
      await passField.fill("");
      for (const char of password) {
        await passField.type(char, { delay: 75 + Math.random() * 75 });
      }
      await sleep(800 + Math.random() * 500);

      await passField.press("Enter");
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(3500 + Math.random() * 2000);

      const url  = page.url();
      const html = await page.content();
      this.saveDebug(html, "mp_after_login");
      logger.info(`[marketplace] Post-login URL: ${url}`);

      if (
        url.includes("checkpoint") ||
        url.includes("two_step_verification") ||
        html.toLowerCase().includes("confirm your identity") ||
        html.toLowerCase().includes("two-factor") ||
        html.toLowerCase().includes("approval code")
      ) {
        logger.warn("[marketplace] ⚠️  Checkpoint / 2FA — pausing for manual completion");
        this.saveDebug(html, "mp_checkpoint");
        await this.handleTwoFactorOrCheckpoint(page);

        const urlAfter = page.url();
        if (urlAfter.includes("login") || urlAfter.includes("checkpoint")) {
          logger.error("[marketplace] Still not logged in after manual intervention");
          return false;
        }
        logger.info("[marketplace] ✓ Manual intervention successful");
        await page.context().storageState({ path: SESSION_FILE });
        this.loggedIn = true;
        return true;
      }

      if (url.includes("login") || html.toLowerCase().includes("wrong password")) {
        logger.error("[marketplace] Login failed — check credentials");
        this.saveDebug(html, "mp_login_failed");
        return false;
      }

      logger.info("[marketplace] ✓ Logged in successfully");
      await page.context().storageState({ path: SESSION_FILE });
      this.loggedIn = true;
      return true;
    } catch (err) {
      logger.error(`[marketplace] Login error: ${err}`);
      this.saveDebug(await page.content().catch(() => ""), "mp_login_error");
      return false;
    }
  }

  private async handleTwoFactorOrCheckpoint(page: Page): Promise<void> {
    logger.info("=== MANUAL INTERVENTION REQUIRED ===");
    logger.info("Complete the verification in the browser, then press Resume.");
    await page.pause();
    try { await page.context().storageState({ path: SESSION_FILE }); } catch {}
  }

  private async verifySession(page: Page): Promise<boolean> {
    try {
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout:   30_000,
      });
      await sleep(3000);
      const url  = page.url();
      const html = await page.content();
      if (url.includes("login") || html.includes('id="email"')) {
        logger.warn("[marketplace] Session expired");
        return false;
      }
      logger.info("[marketplace] Session verified ✓");
      return true;
    } catch {
      return false;
    }
  }

  private async dismissModals(page: Page): Promise<void> {
    let hasDialog: boolean;
    try {
      hasDialog = !!(await page.$("div[role='dialog'], div[aria-modal='true']"));
    } catch { return; }
    if (!hasDialog) return;

    try { await page.keyboard.press("Escape"); await sleep(500); } catch {}

    try {
      const stillOpen = await page.$("div[role='dialog'], div[aria-modal='true']");
      if (!stillOpen) return;
    } catch { return; }

    for (const selector of MODAL_CLOSE_SELECTORS) {
      try {
        const el = await page.$(selector);
        if (!el) continue;
        const tagName = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tagName === "a") continue;
        await el.click({ timeout: 3000 });
        logger.info(`[marketplace] Modal closed via: ${selector}`);
        await sleep(500);
        break;
      } catch {}
    }
  }

  private buildSearchUrl(citySlug: string, propertyType: string): string {
    const params = new URLSearchParams({
      minPrice:        "0",
      maxPrice:        String(MAX_PRICE),
      propertyType,
      daysSinceListed: "7",
    });
    return `${FB_BASE}/marketplace/${citySlug}/propertyforsale/?${params}`;
  }

  // ─────────────────────────────────────────────────────────────
  // Block detection — ONLY flag genuine auth blocks.
  //
  // Previously "this content isn" was triggering false positives
  // because Facebook Marketplace shows "This content isn't available
  // right now" on some category pages even when fully logged in.
  // That is NOT a block — it just means no listings in that category.
  //
  // We now only treat something as blocked if it clearly signals that
  // the user is NOT authenticated (login wall / checkpoint / rate limit).
  // We log WHICH phrase triggered it so false positives are obvious.
  // ─────────────────────────────────────────────────────────────

  private isBlocked(html: string, label: string): boolean {
    const lower = html.toLowerCase();

    const authBlockPhrases: Array<[string, string]> = [
      ["you must log in to",          "login wall"],
      ["log in to continue",           "login wall"],
      ["you're not logged in",         "login wall"],
      ["please log in",                "login wall"],
      ["confirm your identity",        "checkpoint"],
      ["we detected an unusual login", "checkpoint"],
      ["too many requests",            "rate limit"],
    ];

    for (const [phrase, reason] of authBlockPhrases) {
      if (lower.includes(phrase)) {
        logger.warn(`[marketplace] Auth block detected (${reason}) on "${label}" — phrase: "${phrase}"`);
        return true;
      }
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Wait for listing cards to appear.
  //
  // Facebook Marketplace renders cards via a React/GraphQL pipeline.
  // After domcontentloaded the JS bundle still needs to:
  //   1. Parse + execute (300-2000ms)
  //   2. Fire a GraphQL fetch for listings (~500-3000ms round-trip)
  //   3. Render the result cards into the DOM
  //
  // Strategy:
  //   • First wait for networkidle (up to 15s) so the GraphQL fetch has
  //     time to complete before we start polling for card elements.
  //   • Then use waitForFunction to poll for item links (up to CARD_WAIT_MS).
  //   • If that times out, do a light scroll to nudge lazy rendering and
  //     try one more time.
  //
  // Returns the number of cards found, or 0 if none appeared.
  // ─────────────────────────────────────────────────────────────

  private async waitForCards(page: Page, label: string): Promise<number> {
    // Step 1: wait for network to go idle so GraphQL has fired and resolved
    try {
      await page.waitForLoadState("networkidle", { timeout: 15_000 });
      logger.debug(`[marketplace] networkidle reached for ${label}`);
    } catch {
      logger.debug(`[marketplace] networkidle timeout for ${label} — proceeding`);
    }

    await this.dismissModals(page);

    // Step 2: poll for item link elements
    const selectorExpr = ITEM_LINK_SELECTORS
      .map(s => `document.querySelector(${JSON.stringify(s)}) !== null`)
      .join(" || ");

    try {
      await page.waitForFunction(selectorExpr, { timeout: CARD_WAIT_MS, polling: 1500 });
      const count = await this.countCards(page);
      logger.info(`[marketplace] Cards appeared for ${label}: ${count}`);
      return count;
    } catch {
      // Step 3: nudge scroll in case cards are below the fold / lazy-loaded
      logger.debug(`[marketplace] No cards yet for ${label} — nudging scroll`);
      await page.evaluate("window.scrollBy(0, 600)");
      await sleep(3000);
      await page.evaluate("window.scrollTo(0, 0)");
      await sleep(1000);

      const count = await this.countCards(page);
      if (count > 0) {
        logger.info(`[marketplace] Cards appeared after scroll nudge for ${label}: ${count}`);
      } else {
        logger.info(`[marketplace] No cards found for ${label} after ${CARD_WAIT_MS / 1000}s`);
      }
      return count;
    }
  }

  private async countCards(page: Page): Promise<number> {
    return page.evaluate((selectors: string[]) => {
      return selectors.reduce(
        (total, sel) => total + document.querySelectorAll(sel).length,
        0
      );
    }, ITEM_LINK_SELECTORS);
  }

  // ─────────────────────────────────────────────────────────────
  // Scroll feed
  // ─────────────────────────────────────────────────────────────

  private async scrollFeed(page: Page): Promise<void> {
    let lastHeight  = 0;
    let stableCount = 0;

    for (let pass = 0; pass < SCROLL_PASSES; pass++) {
      await this.dismissModals(page);

      for (let i = 0; i < 3; i++) {
        await page.evaluate(`window.scrollBy(0, ${700 + Math.random() * 300})`);
        await sleep(350 + Math.random() * 250);
      }
      await sleep(1800 + Math.random() * 1200);

      const h = (await page.evaluate("document.body.scrollHeight")) as number;
      const cardCount = await this.countCards(page);

      logger.debug(`[marketplace] Scroll ${pass + 1}: ${cardCount} cards, height ${h}`);

      if (h === lastHeight) {
        stableCount++;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
      }
      lastHeight = h;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Scrape a single city + property type
  // ─────────────────────────────────────────────────────────────

  private async scrapeTarget(
    page: Page,
    city: (typeof TARGET_CITIES)[0],
    propertyType: string
  ): Promise<Omit<RawListing, "source">[]> {
    const searchUrl = this.buildSearchUrl(city.slug, propertyType);
    const label     = `${city.label}/${propertyType}`;
    logger.info(`[marketplace] ${label} → ${searchUrl}`);

    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(2000 + Math.random() * 1000);

      // Check for redirect to login (real auth failure)
      if (page.url().includes("login") || page.url().includes("checkpoint")) {
        logger.warn(`[marketplace] Redirected to login on ${label} — session may have expired`);
        return [];
      }

      await this.dismissModals(page);

      // Auth block check (strict — no false positives)
      const initHtml = await page.content();
      this.saveDebug(initHtml, `search_${city.slug}_${propertyType}`);

      if (this.isBlocked(initHtml, label)) {
        return [];
      }

      // Log diagnostics
      const pageTitle = await page.title();
      logger.info(`[marketplace] ${label} — title: "${pageTitle}"`);

      // Wait for cards with networkidle + polling + scroll nudge
      const cardCount = await this.waitForCards(page, label);

      if (cardCount === 0) {
        // Save the HTML at this point for post-mortem analysis
        this.saveDebug(await page.content(), `no_cards_${city.slug}_${propertyType}`);
        return [];
      }

      await this.scrollFeed(page);
      await this.dismissModals(page);

      const html  = await page.content();
      const items = parseMarketplaceSearchPage(html);
      logger.info(`[marketplace] ${label}: ${items.length} cards`);
      return items;
    } catch (err: any) {
      logger.error(`[marketplace] Error on ${label}: ${err.message}`);
      this.saveDebug(await page.content().catch(() => ""), `error_${city.slug}_${propertyType}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Enrich with detail pages
  // ─────────────────────────────────────────────────────────────

  private async enrichListings(
    page: Page,
    rawItems: Omit<RawListing, "source">[]
  ): Promise<RawListing[]> {
    const enriched: RawListing[] = [];

    for (const item of rawItems) {
      try {
        await sleep(DETAIL_DELAY_MS + Math.random() * 2000);
        await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await sleep(1500 + Math.random() * 1000);

        const detailHtml = await page.content();
        if (!this.isBlocked(detailHtml, item.url)) {
          const detail = parseMarketplaceDetailPage(detailHtml);
          enriched.push({ source: this.sourceName, ...item, ...detail });
          logger.debug(`[marketplace] Enriched: ${item.url}`);
        } else {
          enriched.push({ source: this.sourceName, ...item });
        }
      } catch (err) {
        logger.debug(`[marketplace] Detail failed for ${item.url}: ${err}`);
        enriched.push({ source: this.sourceName, ...item });
      }
    }

    return enriched;
  }

  // ─────────────────────────────────────────────────────────────
  // Main scrape
  // ─────────────────────────────────────────────────────────────

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (pageNumber !== 1) return [];

    logger.info("[marketplace] Launching dedicated no-proxy browser");

    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      headless:       false,
    });

    const contextOptions: Record<string, any> = {
      viewport:   { width: 1366, height: 900 },
      locale:     "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };

    if (this.sessionExists()) {
      contextOptions.storageState = SESSION_FILE;
      logger.info("[marketplace] Loading saved Facebook session");
    }

    const context = await browser.newContext(contextOptions);
    const page    = await context.newPage();

    try {
      if (this.sessionExists()) {
        const sessionOk = await this.verifySession(page);
        if (!sessionOk) {
          logger.warn("[marketplace] Session expired — re-logging in");
          try { fs.unlinkSync(SESSION_FILE); } catch {}
          const ok = await this.login(page);
          if (!ok) return [];
        } else {
          this.loggedIn = true;
        }
      } else {
        const ok = await this.login(page);
        if (!ok) return [];
      }

      const allRaw: Omit<RawListing, "source">[] = [];

      for (let i = 0; i < this.targets.length; i++) {
        const { city, propertyType } = this.targets[i];
        logger.info(
          `[marketplace] ── Target ${i + 1}/${this.targets.length}: ${city.label} / ${propertyType}`
        );

        try {
          const items = await this.scrapeTarget(page, city, propertyType);
          allRaw.push(...items);
        } catch (err: any) {
          logger.error(`[marketplace] Error on ${city.label}: ${err.message}`);
        }

        if (i < this.targets.length - 1) {
          const pause = 4000 + Math.random() * 3000;
          logger.info(`[marketplace] Pausing ${Math.round(pause / 1000)}s…`);
          await sleep(pause);
        }
      }

      logger.info(`[marketplace] ${allRaw.length} cards — enriching…`);
      const enriched = await this.enrichListings(page, allRaw);

      try {
        await context.storageState({ path: SESSION_FILE });
        logger.info("[marketplace] Session refreshed");
      } catch {}

      logger.info(`[marketplace] Total: ${enriched.length} enriched listings`);
      return enriched;
    } catch (err: any) {
      logger.error(`[marketplace] scrapePage error: ${err.message}`);
      return [];
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }

  private saveDebug(html: string, label: string): void {
    try {
      const dir = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `marketplace_${label}.html`), html, "utf-8");
    } catch {}
  }
}