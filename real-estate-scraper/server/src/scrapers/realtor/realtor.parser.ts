// src/scrapers/realtor/realtor.parser.ts
//
// ── __NEXT_DATA__ shapes ──────────────────────────────────────────────────────
//
// SEARCH PAGE  (props.pageProps.properties[])
//   .property_id
//   .permalink                 — URL slug
//   .list_price                — number
//   .list_date / .last_update_date
//   .status                    — "for_sale" | "sold" | "pending"
//   .location.address.line / .city / .state_code / .postal_code
//   .location.address.coordinate.lat / .lon
//   .description.beds / .baths_consolidated / .sqft / .lot_sqft
//   .description.type          — "single_family" | "multi_family" etc.
//   .description.year_built
//   .price_reduced_amount
//   .photos[0].href
//   .agents[0].full_name / .phone
//   .branding[0].name
//   props.pageProps.totalProperties / .totalPages
//
// DETAIL PAGE  (props.pageProps.property)
//   .estimates.estimate        — AVM value  ← the "Realtor Estimate"
//   .estimates.estimate_high
//   .estimates.estimate_low
//   .estimates.provider_url    — data source ("black_knight" etc.)
//   .tax_history[0].assessment — last tax assessed value
//   .price_history[0].price    — last sold price
//
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing, PropertyType } from "../../types/listing";
import { logger }                   from "../../utils/logger";

export const MAX_DAYS_OLD     = 30;
export const RESULTS_PER_PAGE = 42;

// ── Shared helpers ────────────────────────────────────────────────────────────

function toPropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "single_family";
  const t = raw.toLowerCase();
  if (t.includes("single"))                           return "single_family";
  if (t.includes("multi"))                            return "multi_family";
  if (t.includes("duplex"))                           return "duplex";
  if (t.includes("condo"))                            return "condo";
  if (t.includes("townhouse") || t.includes("town")) return "townhouse";
  return "single_family";
}

function daysSince(dateStr: string | undefined | null): number | undefined {
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

// ── Estimate extraction from detail page __NEXT_DATA__ ────────────────────────
//
// Called by the scraper after it fetches each detail page via Oxylabs.
// Returns null if the estimate is absent or can't be parsed.
//
// Known paths on detail pages (as of 2025):
//   props.pageProps.property.estimates.estimate          ← primary
//   props.pageProps.property.estimates.estimate_high
//   props.pageProps.property.estimates.estimate_low
//   props.pageProps.propertyDetails.estimates.estimate   ← alternate key
//   props.pageProps.initialReduxState.propertyDetails
//     .currentListing.estimates.estimate                 ← older shape

export interface RealtorEstimate {
  estimate:      number;
  estimateHigh?: number;
  estimateLow?:  number;
  provider?:     string;
}

export function extractEstimateFromDetailNextData(
  nextData: any,
  address:  string
): RealtorEstimate | null {
  // All known paths where Realtor.com embeds the estimate
  const candidates = [
    nextData?.props?.pageProps?.property?.estimates,
    nextData?.props?.pageProps?.propertyDetails?.estimates,
    nextData?.props?.pageProps?.initialReduxState?.propertyDetails
      ?.currentListing?.estimates,
  ];

  for (const est of candidates) {
    if (!est) continue;

    const raw   = est.estimate ?? est.estimated_value ?? est.price;
    const value =
      typeof raw === "number" && raw > 1_000 ? raw : undefined;

    if (value) {
      const result: RealtorEstimate = { estimate: value };

      const hi = est.estimate_high ?? est.high;
      const lo = est.estimate_low  ?? est.low;
      if (typeof hi === "number" && hi > 1_000) result.estimateHigh = hi;
      if (typeof lo === "number" && lo > 1_000) result.estimateLow  = lo;

      const provider = est.provider_url ?? est.provider ?? est.source;
      if (typeof provider === "string") result.provider = provider;

      logger.debug(
        `[realtor-parser] Estimate for "${address}": ` +
        `$${value.toLocaleString()}` +
        (result.estimateLow  ? ` low=$${result.estimateLow.toLocaleString()}`   : "") +
        (result.estimateHigh ? ` high=$${result.estimateHigh.toLocaleString()}` : "") +
        (result.provider     ? ` via ${result.provider}` : "")
      );
      return result;
    }
  }

  // Deep-scan fallback — walk the JSON tree looking for an "estimate" key
  // with a numeric value > $10k. Capped at depth 8 to stay fast.
  const found = deepFindEstimate(nextData, 0);
  if (found) {
    logger.debug(
      `[realtor-parser] Estimate for "${address}" via deep scan: ` +
      `$${found.toLocaleString()}`
    );
    return { estimate: found };
  }

  logger.debug(
    `[realtor-parser] No estimate found in detail page __NEXT_DATA__ ` +
    `for "${address}"`
  );
  return null;
}

function deepFindEstimate(node: any, depth: number): number | null {
  if (depth > 8 || node === null || typeof node !== "object") return null;
  for (const key of ["estimate", "estimated_value", "avm_value"]) {
    if (
      key in node &&
      typeof node[key] === "number" &&
      node[key] > 10_000
    ) {
      return node[key];
    }
  }
  for (const k of Object.keys(node)) {
    const found = deepFindEstimate(node[k], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// ── Search-results parser ─────────────────────────────────────────────────────

export function parseRealtorResults(
  nextData:        any,
  applyDateFilter = true
): {
  listings:        RawListing[];
  allStale:        boolean;
  totalPages:      number;
  totalProperties: number;
} {
  const pageProps = nextData?.props?.pageProps ?? {};

  const totalProperties: number = pageProps.totalProperties ?? 0;
  const totalPages: number =
    pageProps.totalPages ??
    (totalProperties > 0
      ? Math.ceil(totalProperties / RESULTS_PER_PAGE)
      : 1);

  logger.debug(
    `[realtor-parser] pageProps keys: ${Object.keys(pageProps).join(", ")}`
  );
  logger.debug(
    `[realtor-parser] totalProperties=${totalProperties} totalPages=${totalPages}`
  );

  // ── Defensive: handle both array and object-with-array shapes ────────────
  let raw: any[] = [];
  if (Array.isArray(pageProps.properties)) {
    raw = pageProps.properties;
  } else if (
    pageProps.properties &&
    typeof pageProps.properties === "object"
  ) {
    const inner =
      (pageProps.properties as any).results ??
      (pageProps.properties as any).listings;
    if (Array.isArray(inner)) raw = inner;
  }

  if (raw.length === 0) {
    logger.debug(
      "[realtor-parser] No properties in props.pageProps.properties — " +
      `pageProps keys: ${Object.keys(pageProps).join(", ")}`
    );
    return { listings: [], allStale: true, totalPages, totalProperties };
  }

  if (raw[0]) {
    logger.debug(
      `[realtor-parser] First item keys: ${Object.keys(raw[0]).join(", ")}`
    );
    if (raw[0].description) {
      logger.debug(
        `[realtor-parser] description keys: ` +
        `${Object.keys(raw[0].description).join(", ")}`
      );
    }
  }

  const listings: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    if (!item?.property_id) continue;

    // ── Staleness ─────────────────────────────────────────────────────────
    const listDate = item.list_date ?? item.last_update_date;
    const daysOld  = daysSince(listDate);

    if (
      applyDateFilter &&
      typeof daysOld === "number" &&
      daysOld > MAX_DAYS_OLD
    ) {
      staleCount++;
      continue;
    }

    // ── Address ───────────────────────────────────────────────────────────
    const addr       = item.location?.address ?? {};
    const streetLine = addr.line        ?? "";
    const city       = addr.city        ?? "";
    const stateCode  = addr.state_code  ?? "";
    const postalCode = addr.postal_code ?? "";
    const fullAddress = [streetLine, city, stateCode, postalCode]
      .filter(Boolean)
      .join(", ");

    const lat: number | undefined = addr.coordinate?.lat ?? undefined;
    const lng: number | undefined = addr.coordinate?.lon ?? undefined;

    // ── Price ─────────────────────────────────────────────────────────────
    const price: number | undefined =
      typeof item.list_price === "number" && item.list_price > 0
        ? item.list_price
        : undefined;

    // ── Details ───────────────────────────────────────────────────────────
    const desc    = item.description ?? {};
    const beds: number | undefined      = desc.beds       ?? undefined;
    const sqft: number | undefined      = desc.sqft       ?? undefined;
    const yearBuilt: number | undefined = desc.year_built ?? undefined;
    const lotSqft: number | undefined   = desc.lot_sqft   ?? undefined;

    const baths: number | undefined =
      (desc.baths_consolidated ??
        ((desc.baths_full ?? 0) + (desc.baths_half ?? 0) * 0.5)) ||
      undefined;

    // ── URL / photo / agent ───────────────────────────────────────────────
    const url        = buildListingUrl(item.permalink, item.property_id);
    const imgSrc     = item.photos?.[0]?.href ?? undefined;
    const agent      = item.agents?.[0];
    const ownerName  = agent?.full_name ?? item.branding?.[0]?.name ?? undefined;
    const ownerPhone = agent?.phone ?? undefined;

    const listing: RawListing = {
      url,
      source:       "realtor",
      title:        streetLine || fullAddress,
      address:      fullAddress || undefined,
      price,
      beds,
      baths,
      sqft,
      propertyType: toPropertyType(desc.type),
      lat,
      lng,
      imgSrc,
      ownerName,
      ownerPhone,
      status:       item.status ?? "for_sale",
      daysOnMarket: daysOld,
      yearBuilt,
      lotSqft,
      priceReduced: !!(
        item.price_reduced_amount || item.list_price_last_change_amount
      ),
      listedAt:    listDate ? new Date(listDate) : undefined,
      description: desc.text ?? "",
      // estimate is populated later by the scraper after the detail fetch
      zestimate:   undefined,
    } as RawListing;

    listings.push(listing);

    logger.debug(
      `[realtor-parser] ✓ ${fullAddress} | ` +
      `$${price?.toLocaleString() ?? "?"} | ` +
      `${beds ?? "?"}bd ${baths ?? "?"}ba ${sqft ?? "?"}sqft | ` +
      `${daysOld ?? "?"}d old`
    );
  }

  const itemsWithDate = raw.filter(
    (i: any) => i?.list_date ?? i?.last_update_date
  ).length;
  const allStale = itemsWithDate > 0 && staleCount >= itemsWithDate;

  logger.info(
    `[realtor-parser] ${listings.length} valid listings ` +
    `(${staleCount} stale, totalPages=${totalPages})`
  );

  return { listings, allStale, totalPages, totalProperties };
}