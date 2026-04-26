// src/scrapers/zillow/zillow.scraper.ts

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseZillowResults, MAX_DAYS_OLD } from "./zillow.parser";
import { config } from "../../config";
import * as fs   from "fs";
import * as path from "path";

// ── Constants ─────────────────────────────────────────────────────────────────

const NEXT_DATA_WAIT_MS = 10_000;
const BETWEEN_PAGE_MS   = 4_000;
const MAX_PAGES         = 20;
const PAGE_TIMEOUT_MS   = 60_000;

// ── Human behaviour simulation ────────────────────────────────────────────────
// PerimeterX scores sessions on mouse movement and scroll events.
// A page that loads with zero interaction is a strong bot signal.

async function simulateHumanBehavior(page: any): Promise<void> {
  await page.mouse.move(
    200 + Math.random() * 400,
    200 + Math.random() * 200,
    { steps: 12 }
  );
  await sleep(300 + Math.random() * 400);

  await page.evaluate(() => {
    window.scrollBy({ top: 300 + Math.random() * 200, behavior: "smooth" });
  });
  await sleep(500 + Math.random() * 500);

  await page.evaluate(() => {
    window.scrollBy({ top: -(100 + Math.random() * 100), behavior: "smooth" });
  });
  await sleep(300 + Math.random() * 200);
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildPageUrl(baseUrl: string, pageNumber: number): string {
  const [basePath] = baseUrl.split("?");

  const state: Record<string, any> = {
    filterState:   { price: { max: 300_000 } },
    sortSelection: { value: "days" },
  };

  if (pageNumber > 1) {
    state.pagination = { currentPage: pageNumber };
  }

  return `${basePath}?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class ZillowScraper extends BaseScraper {
  readonly sourceName = "zillow";
  private readonly baseUrl: string;
  private stopPaging = false;

  constructor(options: ScraperOptions = {}) {
    super(options);
    this.baseUrl = String(config.sources.zillow);
  }

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (this.stopPaging) return [];

    const page    = await handle.newPage();
    const pageUrl = buildPageUrl(this.baseUrl, pageNumber);

    try {
      logger.info(`[zillow] Page ${pageNumber}/${MAX_PAGES} → ${pageUrl}`);

      // ── Navigate ───────────────────────────────────────────────
      try {
        await page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout:   PAGE_TIMEOUT_MS,
        });
      } catch (navErr: any) {
        logger.error(`[zillow] Navigation failed (page ${pageNumber}): ${navErr.message}`);
        this.stopPaging = true;
        return [];
      }

      // ── Human behaviour (mouse + scroll) ──────────────────────
      await simulateHumanBehavior(page);

      // ── Bot / block detection ──────────────────────────────────
      const pageTitle = await page.title().catch(() => "");
      const titleLow  = pageTitle.toLowerCase();

      const BLOCK_TITLES = [
        "access to this page has been denied",
        "access denied",
        "attention required",
        "just a moment",
        "security check",
      ];
      const isTitleBlock = BLOCK_TITLES.some((t) => titleLow.includes(t));

      const html = await page.content();

      // Match only actual challenge DOM elements, not PX sensor script tags
      // which appear on every legitimate Zillow page.
      const BLOCK_BODY = [
        'id="px-captcha"',
        'id="_pxCaptcha"',
        "challenges.cloudflare.com",
        "cf-browser-verification",
        "errors.edgesuite.net",
        "Enable JavaScript and cookies to continue",
        "Verifying you are human. Please stand by",
      ];
      const isBodyBlock = BLOCK_BODY.some((s) => html.includes(s));

      // A real Zillow page is large and contains its CDN assets.
      // Only flag short pages that are ALSO missing Zillow markers.
      const isShortAndEmpty =
        html.length < 3_000 &&
        !html.includes("__NEXT_DATA__") &&
        !html.includes("zillowstatic.com");

      if (isTitleBlock || isBodyBlock || isShortAndEmpty) {
        const reason = isTitleBlock
          ? `bot block page — title: "${pageTitle}"`
          : isBodyBlock
          ? "bot challenge signal in body"
          : `page too short and missing Zillow markers (${html.length} chars)`;
        logger.error(`[zillow] Blocked on page ${pageNumber}: ${reason}.`);
        this.saveDebug(html, `blocked_p${pageNumber}`);
        this.stopPaging = true;
        return [];
      }

      // Positive check — if Zillow CDN assets are absent something is very wrong
      if (!html.includes("zillowstatic.com") && !html.includes("__NEXT_DATA__")) {
        logger.error(`[zillow] Page ${pageNumber} doesn't look like Zillow — unexpected response`);
        this.saveDebug(html, `unexpected_p${pageNumber}`);
        this.stopPaging = true;
        return [];
      }

      logger.info(`[zillow] Page ${pageNumber} title: "${pageTitle}" (${html.length} chars)`);

      // ── Wait for __NEXT_DATA__ ─────────────────────────────────
      try {
        await page.waitForSelector("#__NEXT_DATA__", { timeout: NEXT_DATA_WAIT_MS });
      } catch {
        logger.warn(`[zillow] __NEXT_DATA__ not found on page ${pageNumber} — trying anyway`);
      }

      // ── Extract + parse ────────────────────────────────────────
      const nextDataText = await page.evaluate(() => {
        const el = document.querySelector("#__NEXT_DATA__");
        return el ? el.textContent : null;
      });

      if (!nextDataText) {
        logger.warn(`[zillow] No __NEXT_DATA__ on page ${pageNumber} — stopping pagination`);
        this.saveDebug(html, `no_next_data_p${pageNumber}`);
        this.stopPaging = true;
        return [];
      }

      let json: any;
      try {
        json = JSON.parse(nextDataText);
      } catch (err) {
        logger.warn(`[zillow] Failed to parse __NEXT_DATA__ on page ${pageNumber}: ${err}`);
        this.stopPaging = true;
        return [];
      }

      const searchJson = json?.props?.pageProps?.searchPageState ?? json;
      const { listings, allStale } = parseZillowResults(searchJson);

      logger.info(
        `[zillow] Page ${pageNumber}: ${listings.length} listings within ${MAX_DAYS_OLD} days` +
          (allStale ? " — all stale, stopping pagination" : "")
      );

      if (allStale) this.stopPaging = true;

      return listings.map((l) => ({ ...l, source: this.sourceName }));

    } finally {
      await page.close();
      if (!this.stopPaging) await sleep(BETWEEN_PAGE_MS + Math.random() * 2_000);
    }
  }

  protected hasMorePages(
    pageNumber: number,
    lastPageResults: RawListing[]
  ): boolean {
    if (this.stopPaging)              return false;
    if (pageNumber >= MAX_PAGES)      return false;
    if (lastPageResults.length === 0) return false;
    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private saveDebug(html: string, label: string): void {
    try {
      const dir  = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `zillow_${label}.html`);
      fs.writeFileSync(file, html);
      logger.debug(`[zillow] Debug HTML → ${file}`);
    } catch {}
  }
}