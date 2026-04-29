// src/scrapers/redfin/redfin.parser.ts
//
// Parses responses from Redfin's internal GIS JSON API:
//   GET https://www.redfin.com/stingray/api/gis?...
//
// This endpoint is what the Redfin browser app calls via XHR for search
// results.  It is NOT protected by AWS WAF (no CAPTCHA) and does not require
// JavaScript rendering — a plain HTTP GET returns clean JSON.
//
// Response shape:
//   "{}&&" + JSON       ← strip the XSSI guard prefix before parsing
//   {
//     errorMessage: "Success",
//     payload: {
//       homes:      RedfinHome[],
//       totalCount: number,
//     }
//   }
//
// Each home field may use a { value, displayLevel } envelope — unwrapped
// by val<T>() below.
//
// Verified GIS field names (from live API response, April 2026):
//   home.dom           → { value: N, level: 1 }   days on market
//   home.timeOnRedfin  → { value: N, level: 1 }   ms on site (fallback)
//   home.beds          → raw number (NOT enveloped)
//   home.baths         → raw number (NOT enveloped)
//   home.sqFt          → { value: N, level: 1 }
//   home.price         → { value: N, level: 1 }
//   home.streetLine    → { value: "123 Main St", level: 1 }
//   home.city          → raw string
//   home.state         → raw string
//   home.zip           → raw string
//   home.propertyType  → raw number  (type code)
//   home.uiPropertyType→ raw number  (display type code — preferred)
//   home.propertyId    → raw number  ← used for AVM API calls in Phase 2
//
// Property type codes (uiPropertyType):
//   1 = House  |  2 = Condo  |  3 = Townhouse  |  4 = Multi-family
//   5 = Land   |  6 = Other  |  7 = Mobile/Manufactured
//
// AVM enrichment strategy (Phase 2 — replaces blocked HTML detail pages):
//
//   The HTML detail pages return HTTP 405 through Oxylabs because Redfin's
//   WAF blocks browser-rendered requests.  Instead we call two JSON-only
//   stingray endpoints that have no WAF protection, just like the GIS API:
//
//   Endpoint A — avmHistoricalData (preferred):
//     GET /stingray/api/home/details/avmHistoricalData
//         ?propertyId=<id>&accessLevel=1
//     Response shape (after XSSI strip):
//       payload.predictedValue          ← current Redfin Estimate (flat)
//       payload.avmValue                ← alias on some responses
//       payload.currentValue            ← alias on some responses
//       payload.avmHistory[]            ← history array; last entry = current
//         .predictedValue | .value
//
//   Endpoint B — belowTheFold (fallback):
//     GET /stingray/api/home/details/belowTheFold
//         ?propertyId=<id>&accessLevel=1&pageType=1
//     Response shape (after XSSI strip):
//       payload.mediaBrowserInfo.
//         virtualTourInfo.avmInfo.predictedValue
//       payload.publicRecordsInfo.
//         basicInfo.propertyLastSoldPrice      ← last-sold fallback
//       payload.listingInfo.redfinEstimate.value ← modern key (some pages)
//
//   Both are plain HTTP GETs through Oxylabs source:"universal" render:false,
//   identical to how the GIS search calls work.
//
// Debug artefacts saved to logs/ for every propertyId fetched:
//   redfin_avm_<propertyId>.json        — raw avmHistoricalData response
//   redfin_btf_<propertyId>.json        — raw belowTheFold response (if used)
//
// Redfin Estimate HTML extraction strategy (fallback if API unavailable):
//   Priority 1 — Pre-hydrated JSON in <script> blocks:
//     "redfinEstimate":{"value":N}  or  "avm":{"value":N}
//   Priority 2 — DOM selectors (only reliable after full JS render):
//     [data-rf-test-id="avm-estimate"], .RedfinEstimate, .statsValue
//   Priority 3 — Loose regex patterns in any <script> block:
//     /"avmValue":\s*([0-9]+)/i
//     /Redfin Estimate[^$]*\$([\d,]+)/i

import * as cheerio from "cheerio";
import { RawListing } from "../../types/listing";
import { logger }     from "../../utils/logger";

export const MAX_DAYS_OLD = 30;

// ── Property type map ─────────────────────────────────────────────────────────

const PROPERTY_TYPE: Record<number, string> = {
  1: "single_family",
  2: "condo",
  3: "townhouse",
  4: "multi_family",
  5: "land",
  6: "unknown",
  7: "mobile",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parsePrice(raw: string | number | null | undefined): number | undefined {
  if (typeof raw === "number" && raw > 0) return raw;
  if (typeof raw === "string") {
    const s = raw.replace(/[$,\s]/g, "").toUpperCase();
    if (s.endsWith("K")) return Math.round(parseFloat(s) * 1_000);
    if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return undefined;
}

// Unwrap Redfin's { value, displayLevel } field envelope.
// If the field is already a primitive, return it as-is.
// If the field is an object without a 'value' property (e.g., { level: 1 }), return undefined.
function val<T>(field: any): T | undefined {
  if (field == null) return undefined;
  if (typeof field === "object") {
    if ("value" in field) return field.value as T;
    return undefined; // Object like { level: 1 } without value — treat as missing
  }
  return field as T;
}

// Strip the XSSI guard Redfin prepends to all API responses
export function stripXSSI(raw: string): string {
  return raw.startsWith("{}&&") ? raw.slice(4) : raw;
}

// ── GIS API response parser ───────────────────────────────────────────────────

export interface RedfinApiResult {
  listings:   RawListing[];
  totalCount: number;
  allStale:   boolean;
}

export function parseRedfinApiResponse(
  raw:            string,
  marketName:     string,
  applyDateFilter = true
): RedfinApiResult {
  let json: any;
  try {
    json = JSON.parse(stripXSSI(raw));
  } catch (err) {
    logger.warn(`[redfin-parser] Failed to parse JSON for "${marketName}": ${err}`);
    logger.debug(`[redfin-parser] Raw snippet: ${raw.slice(0, 200)}`);
    return { listings: [], totalCount: 0, allStale: true };
  }

  if (json?.errorMessage && json.errorMessage !== "Success") {
    logger.warn(`[redfin-parser] API error for "${marketName}": ${json.errorMessage}`);
  }

  const payload      = json?.payload ?? json;
  const homes: any[] = payload?.homes ?? [];
  const totalCount: number = payload?.totalCount ?? homes.length;

  logger.debug(`[redfin-parser] "${marketName}": ${homes.length} homes, totalCount=${totalCount}`);

  if (homes.length === 0) {
    logger.debug(`[redfin-parser] No homes in payload for "${marketName}"`);
    return { listings: [], totalCount: 0, allStale: true };
  }

  logger.debug(`[redfin-parser] First home keys: ${Object.keys(homes[0]).join(", ")}`);

  const results: RawListing[] = [];
  let staleCount = 0;

  for (const home of homes) {
    // ── URL ───────────────────────────────────────────────────────────────
    const urlPath = home.url as string | undefined;
    if (!urlPath) continue;
    const url = urlPath.startsWith("http")
      ? urlPath
      : `https://www.redfin.com${urlPath}`;

    // ── Address ───────────────────────────────────────────────────────────
    // GIS response uses streetLine (enveloped) + city/state/zip (raw strings)
    // rather than a combined "address" field.
    const street = val<string>(home.streetLine);
    const city   = home.city   as string | undefined;
    const state  = home.state  as string | undefined;
    const zip    = val<string>(home.postalCode) ?? (home.zip as string | undefined);

    const address = street
      ? [street, city, state, zip].filter(Boolean).join(", ")
      : url;

    // ── Price ─────────────────────────────────────────────────────────────
    const price = parsePrice(val<number>(home.price));

    // ── Beds / baths / sqft ───────────────────────────────────────────────
    // beds and baths come as raw numbers in the GIS response (not enveloped).
    // sqFt IS enveloped: { value: N, level: 1 }.
    const bedrooms   = home.beds  as number | undefined;
    const bathrooms  = home.baths as number | undefined;
    const squareFeet = val<number>(home.sqFt);

    // ── Days on market ────────────────────────────────────────────────────
    // GIS field is "dom" (enveloped), NOT "daysOnMarket".
    // Fallback: "timeOnRedfin" (enveloped ms) → convert to days.
    let daysOnMarket: number | undefined = val<number>(home.dom);

    if (daysOnMarket == null) {
      const tor = val<number>(home.timeOnRedfin);
      if (typeof tor === "number") {
        daysOnMarket = Math.round(tor / 86_400_000);
      }
    }

    // ── Staleness filter ──────────────────────────────────────────────────
    if (applyDateFilter && typeof daysOnMarket === "number" && daysOnMarket > MAX_DAYS_OLD) {
      logger.debug(`[redfin-parser] Stale (${daysOnMarket}d): ${address}`);
      staleCount++;
      continue;
    }

    // ── Listed date ───────────────────────────────────────────────────────
    let listedAt: Date | undefined;
    if (typeof daysOnMarket === "number") {
      const d = new Date();
      d.setDate(d.getDate() - daysOnMarket);
      listedAt = d;
    }

    // ── Property type ─────────────────────────────────────────────────────
    // Prefer uiPropertyType (display code) over propertyType (internal code).
    // Both are raw numbers — not enveloped.
    const propCode     = (home.uiPropertyType ?? home.propertyType) as number | undefined;
    const propertyType = (propCode != null ? PROPERTY_TYPE[propCode] : undefined) ?? "unknown";

    // ── Redfin AVM (sometimes included in GIS payload) ───────────────────
    const redfinAvm = parsePrice(val<number>(home.redfinAVM));

    // ── propertyId (needed for Phase 2 AVM API calls) ─────────────────────
    // Stored as _redfinPropertyId on the listing object (underscore = internal).
    // The GIS response provides this as a raw number.
    const propertyId = home.propertyId as number | undefined;

    logger.debug(
      `[redfin-parser] ${address} | $${price?.toLocaleString()} | ` +
      `${bedrooms}bd ${bathrooms}ba ${squareFeet}sqft | ` +
      `${daysOnMarket ?? "?"}d | ${propertyType}` +
      (redfinAvm ? ` | AVM $${redfinAvm.toLocaleString()}` : "") +
      (propertyId ? ` | pid=${propertyId}` : "")
    );

    const listing: RawListing & { _redfinPropertyId?: number } = {
      url,
      source:       "redfin",
      title:        address,
      address,
      price,
      zestimate:    redfinAvm,
      bedrooms,
      bathrooms,
      squareFeet,
      propertyType: propertyType as any,
      description:  "",
      listedAt,
      daysOnMarket: daysOnMarket,
    };

    if (propertyId != null) {
      listing._redfinPropertyId = propertyId;
    }

    results.push(listing);
  }

  // allStale: true only if we had homes with age data and ALL were stale.
  // Uses "dom" (enveloped) and "timeOnRedfin" (enveloped) — both need val().
  const itemsWithAge = homes.filter(
    (h: any) => val<number>(h.dom) != null || val<number>(h.timeOnRedfin) != null
  ).length;
  const allStale = itemsWithAge > 0 && staleCount >= itemsWithAge;

  return { listings: results, totalCount, allStale };
}

// ── AVM API URL builders ──────────────────────────────────────────────────────
//
// These endpoints are the same "stingray" API family as the GIS endpoint.
// Neither requires JavaScript rendering — plain HTTP GET returns JSON.
// Both accept the XSSI guard prefix (stripped by stripXSSI before parsing).

/**
 * Builds the avmHistoricalData URL for a given Redfin propertyId.
 *
 * Known response fields (verified April 2026):
 *   payload.predictedValue          — current estimate (preferred)
 *   payload.avmValue                — alias used on some property types
 *   payload.currentValue            — alias used on some property types
 *   payload.avmHistory[]            — historical data points (last = current)
 *     .predictedValue | .value      — value at that point in time
 *   payload.displayLevel            — access level (1 = public)
 */
export function buildAvmUrl(propertyId: number): string {
  return (
    `https://www.redfin.com/stingray/api/home/details/avmHistoricalData` +
    `?propertyId=${propertyId}&accessLevel=1`
  );
}

/**
 * Builds the belowTheFold URL for a given Redfin propertyId.
 * Used as fallback when avmHistoricalData returns no estimate.
 *
 * Known response fields (verified April 2026):
 *   payload.listingInfo.redfinEstimate.value   — modern AVM key
 *   payload.mediaBrowserInfo
 *     .virtualTourInfo.avmInfo.predictedValue  — alternate AVM location
 *   payload.publicRecordsInfo
 *     .basicInfo.propertyLastSoldPrice         — last-sold price (last resort)
 */
export function buildBelowTheFoldUrl(propertyId: number): string {
  return (
    `https://www.redfin.com/stingray/api/home/details/belowTheFold` +
    `?propertyId=${propertyId}&accessLevel=1&pageType=1`
  );
}

// ── AVM API response parsers ──────────────────────────────────────────────────

export interface AvmApiResult {
  redfinEstimate: number | undefined;
  /** Raw parsed JSON payload — saved to disk for debugging */
  rawPayload:     any;
}

/**
 * Parses the avmHistoricalData endpoint response.
 *
 * Tries these fields in priority order:
 *   1. payload.predictedValue
 *   2. payload.avmValue
 *   3. payload.currentValue
 *   4. payload.avmHistory[last].predictedValue
 *   5. payload.avmHistory[last].value
 */
export function parseAvmHistoricalData(raw: string, address: string): AvmApiResult {
  let json: any;
  try {
    json = JSON.parse(stripXSSI(raw));
  } catch (err) {
    logger.warn(`[redfin-parser] avmHistoricalData parse error for "${address}": ${err}`);
    logger.debug(`[redfin-parser] Raw snippet: ${raw.slice(0, 300)}`);
    return { redfinEstimate: undefined, rawPayload: null };
  }

  if (json?.errorMessage && json.errorMessage !== "Success") {
    logger.debug(
      `[redfin-parser] avmHistoricalData API message for "${address}": ${json.errorMessage}`
    );
  }

  const payload = json?.payload ?? json;

  // Priority 1–3: flat fields
  for (const key of ["predictedValue", "avmValue", "currentValue"]) {
    const candidate = parsePrice(payload?.[key]);
    if (candidate && candidate > 10_000) {
      logger.debug(
        `[redfin-parser] AVM via avmHistoricalData[${key}] = ` +
        `$${candidate.toLocaleString()} for "${address}"`
      );
      return { redfinEstimate: candidate, rawPayload: payload };
    }
  }

  // Priority 4–5: history array — last entry is the most recent estimate
  const history: any[] = payload?.avmHistory ?? [];
  if (history.length > 0) {
    const latest = history[history.length - 1];
    for (const key of ["predictedValue", "value"]) {
      const candidate = parsePrice(latest?.[key]);
      if (candidate && candidate > 10_000) {
        logger.debug(
          `[redfin-parser] AVM via avmHistoricalData.history[last][${key}] = ` +
          `$${candidate.toLocaleString()} for "${address}"`
        );
        return { redfinEstimate: candidate, rawPayload: payload };
      }
    }
  }

  logger.debug(`[redfin-parser] avmHistoricalData: no estimate found for "${address}"`);
  return { redfinEstimate: undefined, rawPayload: payload };
}

/**
 * Parses the belowTheFold endpoint response.
 *
 * Tries these fields in priority order:
 *   1. payload.listingInfo.redfinEstimate.value
 *   2. payload.mediaBrowserInfo.virtualTourInfo.avmInfo.predictedValue
 *   3. payload.publicRecordsInfo.basicInfo.propertyLastSoldPrice  (last resort)
 */
export function parseBelowTheFold(raw: string, address: string): AvmApiResult {
  let json: any;
  try {
    json = JSON.parse(stripXSSI(raw));
  } catch (err) {
    logger.warn(`[redfin-parser] belowTheFold parse error for "${address}": ${err}`);
    logger.debug(`[redfin-parser] Raw snippet: ${raw.slice(0, 300)}`);
    return { redfinEstimate: undefined, rawPayload: null };
  }

  if (json?.errorMessage && json.errorMessage !== "Success") {
    logger.debug(
      `[redfin-parser] belowTheFold API message for "${address}": ${json.errorMessage}`
    );
  }

  const payload = json?.payload ?? json;

  // Priority 1: listingInfo.redfinEstimate.value
  const listingEstimate = parsePrice(
    payload?.listingInfo?.redfinEstimate?.value
  );
  if (listingEstimate && listingEstimate > 10_000) {
    logger.debug(
      `[redfin-parser] AVM via belowTheFold[listingInfo.redfinEstimate.value] = ` +
      `$${listingEstimate.toLocaleString()} for "${address}"`
    );
    return { redfinEstimate: listingEstimate, rawPayload: payload };
  }

  // Priority 2: mediaBrowserInfo.virtualTourInfo.avmInfo.predictedValue
  const avmInfoEstimate = parsePrice(
    payload?.mediaBrowserInfo?.virtualTourInfo?.avmInfo?.predictedValue
  );
  if (avmInfoEstimate && avmInfoEstimate > 10_000) {
    logger.debug(
      `[redfin-parser] AVM via belowTheFold[mediaBrowserInfo.avmInfo.predictedValue] = ` +
      `$${avmInfoEstimate.toLocaleString()} for "${address}"`
    );
    return { redfinEstimate: avmInfoEstimate, rawPayload: payload };
  }

  // Priority 3: publicRecordsInfo.basicInfo.propertyLastSoldPrice (last resort)
  const lastSold = parsePrice(
    payload?.publicRecordsInfo?.basicInfo?.propertyLastSoldPrice
  );
  if (lastSold && lastSold > 10_000) {
    logger.debug(
      `[redfin-parser] AVM via belowTheFold[publicRecordsInfo.propertyLastSoldPrice] = ` +
      `$${lastSold.toLocaleString()} for "${address}" (last-sold fallback)`
    );
    return { redfinEstimate: lastSold, rawPayload: payload };
  }

  logger.debug(`[redfin-parser] belowTheFold: no estimate found for "${address}"`);
  return { redfinEstimate: undefined, rawPayload: payload };
}

// ── Detail-page parser (HTML fallback — kept for emergency use) ───────────────
//
// Only called if both AVM JSON API endpoints fail AND an HTML page was
// somehow retrieved.  The HTML detail pages return 405 through Oxylabs in
// production; this path is retained for local testing or alternative proxies.

export interface RedfinDetailData {
  redfinEstimate: number | undefined;
  monthlyPayment: number | undefined;
}

export function parseRedfinDetailPage(html: string, address: string): RedfinDetailData {
  const $ = cheerio.load(html);

  let redfinEstimate: number | undefined;
  let monthlyPayment: number | undefined;

  // ── Tier 1: pre-hydrated JSON in <script> blocks ──────────────────────

  const scriptPatterns: Array<{ pattern: RegExp; label: string }> = [
    {
      pattern: /"redfinEstimate"\s*:\s*\{[^}]{0,120}"value"\s*:\s*([0-9]+)/i,
      label:   "redfinEstimate.value",
    },
    {
      pattern: /"avm"\s*:\s*\{[^}]{0,120}"value"\s*:\s*([0-9]{5,})/i,
      label:   "avm.value",
    },
    {
      pattern: /"estimate"\s*:\s*\{[^}]{0,120}"value"\s*:\s*([0-9]{5,})/i,
      label:   "estimate.value",
    },
    {
      pattern: /"avmValue"\s*:\s*([0-9]+)/i,
      label:   "avmValue (flat)",
    },
  ];

  $("script").each((_, el) => {
    if (redfinEstimate) return;
    const scriptText = $(el).html() ?? "";
    if (
      !scriptText.includes("$") &&
      !scriptText.includes("avm") &&
      !scriptText.includes("estimate")
    ) {
      return;
    }
    for (const { pattern, label } of scriptPatterns) {
      if (redfinEstimate) break;
      const m = scriptText.match(pattern);
      if (m) {
        const candidate = parseInt(m[1], 10);
        if (!isNaN(candidate) && candidate > 10_000) {
          logger.debug(
            `[redfin-parser] AVM via script[${label}] = $${candidate.toLocaleString()} for "${address}"`
          );
          redfinEstimate = candidate;
        }
      }
    }
  });

  // ── Tier 2: DOM selectors ─────────────────────────────────────────────

  if (!redfinEstimate) {
    const domSelectors = [
      '[data-rf-test-id="avm-estimate"]',
      '[data-rf-test-id="redfin-estimate"]',
      ".RedfinEstimate",
      ".statsValue",
      "[class*='avmValue']",
      "[class*='estimate']",
    ];

    for (const sel of domSelectors) {
      if (redfinEstimate) break;
      const text = $(sel).first().text().trim();
      if (text && text.includes("$")) {
        const p = parsePrice(text);
        if (p && p > 10_000) {
          logger.debug(
            `[redfin-parser] AVM via DOM selector "${sel}" = $${p.toLocaleString()} for "${address}"`
          );
          redfinEstimate = p;
        }
      }
    }
  }

  // ── Tier 3: loose text patterns (last resort) ─────────────────────────

  if (!redfinEstimate) {
    $("script").each((_, el) => {
      if (redfinEstimate) return;
      const t = $(el).html() ?? "";
      const m = t.match(/Redfin Estimate[^$]*\$([\d,]+)/i);
      if (m) {
        const p = parsePrice(m[1]);
        if (p && p > 10_000) {
          logger.debug(
            `[redfin-parser] AVM via loose text pattern = $${p.toLocaleString()} for "${address}"`
          );
          redfinEstimate = p;
        }
      }
    });
  }

  // ── Monthly payment ───────────────────────────────────────────────────

  const monthlyRaw = $(
    '[data-rf-test-id="abp-monthly-payment-entry-point-estimate"]'
  ).first().text().trim();
  if (monthlyRaw) {
    monthlyPayment = parsePrice(monthlyRaw);
  }

  if (!monthlyPayment) {
    $("script").each((_, el) => {
      if (monthlyPayment) return;
      const t = $(el).html() ?? "";
      const m =
        t.match(/"monthlyPayment"\s*:\s*([0-9]+)/i) ??
        t.match(/"estimatedMonthlyPayment"\s*:\s*([0-9]+)/i);
      if (m) {
        const p = parseInt(m[1], 10);
        if (!isNaN(p) && p > 100) monthlyPayment = p;
      }
    });
  }

  if (!redfinEstimate) {
    logger.debug(`[redfin-parser] No AVM estimate found for "${address}"`);
  }

  return { redfinEstimate, monthlyPayment };
}