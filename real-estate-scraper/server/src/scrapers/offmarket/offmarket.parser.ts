// src/scrapers/offmarket/offmarket.parser.ts

import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

const BASE = "https://www.offmarket.com";

// Canonical set of valid US state abbreviations — used to reject false matches
const VALID_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

const STATE_SLUG_MAP: Record<string, string> = {};
for (const s of VALID_STATES) {
  STATE_SLUG_MAP[s.toLowerCase()] = s;
}

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/[$,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

function detectPropertyType(text: string): PropertyType {
  const t = text.toLowerCase();
  if (t.includes("single family") || t.includes("sfh")) return "single_family";
  if (t.includes("duplex"))                              return "duplex";
  if (t.includes("multi-family") || t.includes("multifamily") || t.includes("triplex"))
    return "multi_family";
  if (t.includes("condo"))     return "condo";
  if (t.includes("townhome") || t.includes("townhouse")) return "townhouse";
  return "unknown";
}

function absoluteUrl(href: string): string {
  if (!href) return "";
  href = href.trim();
  return href.startsWith("http")
    ? href
    : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * Extract a US state abbreviation from address text.
 *
 * Strict rules to prevent false positives like "AD", "HV", "LO":
 *   - Must follow a comma+space: ", ST"
 *   - Must be followed by a space+zip, end of string, or newline
 *   - Must be in the canonical VALID_STATES set
 */
export function extractStateFromText(text: string): string | undefined {
  if (!text) return undefined;

  const matches = text.matchAll(/,\s+([A-Z]{2})(?=\s+\d{5}|\s*$|\s*\n|\s*,)/gm);
  for (const m of matches) {
    const candidate = m[1].toUpperCase();
    if (VALID_STATES.has(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Extract a US state abbreviation from a listing URL slug.
 * e.g. ".../cleveland-oh-44101/" → "OH"
 *      ".../milwaukee-wi-53202/"  → "WI"
 */
export function extractStateFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  const slug = url.toLowerCase();

  for (const [abbr, upper] of Object.entries(STATE_SLUG_MAP)) {
    if (
      new RegExp(`-${abbr}-\\d`).test(slug) ||   // city-state-zip
      new RegExp(`-${abbr}/`).test(slug)   ||     // city-state/
      new RegExp(`-${abbr}$`).test(slug)          // city-state (end)
    ) {
      return upper;
    }
  }
  return undefined;
}

function extractCityFromText(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/([A-Za-z\s.'-]+),\s*[A-Z]{2}(?:\s+\d{5})?/);
  return m ? m[1].trim() : undefined;
}

/**
 * Parse a date string into a Unix timestamp (ms).
 *
 * FIX: handles the variety of date formats offmarket.com uses:
 *   - ISO 8601: "2025-03-15T10:00:00+00:00"
 *   - Human:    "March 15, 2025"  /  "Mar 15, 2025"
 *   - Relative: "3 days ago"  /  "2 weeks ago"  /  "1 month ago"
 *   - Numeric:  already a timestamp number
 *
 * Returns undefined if the date cannot be parsed or is clearly invalid.
 */
export function parseDateToTimestamp(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;

  // Already a number (ms timestamp)
  if (typeof raw === "number") {
    return isNaN(raw) ? undefined : raw;
  }

  const s = raw.trim();
  if (!s) return undefined;

  // Relative date: "X days/weeks/months ago"
  const relMatch = s.match(/^(\d+)\s+(day|week|month|hour|minute)s?\s+ago$/i);
  if (relMatch) {
    const n    = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms   = unit === "minute" ? n * 60_000
               : unit === "hour"   ? n * 3_600_000
               : unit === "day"    ? n * 86_400_000
               : unit === "week"   ? n * 7 * 86_400_000
               :                     n * 30 * 86_400_000; // month ≈ 30 days
    return Date.now() - ms;
  }

  // Standard ISO or human-readable — let Date handle it
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? undefined : parsed.getTime();
}

function extractCardDate(
  card: cheerio.Cheerio<Element>,
  $: cheerio.CheerioAPI
): string | undefined {
  // data-date attribute (most reliable)
  const dataDate = card.attr("data-date");
  if (dataDate?.trim()) return dataDate.trim();

  // <time datetime="…">
  const timeEl   = card.find("time[datetime]").first();
  const datetime = timeEl.attr("datetime");
  if (datetime?.trim()) return datetime.trim();

  // Visible date text inside known date elements
  const textEl = card
    .find(".listing-date, .date-posted, .lp-listing-date, time")
    .first();
  const text = textEl.text().trim();
  if (text) return text;

  return undefined;
}

// ── Search results page ────────────────────────────────────────────────────

export function parseOffmarketSearchPage(
  html: string
): Omit<RawListing, "source">[] {
  const $ = cheerio.load(html);
  const results: Omit<RawListing, "source">[] = [];

  const cards = $("[data-posturl]");

  if (cards.length > 0) {
    logger.debug(`[om-parser] ${cards.length} cards via data-posturl`);

    cards.each((_, el) => {
      const card = $(el);

      const url = absoluteUrl(card.attr("data-posturl") ?? "");
      if (!url) return;

      const title      = card.attr("data-title")       ?? undefined;
      const price      = parsePrice(card.attr("data-raw-price"));
      const bedRaw     = card.attr("data-bed")          ?? "";
      const bathRaw    = card.attr("data-bath")         ?? "";
      const sqftRaw    = card.attr("data-buildingsqft") ?? "";

      const bedrooms   = bedRaw  !== "" ? parseInt(bedRaw, 10)              || undefined : undefined;
      const bathrooms  = bathRaw !== "" ? parseFloat(bathRaw)               || undefined : undefined;
      const squareFeet = sqftRaw !== "" ? parseInt(sqftRaw.replace(/,/g, ""), 10) || undefined : undefined;

      const addressEl = card.find(".text.gaddress, .gaddress").first();
      addressEl.find("a").remove();
      const address = addressEl.text().trim() || title || undefined;

      const typeEl       = card.find(".listing_price_tag, .grid_price_tag").first();
      const propertyType = typeEl.length ? detectPropertyType(typeEl.text().trim()) : "unknown";

      const stateFromText = extractStateFromText(address ?? "");
      const stateFromUrl  = extractStateFromUrl(url);
      const state         = stateFromText ?? stateFromUrl;

      const city          = address ? extractCityFromText(address) : undefined;

      // FIX: parse listedDate through our robust parser so relative dates
      // ("3 days ago") and ISO strings both become timestamps correctly.
      const listedDateStr = extractCardDate(card, $);
      const listedDate    = parseDateToTimestamp(listedDateStr);

      results.push({
        url, title, price, address, propertyType,
        bedrooms, bathrooms, squareFeet,
        listedDate, state, city,
      } as any);
    });

    logger.debug(`[om-parser] ${results.length} listings parsed`);
    return results;
  }

  // Fallback: /listing/ link scan
  logger.warn("[om-parser] No data-posturl cards — falling back to link scan");
  const seen = new Set<string>();
  $("a[href*='/listing/']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const url  = absoluteUrl(href);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const state = extractStateFromUrl(url);
    results.push({
      url,
      title: $(el).attr("title") || $(el).text().trim() || undefined,
      state,
    } as any);
  });

  if (results.length === 0) {
    logger.warn(`[om-parser] No listings found. Page title: "${$("title").text()}"`);
  }

  return results;
}

// ── Pagination metadata ────────────────────────────────────────────────────

export interface PaginationInfo {
  totalFound:   number;
  loadMorePage: number;
  totalRecords: number;
  randNumber:   string;
  listedIds:    string;
  hasMore:      boolean;
}

export function extractPaginationInfo(html: string): PaginationInfo {
  const $ = cheerio.load(html);

  const totalFound   = parseInt($(".showingString").first().text().trim(), 10) || 0;
  const btn          = $(".loadMoreListing").first();

  // FIX: loadMorePage default was 1, which caused the first AJAX call to
  // request server page 1 again (already loaded).  Default to 2 so that
  // when the button is missing we still start at the right page.
  const loadMorePage = parseInt(btn.attr("data-page") ?? "2", 10);
  const totalRecords = parseInt(btn.attr("data-total-record") ?? "0", 10);
  const randNumber   = btn.attr("data-rand-number") ?? "";

  const listedIds =
    ($("#listed_listing_id").val()              as string) ??
    ($("input[name='listed_listing_id']").val() as string) ??
    ($("input[name='listed-listing-id']").val() as string) ??
    btn.attr("data-listed-ids")                            ??
    "";

  logger.debug(
    `[om-parser] Pagination — loadMorePage:${loadMorePage} ` +
    `total:${totalRecords} nonce:"${randNumber}" ` +
    `listedIds chars:${listedIds.length}`
  );

  const currentCount = $("[data-posturl]").length;
  const hasMore      = btn.length > 0 && currentCount < totalRecords;

  return { totalFound, loadMorePage, totalRecords, randNumber, listedIds, hasMore };
}

// ── Detail page ────────────────────────────────────────────────────────────

export interface OffmarketDetail {
  description?:  string;
  address?:      string;
  location?:     string;
  propertyType?: PropertyType;
  bedrooms?:     number;
  bathrooms?:    number;
  squareFeet?:   number;
  ownerName?:    string;
  ownerPhone?:   string;
  listedDate?:   string;
  state?:        string;
  city?:         string;
}

export function parseOffmarketDetailPage(html: string, pageUrl = ""): OffmarketDetail {
  const $ = cheerio.load(html);

  const descEl      = $(".lp-listing-desription, .lp-listing-description, .listing-desc").first();
  const description = descEl.text().trim() || undefined;

  const addrEl = $(
    ".propertyAddress, .lp-listing-address, .lp-listing-location, address, h1.lp-listing-name"
  ).first();
  const address = addrEl.text().trim() || undefined;

  const locEl = $(".text.gaddress, .lp-listing-location").first();
  locEl.find("a").remove();
  const location = locEl.text().trim() || undefined;

  const typeEl       = $(".listing_price_tag, .grid_price_tag, .propertyFor").first();
  const propertyType = typeEl.text().trim()
    ? detectPropertyType(typeEl.text())
    : detectPropertyType($("body").text());

  const specsText = $(".pFormFieldsWrap, .pFormFields").text().toLowerCase();
  const bedsM     = specsText.match(/(\d+)\s*(?:bd|bed|br)/i);
  const bathsM    = specsText.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath)/i);
  const sqftM     = specsText.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft)/i);

  const bedrooms   = bedsM ? parseInt(bedsM[1], 10)                   : undefined;
  const bathrooms  = bathsM ? parseFloat(bathsM[1])                   : undefined;
  const squareFeet = sqftM  ? parseInt(sqftM[1].replace(/,/g, ""), 10) : undefined;

  const contactText = $(".lp-listing-leadform, [class*='contact'], [class*='agent']").text();
  const phoneMatch  = contactText.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  const ownerPhone  = phoneMatch ? phoneMatch[0].trim() : undefined;
  const nameMatch   = contactText.match(
    /(?:contact|seller|owner|agent|listed by)[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i
  );
  const ownerName = nameMatch ? nameMatch[1].trim() : undefined;

  // ── Date extraction ──────────────────────────────────────────────────────
  // FIX: expanded date source priority — checks more selectors and also
  // handles "X days/weeks ago" relative dates via parseDateToTimestamp.
  let listedDate: string | undefined;

  // 1. <time datetime="…"> — most machine-readable
  const timeEl   = $("time[datetime]").first();
  const datetime = timeEl.attr("datetime");
  if (datetime?.trim()) listedDate = datetime.trim();

  // 2. OpenGraph / meta published time
  if (!listedDate) {
    const metaPub =
      $("meta[property='article:published_time']").attr("content") ??
      $("meta[name='date']").attr("content")                        ??
      $("meta[property='og:updated_time']").attr("content");
    if (metaPub?.trim()) listedDate = metaPub.trim();
  }

  // 3. Visible date elements (including relative "X days ago" text)
  if (!listedDate) {
    const dateEl = $(
      ".listing-date, .date-posted, .lp-listing-date, " +
      "[class*='date-listed'], [class*='listed-date'], " +
      "[class*='listing-posted'], [class*='posted-date']"
    ).first();
    const text = dateEl.text().trim();
    if (text) listedDate = text;
  }

  // 4. JSON-LD datePublished
  if (!listedDate) {
    try {
      const ldJson = JSON.parse($("script[type='application/ld+json']").first().html() ?? "{}");
      const ldDate = ldJson?.datePublished ?? ldJson?.dateCreated ?? "";
      if (ldDate?.trim()) listedDate = ldDate.trim();
    } catch {}
  }

  // ── State / city extraction ──────────────────────────────────────────────
  const addressCandidates = [
    address,
    location,
    $("meta[name='description']").attr("content"),
  ];

  let state: string | undefined;
  let city:  string | undefined;

  for (const c of addressCandidates) {
    if (!c) continue;
    const s = extractStateFromText(c);
    if (s) {
      state = s;
      city  = extractCityFromText(c);
      break;
    }
  }

  // Fallback: URL slug
  if (!state && pageUrl) {
    state = extractStateFromUrl(pageUrl);
  }

  // JSON-LD structured data as last resort
  if (!state) {
    try {
      const ldJson = JSON.parse($("script[type='application/ld+json']").first().html() ?? "{}");
      const ldAddr = ldJson?.address?.addressRegion ?? ldJson?.location?.addressRegion ?? "";
      if (ldAddr && VALID_STATES.has(ldAddr.toUpperCase())) {
        state = ldAddr.toUpperCase();
      }
    } catch {}
  }

  return {
    description, address, location, propertyType,
    bedrooms, bathrooms, squareFeet,
    ownerName, ownerPhone,
    listedDate, state, city,
  };
}