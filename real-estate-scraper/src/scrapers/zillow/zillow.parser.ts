// src/scrapers/zillow/zillow.parser.ts

import { RawListing } from "../../types/listing";

// Only keep listings listed within this many days
export const MAX_DAYS_OLD = 30;

export function parseZillowResults(
  json: any,
  applyDateFilter = true
): {
  listings: RawListing[];
  /** true when every listing on this page is older than MAX_DAYS_OLD — caller should stop paginating */
  allStale: boolean;
} {
  const raw = [
    ...(json?.cat1?.searchResults?.listResults ?? []),
    ...(json?.cat1?.searchResults?.mapResults  ?? []),
  ];

  if (raw.length === 0) return { listings: [], allStale: true };

  const results: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    if (!item?.zpid) continue;

    // ── Days on market ────────────────────────────────────────────────────
    const daysOnZillow: number | undefined =
      item.daysOnZillow                    ??
      item.hdpData?.homeInfo?.daysOnZillow ??
      undefined;

    // ── Listed date ───────────────────────────────────────────────────────
    // listingDateTime is a Unix millisecond timestamp when present.
    // Fall back to computing from daysOnZillow if the timestamp is absent.
    let listedAt: Date | undefined;
    if (item.listingDateTime) {
      listedAt = new Date(Number(item.listingDateTime));
    } else if (typeof daysOnZillow === "number") {
      const d = new Date();
      d.setDate(d.getDate() - daysOnZillow);
      listedAt = d;
    }

    // ── Staleness filter ──────────────────────────────────────────────────
    if (applyDateFilter && typeof daysOnZillow === "number" && daysOnZillow > MAX_DAYS_OLD) {
      staleCount++;
      continue;
    }

    // ── Address ───────────────────────────────────────────────────────────
    const address = [
      item.address,
      item.hdpData?.homeInfo?.city,
      item.hdpData?.homeInfo?.state,
      item.hdpData?.homeInfo?.zipcode,
    ]
      .filter(Boolean)
      .join(", ");

    results.push({
      url:          `https://www.zillow.com/homedetails/${item.zpid}_zpid/`,
      source:       "zillow",
      title:        item.address || "Zillow Listing",
      address,
      price:        item.price ?? item.hdpData?.homeInfo?.price,
      bedrooms:     item.beds,
      bathrooms:    item.baths,
      squareFeet:   item.area,
      propertyType: item.homeType || "unknown",
      description:  "",
      listedAt,
      daysOnZillow,
    });
  }

  // allStale: if every item whose age we know exceeds the cutoff, stop paginating.
  // If no items had daysOnZillow we can't tell → return false (keep going).
  const itemsWithAge = raw.filter(
    (i: any) =>
      i?.daysOnZillow != null ||
      i?.hdpData?.homeInfo?.daysOnZillow != null
  ).length;

  const allStale = itemsWithAge > 0 && staleCount >= itemsWithAge;

  return { listings: results, allStale };
}