// src/scrapers/offmarket/offmarket.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// offmarket.com runs the ListingPro WordPress theme.
//
// Every property card is a div with data-* attributes that carry all fields:
//   data-posturl       → listing URL
//   data-title         → listing title
//   data-raw-price     → "$99,900"
//   data-bed           → "3"
//   data-bath          → "2"
//   data-buildingsqft  → "1,750"
//
// Property type: .listing_price_tag.grid_price_tag ("Single Family" etc.)
// Address:       .text.gaddress span (minus the "View Address" link)
//
// Pagination: AJAX "Load More" button — not page URLs.
// The scraper triggers the AJAX endpoint directly for pages 2+.
//
// Date extraction:
//   Cards:       data-date attr → time[datetime] → .listing-date / .date-posted text
//   Detail page: time[datetime] → meta[property="article:published_time"] →
//                .listing-date / .date-posted / [class*='date'] text
//
// State extraction:
//   Used by the location filter in the scraper.
//   Sources (in priority order):
//     1. Parsed from address text — "City, ST 00000" pattern
//     2. Parsed from the listing URL slug — "-oh-" / "-wi-" etc.
//     3. Parsed from page <title> or meta description
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

const BASE = "https://www.offmarket.com";

// Known US state slugs used in URL matching (lowercase abbr → uppercase)
const STATE_SLUG_MAP: Record<string, string> = {
  oh: "OH", wi: "WI", fl: "FL", tx: "TX", pa: "PA", il: "IL",
  ga: "GA", nc: "NC", mi: "MI", tn: "TN", al: "AL", sc: "SC",
  va: "VA", mo: "MO", in: "IN", ky: "KY", az: "AZ", nv: "NV",
  ca: "CA", ny: "NY", nj: "NJ", md: "MD", co: "CO", wa: "WA",
  or: "OR", mn: "MN", ia: "IA", ks: "KS", ne: "NE", ok: "OK",
  ar: "AR", ms: "MS", la: "LA", wv: "WV", ct: "CT", ma: "MA",
  ri: "RI", nh: "NH", vt: "VT", me: "ME", de: "DE", id: "ID",
  mt: "MT", wy: "WY", sd: "SD", nd: "ND", nm: "NM", ut: "UT",
  ak: "AK", hi: "HI",
};

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/[$,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

function detectPropertyType(text: string): PropertyType {
  const t = text.toLowerCase();
  if (t.includes("single family") || t.includes("sfh")) return "single_family";
  if (t.includes("duplex")) return "duplex";
  if (t.includes("multi-family") || t.includes("multifamily") || t.includes("triplex"))
    return "multi_family";
  if (t.includes("condo")) return "condo";
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
 * Extract a US state abbreviation from plain text.
 * Matches the "City, ST 00000" or "City, ST" pattern.
 */
export function extractStateFromText(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/,\s*([A-Z]{2})(?:\s+\d{5})?/);
  return m ? m[1].toUpperCase() : undefined;
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
    // Match "-xx-DIGITS" (city-state-zip) or "-xx/" (city-state at end)
    if (
      new RegExp(`-${abbr}-\\d`).test(slug) ||
      new RegExp(`-${abbr}/`).test(slug) ||
      new RegExp(`-${abbr}$`).test(slug)
    ) {
      return upper;
    }
  }
  return undefined;
}

/**
 * Extract city name from an address string like "Cleveland, OH 44101".
 */
function extractCityFromText(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/([A-Za-z\s]+),\s*[A-Z]{2}(?:\s+\d{5})?/);
  return m ? m[1].trim() : undefined;
}

/**
 * Attempt to extract a listing date from a card element.
 * Tries (in order):
 *   1. data-date attribute
 *   2. <time datetime="…"> inside the card
 *   3. Text content of .listing-date / .date-posted / time elements
 */
function extractCardDate(
  card: cheerio.Cheerio<Element>,
  $: cheerio.CheerioAPI
): string | undefined {
  const dataDate = card.attr("data-date");
  if (dataDate?.trim()) return dataDate.trim();

  const timeEl = card.find("time[datetime]").first();
  const datetime = timeEl.attr("datetime");
  if (datetime?.trim()) return datetime.trim();

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

      const title = card.attr("data-title") ?? undefined;
      const price = parsePrice(card.attr("data-raw-price"));

      const bedRaw  = card.attr("data-bed") ?? "";
      const bathRaw = card.attr("data-bath") ?? "";
      const sqftRaw = card.attr("data-buildingsqft") ?? "";

      const bedrooms   = bedRaw  !== "" ? parseInt(bedRaw, 10)  || undefined : undefined;
      const bathrooms  = bathRaw !== "" ? parseFloat(bathRaw)   || undefined : undefined;
      const squareFeet = sqftRaw !== ""
        ? parseInt(sqftRaw.replace(/,/g, ""), 10) || undefined
        : undefined;

      const addressEl = card.find(".text.gaddress, .gaddress").first();
      addressEl.find("a").remove();
      const address = addressEl.text().trim() || title || undefined;

      const typeEl = card.find(".listing_price_tag, .grid_price_tag").first();
      const propertyType = typeEl.length
        ? detectPropertyType(typeEl.text().trim())
        : "unknown";

      // State: address text first, then URL slug fallback
      const state =
        extractStateFromText(address ?? "") ??
        extractStateFromUrl(url);

      const city = address ? extractCityFromText(address) : undefined;

      const listedDateStr = extractCardDate(card, $);
      const listedDate = listedDateStr ? new Date(listedDateStr).getTime() : undefined;

      results.push({
        url, title, price, address, propertyType,
        bedrooms, bathrooms, squareFeet,
        listedDate, state, city,
      });
    });

    logger.debug(`[om-parser] ${results.length} listings parsed`);
    return results;
  }

  // Fallback: /listing/ link patterns
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
    });
  });

  if (results.length === 0) {
    const title = $("title").text();
    logger.warn(`[om-parser] No listings found. Page title: "${title}"`);
  }

  return results;
}

// ── Pagination metadata ────────────────────────────────────────────────────

export interface PaginationInfo {
  totalFound: number;
  loadMorePage: number;   // current "page" the button is on
  totalRecords: number;   // total listings available
  randNumber: string;     // nonce-like value needed for AJAX call
  listedIds: string;      // comma-separated IDs already on page
  hasMore: boolean;
}

export function extractPaginationInfo(html: string): PaginationInfo {
  const $ = cheerio.load(html);

  const totalFound =
    parseInt($(".showingString").first().text().trim(), 10) || 0;

  const btn = $(".loadMoreListing").first();
  const loadMorePage  = parseInt(btn.attr("data-page")         ?? "1", 10);
  const totalRecords  = parseInt(btn.attr("data-total-record") ?? "0", 10);
  const randNumber    = btn.attr("data-rand-number") ?? "";

  // Try multiple selectors — the hidden input may have different IDs/names
  const listedIds =
    ($("#listed_listing_id").val()                       as string) ??
    ($("input[name='listed_listing_id']").val()          as string) ??
    ($("input[name='listed-listing-id']").val()          as string) ??
    btn.attr("data-listed-ids")                          ??
    "";

  logger.debug(
    `[om-parser] Pagination — loadMorePage:${loadMorePage} ` +
    `total:${totalRecords} nonce:"${randNumber}" ` +
    `listedIds chars:${listedIds.length}`
  );

  const currentCount = $("[data-posturl]").length;
  const hasMore = btn.length > 0 && currentCount < totalRecords;

  return { totalFound, loadMorePage, totalRecords, randNumber, listedIds, hasMore };
}

// ── Detail page ────────────────────────────────────────────────────────────

export interface OffmarketDetail {
  description?: string;
  address?: string;
  location?: string;
  propertyType?: PropertyType;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  ownerName?: string;
  ownerPhone?: string;
  listedDate?: string;
  state?: string;
  city?: string;
}

export function parseOffmarketDetailPage(html: string): OffmarketDetail {
  const $ = cheerio.load(html);

  const descEl = $(
    ".lp-listing-desription, .lp-listing-description, .listing-desc"
  ).first();
  const description = descEl.text().trim() || undefined;

  // Try every address-like element, from most specific to broadest
  const addrEl = $(
    ".propertyAddress, .lp-listing-address, " +
    ".lp-listing-location, address, h1.lp-listing-name"
  ).first();
  const address = addrEl.text().trim() || undefined;

  const locEl = $(".text.gaddress, .lp-listing-location").first();
  locEl.find("a").remove();
  const location = locEl.text().trim() || undefined;

  const typeEl = $(".listing_price_tag, .grid_price_tag, .propertyFor").first();
  const propertyType = typeEl.text().trim()
    ? detectPropertyType(typeEl.text())
    : detectPropertyType($("body").text());

  const specsText = $(".pFormFieldsWrap, .pFormFields").text().toLowerCase();
  const bedsM = specsText.match(/(\d+)\s*(?:bd|bed|br)/i);
  const bathsM = specsText.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath)/i);
  const sqftM  = specsText.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft)/i);

  const bedrooms   = bedsM ? parseInt(bedsM[1], 10) : undefined;
  const bathrooms  = bathsM ? parseFloat(bathsM[1]) : undefined;
  const squareFeet = sqftM  ? parseInt(sqftM[1].replace(/,/g, ""), 10) : undefined;

  const contactText = $(
    ".lp-listing-leadform, [class*='contact'], [class*='agent']"
  ).text();
  const phoneMatch = contactText.match(
    /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  );
  const ownerPhone = phoneMatch ? phoneMatch[0].trim() : undefined;
  const nameMatch  = contactText.match(
    /(?:contact|seller|owner|agent|listed by)[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i
  );
  const ownerName = nameMatch ? nameMatch[1].trim() : undefined;

  // ── Date extraction ──────────────────────────────────────────────────────
  let listedDate: string | undefined;

  const timeEl   = $("time[datetime]").first();
  const datetime = timeEl.attr("datetime");
  if (datetime?.trim()) listedDate = datetime.trim();

  if (!listedDate) {
    const metaPub =
      $("meta[property='article:published_time']").attr("content") ??
      $("meta[name='date']").attr("content");
    if (metaPub?.trim()) listedDate = metaPub.trim();
  }

  if (!listedDate) {
    const dateEl = $(
      ".listing-date, .date-posted, .lp-listing-date, " +
      "[class*='date-listed'], [class*='listed-date']"
    ).first();
    const text = dateEl.text().trim();
    if (text) listedDate = text;
  }

  // ── State / city extraction ──────────────────────────────────────────────
  // Try candidates from most reliable to broadest
  const candidates = [
    address,
    location,
    $("meta[name='description']").attr("content"),
    $("script[type='application/ld+json']").text(),
    $("title").text(),
  ];

  let state: string | undefined;
  let city: string | undefined;

  for (const c of candidates) {
    if (!c) continue;
    const s = extractStateFromText(c);
    if (s) {
      state = s;
      city  = extractCityFromText(c);
      break;
    }
  }

  return {
    description, address, location, propertyType,
    bedrooms, bathrooms, squareFeet,
    ownerName, ownerPhone,
    listedDate, state, city,
  };
}