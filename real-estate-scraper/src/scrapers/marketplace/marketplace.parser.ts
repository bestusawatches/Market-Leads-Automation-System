// src/scrapers/facebook/marketplace.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// Facebook Marketplace real estate listings parser.
//
// Marketplace listings are more structured than group posts:
//   - Each listing card has a stable aria-label with the title + price
//   - Listing detail pages have a more predictable layout
//   - URLs follow: /marketplace/item/{itemId}/
//
// Still NO reliable data-* attributes — we rely on:
//   1. aria-label on listing cards for title + price
//   2. Link href patterns for item URLs
//   3. Regex on the full listing text for beds/baths/sqft/address
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

const FB_BASE = "https://www.facebook.com";

// ── Field extractors ───────────────────────────────────────────────────────

export function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const clean = raw.replace(/[$,\s]/g, "");
  const kMatch = clean.match(/([\d.]+)[Kk]$/);
  const mMatch = clean.match(/([\d.]+)[Mm]$/);
  const plain = clean.match(/^(\d+)$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1_000);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1_000_000);
  if (plain) return parseInt(plain[1], 10);
  const m = raw.match(/\$\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function extractBedsBaths(text: string): { bedrooms?: number; bathrooms?: number } {
  const beds =
    text.match(/(\d+)\s*(?:bd|bed|br|bedroom)/i) ||
    text.match(/(\d+)\s*\/\s*\d/);
  const baths =
    text.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|bathroom)/i) ||
    text.match(/\d\s*\/\s*(\d+(?:\.\d+)?)/);
  return {
    bedrooms: beds ? parseInt(beds[1], 10) : undefined,
    bathrooms: baths ? parseFloat(baths[1]) : undefined,
  };
}

function extractSqft(text: string): number | undefined {
  const m = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf|square\s*feet)/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function detectPropertyType(text: string): PropertyType {
  const t = text.toLowerCase();
  if (t.includes("single family") || t.includes("sfh")) return "single_family";
  if (t.includes("duplex")) return "duplex";
  if (
    t.includes("multi") ||
    t.includes("triplex") ||
    t.includes("fourplex") ||
    t.includes("4plex")
  )
    return "multi_family";
  if (t.includes("condo")) return "condo";
  if (t.includes("townhome") || t.includes("townhouse")) return "townhouse";
  return "unknown";
}

function extractAddress(text: string): string | undefined {
  // Full address: "123 Main St, Columbus, OH 43215"
  const full = text.match(
    /\d+\s+[A-Z][a-zA-Z\s]+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Circle|Court|Place|Drive|Street|Avenue)\b[^,\n]*,?\s*[A-Z][a-zA-Z\s]+,\s*[A-Z]{2}\s*\d{5}/i
  );
  if (full) return full[0].trim();

  // City, State
  const cityState = text.match(/[A-Z][a-zA-Z\s]+,\s*(?:OH|WI|Ohio|Wisconsin)\b/i);
  return cityState ? cityState[0].trim() : undefined;
}

function absoluteUrl(href: string): string {
  if (!href) return "";
  href = href.trim().split("?")[0]; // strip tracking params
  return href.startsWith("http") ? href : `${FB_BASE}${href}`;
}

// ── Search results page (listing grid) ────────────────────────────────────

/**
 * Parse listing cards from a Facebook Marketplace search results page.
 *
 * Marketplace renders a grid of cards. Each card has:
 *   - An <a> tag linking to /marketplace/item/{id}/
 *   - An aria-label like "Listing: 3br house - $85,000"  (not always present)
 *   - A nested span/div with title text and price
 *
 * We use the /marketplace/item/ link pattern as the anchor, then read
 * surrounding text for price/title.
 */
export function parseMarketplaceSearchPage(
  html: string
): Omit<RawListing, "source">[] {
  const $ = cheerio.load(html);
  const results: Omit<RawListing, "source">[] = [];
  const seen = new Set<string>();

  // Primary: find all links to marketplace items
  $("a[href*='/marketplace/item/']").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href") ?? "";
    const url = absoluteUrl(href);
    if (!url || seen.has(url)) return;
    seen.add(url);

    // The card container is the closest ancestor with meaningful content
    const card = anchor.closest(
      "div[style], [aria-label], div > div > div"
    );
    const cardText = card.length ? card.text() : anchor.text();

    // Title — from aria-label if present, otherwise first meaningful text chunk
    const ariaLabel = anchor.attr("aria-label") ?? card.attr("aria-label") ?? "";
    const title = ariaLabel
      ? ariaLabel.replace(/^Listing:\s*/i, "").trim()
      : cardText.slice(0, 120).replace(/\s+/g, " ").trim() || undefined;

    // Price — from aria-label first, then text scan
    const priceFromAria = ariaLabel.match(/\$[\d,Kk]+/)?.[0];
    const priceFromText = cardText.match(/\$[\d,]+/)?.[0];
    const price = parsePrice(priceFromAria ?? priceFromText);

    // Location — Marketplace often shows city below the price
    const locationMatch = cardText.match(/[A-Z][a-zA-Z\s]+,\s*[A-Z]{2}\b/);
    const location = locationMatch ? locationMatch[0].trim() : undefined;

    const { bedrooms, bathrooms } = extractBedsBaths(cardText);
    const squareFeet = extractSqft(cardText);
    const propertyType = detectPropertyType(cardText);

    results.push({
      url,
      title,
      price,
      location,
      address: location,
      propertyType,
      bedrooms,
      bathrooms,
      squareFeet,
    });
  });

  logger.debug(`[mp-parser] ${results.length} listing cards from search page`);
  return results;
}

// ── Detail page ────────────────────────────────────────────────────────────

export interface MarketplaceDetail {
  title?: string;
  price?: number;
  description?: string;
  address?: string;
  location?: string;
  propertyType?: PropertyType;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  ownerName?: string;
}

/**
 * Parse a Facebook Marketplace listing detail page.
 *
 * Detail pages have a left panel with structured info (price, specs) and
 * a description block. We extract from both.
 */
export function parseMarketplaceDetailPage(html: string): MarketplaceDetail {
  const $ = cheerio.load(html);

  // Title — og:title is the most reliable
  const ogTitle =
    $('meta[property="og:title"]').attr("content") ??
    $("title").text() ??
    "";
  const title = ogTitle.replace(/\s*[\|·-].*$/, "").trim() || undefined;

  // Price
  const priceText =
    $('meta[property="product:price:amount"]').attr("content") ??
    $("[aria-label*='$'], [data-testid*='price']").first().text() ??
    "";
  const price = parsePrice(priceText) ?? parsePrice(ogTitle.match(/\$[\d,Kk]+/)?.[0]);

  // Description — og:description or the main text block
  const ogDesc = $('meta[property="og:description"]').attr("content") ?? "";
  const descEl = $(
    "[data-testid='marketplace-pdp-description'], [aria-label='Seller description']"
  ).first();
  const description = descEl.text().trim() || ogDesc || undefined;

  const bodyText = description ?? $("body").text();

  // Location — Marketplace shows a "Location" label followed by city
  const locationEl = $("[aria-label='Location'], [data-testid*='location']").first();
  const locationText = locationEl.text().trim();
  const location = locationText || extractAddress(bodyText);
  const address = extractAddress(bodyText) || location;

  const propertyType = detectPropertyType(bodyText);
  const { bedrooms, bathrooms } = extractBedsBaths(bodyText);
  const squareFeet = extractSqft(bodyText);

  // Seller name — shown in the "Seller information" section
  const sellerEl = $(
    "[aria-label='Seller information'] a, [data-testid*='seller'] a"
  ).first();
  const ownerName = sellerEl.text().trim() || undefined;

  return {
    title,
    price,
    description,
    address,
    location,
    propertyType,
    bedrooms,
    bathrooms,
    squareFeet,
    ownerName,
  };
}