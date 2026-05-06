// src/scrapers/realtor/realtor.parser.ts
//
// ── Shape notes ───────────────────────────────────────────────────────────────
//
// This parser handles TWO response shapes:
//
//   Shape A — __NEXT_DATA__ (legacy, still exported for reference)
//     props.pageProps.properties[]          — listing array
//     props.pageProps.totalProperties       — total count
//     props.pageProps.totalPages            — page count
//
//   Shape B — internal JSON API  ← used by the refactored scraper
//     The exact field paths depend on which XHR endpoint Realtor.com uses.
//     To discover it:
//       1. DevTools → Network → XHR/Fetch
//       2. Load a search results page on realtor.com
//       3. Find the large JSON response containing property listings
//       4. Paste the URL + sample payload here so the paths can be confirmed
//
//     The scraper saves the raw API response to:
//       logs/realtor_api_<market>_p1.json
//     Inspect that file on first run to verify field paths below.
//
//     ASSUMED paths (update after inspecting logs/realtor_api_*_p1.json):
//       .properties[] or .data.results[] or .data.home_search.results[]
//       .property_id
//       .list_price / .price
//       .list_date
//       .status
//       .location.address.*
//       .description.*
//       .estimates.estimate / .avm.value
//
// ── Estimate paths ────────────────────────────────────────────────────────────
//
//   Detail page __NEXT_DATA__:
//     props.pageProps.property.estimates.estimate
//     props.pageProps.propertyDetails.estimates.estimate
//     props.pageProps.initialReduxState.propertyDetails
//       .currentListing.estimates.estimate
//
//   Property detail API (/api/v3/property or similar):
//     .estimates.estimate
//     .property.estimates.estimate
//     .data.estimates.estimate
//     Fallback: deep scan for keys "estimate", "estimated_value", "avm_value"
//

import { RawListing, PropertyType } from "../../types/listing";
import { logger }                   from "../../utils/logger";

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_DAYS_OLD     = 30;
export const RESULTS_PER_PAGE = 42;

// ── Shared types ──────────────────────────────────────────────────────────────

export interface RealtorEstimate {
  estimate:      number;
  estimateHigh?: number;
  estimateLow?:  number;
  provider?:     string;
}

export interface ParsedPage {
  listings:   RawListing[];
  allStale:   boolean;
  total:      number;   // total results available (for pagination)
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function toPropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "single_family";
  const t = raw.toLowerCase();
  if (t.includes("single"))                           return "single_family";
  if (t.includes("multi"))                            return "multi_family";
  if (t.includes("duplex"))                           return "duplex";
  if (t.includes("condo"))                            return "condo";
  if (t.includes("townhouse") || t.includes("town")) return "townhouse";
  return "single_family";
}

export function daysSince(dateStr: string | undefined | null): number | undefined {
  if (!dateStr) return undefined;
  try {
    const ms = Date.now() - new Date(dateStr).getTime();
    return Math.floor(ms / 86_400_000);
  } catch {
    return undefined;
  }
}

export function buildListingUrl(
  permalink:  string | undefined,
  propertyId: string
): string {
  if (permalink)
    return `https://www.realtor.com/realestateandhomes-detail/${permalink}`;
  return `https://www.realtor.com/realestateandhomes-detail/${propertyId}`;
}

// ── Estimate helpers ──────────────────────────────────────────────────────────

/**
 * Tries a list of known object paths for an estimate block.
 * Returns the first one that contains a numeric estimate > $10k.
 */
function extractFromEstimateBlock(
  block:   any,
  address: string
): RealtorEstimate | null {
  if (!block || typeof block !== "object") return null;

  // Field name variants seen across different API versions
  const raw =
    block.estimate      ??
    block.estimated_value ??
    block.avm_value     ??
    block.price         ??
    null;

  const value =
    typeof raw === "number" && raw > 10_000 ? raw : null;

  if (!value) return null;

  const result: RealtorEstimate = { estimate: value };

  const hi = block.estimate_high ?? block.high ?? block.upper;
  const lo = block.estimate_low  ?? block.low  ?? block.lower;
  if (typeof hi === "number" && hi > 10_000) result.estimateHigh = hi;
  if (typeof lo === "number" && lo > 10_000) result.estimateLow  = lo;

  const provider = block.provider_url ?? block.provider ?? block.source;
  if (typeof provider === "string") result.provider = provider;

  logger.debug(
    `[realtor-parser] estimate for "${address}": ` +
    `$${value.toLocaleString()}` +
    (result.estimateLow  ? ` lo=$${result.estimateLow.toLocaleString()}`   : "") +
    (result.estimateHigh ? ` hi=$${result.estimateHigh.toLocaleString()}` : "") +
    (result.provider     ? ` via ${result.provider}`                       : "")
  );

  return result;
}

/**
 * Deep-scans a JSON tree (max depth 8) for any key named "estimate",
 * "estimated_value", or "avm_value" whose value is a number > $10k.
 * Used as a last resort when no known path yields an estimate.
 */
function deepFindEstimate(node: any, depth = 0): number | null {
  if (depth > 8 || node === null || typeof node !== "object") return null;

  for (const key of ["estimate", "estimated_value", "avm_value"]) {
    if (key in node && typeof node[key] === "number" && node[key] > 10_000) {
      return node[key] as number;
    }
  }

  for (const k of Object.keys(node)) {
    const found = deepFindEstimate(node[k], depth + 1);
    if (found !== null) return found;
  }

  return null;
}

// ── Estimate from property detail API response ────────────────────────────────
//
// Called by the scraper after GET /api/v3/property?property_id=<id>
// (or whatever the real detail endpoint turns out to be).
//
// Field paths tried in order — update this list after inspecting
// logs/realtor_api_*_p1.json and the detail endpoint responses.

export function extractEstimateFromPropertyDetail(
  detail:  any,
  address: string
): RealtorEstimate | null {
  if (!detail) return null;

  // Known paths — ordered from most-specific to least-specific.
  // Expand this list after inspecting the real API responses.
  const candidates: any[] = [
    detail?.estimates,
    detail?.property?.estimates,
    detail?.data?.estimates,
    detail?.data?.property?.estimates,
    detail?.data?.home?.estimates,
    detail?.data?.listing?.estimates,
    // Some endpoints nest it inside an avm key
    detail?.avm,
    detail?.property?.avm,
    detail?.data?.avm,
  ];

  for (const block of candidates) {
    const result = extractFromEstimateBlock(block, address);
    if (result) return result;
  }

  // Deep-scan fallback
  const found = deepFindEstimate(detail);
  if (found) {
    logger.debug(
      `[realtor-parser] estimate for "${address}" via deep scan: ` +
      `$${found.toLocaleString()}`
    );
    return { estimate: found };
  }

  logger.debug(
    `[realtor-parser] no estimate found in property detail for "${address}"`
  );
  return null;
}

// ── Estimate from detail page __NEXT_DATA__ (legacy) ─────────────────────────
//
// Kept so existing code that calls extractEstimateFromDetailNextData
// continues to compile.  Not called by the refactored scraper.

export function extractEstimateFromDetailNextData(
  nextData: any,
  address:  string
): RealtorEstimate | null {
  const candidates: any[] = [
    nextData?.props?.pageProps?.property?.estimates,
    nextData?.props?.pageProps?.propertyDetails?.estimates,
    nextData?.props?.pageProps?.initialReduxState?.propertyDetails
      ?.currentListing?.estimates,
  ];

  for (const block of candidates) {
    const result = extractFromEstimateBlock(block, address);
    if (result) return result;
  }

  const found = deepFindEstimate(nextData);
  if (found) {
    logger.debug(
      `[realtor-parser] estimate for "${address}" via deep scan: ` +
      `$${found.toLocaleString()}`
    );
    return { estimate: found };
  }

  logger.debug(
    `[realtor-parser] no estimate in detail __NEXT_DATA__ for "${address}"`
  );
  return null;
}

// ── Core listing builder ──────────────────────────────────────────────────────
//
// Converts one raw property object (from any API shape) into a RawListing.
// The caller is responsible for extracting the right array from the envelope
// and passing individual items here.
//
// ⚠️  Field paths are ASSUMED based on the __NEXT_DATA__ shape and common
//     Realtor.com API patterns.  Verify against logs/realtor_api_*_p1.json
//     after the first run and update the accessors below if needed.

function buildListing(item: any): RawListing | null {
  // Property ID is required — skip items without one
  const propertyId: string | undefined =
    item?.property_id ?? item?.propertyId ?? item?.id;
  if (!propertyId) return null;

  // ── Address ───────────────────────────────────────────────────────────────
  // Try both the nested location.address shape and a flat address shape
  const addr       = item?.location?.address ?? item?.address ?? {};
  const streetLine = addr.line        ?? addr.street   ?? addr.line1    ?? "";
  const city       = addr.city        ?? item?.city    ?? "";
  const stateCode  = addr.state_code  ?? addr.state    ?? item?.state   ?? "";
  const postalCode = addr.postal_code ?? addr.zip      ?? addr.zipcode  ?? "";
  const fullAddress = [streetLine, city, stateCode, postalCode]
    .filter(Boolean)
    .join(", ");

  const lat: number | undefined = addr.coordinate?.lat ?? addr.lat ?? undefined;
  const lng: number | undefined = addr.coordinate?.lon ?? addr.lon ?? addr.lng ?? undefined;

  // ── Price ─────────────────────────────────────────────────────────────────
  const rawPrice =
    item?.list_price ??
    item?.price      ??
    item?.listing_price;
  const price: number | undefined =
    typeof rawPrice === "number" && rawPrice > 0 ? rawPrice : undefined;

  // ── Dates ─────────────────────────────────────────────────────────────────
  const listDate = item?.list_date ?? item?.listing_date ?? item?.listed_date;
  const daysOld  = daysSince(listDate);

  // ── Property details ──────────────────────────────────────────────────────
  // Realtor.com nests these under "description"; some API endpoints flatten them
  const desc    = item?.description ?? item;
  const beds: number | undefined =
    desc?.beds ?? desc?.bedrooms ?? item?.beds ?? undefined;
  const sqft: number | undefined =
    desc?.sqft ?? desc?.square_feet ?? item?.sqft ?? undefined;
  const yearBuilt: number | undefined =
    desc?.year_built ?? item?.year_built ?? undefined;
  const lotSqft: number | undefined =
    desc?.lot_sqft ?? desc?.lot_size ?? item?.lot_sqft ?? undefined;

  const baths: number | undefined =
    // desc?.baths_consolidated ??
    // (desc?.baths_full != null || desc?.baths_half != null
    //   ? (desc?.baths_full ?? 0) + (desc?.baths_half ?? 0) * 0.5
    //   : desc?.baths ?? desc?.bathrooms ?? item?.baths ?? undefined) ||
    undefined;

  // ── Media / contact ───────────────────────────────────────────────────────
  const imgSrc =
    item?.photos?.[0]?.href       ??
    item?.primary_photo?.href     ??
    item?.thumbnail                ??
    undefined;

  const agent      = item?.agents?.[0] ?? item?.agent ?? item?.listing_agent;
  const ownerName  =
    agent?.full_name  ??
    agent?.name       ??
    item?.branding?.[0]?.name ??
    undefined;
  const ownerPhone =
    agent?.phone      ??
    agent?.phones?.[0]?.number ??
    undefined;

  // ── Inline estimate (some search endpoints include it directly) ───────────
  const inlineEst = extractFromEstimateBlock(
    item?.estimates ?? item?.avm,
    fullAddress || String(propertyId)
  );

  const listing: RawListing & { _realtorPropertyId?: string } = {
    url:          buildListingUrl(item?.permalink, String(propertyId)),
    source:       "realtor",
    title:        streetLine || fullAddress,
    address:      fullAddress || undefined,
    price,
    propertyType: toPropertyType(desc?.type ?? item?.property_type),
    imgSrc,
    ownerName,
    ownerPhone,
    status:       item?.status ?? "for_sale",
    daysOnMarket: daysOld,
    yearBuilt,
    lotSqft,
    priceReduced: !!(
      item?.price_reduced_amount    ||
      item?.list_price_last_change_amount
    ),
    listedAt:    listDate ? new Date(listDate) : undefined,
    description: desc?.text ?? "",
    zestimate:   inlineEst?.estimate,
    // Carry propertyId through so the scraper can look up estimates
    // without re-parsing the URL.
    _realtorPropertyId: String(propertyId),
  };

  return listing;
}

// ── Search-results parser (NEW: JSON API response) ────────────────────────────
//
// Parses the response from the internal Realtor.com search API.
//
// ⚠️  The top-level array path is ASSUMED.  On first run, inspect
//     logs/realtor_api_<market>_p1.json and update `extractResultsArray`
//     if the listing array lives elsewhere.

function extractResultsArray(data: any): any[] {
  // Try the most common envelope shapes, ordered by likelihood.
  // Update this list after inspecting the real API response.
  const candidates: any[] = [
    data?.properties,
    data?.results,
    data?.data?.results,
    data?.data?.properties,
    data?.data?.home_search?.results,
    data?.home_search?.results,
    data?.data?.homes,
    data?.homes,
    data?.listings,
    data?.data?.listings,
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }

  // Last resort: if the top level IS an array
  if (Array.isArray(data)) return data;

  return [];
}

function extractTotal(data: any): number {
  // Common locations for total result count
  return (
    data?.total                     ??
    data?.totalCount                ??
    data?.total_count               ??
    data?.count                     ??
    data?.data?.total               ??
    data?.data?.totalCount          ??
    data?.data?.total_count         ??
    data?.data?.home_search?.total  ??
    data?.home_search?.total        ??
    0
  );
}

export function parseRealtorApiResults(
  apiResponse: any,
  marketName:  string,
  applyDateFilter = true
): ParsedPage {
  const raw   = extractResultsArray(apiResponse);
  const total = extractTotal(apiResponse);

  if (raw.length === 0) {
    logger.debug(
      `[realtor-parser] No results array found for ${marketName}. ` +
      `Top-level keys: ${Object.keys(apiResponse ?? {}).join(", ")}\n` +
      `  → Inspect logs/realtor_api_*.json and update extractResultsArray()`
    );
    return { listings: [], allStale: true, total: 0 };
  }

  logger.debug(
    `[realtor-parser] ${marketName}: ${raw.length} raw items | total=${total}\n` +
    `  First item keys: ${Object.keys(raw[0] ?? {}).join(", ")}`
  );

  const listings: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    const listing = buildListing(item);
    if (!listing) continue;

    if (
      applyDateFilter &&
      typeof listing.daysOnMarket === "number" &&
      listing.daysOnMarket > MAX_DAYS_OLD
    ) {
      staleCount++;
      continue;
    }

    listings.push(listing);

    logger.debug(
      `[realtor-parser] ✓ ${listing.address} | ` +
      `$${listing.price?.toLocaleString() ?? "?"} | ` +
      (listing.zestimate ? ` | est $${listing.zestimate.toLocaleString()}` : "")
    );
  }

  const itemsWithDate = raw.filter(
    (i: any) => i?.list_date ?? i?.listing_date ?? i?.listed_date
  ).length;
  const allStale = itemsWithDate > 0 && staleCount >= itemsWithDate;

  logger.info(
    `[realtor-parser] ${marketName}: ${listings.length} valid, ` +
    `${staleCount} stale, total=${total}`
  );

  return { listings, allStale, total };
}

// ── Search-results parser (LEGACY: __NEXT_DATA__) ─────────────────────────────
//
// Kept so existing callers continue to compile while the migration is in
// progress.  The refactored scraper does NOT call this function.

export function parseRealtorResults(
  nextData:        any,
  applyDateFilter = true
): {
  listings:        RawListing[];
  allStale:        boolean;
  totalPages:      number;
  totalProperties: number;
} {
  const pageProps         = nextData?.props?.pageProps ?? {};
  const totalProperties   = pageProps.totalProperties ?? 0;
  const totalPages: number =
    pageProps.totalPages ??
    (totalProperties > 0
      ? Math.ceil(totalProperties / RESULTS_PER_PAGE)
      : 1);

  logger.debug(
    `[realtor-parser] (legacy) pageProps keys: ${Object.keys(pageProps).join(", ")}`
  );

  // Normalise the properties field — handles both array and wrapped shapes
  let raw: any[] = [];
  if (Array.isArray(pageProps.properties)) {
    raw = pageProps.properties;
  } else if (pageProps.properties && typeof pageProps.properties === "object") {
    const inner =
      (pageProps.properties as any).results ??
      (pageProps.properties as any).listings;
    if (Array.isArray(inner)) raw = inner;
  }

  if (raw.length === 0) {
    return { listings: [], allStale: true, totalPages, totalProperties };
  }

  const { listings, allStale } = _parseItemArray(raw, applyDateFilter);

  logger.info(
    `[realtor-parser] (legacy) ${listings.length} valid listings ` +
    `(totalPages=${totalPages})`
  );

  return { listings, allStale, totalPages, totalProperties };
}

// Shared array-processing logic used by both parsers
function _parseItemArray(
  raw:             any[],
  applyDateFilter: boolean
): { listings: RawListing[]; allStale: boolean } {
  const listings: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    const listing = buildListing(item);
    if (!listing) continue;

    if (
      applyDateFilter &&
      typeof listing.daysOnMarket === "number" &&
      listing.daysOnMarket > MAX_DAYS_OLD
    ) {
      staleCount++;
      continue;
    }

    listings.push(listing);
  }

  const itemsWithDate = raw.filter(
    (i: any) => i?.list_date ?? i?.last_update_date
  ).length;
  const allStale = itemsWithDate > 0 && staleCount >= itemsWithDate;

  return { listings, allStale };
}