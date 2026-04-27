// src/enrichers/zillow/zillow.enricher.ts
//
// ── Strategy ──────────────────────────────────────────────────────────────────
//
// The /homes/for_sale/ADDRESS_rb/ URL returns 0 results for most specific
// addresses because Zillow treats it as a geographic search, not an address
// lookup.
//
// Working approach (confirmed via DevTools):
//
//   Phase 1 — Use Zillow's suggest/autocomplete API to resolve the address
//     to a ZPID: /zg-graph?operationName=ForSaleShopperPlatformFullRenderQuery
//     or the simpler typeahead: /search/GetSearchPageState.htm
//
//   Phase 2 — Navigate directly to the detail page
//     https://www.zillow.com/homedetails/ZPID_zpid/
//     and intercept the GDP GraphQL or gdpClientCache from __NEXT_DATA__.
//
//   Fallback — Use zillow.com/homes/FULL_ADDRESS/ (no _rb suffix, no for_sale)
//     which redirects to the correct HDP and fires gdpClientCache in NEXT_DATA.
//
// ─────────────────────────────────────────────────────────────────────────────

import { chromium }     from "playwright-extra";
import StealthPlugin    from "puppeteer-extra-plugin-stealth";
import { Page, Browser, BrowserContext, Response } from "playwright";
import { PrismaClient } from "@prisma/client";
import { RawListing }   from "../../types/listing";
import { logger }       from "../../utils/logger";
import { sleep }        from "../../utils/browser";
import * as fs          from "fs";
import * as path        from "path";

chromium.use(StealthPlugin());

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_DELAY_MS         = 8_000;
const MAX_DELAY_MS         = 16_000;
const DEFAULT_BATCH_SIZE   = 30;
const REQUEST_TIMEOUT_MS   = 30_000;
const INTERCEPT_TIMEOUT_MS = 25_000;
const STREET_ADDRESS_REGEX = /^\d+\s+\w/;

// GDP / detail page patterns
const GDP_PATTERNS = [
  "zillow.com/graphql",
  "/api/v3/home-details",
  "gdpClientCache",
  "GetSearchPageState",
  "ForSaleShopperPlatform",
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface ZillowData {
  zestimate?:      number;
  zestimateLow?:   number;
  zestimateHigh?:  number;
  listingPrice?:   number;
  zpid?:           string;
  zillowUrl?:      string;
  matchedAddress?: string;
}

interface ResolvedProperty {
  zpid:       string;
  detailUrl:  string;
  zestimate?: number;
}

// ── Browser lifecycle ─────────────────────────────────────────────────────────

let sharedBrowser: Browser | undefined;
let sharedContext: BrowserContext | undefined;

async function getBrowserContext(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    logger.debug("[zillow-enricher] Launching stealth browser…");
    sharedBrowser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--window-size=1440,900",
      ],
    }) as unknown as Browser;
  }

  if (!sharedContext) {
    sharedContext = await sharedBrowser.newContext({
      viewport:   { width: 1440, height: 900 },
      locale:     "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
  }

  const page = await sharedContext.newPage();
  await setupPage(page);
  return { browser: sharedBrowser, context: sharedContext, page };
}

export async function closeBrowser(): Promise<void> {
  try {
    await sharedContext?.close();
    await sharedBrowser?.close();
  } catch {}
  sharedContext = undefined;
  sharedBrowser = undefined;
}

// ── Page setup ────────────────────────────────────────────────────────────────

async function setupPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
    Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages",  { get: () => ["en-US", "en"] });
    (window as any).chrome = { runtime: {} };
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

// ── Build URLs ────────────────────────────────────────────────────────────────

/**
 * Zillow's "how much is my home worth" page is a reliable entry point.
 * It accepts a free-form address, redirects to the HDP, and the resulting
 * page contains gdpClientCache with zestimate data in __NEXT_DATA__.
 */
function buildHdpSearchUrl(address: string): string {
  const encoded = encodeURIComponent(address);
  return `https://www.zillow.com/homes/${encoded}_rb/`;
}

/**
 * Direct detail URL from a known ZPID.
 */
function buildDetailUrl(zpid: string): string {
  return `https://www.zillow.com/homedetails/${zpid}_zpid/`;
}

/**
 * Zillow's typeahead/suggest endpoint — returns ZPID directly.
 * Confirmed working as of 2024.
 */
function buildTypeaheadUrl(address: string): string {
  const params = new URLSearchParams({
    q:          address,
    resultTypes: "forSaleHomes,recentlySoldHomes,rentalHomes",
    resultCount: "1",
  });
  return `https://www.zillow.com/search/GetSearchPageState.htm?${params}`;
}

// ── Phase 1A: Typeahead API to get ZPID ──────────────────────────────────────

async function resolveZpidViaTypeahead(
  page: Page,
  address: string
): Promise<ResolvedProperty | null> {
  logger.debug(`[zillow-enricher] Typeahead lookup: ${address}`);

  try {
    const url = buildTypeaheadUrl(address);
    const response = await page.evaluate(async (fetchUrl: string) => {
      const res = await fetch(fetchUrl, {
        headers: {
          "Accept": "application/json",
          "Referer": "https://www.zillow.com/",
        },
      });
      if (!res.ok) return null;
      return res.json();
    }, url);

    if (!response) return null;

    const result = extractFromTypeaheadResponse(response, address);
    if (result) {
      logger.debug(`[zillow-enricher] Typeahead resolved: zpid=${result.zpid}`);
      return result;
    }
  } catch (err: any) {
    logger.debug(`[zillow-enricher] Typeahead error: ${err.message}`);
  }

  return null;
}

function extractFromTypeaheadResponse(json: any, address: string): ResolvedProperty | null {
  // Try various response shapes
  const results: any[] = [
    ...(json?.results ?? []),
    ...(json?.cat1?.searchResults?.mapResults ?? []),
    ...(json?.cat1?.searchResults?.listResults ?? []),
    ...(json?.cat2?.searchResults?.mapResults ?? []),
  ];

  if (results.length === 0) return null;

  const inputNorm = normalizeAddress(address.split(",")[0]);
  const best =
    results.find((r) => {
      const addr =
        r?.address ??
        r?.hdpData?.homeInfo?.streetAddress ??
        r?.metaData?.address ??
        "";
      return normalizeAddress(addr).includes(inputNorm);
    }) ?? results[0];

  if (!best) return null;

  const zpid =
    best.zpid ??
    best.metaData?.zpid ??
    best.hdpData?.homeInfo?.zpid;

  if (!zpid) return null;

  const detailUrl =
    best.detailUrl
      ? `https://www.zillow.com${best.detailUrl}`
      : buildDetailUrl(String(zpid));

  return {
    zpid: String(zpid),
    detailUrl,
    zestimate: best.zestimate ? Number(best.zestimate) : undefined,
  };
}

// ── Phase 1B: Navigate to /homes/ADDRESS_rb/ and intercept XHR ───────────────
//
// Key fix: we now also wait for networkidle before giving up on XHR,
// and we attempt extraction from __NEXT_DATA__ more aggressively.

async function searchForProperty(
  page: Page,
  address: string
): Promise<ResolvedProperty | null> {
  logger.debug(`[zillow-enricher] Phase 1B — address search: ${address}`);

  const searchUrl = buildHdpSearchUrl(address);
  logger.debug(`[zillow-enricher] Search URL: ${searchUrl}`);

  let interceptedResult: ResolvedProperty | null = null;

  const handler = async (response: Response) => {
    if (interceptedResult) return;

    const responseUrl = response.url();

    // Match any JSON response that could contain search results
    const isRelevant =
      responseUrl.includes("async-create-search-page-state") ||
      responseUrl.includes("GetSearchPageState") ||
      responseUrl.includes("search/results");

    if (!isRelevant) return;

    try {
      const ct = response.headers()["content-type"] ?? "";
      if (!ct.includes("application/json")) return;

      const json = await response.json().catch(() => null);
      if (!json) return;

      logger.debug(`[zillow-enricher] Intercepted relevant XHR: ${responseUrl}`);

      const result = extractFromMapResults(json, address);
      if (result) {
        interceptedResult = result;
        logger.debug(
          `[zillow-enricher] XHR hit: zpid=${result.zpid} zestimate=${result.zestimate ?? "none"}`
        );
      }
    } catch (err: any) {
      logger.debug(`[zillow-enricher] XHR parse error: ${err.message}`);
    }
  };

  page.on("response", handler);

  try {
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: REQUEST_TIMEOUT_MS,
    });

    // Wait up to 8s for XHR
    const xhrDeadline = Date.now() + 8_000;
    while (!interceptedResult && Date.now() < xhrDeadline) {
      await sleep(300);
    }

    if (interceptedResult) return interceptedResult;

    // Wait for networkidle to ensure all XHRs have fired
    try {
      await page.waitForLoadState("networkidle", { timeout: 12_000 });
    } catch {}

    // One more check after networkidle
    if (interceptedResult) return interceptedResult;

    // ── Fallback: __NEXT_DATA__ ───────────────────────────────────────────
    logger.debug(`[zillow-enricher] XHR not intercepted — checking __NEXT_DATA__: ${address}`);

    const html = await page.content();

    if (html.includes("_pxCaptcha") || html.includes("cf-browser-verification") || html.length < 5_000) {
      logger.warn(`[zillow-enricher] Bot challenge page for: ${address}`);
      saveDebug(`bot_challenge_${Date.now()}`, html);
      return null;
    }

    // Check if we got redirected to an HDP (detail page) — great, parse it directly
    const currentUrl = page.url();
    if (currentUrl.includes("/homedetails/") || currentUrl.match(/\/\d+_zpid\//)) {
      logger.debug(`[zillow-enricher] Redirected to HDP: ${currentUrl}`);
      const zpidMatch = currentUrl.match(/\/(\d+)_zpid/);
      if (zpidMatch) {
        return {
          zpid: zpidMatch[1],
          detailUrl: currentUrl,
          zestimate: undefined,
        };
      }
    }

    const nextData = extractNextData(html);
    if (nextData) {
      // Try search page state first
      const fromSearch = extractFromNextDataSearch(nextData, address);
      if (fromSearch) {
        logger.debug(`[zillow-enricher] Found in __NEXT_DATA__ search: zpid=${fromSearch.zpid}`);
        return fromSearch;
      }

      // Try HDP/detail page state (redirected directly to property)
      const fromHdp = extractZpidFromNextDataHdp(nextData);
      if (fromHdp) {
        logger.debug(`[zillow-enricher] Found in __NEXT_DATA__ HDP: zpid=${fromHdp.zpid}`);
        return fromHdp;
      }
    }

    // DOM fallback
    const domResult = await extractFromDom(page, address);
    if (domResult) {
      logger.debug(`[zillow-enricher] Found in DOM: zpid=${domResult.zpid}`);
      return domResult;
    }

    logger.debug(`[zillow-enricher] No result found for: ${address}`);
    saveDebug(`no_result_${Date.now()}`, html);
    return null;

  } catch (err: any) {
    logger.debug(`[zillow-enricher] Search error: ${err.message}`);
    return null;
  } finally {
    page.off("response", handler);
  }
}

// ── Extract from mapResults ───────────────────────────────────────────────────

function extractFromMapResults(json: any, address: string): ResolvedProperty | null {
  const mapResults: any[] =
    json?.cat1?.searchResults?.mapResults ??
    json?.cat2?.searchResults?.mapResults ??
    [];

  const listResults: any[] =
    json?.cat1?.searchResults?.listResults ??
    json?.cat2?.searchResults?.listResults ??
    [];

  const allResults = [...mapResults, ...listResults];

  if (allResults.length === 0) {
    logger.debug("[zillow-enricher] mapResults + listResults both empty in XHR");
    return null;
  }

  logger.debug(`[zillow-enricher] ${allResults.length} results in XHR`);

  const inputNorm = normalizeAddress(address.split(",")[0]);
  const best =
    allResults.find((r) => {
      const addr = r?.address ?? r?.hdpData?.homeInfo?.streetAddress ?? "";
      return normalizeAddress(addr).includes(inputNorm);
    }) ?? allResults[0];

  if (!best?.zpid) return null;

  const zpid = String(best.zpid);
  const detailUrl = best.detailUrl
    ? `https://www.zillow.com${best.detailUrl}`
    : buildDetailUrl(zpid);

  const zestimate = best.zestimate ?? best.hdpData?.homeInfo?.zestimate;

  return {
    zpid,
    detailUrl,
    zestimate: zestimate ? Number(zestimate) : undefined,
  };
}

// ── Extract ZPID from HDP __NEXT_DATA__ (when page redirects to detail) ───────

function extractZpidFromNextDataHdp(nextData: any): ResolvedProperty | null {
  try {
    // Check gdpClientCache for property data
    const cache =
      nextData?.props?.pageProps?.componentProps?.gdpClientCache ??
      nextData?.props?.pageProps?.gdpClientCache;

    if (cache && typeof cache === "object") {
      for (const key of Object.keys(cache)) {
        const prop = cache[key]?.property;
        if (prop?.zpid) {
          const zpid = String(prop.zpid);
          const result: ResolvedProperty = {
            zpid,
            detailUrl: prop.hdpUrl
              ? `https://www.zillow.com${prop.hdpUrl}`
              : buildDetailUrl(zpid),
            zestimate: prop.zestimate && Number(prop.zestimate) > 1_000
              ? Number(prop.zestimate)
              : undefined,
          };
          return result;
        }
      }
    }

    // Direct property in pageProps
    const prop = nextData?.props?.pageProps?.property;
    if (prop?.zpid) {
      return {
        zpid: String(prop.zpid),
        detailUrl: buildDetailUrl(String(prop.zpid)),
        zestimate: prop.zestimate && Number(prop.zestimate) > 1_000
          ? Number(prop.zestimate)
          : undefined,
      };
    }
  } catch {}

  return null;
}

// ── Extract from __NEXT_DATA__ search page state ──────────────────────────────

function extractFromNextDataSearch(nextData: any, address: string): ResolvedProperty | null {
  const mapResults: any[] =
    nextData?.props?.pageProps?.searchPageState?.cat1?.searchResults?.mapResults ??
    nextData?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults ??
    [];

  if (mapResults.length === 0) return null;

  const inputNorm = normalizeAddress(address.split(",")[0]);
  const best =
    mapResults.find((r) => normalizeAddress(r?.address ?? "").includes(inputNorm)) ??
    mapResults[0];

  if (!best?.zpid) return null;

  return {
    zpid: String(best.zpid),
    detailUrl: best.detailUrl
      ? `https://www.zillow.com${best.detailUrl}`
      : buildDetailUrl(String(best.zpid)),
    zestimate: best.zestimate ? Number(best.zestimate) : undefined,
  };
}

// ── DOM fallback ──────────────────────────────────────────────────────────────

async function extractFromDom(page: Page, address: string): Promise<ResolvedProperty | null> {
  try {
    const result = await page.evaluate((inputAddress: string) => {
      // Check for ZPID in URL
      const urlMatch = window.location.href.match(/\/(\d+)_zpid/);
      if (urlMatch) {
        return {
          zpid: urlMatch[1],
          detailUrl: window.location.href,
          zestimate: undefined as number | undefined,
        };
      }

      const cards = document.querySelectorAll('[data-testid="property-card"]');
      if (!cards.length) return null;

      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      const inputNorm = norm(inputAddress.split(",")[0]);

      let bestCard: Element | null = null;
      cards.forEach((card) => {
        const addrEl = card.querySelector('[data-testid="property-card-address-link"] address');
        if (addrEl && norm(addrEl.textContent ?? "").includes(inputNorm)) {
          bestCard = card;
        }
      });
      if (!bestCard) bestCard = cards[0];
      if (!bestCard) return null;

      const articleId = (bestCard as HTMLElement).id ?? "";
      let zpid = articleId.match(/zpid_(\d+)/)?.[1] ?? null;

      const link = bestCard.querySelector('a[href*="_zpid"]') as HTMLAnchorElement | null;
      const detailUrl = link?.href ?? null;
      if (!zpid && detailUrl) {
        zpid = detailUrl.match(/\/(\d+)_zpid/)?.[1] ?? null;
      }

      if (!zpid) return null;

      return {
        zpid,
        detailUrl: detailUrl ?? `https://www.zillow.com/homedetails/${zpid}_zpid/`,
        zestimate: undefined as number | undefined,
      };
    }, address);

    return result;
  } catch (err: any) {
    logger.debug(`[zillow-enricher] DOM extraction error: ${err.message}`);
    return null;
  }
}

// ── Phase 2: Detail page → zestimate ─────────────────────────────────────────

async function fetchZestimateFromDetailPage(
  page: Page,
  detailUrl: string,
  address: string
): Promise<ZillowData | null> {
  logger.debug(`[zillow-enricher] Phase 2 — detail page: ${detailUrl}`);

  let intercepted: ZillowData | null = null;

  const handler = async (response: Response) => {
    if (intercepted) return;

    const responseUrl = response.url();
    const isGDP = GDP_PATTERNS.some((p) => responseUrl.includes(p));
    if (!isGDP) return;

    try {
      const ct = response.headers()["content-type"] ?? "";
      if (!ct.includes("application/json")) return;

      const json = await response.json().catch(() => null);
      if (!json) return;

      const extracted = extractZestimateFromJson(json);
      if (extracted?.zestimate) {
        intercepted = extracted;
        logger.info(
          `[zillow-enricher] ✓ ${address} → $${extracted.zestimate.toLocaleString()} (detail XHR)`
        );
      }
    } catch {}
  };

  page.on("response", handler);

  try {
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS });

    // Wait up to 10s for GDP XHR
    const xhrDeadline = Date.now() + 10_000;
    while (!intercepted && Date.now() < xhrDeadline) {
      await sleep(300);
    }

    if (intercepted) return intercepted;

    // Wait for networkidle
    try { await page.waitForLoadState("networkidle", { timeout: 10_000 }); } catch {}

    if (intercepted) return intercepted;

    const html = await page.content();
    if (html.length < 5_000 || html.includes("_pxCaptcha")) {
      logger.warn(`[zillow-enricher] Bot challenge on detail page: ${address}`);
      return null;
    }

    // Parse __NEXT_DATA__ from detail page
    const nextData = extractNextData(html);
    if (nextData) {
      const result = extractZestimatesFromNextData(nextData);
      if (result?.zestimate) {
        logger.info(
          `[zillow-enricher] ✓ ${address} → $${result.zestimate.toLocaleString()} (NEXT_DATA)`
        );
        return result;
      }
    }

    // Last resort: scrape the zestimate text from the DOM
    const domZestimate = await scrapeZestimateFromDom(page);
    if (domZestimate) {
      logger.info(
        `[zillow-enricher] ✓ ${address} → $${domZestimate.toLocaleString()} (DOM scrape)`
      );
      return { zestimate: domZestimate };
    }

    logger.debug(`[zillow-enricher] No zestimate on detail page: ${address}`);
    saveDebug(`detail_nozestimate_${Date.now()}`, html);
    return null;

  } catch (err: any) {
    logger.debug(`[zillow-enricher] Detail page error: ${err.message}`);
    return null;
  } finally {
    page.off("response", handler);
  }
}

// ── DOM zestimate scrape ──────────────────────────────────────────────────────

async function scrapeZestimateFromDom(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      // Various selectors Zillow has used for the zestimate display
      const selectors = [
        '[data-testid="zestimate-text"]',
        '[class*="zestimate"] [class*="value"]',
        '[class*="Zestimate"] span',
        'span[class*="zestimate"]',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.textContent) {
          const match = el.textContent.match(/\$[\d,]+/);
          if (match) {
            const val = parseInt(match[0].replace(/[$,]/g, ""), 10);
            if (val > 1_000) return val;
          }
        }
      }

      // Generic search for zestimate value in page text
      const allText = document.body.innerText;
      const zestMatch = allText.match(/Zestimate[^\n$]*\$([\d,]+)/i);
      if (zestMatch) {
        const val = parseInt(zestMatch[1].replace(/,/g, ""), 10);
        if (val > 1_000) return val;
      }

      return null;
    });
  } catch {
    return null;
  }
}

// ── Core per-address fetch ────────────────────────────────────────────────────

async function fetchZestimate(page: Page, address: string): Promise<ZillowData | null> {
  logger.info(`[zillow-enricher] Fetching: ${address}`);

  // Try typeahead first (fast API call, no navigation)
  let resolved = await resolveZpidViaTypeahead(page, address);

  // If typeahead got zestimate directly, we're done
  if (resolved?.zestimate && resolved.zestimate > 1_000) {
    logger.info(`[zillow-enricher] ✓ ${address} → $${resolved.zestimate.toLocaleString()} (typeahead)`);
    return { zestimate: resolved.zestimate, zpid: resolved.zpid, zillowUrl: resolved.detailUrl };
  }

  // If typeahead found ZPID but no zestimate, go straight to detail page
  if (!resolved) {
    // Fall back to navigation-based search
    resolved = await searchForProperty(page, address);
  }

  if (!resolved) {
    logger.debug(`[zillow-enricher] Could not resolve ZPID for: ${address}`);
    return null;
  }

  // If search gave us a zestimate, done
  if (resolved.zestimate && resolved.zestimate > 1_000) {
    logger.info(`[zillow-enricher] ✓ ${address} → $${resolved.zestimate.toLocaleString()} (search)`);
    return { zestimate: resolved.zestimate, zpid: resolved.zpid, zillowUrl: resolved.detailUrl };
  }

  // Phase 2: navigate to detail page
  await sleep(1_200 + Math.random() * 800);
  const data = await fetchZestimateFromDetailPage(page, resolved.detailUrl, address);

  if (!data?.zestimate) {
    logger.debug(`[zillow-enricher] No zestimate found for: ${address}`);
    return null;
  }

  return { ...data, zpid: data.zpid ?? resolved.zpid, zillowUrl: data.zillowUrl ?? resolved.detailUrl };
}

// ── JSON extraction helpers ───────────────────────────────────────────────────

function extractZestimateFromJson(json: any): ZillowData | null {
  const result: ZillowData = {};

  const gqlProperty = json?.data?.property ?? json?.data?.homeDetailsByZpid ?? null;
  if (gqlProperty) {
    applyPropertyFields(result, gqlProperty);
    if (result.zestimate) return result;
  }

  const cache = json?.gdpClientCache ?? json?.props?.pageProps?.componentProps?.gdpClientCache;
  if (cache && typeof cache === "object") {
    for (const key of Object.keys(cache)) {
      const prop = cache[key]?.property;
      if (!prop) continue;
      applyPropertyFields(result, prop);
      if (result.zestimate) return result;
    }
  }

  if (typeof json?.zestimate === "number" && json.zestimate > 1_000) {
    applyPropertyFields(result, json);
    if (result.zestimate) return result;
  }

  // Search result shapes
  const allResults = [
    ...(json?.cat1?.searchResults?.mapResults ?? []),
    ...(json?.cat1?.searchResults?.listResults ?? []),
    ...(json?.cat2?.searchResults?.mapResults ?? []),
  ];
  for (const r of allResults) {
    const z = r?.zestimate ?? r?.hdpData?.homeInfo?.zestimate;
    if (z && Number(z) > 1_000) {
      result.zestimate = Number(z);
      if (r.zpid) result.zpid = String(r.zpid);
      return result;
    }
  }

  const found = deepFind(json, "zestimate", 0);
  if (found !== null) {
    result.zestimate = Number(found);
    return result;
  }

  return null;
}

function applyPropertyFields(result: ZillowData, prop: any): void {
  if (prop.zestimate && Number(prop.zestimate) > 1_000) result.zestimate = Number(prop.zestimate);
  if (prop.zestimateLowPercent && result.zestimate)
    result.zestimateLow = Math.round(result.zestimate * (1 - Number(prop.zestimateLowPercent) / 100));
  if (prop.zestimateHighPercent && result.zestimate)
    result.zestimateHigh = Math.round(result.zestimate * (1 + Number(prop.zestimateHighPercent) / 100));
  if (prop.price)  result.listingPrice = Number(prop.price);
  if (prop.zpid)   result.zpid         = String(prop.zpid);
  if (prop.hdpUrl) result.zillowUrl    = `https://www.zillow.com${prop.hdpUrl}`;
  if (prop.address?.streetAddress) {
    result.matchedAddress = [
      prop.address.streetAddress, prop.address.city,
      prop.address.state, prop.address.zipcode,
    ].filter(Boolean).join(", ");
  }
}

function extractNextData(html: string): any | null {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractZestimatesFromNextData(nextData: any): ZillowData {
  const result: ZillowData = {};
  try {
    // Try gdpClientCache (detail pages)
    const cache =
      nextData?.props?.pageProps?.componentProps?.gdpClientCache ??
      nextData?.props?.pageProps?.gdpClientCache;

    if (cache && typeof cache === "object") {
      for (const key of Object.keys(cache)) {
        const prop = cache[key]?.property;
        if (!prop) continue;
        applyPropertyFields(result, prop);
        if (result.zestimate) return result;
      }
    }

    // Try direct property object
    const directProp = nextData?.props?.pageProps?.property;
    if (directProp) {
      applyPropertyFields(result, directProp);
      if (result.zestimate) return result;
    }
  } catch {}

  if (!result.zestimate) {
    try {
      const found = deepFind(nextData, "zestimate", 0);
      if (found !== null) result.zestimate = Number(found);
    } catch {}
  }

  return result;
}

function deepFind(node: any, key: string, depth: number): any {
  if (depth > 12 || node === null || typeof node !== "object") return null;
  if (key in node && typeof node[key] === "number" && node[key] > 1_000) return node[key];
  for (const k of Object.keys(node)) {
    const found = deepFind(node[k], key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().replace(/[^a-z0-9\s,]/g, "").trim();
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function saveDebug(label: string, content: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `zillow_${label}.html`), content, "utf-8");
  } catch {}
}

function saveDebugJson(label: string, content: any): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `zillow_${label}.json`), JSON.stringify(content, null, 2), "utf-8");
  } catch {}
}

// ── In-memory enrichment (called by runner.ts) ────────────────────────────────

export async function enrichRawListings(listings: RawListing[]): Promise<RawListing[]> {
  const enrichable = listings.filter(
    (l) => l.address && STREET_ADDRESS_REGEX.test(l.address) && !l.zestimate
  );

  if (enrichable.length === 0) {
    logger.info("[zillow-enricher] No enrichable listings — skipping");
    return listings;
  }

  logger.info(`[zillow-enricher] Enriching ${enrichable.length} of ${listings.length} listings`);

  const { page } = await getBrowserContext();
  const zestimateMap = new Map<string, ZillowData>();

  try {
    // Navigate to zillow.com first to establish cookies/session
    logger.debug("[zillow-enricher] Warming up session on zillow.com…");
    try {
      await page.goto("https://www.zillow.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
      await sleep(2_000 + Math.random() * 1_000);
    } catch {}

    for (let i = 0; i < enrichable.length; i++) {
      const listing = enrichable[i];
      logger.info(`[zillow-enricher] [${i + 1}/${enrichable.length}] ${listing.address}`);

      const data = await fetchZestimate(page, listing.address!);
      if (data?.zestimate) zestimateMap.set(listing.address!, data);

      if (i < enrichable.length - 1) {
        const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
        logger.debug(`[zillow-enricher] Waiting ${Math.round(delay / 1_000)}s…`);
        await sleep(delay);
      }
    }
  } finally {
    await page.close();
  }

  const enriched = listings.map((l) => {
    if (!l.address) return l;
    const data = zestimateMap.get(l.address);
    return data?.zestimate ? { ...l, zestimate: data.zestimate } : l;
  });

  logger.info(`[zillow-enricher] Done — ${zestimateMap.size}/${enrichable.length} zestimates found`);
  return enriched;
}

// ── Standalone DB enricher ────────────────────────────────────────────────────

export async function runZillowEnricher(
  options: { limit?: number; dryRun?: boolean } = {}
): Promise<void> {
  const { limit = DEFAULT_BATCH_SIZE, dryRun = false } = options;
  const prisma = new PrismaClient();

  try {
    const listings = await prisma.listing.findMany({
      where:   { zestimate: null, address: { not: null, contains: " " } },
      take:    limit,
      orderBy: { createdAt: "desc" },
    });

    const enrichable = listings.filter(
      (l) => l.address && STREET_ADDRESS_REGEX.test(l.address)
    );

    logger.info(
      `[zillow-enricher] ${enrichable.length} listings to enrich ` +
        `(${listings.length - enrichable.length} skipped — no street number)`
    );

    if (enrichable.length === 0) { logger.info("[zillow-enricher] Nothing to enrich."); return; }

    if (dryRun) {
      enrichable.forEach((l) => logger.info(`  • ${l.address}`));
      return;
    }

    const { page } = await getBrowserContext();
    let enriched = 0, failed = 0;

    try {
      // Warm up session
      logger.debug("[zillow-enricher] Warming up session on zillow.com…");
      try {
        await page.goto("https://www.zillow.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(2_000 + Math.random() * 1_000);
      } catch {}

      for (let i = 0; i < enrichable.length; i++) {
        const listing = enrichable[i];
        logger.info(`[zillow-enricher] [${i + 1}/${enrichable.length}] ${listing.address}`);

        const data = await fetchZestimate(page, listing.address!);
        if (data?.zestimate) {
          await prisma.listing.update({ where: { id: listing.id }, data: { zestimate: data.zestimate } });
          enriched++;
        } else { failed++; }

        if (i < enrichable.length - 1) {
          const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
          logger.debug(`[zillow-enricher] Waiting ${Math.round(delay / 1_000)}s…`);
          await sleep(delay);
        }
      }
    } finally {
      await page.close();
      await closeBrowser();
    }

    logger.info(`[zillow-enricher] Done — ${enriched} enriched, ${failed} failed/not found`);
  } finally {
    await prisma.$disconnect();
  }
}