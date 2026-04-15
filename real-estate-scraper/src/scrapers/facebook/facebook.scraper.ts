// src/scrapers/facebook/facebook.scraper.ts

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseFacebookGroupPosts } from "./facebook.parser";
import * as fs from "fs";
import * as path from "path";

const LOGIN_URL = "https://www.facebook.com/login";
const SESSION_FILE = "facebook-session.json";

const DEFAULT_GROUP_URLS: string[] = (process.env.FACEBOOK_GROUP_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const SCROLL_PASSES = 8;
const SCROLL_STEP = 800;

export class FacebookScraper extends BaseScraper {
  readonly sourceName = "facebook";

  private loggedIn = false;

  constructor(options: ScraperOptions = {}) {
    super(options);

    if (!process.env.FACEBOOK_USERNAME || !process.env.FACEBOOK_PASSWORD) {
      logger.error(
        "[facebook] FACEBOOK_USERNAME and FACEBOOK_PASSWORD must be set in .env"
      );
    }

    if (DEFAULT_GROUP_URLS.length === 0) {
      logger.warn("[facebook] No FACEBOOK_GROUP_URLS set");
    } else {
      logger.info(
        `[facebook] ${DEFAULT_GROUP_URLS.length} target group(s):\n` +
          DEFAULT_GROUP_URLS.map((u) => `  • ${u}`).join("\n")
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Session Helpers
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

    logger.info("[facebook] Logging in…");

    try {
      await page.goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await sleep(3000);

      // DEBUG: Save page in case of failure
      const htmlBefore = await page.content();
      this.saveDebug(htmlBefore, "login_page_loaded");

      // Wait explicitly for email field
      await page.waitForSelector("#email", { timeout: 60000 });

      await page.fill("#email", username);
      await sleep(500);

      await page.fill("#pass", "");
      for (const char of password) {
        await page.type("#pass", char, { delay: 80 });
      }

      await page.click('[name="login"]');

      await page.waitForLoadState("domcontentloaded");
      await sleep(5000);

      const url = page.url();
      const html = await page.content();

      this.saveDebug(html, "after_login");

      if (
        url.includes("checkpoint") ||
        html.toLowerCase().includes("confirm your identity")
      ) {
        logger.error("[facebook] Account checkpoint detected");
        return false;
      }

      if (url.includes("login")) {
        logger.error("[facebook] Login failed");
        return false;
      }

      logger.info("[facebook] ✓ Logged in");

      // SAVE SESSION
      const context = page.context();
      await context.storageState({ path: SESSION_FILE });
      logger.info("[facebook] Session saved");

      this.loggedIn = true;
      return true;
    } catch (err) {
      logger.error(`[facebook] Login error: ${err}`);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Navigate
  // ─────────────────────────────────────────────────────────────

  private async navigateToGroup(page: Page, groupUrl: string) {
    try {
      await page.goto(groupUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await sleep(5000);

      const html = await page.content();
      this.saveDebug(html, "group_page");

      if (page.url().includes("login")) {
        logger.warn("[facebook] Redirected to login");
        return false;
      }

      if (html.includes("Join Group")) {
        logger.error(`[facebook] Not a member: ${groupUrl}`);
        return false;
      }

      return true;
    } catch (err) {
      logger.error(`[facebook] Navigation error: ${err}`);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Scroll
  // ─────────────────────────────────────────────────────────────

  private async scrollFeed(page: Page) {
    for (let i = 0; i < SCROLL_PASSES; i++) {
      await page.evaluate(`window.scrollBy(0, ${SCROLL_STEP})`);
      await sleep(1500);
    }
  }

  private async expandPosts(page: Page) {
    const buttons = await page.$$('[aria-label="See more"]');
    for (const btn of buttons.slice(0, 20)) {
      try {
        await btn.click();
        await sleep(200);
      } catch {}
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Main scrape
  // ─────────────────────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (DEFAULT_GROUP_URLS.length === 0) return [];

    const context = this.sessionExists()
      ? await handle.browser.newContext({ storageState: SESSION_FILE })
      : await handle.browser.newContext();

    const page = await context.newPage();

    try {
      if (!this.sessionExists()) {
        const ok = await this.login(page);
        if (!ok) return [];
      } else {
        logger.info("[facebook] Using saved session");
      }

      const groupUrl =
        DEFAULT_GROUP_URLS[(pageNumber - 1) % DEFAULT_GROUP_URLS.length];

      const ok = await this.navigateToGroup(page, groupUrl);
      if (!ok) return [];

      await this.scrollFeed(page);
      await this.expandPosts(page);

      const html = await page.content();
      this.saveDebug(html, "final_page");

      const listings = parseFacebookGroupPosts(
        html,
        groupUrl,
        "facebook"
      );

      logger.info(`[facebook] ${listings.length} listings`);

      return listings;
    } catch (err) {
      logger.error(`[facebook] scrapePage error: ${err}`);
      return [];
    } finally {
      await context.close();
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= DEFAULT_GROUP_URLS.length;
  }

  // ─────────────────────────────────────────────────────────────
  // Debug helper
  // ─────────────────────────────────────────────────────────────

  private saveDebug(html: string, label: string) {
    try {
      const dir = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `facebook_${label}.html`),
        html
      );
    } catch {}
  }
}