// src/scrapers/facebook/facebook.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Facebook Groups scraper for real estate investment leads.
//
// REQUIREMENTS before running:
//   1. A dedicated throwaway FB account (NOT your personal account)
//      - Add a profile photo and fill in basic info
//      - Manually join your target groups and wait a few days
//   2. A US residential proxy (PROXY_URL in .env)
//   3. FACEBOOK_EMAIL and FACEBOOK_PASSWORD in .env
//   4. FACEBOOK_GROUP_URLS — comma-separated group URLs in .env
//
// .env example:
//   FACEBOOK_EMAIL=yourthrowaway@email.com
//   FACEBOOK_PASSWORD=yourpassword
//   FACEBOOK_GROUP_URLS=https://www.facebook.com/groups/ohiorealestateinvestors,https://www.facebook.com/groups/milwaukeeinvestmentproperties
//   PROXY_URL=http://user:pass@us-residential-host:port
//
// ANTI-BOT NOTES:
//   - Facebook runs PerimeterX + their own browser fingerprinting
//   - Never run this on your personal account
//   - Randomize all delays — consistent timing is a bot signal
//   - If you hit a CAPTCHA or checkpoint, you must solve it manually
//   - Accounts used for scraping will eventually get checkpointed or banned
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseFacebookGroupPosts } from "./facebook.parser";
import * as fs from "fs";
import * as path from "path";

const LOGIN_URL = "https://www.facebook.com/login";
const FB_BASE = "https://www.facebook.com";

// Target groups for Ohio + Milwaukee investment properties
const DEFAULT_GROUP_URLS: string[] = (
  process.env.FACEBOOK_GROUP_URLS ?? ""
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

// How far to scroll per "pass" on a group feed (pixels)
const SCROLL_PASSES = 8;
const SCROLL_STEP = 800;

export class FacebookScraper extends BaseScraper {
  readonly sourceName = "facebook";

  private loggedIn = false;
  private currentGroupIndex = 0;

  constructor(options: ScraperOptions = {}) {
    super(options);

    if (!process.env.FACEBOOK_EMAIL || !process.env.FACEBOOK_PASSWORD) {
      logger.error(
        "[facebook] FACEBOOK_EMAIL and FACEBOOK_PASSWORD must be set in .env\n" +
          "  Use a dedicated throwaway account — never your personal account."
      );
    }

    if (!process.env.PROXY_URL) {
      logger.warn(
        "[facebook] No PROXY_URL set. Facebook is more likely to trigger\n" +
          "  checkpoints without a US residential proxy."
      );
    }

    if (DEFAULT_GROUP_URLS.length === 0) {
      logger.warn(
        "[facebook] No FACEBOOK_GROUP_URLS set in .env.\n" +
          "  Add comma-separated group URLs:\n" +
          "  FACEBOOK_GROUP_URLS=https://www.facebook.com/groups/ohioreinvestors,..."
      );
    } else {
      logger.info(
        `[facebook] ${DEFAULT_GROUP_URLS.length} target group(s):\n` +
          DEFAULT_GROUP_URLS.map((u) => `  • ${u}`).join("\n")
      );
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  private async login(page: Page): Promise<boolean> {
    const email = process.env.FACEBOOK_EMAIL;
    const password = process.env.FACEBOOK_PASSWORD;
    if (!email || !password) return false;

    logger.info("[facebook] Logging in…");

    try {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(2000 + Math.random() * 1500);

      // Accept cookies if the dialog appears (common in some regions)
      try {
        const cookieBtn = await page.$(
          '[data-cookiebanner="accept_button"], [aria-label*="Accept"], button:has-text("Accept All")'
        );
        if (cookieBtn) {
          await cookieBtn.click();
          await sleep(1000);
        }
      } catch {
        // no cookie banner
      }

      // Fill email
      await page.fill("#email", email);
      await sleep(500 + Math.random() * 500);

      // Fill password (type slowly — instant fill looks like a bot)
      await page.fill("#pass", "");
      for (const char of password) {
        await page.type("#pass", char, { delay: 80 + Math.random() * 80 });
      }
      await sleep(800 + Math.random() * 500);

      // Click login
      await page.click('[name="login"]');
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(3000 + Math.random() * 2000);

      const url = page.url();
      const html = await page.content();

      // Check for checkpoint / captcha
      if (url.includes("checkpoint") || html.toLowerCase().includes("confirm your identity")) {
        logger.error(
          "[facebook] ⚠️  Account checkpoint detected.\n" +
            "  Facebook requires manual verification. Open the browser in non-headless\n" +
            "  mode (set HEADLESS=false in .env or browser.ts) and solve the checkpoint,\n" +
            "  then re-run."
        );
        this.saveDebug(html, "checkpoint");
        return false;
      }

      if (url.includes("login") || html.toLowerCase().includes("wrong password")) {
        logger.error("[facebook] Login failed — check FACEBOOK_EMAIL / FACEBOOK_PASSWORD");
        this.saveDebug(html, "login_failed");
        return false;
      }

      logger.info("[facebook] ✓ Logged in successfully");
      this.saveDebug(html, "logged_in");
      this.loggedIn = true;
      return true;
    } catch (err) {
      logger.error(`[facebook] Login error: ${err}`);
      return false;
    }
  }

  // ── Navigate to group ──────────────────────────────────────────────────────

  private async navigateToGroup(page: Page, groupUrl: string): Promise<boolean> {
    logger.info(`[facebook] Navigating to group: ${groupUrl}`);
    try {
      // Append /buy_sell_discussion or /posts for the deals feed if not already there
      const feedUrl = groupUrl.replace(/\/?$/, "") + "/";
      await page.goto(feedUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(4000 + Math.random() * 2000);

      const html = await page.content();

      // Check if we got redirected to login (session expired)
      if (page.url().includes("login")) {
        logger.warn("[facebook] Redirected to login — session may have expired");
        return false;
      }

      // Check if group is private and we're not a member
      if (
        html.includes("Join Group") ||
        html.toLowerCase().includes("you must join this group")
      ) {
        logger.error(
          `[facebook] Not a member of group: ${groupUrl}\n` +
            "  Join the group manually with your account and wait a few days before scraping."
        );
        return false;
      }

      return true;
    } catch (err) {
      logger.warn(`[facebook] Navigation error for ${groupUrl}: ${err}`);
      return false;
    }
  }

  // ── Scroll feed to load posts ──────────────────────────────────────────────

  private async scrollFeed(page: Page, targetPostCount: number): Promise<void> {
    logger.debug(`[facebook] Scrolling to load ~${targetPostCount} posts…`);

    let lastHeight = 0;
    let noGrowthCount = 0;

    for (let pass = 0; pass < SCROLL_PASSES; pass++) {
      // Scroll down gradually — smooth scrolling looks more human
      for (let i = 0; i < 3; i++) {
        await page.evaluate(`window.scrollBy(0, ${SCROLL_STEP + Math.random() * 200})`);
        await sleep(400 + Math.random() * 300);
      }

      // Longer pause every few passes to let content load
      if (pass % 2 === 0) {
        await sleep(2000 + Math.random() * 1500);
      }

      const currentHeight = await page.evaluate("document.body.scrollHeight") as number;

      // Count visible posts
      const postCount = await page.evaluate(
        () => document.querySelectorAll("[role='article']").length
      ) as number;

      logger.debug(`[facebook] Scroll pass ${pass + 1}: ${postCount} posts visible`);

      if (postCount >= targetPostCount) break;

      if (currentHeight === lastHeight) {
        noGrowthCount++;
        if (noGrowthCount >= 3) {
          logger.debug("[facebook] Page height stable — likely reached end of feed");
          break;
        }
      } else {
        noGrowthCount = 0;
      }
      lastHeight = currentHeight;

      // Occasionally scroll back up a bit — more human-like
      if (pass % 3 === 2) {
        await page.evaluate(`window.scrollBy(0, -${200 + Math.random() * 200})`);
        await sleep(500);
      }
    }
  }

  // ── Handle "See More" expansions ───────────────────────────────────────────

  private async expandPosts(page: Page): Promise<void> {
    try {
      // Click "See more" links in post bodies so we get full text
      const seeMoreLinks = await page.$$(
        '[aria-label="See more"], [aria-expanded="false"][role="button"]'
      );

      for (const link of seeMoreLinks.slice(0, 20)) {
        try {
          await link.click();
          await sleep(200 + Math.random() * 150);
        } catch {
          // some links may be stale
        }
      }
    } catch {
      // non-fatal
    }
  }

  // ── BaseScraper implementation ─────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (DEFAULT_GROUP_URLS.length === 0) {
      logger.error("[facebook] No group URLs configured — nothing to scrape");
      return [];
    }

    const page = await handle.newPage();

    try {
      // Login once at the start of the first scrape pass
      if (!this.loggedIn) {
        const ok = await this.login(page);
        if (!ok) return [];
        // Human-like pause after login before navigating to groups
        await sleep(5000 + Math.random() * 3000);
      }

      // Each "page" corresponds to one group
      const groupIndex = (pageNumber - 1) % DEFAULT_GROUP_URLS.length;
      const groupUrl = DEFAULT_GROUP_URLS[groupIndex];

      if (!groupUrl) return [];

      const source = `facebook_${this.slugifyGroupUrl(groupUrl)}`;

      const navigated = await this.navigateToGroup(page, groupUrl);
      if (!navigated) return [];

      // Scroll to load posts — aim for ~40 posts per pass
      const targetPosts = Math.min(
        this.options.maxListings ?? 40,
        40
      );
      await this.scrollFeed(page, targetPosts);
      await this.expandPosts(page);

      // Small final wait for any lazy-loaded content
      await sleep(2000);

      const html = await page.content();
      this.saveDebug(html, `group_${groupIndex}_page_${pageNumber}`);

      const listings = parseFacebookGroupPosts(html, groupUrl, source);

      logger.info(
        `[facebook] Group ${groupIndex + 1}/${DEFAULT_GROUP_URLS.length} ` +
          `(${groupUrl.split("/").pop()}): ${listings.length} listings`
      );

      // If there are more groups and we haven't hit our limit, signal that
      // there's more to scrape by returning a non-empty result — BaseScraper
      // will call scrapePage with pageNumber+1 automatically.
      return listings;
    } catch (err) {
      logger.error(`[facebook] scrapePage error: ${err}`);
      return [];
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ── Should continue to next page? ─────────────────────────────────────────
  // Override BaseScraper's pagination: we stop when we've visited all groups.

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= DEFAULT_GROUP_URLS.length;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private slugifyGroupUrl(url: string): string {
    const m = url.match(/groups\/([^/?#]+)/);
    return m ? m[1].replace(/[^a-z0-9]/gi, "_").toLowerCase() : "group";
  }

  private saveDebug(html: string, label: string): void {
    try {
      const logDir = path.resolve(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, `facebook_${label}.html`),
        html,
        "utf-8"
      );
      logger.debug(`[facebook] Debug → logs/facebook_${label}.html`);
    } catch {
      // non-critical
    }
  }
}