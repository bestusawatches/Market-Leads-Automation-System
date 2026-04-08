// src/scrapers/investorlift/investorlift.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// InvestorLift is a login-protected React SPA.
//
// Strategy:
//   1. Log in with credentials from env vars (INVESTORLIFT_EMAIL / PASSWORD)
//   2. Intercept the XHR/fetch calls the SPA makes to its own API
//      → This gives us clean JSON without fragile DOM parsing
//   3. Fall back to DOM parsing if the API intercept yields nothing
//   4. Paginate until MAX_PAGES or MAX_LISTINGS is reached
//
// Required env vars (add to .env):
//   INVESTORLIFT_EMAIL=you@example.com
//   INVESTORLIFT_PASSWORD=yourpassword
// ─────────────────────────────────────────────────────────────────────────────

import { Page, Route } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseApiResponse, parseDomListings } from "./investorlift.parser";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://app.investorlift.com";
const LOGIN_URL = `${BASE_URL}/login`;
const LISTINGS_URL = `${BASE_URL}/properties`;

// Known API endpoint patterns — we intercept responses matching these
const API_PATTERNS = [
  "**/api/v*/properties**",
  "**/api/v*/listings**",
  "**/properties/search**",
  "**investorlift.com/api/**",
];

export class InvestorLiftScraper extends BaseScraper {
  readonly sourceName = "investorlift";

  private readonly email: string;
  private readonly password: string;
  private isLoggedIn = false;

  constructor(options: ScraperOptions = {}) {
    super(options);

    this.email = process.env.INVESTORLIFT_EMAIL ?? "";
    this.password = process.env.INVESTORLIFT_PASSWORD ?? "";

    if (!this.email || !this.password) {
      throw new Error(
        "[investorlift] Missing credentials. Set INVESTORLIFT_EMAIL and " +
          "INVESTORLIFT_PASSWORD in your .env file."
      );
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────

  private async login(page: Page): Promise<void> {
    logger.info("[investorlift] Navigating to login page…");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(1500);

    // Fill credentials — try common selector patterns
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      "#email",
    ];
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="password" i]',
      "#password",
    ];
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      "[data-testid='login-button']",
    ];

    // Email field
    let filled = false;
    for (const sel of emailSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5_000 });
        await page.fill(sel, this.email);
        filled = true;
        logger.debug(`[investorlift] Filled email with selector: ${sel}`);
        break;
      } catch {
        // try next selector
      }
    }
    if (!filled) throw new Error("[investorlift] Could not find email input field");

    // Password field
    filled = false;
    for (const sel of passwordSelectors) {
      try {
        await page.fill(sel, this.password);
        filled = true;
        logger.debug(`[investorlift] Filled password with selector: ${sel}`);
        break;
      } catch {
        // try next selector
      }
    }
    if (!filled) throw new Error("[investorlift] Could not find password input field");

    await sleep(500);

    // Submit
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        await page.click(sel);
        submitted = true;
        logger.debug(`[investorlift] Clicked submit with selector: ${sel}`);
        break;
      } catch {
        // try next selector
      }
    }
    if (!submitted) throw new Error("[investorlift] Could not find submit button");

    // Wait for navigation away from login page
    try {
      await page.waitForURL(
        (url) => !url.toString().includes("/login"),
        { timeout: 30_000 }
      );
      logger.info("[investorlift] Login successful");
      this.isLoggedIn = true;
    } catch {
      // Save debug screenshot and HTML on login failure
      await this.saveDebug(page, "login_failed");
      throw new Error(
        "[investorlift] Login failed — still on login page after submit. " +
          "Check credentials and see logs/investorlift_login_failed.html"
      );
    }
  }

  // ── Page scraping ──────────────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    const page = await handle.newPage();

    try {
      // Log in on first page only
      if (!this.isLoggedIn) {
        await this.login(page);
      }

      // ── Set up API response interception ──────────────────────────────
      const interceptedListings: RawListing[] = [];
      let apiCaptured = false;

      const handleRoute = async (route: Route) => {
        // Let the request proceed normally
        await route.continue();
      };

      // Listen for API responses
      page.on("response", async (response) => {
        const url = response.url();
        const isApiCall = API_PATTERNS.some((pattern) => {
          // Convert glob pattern to simple check
          const clean = pattern.replace(/\*\*/g, "").replace(/\*/g, "");
          return url.includes(clean.replace(/^\//, ""));
        });

        if (!isApiCall) return;
        if (!response.ok()) return;

        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("application/json")) return;

        try {
          const json = await response.json();
          logger.debug(`[investorlift] Intercepted API: ${url}`);

          // Save raw API response for debugging
          this.saveApiDebug(json, pageNumber, url);

          const parsed = parseApiResponse(json, this.sourceName);
          if (parsed.length > 0) {
            interceptedListings.push(...parsed);
            apiCaptured = true;
            logger.info(
              `[investorlift] API intercept page ${pageNumber}: ${parsed.length} listings`
            );
          }
        } catch (err) {
          logger.debug(`[investorlift] Could not parse API response from ${url}: ${err}`);
        }
      });

      // ── Navigate to listings page ─────────────────────────────────────
      const pageUrl = this.buildListingsUrl(pageNumber);
      logger.info(`[investorlift] Fetching page ${pageNumber}: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

      // Wait for either property cards or a known loading indicator to disappear
      try {
        await page.waitForSelector(
          "[data-testid='property-card'], .property-card, .listing-card, [class*='PropertyCard']",
          { timeout: 20_000 }
        );
      } catch {
        logger.warn(`[investorlift] No property cards visible on page ${pageNumber}`);
      }

      // Scroll to trigger lazy loading
      for (const y of [400, 800, 1200, 1600, 1200, 800]) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(300 + Math.random() * 300);
      }

      // Give XHR calls time to complete
      await sleep(2000);

      // Save debug HTML
      await this.saveDebug(page, `page_${pageNumber}`);

      // ── Use API results if captured, else fall back to DOM ────────────
      if (apiCaptured && interceptedListings.length > 0) {
        return interceptedListings;
      }

      logger.warn(
        `[investorlift] No API responses captured on page ${pageNumber} — falling back to DOM`
      );
      const html = await page.content();
      return parseDomListings(html, this.sourceName);
    } finally {
      await page.close();
    }
  }

  // ── URL builder ────────────────────────────────────────────────────────

  /**
   * Build the paginated listings URL.
   * InvestorLift uses query params for pagination — adjust if their
   * URL structure differs in your account.
   */
  private buildListingsUrl(page: number): string {
    const params = new URLSearchParams({
      page: String(page),
      // Filter for Ohio + Milwaukee matching project criteria
      // Uncomment and adjust these if InvestorLift supports URL-based filters:
      // state: "OH",
      // max_price: "300000",
    });
    return `${LISTINGS_URL}?${params.toString()}`;
  }

  // ── Debug helpers ──────────────────────────────────────────────────────

  private async saveDebug(page: Page, label: string): Promise<void> {
    try {
      const logDir = path.resolve(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const html = await page.content();
      fs.writeFileSync(
        path.join(logDir, `investorlift_${label}.html`),
        html,
        "utf-8"
      );
      logger.debug(`[investorlift] Debug HTML → logs/investorlift_${label}.html`);
    } catch {
      // non-critical
    }
  }

  private saveApiDebug(json: unknown, page: number, url: string): void {
    try {
      const logDir = path.resolve(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const slug = url.replace(/[^a-z0-9]/gi, "_").slice(-40);
      fs.writeFileSync(
        path.join(logDir, `investorlift_api_p${page}_${slug}.json`),
        JSON.stringify(json, null, 2),
        "utf-8"
      );
    } catch {
      // non-critical
    }
  }
}
