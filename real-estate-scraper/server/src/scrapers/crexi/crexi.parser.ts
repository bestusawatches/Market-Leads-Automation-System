// src/scrapers/crexi/crexi.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// Three-path parser for Crexi search results:
//
// PATH A — Intercepted API JSON
//   Crexi's Angular app fetches from api.crexi.com. When the scraper intercepts
//   these XHR responses the JSON is passed here as `nextData`. The tree-walker
//   finds the listings array and maps it to RawListing objects.
//
//   Known Crexi API shapes:
//     { data: { assets: [ { id, name, askingPrice, address: { city, state } } ] } }
//     { assets: [ ... ] }
//     { results: [ ... ] }
//
//   ⚠  IMPORTANT: Crexi's API wraps location inside a nested `address` object:
//        asset.address.city  /  asset.address.stateCode  /  asset.address.state
//      The parser normalises all known shapes into flat city/state strings.
//
// PATH B — __NEXT_DATA__ JSON (not applicable — Crexi is Angular, not Next.js)
//   Kept for future compatibility but will always return empty in practice.
//
// PATH C — HTML / cheerio using Crexi's Angular custom elements.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Nested address shape returned by api.crexi.com ────────────────────────

interface CrxAddress {
  street?:       string;
  streetAddress?: string;
  address1?:     string;
  address2?:     string;
  city?:         string;
  cityName?:     string;
  state?:        string;
  stateCode?:    string;
  stateName?:    string;
  zip?:          string;
  zipCode?:      string;
  postalCode?:   string;
  county?:       string;
  country?:      string;
}

// ── Raw asset shape from api.crexi.com/assets/search ──────────────────────

interface CrxRaw {
  // Identity
  id?:           string | number;
  name?:         string;
  title?:        string;
  slug?:         string;
  url?:          string;

  // Location — flat (legacy / HTML path)
  address?:      string | CrxAddress;   // may be string OR nested object
  city?:         string;
  cityName?:     string;
  state?:        string;
  stateCode?:    string;
  stateName?:    string;
  zip?:          string;
  postalCode?:   string;
  latitude?:     number;
  longitude?:    number;

  // Financials
  askingPrice?:  number;
  price?:        number;
  listPrice?:    number;
  capRate?:      number;
  noi?:          number;
  noiAnnual?:    number;
  grossRevenue?: number;

  // Property type
  propertyType?: string;
  type?:         string;
  assetType?:    string;
  listingType?:  string;
  assetClass?:   string;
  category?:     string;

  // Size
  squareFeet?:      number;
  sqft?:            number;
  buildingSize?:    number;
  buildingSquareFeet?: number;
  totalSquareFeet?: number;
  lotSize?:         number;
  lotSqft?:         number;

  // Unit counts
  units?:       number;
  unitCount?:   number;
  totalUnits?:  number;
  bedrooms?:    number;
  bathrooms?:   number;
  yearBuilt?:   number;

  // Text
  description?: string;
  summary?:     string;
  teaser?:      string;

  // Broker
  brokerName?:  string;
  brokerPhone?: string;

  // Status
  status?:      string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalisePropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "unknown";
  const t = raw.toLowerCase();
  if (t.includes("single") || t.includes("sfr") || t.includes("sfh"))                       return "single_family";
  if (t.includes("duplex"))                                                                   return "duplex";
  if (t.includes("multi") || t.includes("apartment") || t.includes("residential income"))   return "multi_family";
  if (t.includes("condo"))                                                                    return "condo";
  if (t.includes("town"))                                                                     return "townhouse";
  return "unknown";
}

/**
 * Extract flat city + state strings from a CrxRaw record.
 * Handles both:
 *   - Flat fields:  r.city / r.stateCode / r.state
 *   - Nested object: r.address.city / r.address.stateCode / r.address.state
 */
function extractCityState(r: CrxRaw): { city: string | undefined; state: string | undefined } {
  // Start with flat fields
  let city:  string | undefined = r.city  ?? r.cityName;
  let state: string | undefined = r.state ?? r.stateCode ?? r.stateName;

  // Override / fill from nested address object
  if (r.address && typeof r.address === "object") {
    const a = r.address as CrxAddress;
    city  = city  ?? a.city  ?? a.cityName;
    state = state ?? a.state ?? a.stateCode ?? a.stateName;
  }

  return { city, state };
}

/**
 * Build a human-readable address string. Prefers the nested address object
 * so that street + city + state + zip are all included when available.
 */
function buildAddress(r: CrxRaw): string | undefined {
  if (r.address && typeof r.address === "object") {
    const a = r.address as CrxAddress;
    const street = a.street ?? a.streetAddress ?? a.address1 ?? "";
    const city   = a.city   ?? a.cityName ?? r.city ?? r.cityName ?? "";
    const state  = a.state  ?? a.stateCode ?? a.stateName ?? r.state ?? r.stateCode ?? r.stateName ?? "";
    const zip    = a.zip    ?? a.zipCode ?? a.postalCode ?? r.zip ?? r.postalCode ?? "";
    const parts  = [street, city, state, zip].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }

  // Flat string address
  const { city, state } = extractCityState(r);
  const parts = [
    typeof r.address === "string" ? r.address : undefined,
    city,
    state,
    r.zip ?? r.postalCode,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function buildUrl(r: CrxRaw, fallback: string): string {
  if (r.url && r.url.startsWith("http")) return r.url;
  if (r.slug) return `https://www.crexi.com/properties/${r.slug}`;
  if (r.id)   return `https://www.crexi.com/properties/${r.id}`;
  return fallback;
}

function rawToListing(r: CrxRaw, sourceUrl: string, source: string): RawListing | null {
  const price = r.askingPrice ?? r.price ?? r.listPrice ?? undefined;
  const sqft  = r.squareFeet  ?? r.sqft  ?? r.buildingSize
             ?? r.buildingSquareFeet ?? r.totalSquareFeet ?? undefined;

  const { city, state } = extractCityState(r);
  const address  = buildAddress(r);
  const location = [city, state].filter(Boolean).join(", ") || address;

  const propType = normalisePropertyType(
    r.propertyType ?? r.type ?? r.assetType ?? r.listingType ?? r.assetClass ?? r.category
  );
  const title = r.name ?? r.title ?? (r.description ?? "").slice(0, 100);
  const url   = buildUrl(r, sourceUrl);

  // Require at least a price OR an address to emit a listing
  if (!price && !address) return null;

  return {
    url,
    source,
    title:        title.replace(/\s+/g, " ").trim().slice(0, 200),
    price,
    address,
    location,
    propertyType: propType,
    bedrooms:     r.bedrooms,
    bathrooms:    r.bathrooms,
    squareFeet:   sqft ? Math.round(sqft) : undefined,
    description:  r.description ?? r.summary ?? r.teaser ?? "",
    ownerName:    r.brokerName,
    ownerPhone:   r.brokerPhone,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON tree-walker — finds a listings array anywhere in the JSON tree.
// "assets" is first because that is Crexi's primary API field name.
// ─────────────────────────────────────────────────────────────────────────────

function findListingsArray(node: any, depth = 0): CrxRaw[] | null {
  if (depth > 10 || node === null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    if (node.length > 0 && isListingObject(node[0])) return node as CrxRaw[];
    for (const item of node) {
      const found = findListingsArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const priorityKeys = [
    "assets",           // Crexi API: { data: { assets: [...] } }
    "listings",
    "properties",
    "results",
    "items",
    "searchResults",
    "propertyResults",
    "data",
  ];

  for (const key of priorityKeys) {
    if (key in node) {
      const found = findListingsArray(node[key], depth + 1);
      if (found) return found;
    }
  }

  for (const key of Object.keys(node)) {
    if (priorityKeys.includes(key)) continue;
    const found = findListingsArray(node[key], depth + 1);
    if (found) return found;
  }

  return null;
}

function isListingObject(obj: any): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const listingFields = [
    "askingPrice", "listPrice", "price", "address", "city", "cityName",
    "stateCode", "propertyType", "assetType", "squareFeet", "slug", "capRate",
  ];
  return listingFields.some((f) => f in obj);
}

function parseViaJSON(json: any, sourceUrl: string, source: string, label: string): RawListing[] {
  if (!json) return [];

  const rawListings = findListingsArray(json);
  if (!rawListings || rawListings.length === 0) {
    logger.debug(`[crexi-parser] ${label}: JSON present but no listings array found`);
    return [];
  }

  logger.info(`[crexi-parser] ${label}: found ${rawListings.length} raw items`);

  // Debug: log the first item's keys so we can see the actual API shape
  if (rawListings.length > 0) {
    logger.debug(`[crexi-parser] ${label}: first item keys → ${Object.keys(rawListings[0]).join(", ")}`);
    const firstAddr = (rawListings[0] as any).address;
    if (firstAddr && typeof firstAddr === "object") {
      logger.debug(`[crexi-parser] ${label}: address object keys → ${Object.keys(firstAddr).join(", ")}`);
    }
  }

  const results: RawListing[] = [];
  for (const r of rawListings) {
    const listing = rawToListing(r, sourceUrl, source);
    if (listing) results.push(listing);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH C — HTML / cheerio
// ─────────────────────────────────────────────────────────────────────────────

function extractPriceFromText(text: string): number | undefined {
  const clean = (text ?? "").trim();
  if (!clean || /unpriced/i.test(clean)) return undefined;

  const m =
    clean.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]\b/) ||
    clean.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]\b/) ||
    clean.match(/\$\s*([\d,]+)/);
  if (!m) return undefined;
  let val      = parseFloat(m[1].replace(/,/g, ""));
  const suffix = m[0][m[0].length - 1]?.toLowerCase();
  if (suffix === "k") val *= 1_000;
  if (suffix === "m") val *= 1_000_000;
  return Math.round(val);
}

function extractSqftFromText(text: string): number | undefined {
  const m = (text ?? "").match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf)\b/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function parseViaHTML(html: string, sourceUrl: string, source: string): RawListing[] {
  if (
    html.includes("challenges.cloudflare.com") ||
    html.includes("cf-browser-verification") ||
    html.includes("Performing security verification")
  ) {
    logger.warn("[crexi-parser] HTML appears to be a Cloudflare challenge page — skipping parse");
    return [];
  }

  const $ = cheerio.load(html);
  const results: RawListing[] = [];
  const seen = new Set<string>();

  let cards = $("crx-sales-property-tile[id^='search-item-']");
  let selectorUsed = "crx-sales-property-tile[id^='search-item-']";

  if (cards.length === 0) {
    cards = $("cui-card:has(a.cui-card-cover-link)");
    selectorUsed = "cui-card:has(a.cui-card-cover-link)";
  }

  if (cards.length === 0) {
    cards = $("[data-cy='propertyPrice']")
      .map((_, el) => $(el).closest("cui-card, crx-sales-property-tile, article").get(0))
      .filter((_, el) => !!el) as any;
    selectorUsed = "ancestor of [data-cy=propertyPrice]";
  }

  if (cards.length === 0) {
    logger.warn("[crexi-parser] Angular tile selectors missed — collecting property hrefs as stubs");
    $("a[href*='/properties/'][href*='-']").each((_, el) => {
      const rawHref = $(el).attr("href") ?? "";
      if (!rawHref || rawHref === "/" || rawHref.includes("?")) return;
      const url = rawHref.startsWith("http") ? rawHref : `https://www.crexi.com${rawHref}`;
      if (seen.has(url) || url === sourceUrl) return;
      seen.add(url);
      results.push({
        url,
        source,
        title:        rawHref.split("/").pop()?.replace(/-/g, " ") ?? "",
        propertyType: "unknown",
        description:  "",
      });
    });
    logger.info(`[crexi-parser] href stubs: ${results.length}`);
    return results;
  }

  logger.info(`[crexi-parser] HTML fallback: ${cards.length} tiles via "${selectorUsed}"`);

  cards.each((_, el) => {
    const tile = $(el);

    const linkEl  = tile.find("a.cui-card-cover-link").first();
    const rawHref = linkEl.attr("href") ?? "";
    if (!rawHref) return;
    const url = rawHref.startsWith("http") ? rawHref : `https://www.crexi.com${rawHref}`;
    if (seen.has(url)) return;
    seen.add(url);

    const priceText = tile.find("[data-cy='propertyPrice']").first().text().trim();
    const price     = extractPriceFromText(priceText);
    const title     = tile.find("[data-cy='propertyName']").first().text().trim();
    const descText  = tile.find("[data-cy='propertyDescription']").first().text().trim();
    const propType  = normalisePropertyType(descText);

    const addrEl   = tile.find("[data-cy='propertyAddress']").first();
    const citySpan = addrEl.find("span").first().text().trim();
    const streetRaw = addrEl.clone().find("span").remove().end().text().trim();
    const address   = [streetRaw, citySpan].filter(Boolean).join(", ") || undefined;
    const location  = citySpan || address;
    const sqft      = extractSqftFromText(descText);

    results.push({
      url,
      source,
      title:        (title || rawHref.split("/").pop() || "").replace(/\s+/g, " ").trim().slice(0, 200),
      price,
      address,
      location,
      propertyType: propType,
      squareFeet:   sqft,
      description:  descText,
    });
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug dump
// ─────────────────────────────────────────────────────────────────────────────

function saveParserDebug(pathACount: number, pathBCount: number, pathCCount: number) {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "crexi_parser_debug.txt"),
      [
        `Path A (intercepted API JSON) listings: ${pathACount}`,
        `Path B (__NEXT_DATA__ JSON) listings:   ${pathBCount}`,
        `Path C (HTML cheerio) listings:         ${pathCCount}`,
        `Final count: ${Math.max(pathACount, pathBCount, pathCCount)}`,
      ].join("\n")
    );
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function parseCrxiListings(
  html: string,
  nextData: any,
  sourceUrl: string,
  source: string
): RawListing[] {
  // Path A: intercepted API JSON — highest fidelity
  const pathAResults = parseViaJSON(nextData, sourceUrl, source, "intercepted API");
  if (pathAResults.length > 0) {
    logger.info(`[crexi-parser] PATH A succeeded: ${pathAResults.length} listings`);
    saveParserDebug(pathAResults.length, 0, 0);
    return pathAResults;
  }

  // Path B: __NEXT_DATA__ JSON (same walker, Crexi is Angular so this is a no-op)
  const pathBResults = parseViaJSON(nextData, sourceUrl, source, "__NEXT_DATA__");
  if (pathBResults.length > 0) {
    logger.info(`[crexi-parser] PATH B succeeded: ${pathBResults.length} listings`);
    saveParserDebug(0, pathBResults.length, 0);
    return pathBResults;
  }

  // Path C: rendered Angular HTML
  if (!html) {
    logger.info("[crexi-parser] No HTML provided and no JSON listings — returning empty");
    saveParserDebug(0, 0, 0);
    return [];
  }

  logger.info("[crexi-parser] Paths A+B empty — falling back to HTML");
  const pathCResults = parseViaHTML(html, sourceUrl, source);
  logger.info(`[crexi-parser] PATH C: ${pathCResults.length} listings`);
  saveParserDebug(0, 0, pathCResults.length);
  return pathCResults;
}