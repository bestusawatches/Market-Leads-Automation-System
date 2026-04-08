// src/scrapers/investorlift/investorlift.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// InvestorLift is a React SPA — all data is loaded dynamically.
// We extract listings from two sources (in priority order):
//   1. The XHR/fetch API responses that the SPA calls (most reliable)
//   2. The rendered DOM as a fallback
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePrice(val: unknown): number | undefined {
  if (typeof val === "number") return Math.round(val);
  if (typeof val === "string") {
    const m = val.replace(/[$,\s]/g, "").match(/\d+/);
    return m ? parseInt(m[0], 10) : undefined;
  }
  return undefined;
}

function normalizePropertyType(raw: unknown): PropertyType {
  if (!raw) return "unknown";
  const t = String(raw).toLowerCase();
  if (t.includes("single") || t.includes("sfh")) return "single_family";
  if (t.includes("multi") || t.includes("duplex") || t.includes("triplex"))
    return "multi_family";
  if (t.includes("condo")) return "condo";
  if (t.includes("town")) return "townhouse";
  return "unknown";
}

function buildDetailUrl(listingId: string | number): string {
  return `https://app.investorlift.com/properties/${listingId}`;
}

// ── API response parser ────────────────────────────────────────────────────

/**
 * Parse the JSON payload from InvestorLift's internal API.
 *
 * InvestorLift calls endpoints like:
 *   GET /api/v1/properties?page=1&per_page=20&...
 *
 * The response shape (based on observed traffic) looks like:
 * {
 *   data: [ { id, address, city, state, zip, price, beds, baths, sqft,
 *             property_type, listed_at, owner_name, owner_phone, ... } ],
 *   meta: { total, page, per_page }
 * }
 *
 * ⚠️  InvestorLift may change their API shape — check logs/investorlift_api_*.json
 *     if parsing breaks.
 */
export function parseApiResponse(
  json: unknown,
  source: string
): RawListing[] {
  if (!json || typeof json !== "object") {
    logger.warn("[il-parser] API response is not an object");
    return [];
  }

  // Handle both { data: [...] } and bare array responses
  const raw = json as Record<string, unknown>;
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw["data"])
    ? (raw["data"] as unknown[])
    : Array.isArray(raw["properties"])
    ? (raw["properties"] as unknown[])
    : Array.isArray(raw["results"])
    ? (raw["results"] as unknown[])
    : [];

  if (items.length === 0) {
    logger.warn(
      `[il-parser] Could not find listings array in API response. Keys: ${Object.keys(raw).join(", ")}`
    );
    return [];
  }

  logger.debug(`[il-parser] API returned ${items.length} raw items`);

  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item): RawListing => {
      const id = item["id"] ?? item["listing_id"] ?? item["property_id"];
      const url = id
        ? buildDetailUrl(String(id))
        : String(item["url"] ?? item["link"] ?? "");

      // Address assembly
      const street =
        item["address"] ?? item["street_address"] ?? item["street"] ?? "";
      const city = item["city"] ?? item["city_name"] ?? "";
      const state = item["state"] ?? item["state_code"] ?? "";
      const zip = item["zip"] ?? item["zipcode"] ?? item["postal_code"] ?? "";
      const address = [street, city, state, zip]
        .map((p) => String(p).trim())
        .filter(Boolean)
        .join(", ");

      const location = [city, state]
        .map((p) => String(p).trim())
        .filter(Boolean)
        .join(", ");

      // Date
      const dateRaw =
        item["listed_at"] ??
        item["created_at"] ??
        item["posted_at"] ??
        item["list_date"];
      const postedDate = dateRaw ? new Date(String(dateRaw)) : undefined;

      return {
        url,
        source,
        title: address || undefined,
        address: address || undefined,
        location: location || undefined,
        price: normalizePrice(item["price"] ?? item["list_price"] ?? item["asking_price"]),
        propertyType: normalizePropertyType(
          item["property_type"] ?? item["type"] ?? item["home_type"]
        ),
        bedrooms:
          item["beds"] != null ? Number(item["beds"]) : undefined,
        bathrooms:
          item["baths"] != null ? Number(item["baths"]) : undefined,
        squareFeet:
          item["sqft"] != null
            ? Number(String(item["sqft"]).replace(/,/g, ""))
            : undefined,
        description: item["description"]
          ? String(item["description"])
          : undefined,
        postedDate,
        // Owner contact — InvestorLift sometimes exposes these directly
        ownerName: item["owner_name"]
          ? String(item["owner_name"])
          : undefined,
        ownerPhone:
          item["owner_phone"] ?? item["seller_phone"] ?? item["contact_phone"]
            ? String(
                item["owner_phone"] ??
                  item["seller_phone"] ??
                  item["contact_phone"]
              )
            : undefined,
        zestimate:
          item["zestimate"] != null ? Number(item["zestimate"]) : undefined,
      };
    });
}

// ── DOM fallback parser ────────────────────────────────────────────────────

/**
 * Fallback: parse listings from the rendered HTML when the API
 * intercept didn't capture a response.
 *
 * Card selectors are based on InvestorLift's current layout (April 2026).
 * If the layout changes, update the selectors here — the rest of the
 * pipeline stays the same.
 */
export function parseDomListings(html: string, source: string): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];

  // InvestorLift renders property cards — try several known selectors
  const cardSelectors = [
    "[data-testid='property-card']",
    ".property-card",
    ".listing-card",
    "[class*='PropertyCard']",
    "[class*='ListingCard']",
    "[class*='property-item']",
  ];

  let cards = $();
  for (const sel of cardSelectors) {
    cards = $(sel);
    if (cards.length > 0) {
      logger.debug(`[il-parser] DOM: found ${cards.length} cards with selector "${sel}"`);
      break;
    }
  }

  if (cards.length === 0) {
    logger.warn("[il-parser] DOM fallback: no property cards found — check selectors");
    return [];
  }

  cards.each((_, el) => {
    const card = $(el);

    // URL — look for a link with a property path
    const anchor = card.find("a[href*='/properties/'], a[href*='/listing/']").first();
    const href = anchor.attr("href") ?? "";
    const url = href.startsWith("http")
      ? href
      : href
      ? `https://app.investorlift.com${href}`
      : "";

    if (!url) return; // skip cards without a link

    // Price
    const priceText =
      card.find("[class*='price'], [data-testid*='price']").first().text() ||
      card.find("span, p").filter((_, e) => /\$[\d,]+/.test($(e).text())).first().text();
    const price = normalizePrice(priceText);

    // Address
    const address =
      card.find("[class*='address'], [data-testid*='address']").first().text().trim() ||
      anchor.text().trim();

    // Beds / baths / sqft
    const detailText = card.find("[class*='detail'], [class*='spec'], [class*='stat']").text();
    const bedsM = detailText.match(/(\d+)\s*(?:bd|bed|br)/i);
    const bathsM = detailText.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath)/i);
    const sqftM = detailText.match(/([\d,]+)\s*(?:sqft|sq ft|sf)/i);

    results.push({
      url,
      source,
      title: address || undefined,
      address: address || undefined,
      price,
      bedrooms: bedsM ? parseInt(bedsM[1], 10) : undefined,
      bathrooms: bathsM ? parseFloat(bathsM[1]) : undefined,
      squareFeet: sqftM ? parseInt(sqftM[1].replace(/,/g, ""), 10) : undefined,
    });
  });

  logger.debug(`[il-parser] DOM fallback: parsed ${results.length} listings`);
  return results;
}
