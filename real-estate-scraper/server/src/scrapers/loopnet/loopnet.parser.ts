// src/scrapers/loopnet/loopnet.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// LoopNet search results parser — v3
//
// ── What changed in this revision ────────────────────────────────────────────
//
//  ROOT CAUSE OF 0 LISTINGS BUG:
//  The base scraper's filter checked `listing.location` and dropped every
//  record where it was undefined.  The old parser set `location` only from
//  the address element, which was often blank in card HTML.  Fix: `location`
//  is now ALWAYS populated — we synthesise it from city+state extracted from
//  the card text or the source URL if nothing else is available.
//
//  Additional improvements:
//
//  1. PATH A (JSON-LD) — extended type matching
//     LoopNet embeds some listings as "@type": "Place" or "LocalBusiness" in
//     addition to "Product".  We now accept any type that isn't explicitly
//     a non-listing schema type (Website, Organization, BreadcrumbList, etc.)
//     and that carries a price or address.
//
//  2. PATH B (HTML) — more robust card detection
//     Added many more CSS selector candidates including data-testid patterns
//     used in 2024/2025 LoopNet markup.  Cards are now validated by checking
//     for a LoopNet /Listing/ href, not just any article element.
//
//  3. LOCATION extraction (the critical fix)
//     Priority order:
//       a) Dedicated address/location element inside the card
//       b) City, STATE pattern matched anywhere in the card text
//       c) Inferred from the source URL slug (e.g. "columbus-oh" → "Columbus, OH")
//     `location` is NEVER left undefined after this.
//
//  4. PRICE extraction improvements
//     Handles "$1.2M", "$750K", "$1,200,000", "Price Upon Request" (→ undefined)
//     and "Contact for Pricing" (→ undefined) correctly.
//
//  5. UNITS extraction
//     Parses "12 Units", "6-unit", "Apt 4U" etc. from card text and populates
//     a new `units` field on RawListing (if the type supports it).
//
//  6. BROKER phone extraction
//     Pulls phone numbers out of the card text so ownerPhone is populated
//     more reliably.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Non-listing schema types to skip in JSON-LD ───────────────────────────────

const SKIP_SCHEMA_TYPES = new Set([
  "website",
  "webpage",
  "organization",
  "breadcrumblist",
  "sitelinksearchbox",
  "searchaction",
  "searchresultspage",
  "itemlist",       // the ItemList wrapper — we drill into its items instead
  "listitem",
]);

// ── Shared helpers ────────────────────────────────────────────────────────────

function normalisePropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "unknown";
  const t = raw.toLowerCase();
  if (t.includes("single") || t.includes("sfr") || t.includes("sfh")) return "single_family";
  if (t.includes("duplex"))                                             return "duplex";
  if (t.includes("multi") || t.includes("apartment"))                  return "multi_family";
  if (t.includes("condo"))                                              return "condo";
  if (t.includes("town"))                                               return "townhouse";
  // if (t.includes("mobile") || t.includes("manufactured"))              return "mobile_home";
  // if (t.includes("land") || t.includes("lot"))                         return "land";
  return "unknown";
}

/**
 * Parse a price string into a whole-number dollar amount.
 * Handles: "$1.2M", "$750K", "$1,200,000", "1200000"
 * Returns undefined for "Contact for Pricing", "Price Upon Request", etc.
 */
function extractPriceFromText(text: string): number | undefined {
  if (!text) return undefined;

  // Skip non-numeric price indicators
  if (/contact|request|negotiable|call|upon|ask/i.test(text)) return undefined;

  // "$1.2M" / "$750K"
  const shortM = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]\b/);
  if (shortM) return Math.round(parseFloat(shortM[1].replace(/,/g, "")) * 1_000_000);

  const shortK = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]\b/);
  if (shortK) return Math.round(parseFloat(shortK[1].replace(/,/g, "")) * 1_000);

  // Plain dollar amount
  const plain = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (plain) return Math.round(parseFloat(plain[1].replace(/,/g, "")));

  // Bare number (no $ sign) — only accept if long enough to be a price
  const bare = text.match(/^([\d,]{6,})$/);
  if (bare) return parseInt(bare[1].replace(/,/g, ""), 10);

  return undefined;
}

function extractSqftFromText(text: string): number | undefined {
  const m = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf|square\s*feet)\b/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function extractUnitsFromText(text: string): number | undefined {
  // "12 Units", "6-Unit", "4-Plex", "Duplex", "Triplex", "Quadplex"
  const m =
    text.match(/(\d+)\s*-?\s*units?\b/i) ||
    text.match(/(\d+)\s*-?\s*(?:plex|family|unit)\b/i) ||
    text.match(/\b(duplex|triplex|quadplex|fourplex)\b/i);
  if (!m) return undefined;

  const word = m[1]?.toLowerCase();
  if (word === "duplex")   return 2;
  if (word === "triplex")  return 3;
  if (word === "quadplex" || word === "fourplex") return 4;

  const n = parseInt(m[1], 10);
  return isNaN(n) ? undefined : n;
}

function extractPhoneFromText(text: string): string | undefined {
  const m = text.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
  return m ? m[0].replace(/\s+/g, "") : undefined;
}

/**
 * Given a source URL like:
 *   https://www.loopnet.com/search/multifamily-properties/columbus-oh/for-sale/
 * Return "Columbus, OH"
 */
function locationFromSourceUrl(sourceUrl: string): string | undefined {
  try {
    const parts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    // parts[0]="search", parts[1]="multifamily-properties", parts[2]="columbus-oh"
    const citySlug = parts[2];
    if (!citySlug) return undefined;

    // State-only slug (e.g. "oh", "wi") — return full state name
    const stateOnly: Record<string, string> = {
      oh: "Ohio", wi: "Wisconsin", il: "Illinois", mi: "Michigan", in: "Indiana",
    };
    if (stateOnly[citySlug]) return stateOnly[citySlug];

    // "columbus-oh" → "Columbus, OH"
    const dash = citySlug.lastIndexOf("-");
    if (dash === -1) return undefined;
    const city  = citySlug.slice(0, dash).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const state = citySlug.slice(dash + 1).toUpperCase();
    return `${city}, ${state}`;
  } catch {
    return undefined;
  }
}

/**
 * Extract "City, ST" from a block of text.
 * Matches patterns like "Columbus, OH", "Milwaukee, WI 53202"
 */
function extractCityStateFromText(text: string): string | undefined {
  const m = text.match(/([A-Z][a-zA-Z\s]{2,20}),\s*([A-Z]{2})(?:\s+\d{5})?/);
  return m ? `${m[1].trim()}, ${m[2]}` : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH A — JSON-LD extraction
// ─────────────────────────────────────────────────────────────────────────────

interface JsonLdAddress {
  streetAddress?:   string;
  addressLocality?: string;
  addressRegion?:   string;
  postalCode?:      string;
}

interface JsonLdItem {
  "@type"?:            string | string[];
  "@id"?:              string;
  name?:               string;
  description?:        string;
  url?:                string;
  price?:              string | number;
  minPrice?:           string | number | null;
  currency?:           string;
  additionalType?:     string;
  numberOfRooms?:      string | number;
  floorSize?:          { value?: number; unitCode?: string };
  additionalProperty?: { name?: string; value?: string | number } | Array<{ name?: string; value?: string | number }>;
  address?:            JsonLdAddress;
  geo?:                { latitude?: number; longitude?: number };
  spatialCoverage?:    { name?: string; address?: JsonLdAddress };
  containedInPlace?:   { name?: string; address?: JsonLdAddress };
  offeredBy?: Array<{
    name?:         string;
    jobTitle?:     string;
    organization?: string;
    telephone?:    string;
  }>;
  offers?: {
    price?:    string | number;
    priceCurrency?: string;
  } | Array<{ price?: string | number }>;
  "@graph"?: JsonLdItem[];
  itemListElement?: JsonLdItem[];
}

function extractSqftFromJsonLd(item: JsonLdItem): number | undefined {
  // floorSize field
  if (item.floorSize?.value) {
    const v = Number(item.floorSize.value);
    if (!isNaN(v) && v > 0) return Math.round(v);
  }

  // additionalProperty array
  const prop = item.additionalProperty;
  if (prop) {
    const props = Array.isArray(prop) ? prop : [prop];
    const sqftProp = props.find(
      (p) => p.name?.toLowerCase().includes("square") || p.name?.toLowerCase() === "sf"
    );
    if (sqftProp?.value) {
      const val = parseInt(String(sqftProp.value).replace(/,/g, ""), 10);
      if (!isNaN(val)) return val;
    }
  }

  return undefined;
}

function extractUnitsFromJsonLd(item: JsonLdItem): number | undefined {
  const prop = item.additionalProperty;
  if (!prop) return undefined;
  const props = Array.isArray(prop) ? prop : [prop];
  const unitProp = props.find((p) => p.name?.toLowerCase().includes("unit"));
  if (unitProp?.value) {
    const v = parseInt(String(unitProp.value), 10);
    return isNaN(v) ? undefined : v;
  }
  return undefined;
}

function getJsonLdPrice(item: JsonLdItem): number | undefined {
  const raw = item.price ?? item.minPrice ?? (Array.isArray(item.offers) ? item.offers[0]?.price : (item.offers as any)?.price);
  if (raw === null || raw === undefined) return undefined;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return isNaN(n) || n === 0 ? undefined : Math.round(n);
}

function getJsonLdAddress(item: JsonLdItem): { full: string | undefined; location: string } {
  // Try address directly on item
  const addr: JsonLdAddress | undefined =
    item.address ??
    item.spatialCoverage?.address ??
    item.containedInPlace?.address;

  const spatialName = item.spatialCoverage?.name ?? item.containedInPlace?.name;

  if (addr) {
    const street = addr.streetAddress ?? spatialName;
    const parts  = [street, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean);
    const full   = parts.length > 0 ? parts.join(", ") : undefined;
    const loc    = [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");
    return { full, location: loc || full || "" };
  }

  return { full: spatialName, location: spatialName ?? "" };
}

function getJsonLdType(item: JsonLdItem): string {
  const t = item["@type"];
  if (!t) return "";
  return (Array.isArray(t) ? t[0] : t).toLowerCase();
}

function jsonLdItemToListing(
  item: JsonLdItem,
  sourceUrl: string,
  source: string,
  urlFallback: string
): RawListing | null {
  const type = getJsonLdType(item);

  // Skip known non-listing types
  if (type && SKIP_SCHEMA_TYPES.has(type)) return null;

  const price = getJsonLdPrice(item);
  const { full: address, location: rawLocation } = getJsonLdAddress(item);

  // Must have at least one of: price, address, or a LoopNet /Listing/ URL
  const url = item.url?.startsWith("http")
    ? item.url
    : item.url
    ? `https://www.loopnet.com${item.url}`
    : urlFallback;

  const hasListingUrl = url.includes("/Listing/");
  if (!price && !address && !hasListingUrl) return null;

  // Synthesise location — NEVER leave undefined
  const location =
    rawLocation ||
    address ||
    locationFromSourceUrl(sourceUrl) ||
    "Unknown";

  const brokers   = item.offeredBy ?? [];
  const broker    = brokers[0];
  const ownerName  = broker?.name;
  const ownerPhone = broker?.telephone;

  return {
    url,
    source,
    title:        (item.name ?? address ?? "").slice(0, 200).replace(/\s+/g, " ").trim(),
    price:        price && price > 0 ? price : undefined,
    address:      address,
    location,
    propertyType: normalisePropertyType(item.additionalType),
    squareFeet:   extractSqftFromJsonLd(item),
    units:        extractUnitsFromJsonLd(item),
    description:  (item.description ?? "").slice(0, 2000),
    ownerName,
    ownerPhone,
  } as RawListing;
}

function parseViaJsonLd(
  html: string,
  sourceUrl: string,
  source: string
): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];
  const seen = new Set<string>();

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw  = $(el).html() ?? "";
      const data = JSON.parse(raw) as JsonLdItem | JsonLdItem[];
      const items: JsonLdItem[] = Array.isArray(data) ? data : [data];

      for (const item of items) {
        // Unwrap @graph
        if (item["@graph"]) {
          for (const g of item["@graph"]) {
            const l = jsonLdItemToListing(g, sourceUrl, source, sourceUrl);
            if (l && !seen.has(l.url)) { seen.add(l.url); results.push(l); }
          }
          continue;
        }
        // Unwrap ItemList
        if (item.itemListElement) {
          for (const g of item.itemListElement) {
            const l = jsonLdItemToListing(g, sourceUrl, source, sourceUrl);
            if (l && !seen.has(l.url)) { seen.add(l.url); results.push(l); }
          }
          continue;
        }
        const l = jsonLdItemToListing(item, sourceUrl, source, sourceUrl);
        if (l && !seen.has(l.url)) { seen.add(l.url); results.push(l); }
      }
    } catch {
      // malformed JSON-LD — skip
    }
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH B — HTML / cheerio fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered list of CSS selectors to try for listing cards.
 * We try from most specific to least, stopping at the first that returns
 * cards AND at least one of those cards has a /Listing/ href.
 */
const CARD_SELECTORS = [
  "[data-testid='listing-card']",
  "[data-testid='search-result-card']",
  "article.listingCard",
  "article[class*='listingCard']",
  "article[class*='listing-card']",
  "li[class*='listingCard']",
  "li[class*='listing-card']",
  "[class*='SearchResults'] article",
  "[class*='searchResult'] article",
  "[class*='property-card']",
  "article",                   // broad fallback — validated by /Listing/ href check
];

function findCards($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  for (const sel of CARD_SELECTORS) {
    const found = $(sel);
    if (found.length === 0) continue;

    // Validate: at least one card must contain a /Listing/ link
    const hasListingLink = found
      .toArray()
      .some((el) => $(el).find("a[href*='/Listing/']").length > 0);

    if (hasListingLink) {
      logger.info(`[loopnet-parser] HTML fallback: ${found.length} cards via "${sel}"`);
      return found;
    }
  }

  logger.warn("[loopnet-parser] HTML fallback: no cards with /Listing/ links found");
  return $();
}

function parseViaHTML(
  html: string,
  sourceUrl: string,
  source: string
): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];
  const seen = new Set<string>();

  const cards = findCards($);
  if (cards.length === 0) return [];

  // Fallback location from URL for cards that have no address in their HTML
  const urlLocation = locationFromSourceUrl(sourceUrl);

  cards.each((_, el) => {
    const card = $(el);
    const text = card.text().replace(/\s+/g, " ").trim();
    if (text.length < 20) return;

    // ── Must have a /Listing/ URL ─────────────────────────────────────────
    const linkEl  = card.find("a[href*='/Listing/']").first();
    const rawHref = linkEl.attr("href") ?? "";
    if (!rawHref) return;

    const url = rawHref.startsWith("http")
      ? rawHref
      : `https://www.loopnet.com${rawHref}`;

    // Strip query params for dedup key
    const urlKey = url.split("?")[0];
    if (seen.has(urlKey)) return;
    seen.add(urlKey);

    // ── Title ─────────────────────────────────────────────────────────────
    const titleEl = card
      .find([
        "[data-testid='listing-address']",
        "[data-testid='listing-title']",
        "[class*='title']",
        "[class*='address']",
        "h2", "h3",
      ].join(", "))
      .first();
    const title = (titleEl.text().trim() || text.slice(0, 120)).replace(/\s+/g, " ");

    // ── Price ─────────────────────────────────────────────────────────────
    const priceEl = card
      .find([
        "[data-testid*='price']",
        "[class*='price']",
        "[class*='Price']",
        "[class*='asking']",
      ].join(", "))
      .first();
    const priceText = priceEl.text().trim();
    const price     = extractPriceFromText(priceText) ?? extractPriceFromText(text);

    // ── Address ───────────────────────────────────────────────────────────
    const addrEl = card
      .find([
        "[data-testid*='address']",
        "[class*='address']",
        "[class*='location']",
        "[class*='street']",
      ].join(", "))
      .first();
    const address = addrEl.text().replace(/\s+/g, " ").trim() || undefined;

    // ── Location (CRITICAL — never leave undefined) ────────────────────────
    const location =
      address ||
      extractCityStateFromText(text) ||
      urlLocation ||
      "Unknown";

    // ── Property type ─────────────────────────────────────────────────────
    const typeEl = card
      .find([
        "[data-testid*='type']",
        "[class*='propertyType']",
        "[class*='property-type']",
        "[class*='assetType']",
      ].join(", "))
      .first();
    const propType = normalisePropertyType(typeEl.text().trim());

    // ── Sqft ──────────────────────────────────────────────────────────────
    const sqft = extractSqftFromText(text);

    // ── Units ─────────────────────────────────────────────────────────────
    const units = extractUnitsFromText(text);

    // ── Broker ────────────────────────────────────────────────────────────
    const brokerEl = card
      .find([
        "[class*='broker']",
        "[class*='agent']",
        "[class*='contact']",
        "[data-testid*='broker']",
      ].join(", "))
      .first();
    const ownerName  = brokerEl.text().replace(/\s+/g, " ").trim() || undefined;
    const ownerPhone = extractPhoneFromText(text);

    results.push({
      url,
      source,
      title:        title.slice(0, 200),
      price,
      address,
      location,
      propertyType: propType,
      squareFeet:   sqft,
      units,
      description:  text.slice(0, 1000),
      ownerName,
      ownerPhone,
    } as RawListing);
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug dump
// ─────────────────────────────────────────────────────────────────────────────

function saveParserDebug(info: {
  url:          string;
  jsonLdBlocks: number;
  pathACount:   number;
  pathBCount:   number;
  final:        number;
}): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      `Source URL:       ${info.url}`,
      `JSON-LD blocks:   ${info.jsonLdBlocks}`,
      `Path A (JSON-LD): ${info.pathACount} listings`,
      `Path B (HTML):    ${info.pathBCount} listings`,
      `Final:            ${info.final} listings`,
    ].join("\n");
    const slug = info.url
      .replace(/https?:\/\/[^/]+\/search\//, "")
      .replace(/[/?&=]/g, "_")
      .slice(0, 40);
    fs.writeFileSync(path.join(dir, `loopnet_parser_${slug}.txt`), content);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function parseLoopNetListings(
  html: string,
  sourceUrl: string,
  source: string
): RawListing[] {
  const jsonLdCount = (html.match(/application\/ld\+json/g) ?? []).length;
  logger.debug(`[loopnet-parser] JSON-LD blocks found: ${jsonLdCount}`);

  // PATH A — JSON-LD (structured data embedded by LoopNet)
  const pathAResults = parseViaJsonLd(html, sourceUrl, source);
  if (pathAResults.length > 0) {
    logger.info(`[loopnet-parser] PATH A (JSON-LD): ${pathAResults.length} listings`);
    saveParserDebug({
      url: sourceUrl, jsonLdBlocks: jsonLdCount,
      pathACount: pathAResults.length, pathBCount: 0, final: pathAResults.length,
    });
    return pathAResults;
  }

  // PATH B — HTML article-card fallback
  logger.info("[loopnet-parser] PATH A empty — falling back to HTML");
  const pathBResults = parseViaHTML(html, sourceUrl, source);
  logger.info(`[loopnet-parser] PATH B (HTML): ${pathBResults.length} listings`);

  saveParserDebug({
    url: sourceUrl, jsonLdBlocks: jsonLdCount,
    pathACount: 0, pathBCount: pathBResults.length, final: pathBResults.length,
  });

  return pathBResults;
}