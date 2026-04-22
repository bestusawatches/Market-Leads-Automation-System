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
//     { data: { assets: [ { id, name, askingPrice, ... } ] } }
//     { assets: [ ... ] }
//     { results: [ ... ] }
//
// PATH B — __NEXT_DATA__ JSON (not applicable — Crexi is Angular, not Next.js)
//   Kept for future compatibility but will always return empty in practice.
//   Reuses the same JSON tree-walker as Path A.
//
// PATH C — HTML / cheerio using Crexi's actual Angular custom elements:
//
//   <crx-sales-property-tile id="search-item-NNNNNN">
//     <cui-card>
//       <a class="cui-card-cover-link" href="/properties/...">  ← URL
//       <span data-cy="propertyPrice">$1,354,000</span>         ← Price
//       <h5   data-cy="propertyName">Title here</h5>            ← Title
//       <div  data-cy="propertyDescription">Multifamily…</div>  ← Desc/type
//       <h4   data-cy="propertyAddress">
//           123 Main St
//           <span>Columbus, OH 43215</span>                      ← City/State
//       </h4>
//     </cui-card>
//   </crx-sales-property-tile>
//
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Type helpers ───────────────────────────────────────────────────────────

interface CrxRaw {
  id?:           string | number;
  name?:         string;
  title?:        string;
  address?:      string;
  city?:         string;
  state?:        string;
  zip?:          string;
  askingPrice?:  number;
  price?:        number;
  listPrice?:    number;
  propertyType?: string;
  type?:         string;
  squareFeet?:   number;
  sqft?:         number;
  buildingSize?: number;
  bedrooms?:     number;
  bathrooms?:    number;
  capRate?:      number;
  noi?:          number;
  description?:  string;
  summary?:      string;
  brokerName?:   string;
  brokerPhone?:  string;
  slug?:         string;
  url?:          string;
  latitude?:     number;
  longitude?:    number;
  units?:        number;
  yearBuilt?:    number;
  lotSize?:      number;
  status?:       string;
}

// ── Normalise property type ────────────────────────────────────────────────

function normalisePropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "unknown";
  const t = raw.toLowerCase();
  if (t.includes("single") || t.includes("sfr") || t.includes("sfh"))                     return "single_family";
  if (t.includes("duplex"))                                                                 return "duplex";
  if (t.includes("multi") || t.includes("apartment") || t.includes("residential income")) return "multi_family";
  if (t.includes("condo"))                                                                  return "condo";
  if (t.includes("town"))                                                                   return "townhouse";
  return "unknown";
}

function buildAddress(r: CrxRaw): string | undefined {
  const parts = [r.address, r.city, r.state, r.zip].filter(Boolean);
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
  const sqft  = r.squareFeet  ?? r.sqft  ?? r.buildingSize ?? undefined;

  const address  = buildAddress(r);
  const propType = normalisePropertyType(r.propertyType ?? r.type);
  const title    = r.name ?? r.title ?? r.description?.slice(0, 100) ?? "";
  const url      = buildUrl(r, sourceUrl);

  if (!price && !address) return null;

  return {
    url,
    source,
    title:        title.replace(/\s+/g, " ").trim().slice(0, 200),
    price,
    address,
    location:     [r.city, r.state].filter(Boolean).join(", ") || address,
    propertyType: propType,
    bedrooms:     r.bedrooms,
    bathrooms:    r.bathrooms,
    squareFeet:   sqft ? Math.round(sqft) : undefined,
    description:  r.description ?? r.summary ?? "",
    ownerName:    r.brokerName,
    ownerPhone:   r.brokerPhone,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON tree-walker — finds a listings array anywhere in the JSON tree.
//
// Used for both intercepted API responses (Path A) and __NEXT_DATA__ (Path B).
//
// "assets" is listed first because that is Crexi's actual API field name:
//   { data: { assets: [ { id, name, askingPrice, ... } ] } }
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

  // "assets" must be first — it is Crexi's actual API field name
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
    "askingPrice", "listPrice", "price", "address", "city",
    "propertyType", "squareFeet", "slug", "capRate",
  ];
  return listingFields.some((f) => f in obj);
}

// Shared JSON → RawListing converter used by both Path A and Path B
function parseViaJSON(json: any, sourceUrl: string, source: string, label: string): RawListing[] {
  if (!json) return [];

  const rawListings = findListingsArray(json);
  if (!rawListings || rawListings.length === 0) {
    logger.debug(`[crexi-parser] ${label}: JSON present but no listings array found`);
    return [];
  }

  logger.info(`[crexi-parser] ${label}: found ${rawListings.length} raw items`);

  const results: RawListing[] = [];
  for (const r of rawListings) {
    const listing = rawToListing(r, sourceUrl, source);
    if (listing) results.push(listing);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH C — HTML / cheerio — Crexi Angular custom element selectors
//
// Crexi renders as an Angular SPA. The key elements visible in the fully
// rendered DOM are:
//
//   <crx-sales-property-tile id="search-item-NNNNNN">
//     …
//     <span data-cy="propertyPrice">$555,000</span>
//     <h5   data-cy="propertyName">7 Duplex's 15 Cap Rate Cleveland</h5>
//     <div  data-cy="propertyDescription">Multifamily • 7 Units • …</div>
//     <h4   data-cy="propertyAddress">
//         7 LOCATIONS
//         <span>Cleveland, OH 44112</span>
//     </h4>
//     <a class="cui-card-cover-link" href="/properties/2431987/ohio-…">
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
  // Guard: if this looks like a CF challenge page that slipped through, bail early.
  // This catches the case where waitForCloudflare times out and returns true anyway.
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

  // ── 1. Primary: Crexi Angular tiles ─────────────────────────────────────
  let cards = $("crx-sales-property-tile[id^='search-item-']");
  let selectorUsed = "crx-sales-property-tile[id^='search-item-']";

  // ── 2. Fallback A: cui-card with a cover link ────────────────────────────
  if (cards.length === 0) {
    cards = $("cui-card:has(a.cui-card-cover-link)");
    selectorUsed = "cui-card:has(a.cui-card-cover-link)";
  }

  // ── 3. Fallback B: any element containing a data-cy="propertyPrice" ──────
  if (cards.length === 0) {
    cards = $("[data-cy='propertyPrice']")
      .map((_, el) => $(el).closest("cui-card, crx-sales-property-tile, article").get(0))
      .filter((_, el) => !!el) as any;
    selectorUsed = "ancestor of [data-cy=propertyPrice]";
  }

  // ── 4. Last-resort: collect all property hrefs as stub listings ──────────
  if (cards.length === 0) {
    logger.warn("[crexi-parser] Angular tile selectors missed — collecting property hrefs as stubs");
    $("a[href*='/properties/'][href*='-']").each((_, el) => {
      const rawHref = $(el).attr("href") ?? "";
      if (!rawHref || rawHref === "/" || rawHref.includes("?")) return;
      const url = rawHref.startsWith("http")
        ? rawHref
        : `https://www.crexi.com${rawHref}`;
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

    // ── Cover link / URL ──────────────────────────────────────────────────
    const linkEl  = tile.find("a.cui-card-cover-link").first();
    const rawHref = linkEl.attr("href") ?? "";
    if (!rawHref) return;
    const url = rawHref.startsWith("http")
      ? rawHref
      : `https://www.crexi.com${rawHref}`;
    if (seen.has(url)) return;
    seen.add(url);

    // ── Price ─────────────────────────────────────────────────────────────
    const priceText = tile.find("[data-cy='propertyPrice']").first().text().trim();
    const price     = extractPriceFromText(priceText);

    // ── Title ─────────────────────────────────────────────────────────────
    const title = tile.find("[data-cy='propertyName']").first().text().trim();

    // ── Description → property type, CAP rate hint ────────────────────────
    const descText = tile.find("[data-cy='propertyDescription']").first().text().trim();
    const propType = normalisePropertyType(descText);

    // ── Address ──────────────────────────────────────────────────────────
    // <h4 data-cy="propertyAddress"> STREET <span>City, ST ZIP</span></h4>
    const addrEl   = tile.find("[data-cy='propertyAddress']").first();
    const citySpan = addrEl.find("span").first().text().trim();
    // Street text sits as a direct text node — clone, strip span, grab text
    const streetRaw = addrEl.clone().find("span").remove().end().text().trim();
    const address   = [streetRaw, citySpan].filter(Boolean).join(", ") || undefined;
    const location  = citySpan || address;

    // ── Square footage from description ──────────────────────────────────
    const sqft = extractSqftFromText(descText);

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

function saveParserDebug(
  pathACount: number,
  pathBCount: number,
  pathCCount: number,
) {
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
//
// `nextData` can be:
//   - An intercepted Crexi API JSON response  → parsed as Path A
//   - A parsed __NEXT_DATA__ object           → parsed as Path B (same walker)
//   - null                                    → falls through to Path C (HTML)
// ─────────────────────────────────────────────────────────────────────────────

export function parseCrxiListings(
  html: string,
  nextData: any,
  sourceUrl: string,
  source: string
): RawListing[] {
  // Path A: intercepted API JSON — highest fidelity, no DOM rendering dependency
  const pathAResults = parseViaJSON(nextData, sourceUrl, source, "intercepted API");
  if (pathAResults.length > 0) {
    logger.info(`[crexi-parser] PATH A succeeded: ${pathAResults.length} listings`);
    saveParserDebug(pathAResults.length, 0, 0);
    return pathAResults;
  }

  // Path B: __NEXT_DATA__ JSON — same walker, different label.
  // In practice nextData IS the intercepted API JSON, so if Path A returned
  // empty the JSON genuinely had no recognisable listings; Path B is a no-op.
  // Kept explicitly so the log makes the distinction clear if behaviour changes.
  const pathBResults = parseViaJSON(nextData, sourceUrl, source, "__NEXT_DATA__");
  if (pathBResults.length > 0) {
    logger.info(`[crexi-parser] PATH B succeeded: ${pathBResults.length} listings`);
    saveParserDebug(0, pathBResults.length, 0);
    return pathBResults;
  }

  // Path C: parse rendered Angular HTML
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