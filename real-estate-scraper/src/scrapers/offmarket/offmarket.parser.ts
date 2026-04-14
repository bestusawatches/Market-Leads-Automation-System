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
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

const BASE = "https://www.offmarket.com";

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/[$,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

function detectPropertyType(text: string): PropertyType {
  const t = text.toLowerCase();
  if (t.includes("single family") || t.includes("sfh")) return "single_family";
  if (t.includes("duplex")) return "duplex";
  if (t.includes("multi-family") || t.includes("multifamily") || t.includes("triplex")) return "multi_family";
  if (t.includes("condo")) return "condo";
  if (t.includes("townhome") || t.includes("townhouse")) return "townhouse";
  return "unknown";
}

function absoluteUrl(href: string): string {
  if (!href) return "";
  href = href.trim();
  return href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;
}

// ── Search results page ────────────────────────────────────────────────────

export function parseOffmarketSearchPage(
  html: string
): Omit<RawListing, "source">[] {
  const $ = cheerio.load(html);
  const results: Omit<RawListing, "source">[] = [];

  // Primary: data-posturl cards (confirmed present in real HTML)
  const cards = $("[data-posturl]");

  if (cards.length > 0) {
    logger.debug(`[om-parser] ${cards.length} cards via data-posturl`);

    cards.each((_, el) => {
      const card = $(el);

      const url = absoluteUrl(card.attr("data-posturl") ?? "");
      if (!url) return;

      const title = card.attr("data-title") ?? undefined;
      const price = parsePrice(card.attr("data-raw-price"));

      const bedRaw = card.attr("data-bed") ?? "";
      const bathRaw = card.attr("data-bath") ?? "";
      const sqftRaw = card.attr("data-buildingsqft") ?? "";

      const bedrooms = bedRaw !== "" ? parseInt(bedRaw, 10) || undefined : undefined;
      const bathrooms = bathRaw !== "" ? parseFloat(bathRaw) || undefined : undefined;
      const squareFeet = sqftRaw !== ""
        ? parseInt(sqftRaw.replace(/,/g, ""), 10) || undefined
        : undefined;

      // Address from .text.gaddress — remove "View Address" link first
      const addressEl = card.find(".text.gaddress, .gaddress").first();
      addressEl.find("a").remove();
      const address = addressEl.text().trim() || title || undefined;

      // Property type from the badge overlay on the thumbnail
      const typeEl = card.find(".listing_price_tag, .grid_price_tag").first();
      const propertyType = typeEl.length
        ? detectPropertyType(typeEl.text().trim())
        : "unknown";

      results.push({ url, title, price, address, propertyType, bedrooms, bathrooms, squareFeet });
    });

    logger.debug(`[om-parser] ${results.length} listings parsed`);
    return results;
  }

  // Fallback: /listing/ link patterns
  logger.warn("[om-parser] No data-posturl cards — falling back to link scan");
  const seen = new Set<string>();
  $("a[href*='/listing/']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const url = absoluteUrl(href);
    if (!url || seen.has(url)) return;
    seen.add(url);
    results.push({ url, title: $(el).attr("title") || $(el).text().trim() || undefined });
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
  loadMorePage: number;       // current "page" the button is on
  totalRecords: number;       // total listings available
  randNumber: string;         // nonce-like value needed for AJAX call
  listedIds: string;          // comma-separated IDs already on page
  hasMore: boolean;
}

export function extractPaginationInfo(html: string): PaginationInfo {
  const $ = cheerio.load(html);

  const totalFound = parseInt($(".showingString").first().text().trim(), 10) || 0;
  const btn = $(".loadMoreListing").first();
  const loadMorePage = parseInt(btn.attr("data-page") ?? "1", 10);
  const totalRecords = parseInt(btn.attr("data-total-record") ?? "0", 10);
  const randNumber = btn.attr("data-rand-number") ?? "";
  const listedIds = ($("#listed_listing_id").val() as string) ?? "";

  // The button exists and there are more listings than already shown
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
}

export function parseOffmarketDetailPage(html: string): OffmarketDetail {
  const $ = cheerio.load(html);

  const descEl = $(".lp-listing-desription, .lp-listing-description, .listing-desc").first();
  const description = descEl.text().trim() || undefined;

  const addrEl = $(".propertyAddress, .lp-listing-address, h1.lp-listing-name").first();
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
  const sqftM = specsText.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft)/i);

  const bedrooms = bedsM ? parseInt(bedsM[1], 10) : undefined;
  const bathrooms = bathsM ? parseFloat(bathsM[1]) : undefined;
  const squareFeet = sqftM ? parseInt(sqftM[1].replace(/,/g, ""), 10) : undefined;

  const contactText = $(".lp-listing-leadform, [class*='contact'], [class*='agent']").text();
  const phoneMatch = contactText.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  const ownerPhone = phoneMatch ? phoneMatch[0].trim() : undefined;
  const nameMatch = contactText.match(/(?:contact|seller|owner|agent|listed by)[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
  const ownerName = nameMatch ? nameMatch[1].trim() : undefined;

  return { description, address, location, propertyType, bedrooms, bathrooms, squareFeet, ownerName, ownerPhone };
}