// src/scrapers/propwire/propwire.parser.ts
//
// ── Data sources ──────────────────────────────────────────────────────────────
//
// Propwire is a React SPA. The search page HTML does NOT contain property data
// for unauthenticated users — results are loaded via authenticated XHR after
// React mounts. We therefore skip the HTML scraping approach and call
// Propwire's internal search API directly.
//
// STRATEGY: Call the internal API endpoint the React app uses:
//
//   POST https://api.propwire.com/api/v1/search
//   Headers:
//     Authorization: Bearer <JWT from PROPWIRE_SESSION_COOKIE env var>
//     Content-Type: application/json
//
//   Body: { filters: <filters object>, page: N, per_page: 25 }
//
//   Response shape:
//   {
//     data: {
//       properties: PropertyObject[],
//       total:      number,
//       per_page:   number,
//       current_page: number,
//       last_page:  number,
//     }
//   }
//
// ALTERNATIVE: The JWT token embedded in the page HTML data-page attribute
// is a short-lived CSRF/session token (expires ~2h). The longer-lived auth
// token is in the Authorization Bearer header the app sends via XHR.
//
// HOW TO GET THE API TOKEN:
//   1. Log into propwire.com in Chrome
//   2. Open DevTools → Network tab
//   3. Perform a search, filter by XHR/Fetch
//   4. Find a request to api.propwire.com
//   5. Copy the Authorization header value (starts with "Bearer eyJ...")
//   6. Set PROPWIRE_API_TOKEN=eyJ... in .env (without the "Bearer " prefix)
//
// ── Authentication ────────────────────────────────────────────────────────────
//
// Set PROPWIRE_API_TOKEN in .env with the Bearer token value.
// This token lasts longer than the laravel_session cookie (~24h typically).
//
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing, PropertyType } from "../../types/listing";
import { logger }                   from "../../utils/logger";

export const MAX_DAYS_OLD     = 30;
export const RESULTS_PER_PAGE = 25; // Propwire default page size

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parsePrice(raw: any): number | undefined {
  if (typeof raw === "number" && raw > 0) return Math.round(raw);
  if (typeof raw === "string") {
    const s = raw.replace(/[$,\s]/g, "").toUpperCase();
    if (s.endsWith("K")) return Math.round(parseFloat(s) * 1_000);
    if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return undefined;
}

function toPropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "single_family";
  const t = raw.toUpperCase();
  if (t === "SFR" || t.includes("SINGLE"))  return "single_family";
  if (t === "MFR" || t.includes("MULTI"))   return "multi_family";
  if (t === "DUPLEX")                        return "duplex";
  if (t === "CONDO")                         return "condo";
  if (t.includes("TOWN"))                    return "townhouse";
  return "single_family";
}

function daysSince(dateStr: string | undefined | null): number | undefined {
  if (!dateStr) return undefined;
  try {
    const ms = Date.now() - new Date(dateStr).getTime();
    const d  = Math.floor(ms / 86_400_000);
    return d >= 0 ? d : undefined;
  } catch {
    return undefined;
  }
}

export function buildListingUrl(propertyId: string, address: string, city: string, state: string): string {
  const citySlug = city.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const addrSlug = address.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const st       = state.toLowerCase();
  return `https://propwire.com/property/${st}/${citySlug}/${addrSlug}/${propertyId}`;
}

// ── API response parser ───────────────────────────────────────────────────────
//
// Parses the JSON response from Propwire's internal search API.
// Handles multiple possible response envelope shapes.

export interface PropwireSearchResult {
  listings:        RawListing[];
  allStale:        boolean;
  totalCount:      number;
  totalPages:      number;
}

export function parsePropwireApiResponse(
  json:            any,
  applyDateFilter = true
): PropwireSearchResult {
  // Unwrap various envelope shapes
  const payload =
    json?.data ??
    json?.payload ??
    json;

  const raw: any[] =
    payload?.properties ??
    payload?.results ??
    payload?.data ??
    json?.properties ??
    [];

  const totalCount: number =
    payload?.total ??
    payload?.totalCount ??
    payload?.count ??
    raw.length;

  const perPage: number =
    payload?.per_page ??
    payload?.perPage ??
    RESULTS_PER_PAGE;

  const totalPages: number =
    payload?.last_page ??
    payload?.totalPages ??
    (totalCount > 0 ? Math.ceil(totalCount / perPage) : 1);

  logger.debug(
    `[propwire-parser] properties=${raw.length} total=${totalCount} pages=${totalPages}`
  );

  if (raw.length === 0) {
    logger.debug(
      `[propwire-parser] No properties in response. ` +
      `Top-level keys: ${Object.keys(json ?? {}).join(", ")}`
    );
    return { listings: [], allStale: true, totalCount: 0, totalPages: 1 };
  }

  logger.debug(
    `[propwire-parser] First property keys: ${Object.keys(raw[0]).join(", ")}`
  );

  const listings: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    if (!item?.property_id && !item?.id) continue;

    const propertyId = String(item.property_id ?? item.id ?? "");

    // ── Address ───────────────────────────────────────────────────────────
    const streetLine = (item.address ?? item.street_address ?? "").trim();
    const city       = (item.city ?? "").trim();
    const state      = (item.state ?? "").trim();
    const zip        = (item.zip ?? item.postal_code ?? "").trim();
    const fullAddress = [streetLine, city, state, zip].filter(Boolean).join(", ");

    if (!fullAddress) continue;

    // ── Staleness filter ──────────────────────────────────────────────────
    const listDate   = item.list_date ?? item.listing_date ?? item.last_sale_date;
    const daysOld    = item.days_on_market ?? daysSince(listDate);

    if (applyDateFilter && typeof daysOld === "number" && daysOld > MAX_DAYS_OLD) {
      staleCount++;
      continue;
    }

    // ── Price ─────────────────────────────────────────────────────────────
    const price = parsePrice(item.list_price ?? item.listing_price);

    // ── Propwire AVM ──────────────────────────────────────────────────────
    const estimatedValue = parsePrice(
      item.estimated_value ?? item.estimatedValue ?? item.avm_value
    );
    const estimatedEquity = parsePrice(
      item.estimated_equity ?? item.estimatedEquity
    );

    // ── Details ───────────────────────────────────────────────────────────
    const beds     = typeof item.bedrooms  === "number" ? item.bedrooms  : undefined;
    const baths    = typeof item.bathrooms === "number" ? item.bathrooms : undefined;
    const sqft     = typeof item.sqft      === "number" ? item.sqft      : undefined;
    const yearBuilt = typeof item.year_built === "number" ? item.year_built : undefined;

    const lat: number | undefined = typeof item.latitude  === "number" ? item.latitude  : undefined;
    const lng: number | undefined = typeof item.longitude === "number" ? item.longitude : undefined;

    // ── Lead type / status ────────────────────────────────────────────────
    const leadTypes: string[] = Array.isArray(item.lead_type)
      ? item.lead_type
      : item.lead_type ? [item.lead_type] : [];

    const status = item.mls_status ?? item.status ?? (leadTypes[0] ?? "off_market");

    // ── Owner ─────────────────────────────────────────────────────────────
    const ownerName  = item.owner_name ?? item.ownerName ?? undefined;
    const ownerPhone = item.owner_phone ?? undefined;

    // ── URL ───────────────────────────────────────────────────────────────
    const url = propertyId
      ? buildListingUrl(propertyId, streetLine, city, state)
      : "";

    if (!url) continue;

    const listing: RawListing = {
      url,
      source:       "propwire",
      title:        streetLine || fullAddress,
      address:      fullAddress,
      price,
      propwireEstimate: estimatedValue,
      beds,
      baths,
      sqft,
      propertyType: toPropertyType(item.property_type ?? item.propertyType),
      lat,
      lng,
      ownerName,
      ownerPhone,
      status,
      daysOnMarket: typeof daysOld === "number" ? daysOld : undefined,
      yearBuilt,
      listedAt:     listDate ? new Date(listDate) : undefined,
      description:  leadTypes.join(", "),
    } as RawListing;

    (listing as any)._estimatedEquity  = estimatedEquity;
    (listing as any)._leadTypes        = leadTypes;
    (listing as any)._propwireId       = propertyId;
    (listing as any)._taxAssessment    = parsePrice(item.tax_assessment);
    (listing as any)._lastSalePrice    = parsePrice(item.last_sale_price);
    (listing as any)._openMortgage     = parsePrice(item.open_mortgage_balance);

    listings.push(listing);

    logger.debug(
      `[propwire-parser] ✓ ${fullAddress} | ` +
      `list=$${price?.toLocaleString() ?? "?"} | ` +
      `AVM=$${estimatedValue?.toLocaleString() ?? "?"} | ` +
      `${beds ?? "?"}bd ${baths ?? "?"}ba | ` +
      `leads=[${leadTypes.join(",")}]`
    );
  }

  const itemsWithDate = raw.filter(
    (i: any) => i?.list_date ?? i?.listing_date ?? i?.days_on_market != null
  ).length;
  const allStale = itemsWithDate > 0 && staleCount >= itemsWithDate;

  logger.info(
    `[propwire-parser] ${listings.length} valid | ${staleCount} stale | ` +
    `total=${totalCount} pages=${totalPages}`
  );

  return { listings, allStale, totalCount, totalPages };
}

// ── __NEXT_DATA__ extractor (kept for fallback/detail pages) ──────────────────

export function extractNextData(html: string): any | null {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (match?.[1]) {
    try { return JSON.parse(match[1]); } catch {}
  }

  const pwMatch = html.match(/window\.__propwireData__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i);
  if (pwMatch?.[1]) {
    try { return { _propwireData: JSON.parse(pwMatch[1]) }; } catch {}
  }

  return null;
}

// ── Propwire Estimate extraction from detail page (unchanged) ─────────────────

export interface PropwireEstimate {
  estimatedValue:  number;
  estimatedEquity?: number;
  taxAssessment?:  number;
  lastSalePrice?:  number;
}

export function extractEstimateFromDetailPage(
  nextData: any,
  address:  string
): PropwireEstimate | null {
  const prop =
    nextData?.props?.pageProps?.property ??
    nextData?.props?.pageProps?.initialState?.property ??
    nextData?._propwireData?.property ??
    null;

  if (prop) {
    const ev = parsePrice(prop.estimated_value ?? prop.estimatedValue ?? prop.avm_value);
    if (ev && ev > 10_000) {
      const result: PropwireEstimate = { estimatedValue: ev };

      const eq = parsePrice(prop.estimated_equity ?? prop.estimatedEquity);
      if (eq) result.estimatedEquity = eq;

      const ta = parsePrice(prop.tax_assessment ?? prop.taxAssessment);
      if (ta) result.taxAssessment = ta;

      const lsp = parsePrice(prop.last_sale_price ?? prop.lastSalePrice);
      if (lsp) result.lastSalePrice = lsp;

      logger.debug(
        `[propwire-parser] Estimate for "${address}": ` +
        `$${ev.toLocaleString()}` +
        (result.estimatedEquity ? ` equity=$${result.estimatedEquity.toLocaleString()}` : "")
      );
      return result;
    }
  }

  const found = deepFind(nextData, ["estimated_value", "estimatedValue", "avm_value"], 0);
  if (found && found > 10_000) {
    logger.debug(
      `[propwire-parser] Estimate via deep scan for "${address}": $${found.toLocaleString()}`
    );
    return { estimatedValue: found };
  }

  logger.debug(`[propwire-parser] No estimate found in detail __NEXT_DATA__ for "${address}"`);
  return null;
}

function deepFind(node: any, keys: string[], depth: number): number | null {
  if (depth > 10 || node === null || typeof node !== "object") return null;
  for (const key of keys) {
    if (key in node) {
      const v = parsePrice(node[key]);
      if (v && v > 10_000) return v;
    }
  }
  for (const k of Object.keys(node)) {
    const found = deepFind(node[k], keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// ── Legacy HTML search page parser (kept for reference, no longer primary) ────

export interface PropwireSearchResultLegacy {
  listings:        RawListing[];
  allStale:        boolean;
  totalCount:      number;
  totalPages:      number;
}

export function parsePropwireSearchPage(
  nextData:        any,
  applyDateFilter = true
): PropwireSearchResultLegacy {
  const pageProps = nextData?.props?.pageProps ?? {};
  const searchState = pageProps?.initialState?.searchResults ?? pageProps;
  const raw: any[] =
    searchState?.properties ??
    pageProps?.properties ??
    nextData?._propwireData?.properties ??
    [];

  const totalCount: number =
    searchState?.total ??
    searchState?.totalCount ??
    pageProps?.total ??
    raw.length;

  const totalPages: number =
    searchState?.totalPages ??
    (totalCount > 0 ? Math.ceil(totalCount / RESULTS_PER_PAGE) : 1);

  logger.debug(
    `[propwire-parser] (legacy HTML) properties=${raw.length} total=${totalCount}`
  );

  if (raw.length === 0) {
    logger.debug(
      `[propwire-parser] No properties in __NEXT_DATA__. ` +
      `pageProps keys: ${Object.keys(pageProps).join(", ")}`
    );
    return { listings: [], allStale: true, totalCount: 0, totalPages: 1 };
  }

  // Reuse API parser logic since property shape is the same
  return parsePropwireApiResponse({ data: { properties: raw, total: totalCount, last_page: totalPages } }, applyDateFilter);
}