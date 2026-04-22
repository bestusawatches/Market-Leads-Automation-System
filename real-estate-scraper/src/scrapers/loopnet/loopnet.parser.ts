// src/scrapers/loopnet/loopnet.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// LoopNet search results parser
//
// Two extraction paths (tried in order):
//
// PATH A — JSON-LD structured data  (most reliable)
//   LoopNet embeds every listing as a Schema.org Product/RealEstateListing
//   inside <script type="application/ld+json"> tags.  This data is stable
//   and doesn't break when CSS class names change.
//
//   Shape of each JSON-LD object:
//   {
//     "@type": "Product",            // or "Offer", "RealEstateListing"
//     "name": "123 Main St ...",
//     "description": "...",
//     "url": "https://www.loopnet.com/Listing/...",
//     "price": "2500000",
//     "additionalType": "Multifamily",
//     "additionalProperty": { "name": "Square Footage", "value": "12000" },
//     "spatialCoverage": {
//       "name": "123 Main St",
//       "address": { "addressLocality": "Columbus", "addressRegion": "OH", "postalCode": "43201" }
//     },
//     "offeredBy": [{ "name": "John Smith", "jobTitle": "...", "organization": "..." }]
//   }
//
// PATH B — HTML / cheerio  (fallback)
//   Parses the rendered article/li card elements using stable aria and
//   data-testid attributes.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Shared helpers ─────────────────────────────────────────────────────────

function normalisePropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "unknown";
  const t = raw.toLowerCase();
  if (t.includes("single") || t.includes("sfr") || t.includes("sfh"))           return "single_family";
  if (t.includes("duplex"))                                                       return "duplex";
  if (t.includes("multi") || t.includes("apartment") || t.includes("apartment")) return "multi_family";
  if (t.includes("condo"))                                                        return "condo";
  if (t.includes("town"))                                                         return "townhouse";
  return "unknown";
}

function extractPriceFromText(text: string): number | undefined {
  const m =
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]\b/) ||
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]\b/) ||
    text.match(/\$\s*([\d,]+)/);
  if (!m) return undefined;
  let val    = parseFloat(m[1].replace(/,/g, ""));
  const raw    = m[0];
  const suffix = raw[raw.length - 1]?.toLowerCase();
  if (suffix === "k") val *= 1_000;
  if (suffix === "m") val *= 1_000_000;
  return Math.round(val);
}

function extractSqftFromText(text: string): number | undefined {
  const m = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf)\b/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH A — JSON-LD extraction
// ─────────────────────────────────────────────────────────────────────────────

interface JsonLdItem {
  "@type"?:            string;
  name?:               string;
  description?:        string;
  url?:                string;
  price?:              string | number;
  minPrice?:           string | number | null;
  currency?:           string;
  additionalType?:     string;
  additionalProperty?: { name?: string; value?: string | number } | Array<{ name?: string; value?: string | number }>;
  spatialCoverage?:    {
    name?:    string;
    address?: {
      addressLocality?: string;
      addressRegion?:   string;
      postalCode?:      string;
      streetAddress?:   string;
    };
  };
  offeredBy?: Array<{
    name?:         string;
    jobTitle?:     string;
    organization?: string;
    telephone?:    string;
  }>;
  "@graph"?: JsonLdItem[];
}

function extractSqftFromJsonLd(item: JsonLdItem): number | undefined {
  const prop = item.additionalProperty;
  if (!prop) return undefined;

  const props = Array.isArray(prop) ? prop : [prop];
  const sqftProp = props.find(
    (p) => p.name?.toLowerCase().includes("square") || p.name?.toLowerCase() === "sf"
  );
  if (!sqftProp?.value) return undefined;
  const val = parseInt(String(sqftProp.value).replace(/,/g, ""), 10);
  return isNaN(val) ? undefined : val;
}

function jsonLdItemToListing(
  item: JsonLdItem,
  sourceUrl: string,
  source: string
): RawListing | null {
  // Only process types that look like property listings
  const type = (item["@type"] ?? "").toLowerCase();
  if (
    type &&
    !type.includes("product") &&
    !type.includes("offer") &&
    !type.includes("realestate") &&
    !type.includes("accommodation")
  ) {
    return null;
  }

  const rawPrice = item.price ?? item.minPrice;
  const price    = rawPrice
    ? Math.round(parseFloat(String(rawPrice).replace(/[^0-9.]/g, "")))
    : undefined;

  const spatial = item.spatialCoverage;
  const addr    = spatial?.address;
  const addressParts = [
    addr?.streetAddress ?? spatial?.name,
    addr?.addressLocality,
    addr?.addressRegion,
    addr?.postalCode,
  ].filter(Boolean);
  const address = addressParts.length > 0 ? addressParts.join(", ") : undefined;
  const location = [addr?.addressLocality, addr?.addressRegion]
    .filter(Boolean)
    .join(", ");

  // Skip if neither price nor address
  if (!price && !address) return null;

  const brokers   = item.offeredBy ?? [];
  const broker    = brokers[0];
  const ownerName = broker?.name;
  const ownerPhone = broker?.telephone;

  const url = item.url?.startsWith("http")
    ? item.url
    : item.url
    ? `https://www.loopnet.com${item.url}`
    : sourceUrl;

  return {
    url,
    source,
    title:        (item.name ?? address ?? "").slice(0, 200).replace(/\s+/g, " ").trim(),
    price:        price && price > 0 ? price : undefined,
    address,
    location:     location || address,
    propertyType: normalisePropertyType(item.additionalType),
    squareFeet:   extractSqftFromJsonLd(item),
    description:  (item.description ?? "").slice(0, 2000),
    ownerName,
    ownerPhone,
  };
}

function parseViaJsonLd(
  html: string,
  sourceUrl: string,
  source: string
): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw  = $(el).html() ?? "";
      const data = JSON.parse(raw) as JsonLdItem | JsonLdItem[];

      const items: JsonLdItem[] = Array.isArray(data) ? data : [data];

      for (const item of items) {
        // Handle @graph wrapper
        if (item["@graph"]) {
          for (const graphItem of item["@graph"]) {
            const listing = jsonLdItemToListing(graphItem, sourceUrl, source);
            if (listing) results.push(listing);
          }
          continue;
        }
        const listing = jsonLdItemToListing(item, sourceUrl, source);
        if (listing) results.push(listing);
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

function parseViaHTML(
  html: string,
  sourceUrl: string,
  source: string
): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];
  const seen = new Set<string>();

  // LoopNet card selectors — from most to least specific
  const cardSelectors = [
    "[data-testid='listing-card']",
    "article.listingCard",
    "article[class*='listingCard']",
    "li[class*='listingCard']",
    "li[class*='listing-card']",
    "article",
  ];

  let cards = $();
  for (const sel of cardSelectors) {
    const found = $(sel);
    if (found.length > 0) {
      logger.info(`[loopnet-parser] HTML fallback: ${found.length} cards via "${sel}"`);
      cards = found;
      break;
    }
  }

  if (cards.length === 0) {
    logger.warn("[loopnet-parser] HTML fallback: no cards found");
    return [];
  }

  cards.each((_, el) => {
    const card = $(el);
    const text = card.text().replace(/\s+/g, " ").trim();
    if (text.length < 20) return;

    // ── URL ──────────────────────────────────────────────────────
    const linkEl  = card.find("a[href*='/Listing/']").first();
    const rawHref = linkEl.attr("href") ?? "";
    const url     = rawHref.startsWith("http")
      ? rawHref
      : rawHref
      ? `https://www.loopnet.com${rawHref}`
      : sourceUrl;

    if (seen.has(url)) return;
    seen.add(url);

    // ── Title / address ───────────────────────────────────────────
    const titleEl = card
      .find("[class*='title'], [class*='address'], h2, h3, [data-testid='listing-address']")
      .first();
    const title = titleEl.text().trim() || text.slice(0, 100);

    // ── Price ─────────────────────────────────────────────────────
    const priceEl = card
      .find("[class*='price'], [class*='Price'], [data-testid*='price']")
      .first();
    const price = extractPriceFromText(priceEl.text() || text);

    // ── Property type ─────────────────────────────────────────────
    const typeEl = card
      .find("[class*='propertyType'], [class*='property-type'], [data-testid*='type']")
      .first();
    const propType = normalisePropertyType(typeEl.text().trim());

    // ── Sqft ──────────────────────────────────────────────────────
    const sqft = extractSqftFromText(text);

    // ── Address ───────────────────────────────────────────────────
    const addrEl = card
      .find("[class*='address'], [class*='location'], [data-testid*='address']")
      .first();
    const address = addrEl.text().trim() || undefined;

    // ── Broker ────────────────────────────────────────────────────
    const brokerEl = card.find("[class*='broker'], [class*='agent']").first();
    const ownerName = brokerEl.text().trim() || undefined;

    if (!price && !address) return;

    results.push({
      url,
      source,
      title:        title.replace(/\s+/g, " ").trim().slice(0, 200),
      price,
      address,
      location:     address,
      propertyType: propType,
      squareFeet:   sqft,
      description:  text.slice(0, 1000),
      ownerName,
    });
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug dump
// ─────────────────────────────────────────────────────────────────────────────

function saveParserDebug(info: {
  url: string;
  jsonLdBlocks: number;
  pathACount: number;
  pathBCount: number;
  final: number;
}) {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      `Source URL:        ${info.url}`,
      `JSON-LD blocks:    ${info.jsonLdBlocks}`,
      `Path A (JSON-LD):  ${info.pathACount} listings`,
      `Path B (HTML):     ${info.pathBCount} listings`,
      `Final:             ${info.final} listings`,
    ].join("\n");
    const slug = info.url.replace(/https?:\/\/[^/]+\/search\//, "").replace(/\//g, "_").slice(0, 40);
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
  // Count JSON-LD blocks for debug info
  const jsonLdCount = (html.match(/application\/ld\+json/g) ?? []).length;
  logger.debug(`[loopnet-parser] JSON-LD blocks found: ${jsonLdCount}`);

  // PATH A — JSON-LD
  const pathAResults = parseViaJsonLd(html, sourceUrl, source);
  if (pathAResults.length > 0) {
    logger.info(`[loopnet-parser] PATH A (JSON-LD): ${pathAResults.length} listings`);
    saveParserDebug({ url: sourceUrl, jsonLdBlocks: jsonLdCount, pathACount: pathAResults.length, pathBCount: 0, final: pathAResults.length });
    return pathAResults;
  }

  // PATH B — HTML fallback
  logger.info("[loopnet-parser] PATH A empty — falling back to HTML");
  const pathBResults = parseViaHTML(html, sourceUrl, source);
  logger.info(`[loopnet-parser] PATH B (HTML): ${pathBResults.length} listings`);

  saveParserDebug({ url: sourceUrl, jsonLdBlocks: jsonLdCount, pathACount: 0, pathBCount: pathBResults.length, final: pathBResults.length });
  return pathBResults;
}