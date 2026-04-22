// src/enrichers/zillow.enricher.ts
// ─────────────────────────────────────────────────────────────────────────────
// Zillow Zestimate enricher.
//
// Takes listings that already have a street address and fetches the Zillow
// estimated value (Zestimate) for each one. This is an ENRICHER, not a
// primary scraper — it runs after your scrapers have collected listings.
//
// Flow per listing:
//   1. Construct Zillow search URL from the street address
//   2. Navigate with a stealth browser (PerimeterX evasion)
//   3. Extract __NEXT_DATA__ JSON (Next.js data blob — always present)
//   4. Walk JSON tree to find zestimate, price, zpid
//   5. Update the listing record in the DB
//
// Run via:
//   ts-node index.ts --enrich zillow
//   ts-node index.ts --enrich zillow --limit 50   (process max 50 at a time)
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "playwright";
import { logger } from "../../utils/logger";
import { sleep } from "../../utils/browser";
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

chromium.use(StealthPlugin());

// ── Config ─────────────────────────────────────────────────────────────────

// Delay between requests — Zillow rate-limits aggressively
const MIN_DELAY_MS = 8_000;
const MAX_DELAY_MS = 15_000;

// How many listings to enrich per run (avoids long blocking sessions)
const DEFAULT_BATCH_SIZE = 30;

// Only enrich listings that have a real street address (not just "Cleveland, OH")
const STREET_ADDRESS_REGEX = /^\d+\s+\w/;

// ── Zestimate extraction from __NEXT_DATA__ ────────────────────────────────
//
// Zillow embeds ALL page data in <script id="__NEXT_DATA__">.
// The zestimate lives at different paths depending on whether we landed on:
//   A) A search results page (rare — happens when address is ambiguous)
//   B) A property detail page (ideal — direct match)
//
// We try all known paths and return the first value found.

interface ZillowData {
  zestimate?:        number;
  zestimateLow?:     number;
  zestimateHigh?:    number;
  listingPrice?:     number;
  zpid?:             string;
  zillowUrl?:        string;
  matchedAddress?:   string;
}

function extractZestimates(nextData: any): ZillowData {
  if (!nextData) return {};

  const result: ZillowData = {};

  // ── Path 1: Detail page — gdpClientCache ──────────────────────────────
  // This is the most reliable path. Present when you land directly on a
  // property detail page (/homedetails/...).
  try {
    const gdpCache =
      nextData?.props?.pageProps?.componentProps?.gdpClientCache;

    if (gdpCache && typeof gdpCache === "object") {
      // gdpClientCache is keyed by "<zpid>:null"
      for (const key of Object.keys(gdpCache)) {
        const prop = gdpCache[key]?.property;
        if (!prop) continue;

        if (prop.zestimate)   result.zestimate    = Number(prop.zestimate);
        if (prop.zestimateLowPercent)  {
          // zestimateLowPercent is a % like 5 (meaning ±5%)
          // Compute actual low/high from zestimate
          const pct = Number(prop.zestimateLowPercent) / 100;
          if (result.zestimate) {
            result.zestimateLow  = Math.round(result.zestimate * (1 - pct));
            result.zestimateHigh = Math.round(result.zestimate * (1 + pct));
          }
        }
        if (prop.price)        result.listingPrice  = Number(prop.price);
        if (prop.zpid)         result.zpid          = String(prop.zpid);
        if (prop.hdpUrl)       result.zillowUrl     = `https://www.zillow.com${prop.hdpUrl}`;
        if (prop.address?.streetAddress) {
          result.matchedAddress = [
            prop.address.streetAddress,
            prop.address.city,
            prop.address.state,
            prop.address.zipcode,
          ].filter(Boolean).join(", ");
        }

        if (result.zestimate) break; // found what we need
      }
    }
  } catch {}

  if (result.zestimate) return result;

  // ── Path 2: Search results page — first result's zestimate ───────────
  // Happens when the address search returns a list rather than a direct match.
  try {
    const searchState =
      nextData?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;

    if (Array.isArray(searchState) && searchState.length > 0) {
      const first = searchState[0];
      if (first?.zestimate)    result.zestimate    = Number(first.zestimate);
      if (first?.unformattedPrice) result.listingPrice = Number(first.unformattedPrice);
      if (first?.zpid)         result.zpid         = String(first.zpid);
      if (first?.detailUrl)    result.zillowUrl    = `https://www.zillow.com${first.detailUrl}`;
      if (first?.address)      result.matchedAddress = first.address;
    }
  } catch {}

  if (result.zestimate) return result;

  // ── Path 3: Deep scan — walk the entire JSON tree ─────────────────────
  // Last resort: recursively search for a "zestimate" key anywhere in the tree.
  try {
    const found = deepFind(nextData, "zestimate", 0);
    if (found !== null && found !== undefined) {
      result.zestimate = Number(found);
    }
  } catch {}

  return result;
}

function deepFind(node: any, key: string, depth: number): any {
  if (depth > 12 || node === null || typeof node !== "object") return null;
  if (key in node && typeof node[key] === "number" && node[key] > 1000) {
    return node[key];
  }
  for (const k of Object.keys(node)) {
    const found = deepFind(node[k], key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// ── Build Zillow search URL from address ───────────────────────────────────

function buildZillowUrl(address: string): string {
  // Zillow accepts addresses in the URL slug format:
  // https://www.zillow.com/homes/123-Main-St,-Columbus,-OH_rb/
  const slug = address
    .replace(/[,]/g, "")          // remove commas
    .replace(/\s+/g, "-")         // spaces → hyphens
    .replace(/[^a-zA-Z0-9-]/g, "") // strip special chars
    .replace(/-+/g, "-");          // collapse multiple hyphens

  return `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;
}

// ── Browser setup ──────────────────────────────────────────────────────────

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1440,900",
    ],
  }) as unknown as Browser;
}

async function setupPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
    Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages",  { get: () => ["en-US", "en"] });
    (window as any).chrome = { runtime: {} };
  });

  await page.setExtraHTTPHeaders({
    "Accept-Language":           "en-US,en;q=0.9",
    "Accept":                    "text/html,application/xhtml+xml,*/*;q=0.8",
    "Sec-Fetch-Dest":            "document",
    "Sec-Fetch-Mode":            "navigate",
    "Sec-Fetch-Site":            "none",
    "Upgrade-Insecure-Requests": "1",
  });
}

// ── Fetch zestimate for one address ───────────────────────────────────────

async function fetchZestimate(
  page: Page,
  address: string
): Promise<ZillowData | null> {
  const url = buildZillowUrl(address);
  logger.info(`[zillow-enricher] Fetching: ${address}`);
  logger.debug(`[zillow-enricher] URL: ${url}`);

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout:   45_000,
    });

    // Check for block / CAPTCHA
    const status = response?.status() ?? 0;
    if (status === 403 || status === 429) {
      logger.warn(`[zillow-enricher] Blocked (HTTP ${status}) for: ${address}`);
      return null;
    }

    // Short wait for JS to hydrate
    await sleep(2000 + Math.random() * 1500);

    // Extract __NEXT_DATA__
    const nextDataRaw = await page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      return el ? el.textContent : null;
    });

    if (!nextDataRaw) {
      // Check if we hit a CAPTCHA or block page
      const title = await page.title();
      if (title.toLowerCase().includes("captcha") || title.toLowerCase().includes("robot")) {
        logger.warn(`[zillow-enricher] CAPTCHA detected for: ${address}`);
      } else {
        logger.debug(`[zillow-enricher] No __NEXT_DATA__ found for: ${address} (title: ${title})`);
      }
      return null;
    }

    const nextData = JSON.parse(nextDataRaw);
    const result   = extractZestimates(nextData);

    if (result.zestimate) {
      logger.info(
        `[zillow-enricher] ✓ ${address} → Zestimate: $${result.zestimate.toLocaleString()}` +
        (result.listingPrice ? ` | Listed: $${result.listingPrice.toLocaleString()}` : "")
      );
    } else {
      logger.debug(`[zillow-enricher] No zestimate found for: ${address}`);
      // Save debug HTML so you can inspect what Zillow returned
      saveDebug(await page.content(), `no_zestimate_${Date.now()}`);
    }

    return result;
  } catch (err: any) {
    logger.error(`[zillow-enricher] Error fetching ${address}: ${err.message}`);
    return null;
  }
}

// ── Main enricher ──────────────────────────────────────────────────────────

export async function runZillowEnricher(options: {
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<void> {
  const { limit = DEFAULT_BATCH_SIZE, dryRun = false } = options;

  const prisma = new PrismaClient();
  let browser: Browser | undefined;

  try {
    // Fetch listings that have a street address but no zestimate yet
    const listings = await prisma.listing.findMany({
      where: {
        zestimate:    null,         // not yet enriched
        address: {
          not:       null,
          contains:  " ",           // must have at least one space (rules out bare city names)
        },
      },
      take:    limit,
      orderBy: { createdAt: "desc" },
    });

    // Filter to listings with a proper street address (starts with a number)
    const enrichable = listings.filter(
      (l) => l.address && STREET_ADDRESS_REGEX.test(l.address)
    );

    logger.info(
      `[zillow-enricher] ${enrichable.length} listings to enrich ` +
      `(${listings.length - enrichable.length} skipped — no street number)`
    );

    if (enrichable.length === 0) {
      logger.info("[zillow-enricher] Nothing to enrich.");
      return;
    }

    if (dryRun) {
      logger.info("[zillow-enricher] DRY RUN — addresses that would be looked up:");
      enrichable.forEach((l) => logger.info(`  • ${l.address}`));
      return;
    }

    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport:   { width: 1440, height: 900 },
      locale:     "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    await setupPage(page);

    let enriched = 0;
    let failed   = 0;

    for (let i = 0; i < enrichable.length; i++) {
      const listing = enrichable[i];
      logger.info(
        `[zillow-enricher] [${i + 1}/${enrichable.length}] ${listing.address}`
      );

      const data = await fetchZestimate(page, listing.address!);

      if (data?.zestimate) {
        // Update the DB record
        await prisma.listing.update({
          where: { id: listing.id },
          data: {
            zestimate:      data.zestimate,
            // Store low/high in description or a notes field if your schema supports it
            // zestimateLow:  data.zestimateLow,
            // zestimateHigh: data.zestimateHigh,
          },
        });
        enriched++;
      } else {
        failed++;
      }

      // Rate-limit between requests
      if (i < enrichable.length - 1) {
        const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
        logger.debug(
          `[zillow-enricher] Waiting ${Math.round(delay / 1000)}s before next request…`
        );
        await sleep(delay);
      }
    }

    await context.close();

    logger.info(
      `[zillow-enricher] Done — ${enriched} enriched, ${failed} failed/not found`
    );
  } finally {
    await browser?.close();
    await prisma.$disconnect();
  }
}

// ── Debug helper ──────────────────────────────────────────────────────────

function saveDebug(html: string, label: string) {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `zillow_enricher_${label}.html`), html);
  } catch {}
}