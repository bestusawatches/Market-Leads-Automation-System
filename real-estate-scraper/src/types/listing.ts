// src/types/listing.ts
// ─────────────────────────────────────────────────────────────────────────────
// Canonical shape every scraper must return.
// The runner feeds this directly into the DB repository.
// ─────────────────────────────────────────────────────────────────────────────

export type PropertyType =
  | "single_family"
  | "multi_family"
  | "duplex"
  | "condo"
  | "townhouse"
  | "unknown";

export type DealScore = "good_deal" | "average_deal" | "low_potential";

/** Raw output from any scraper — all fields optional except url + source */
export interface RawListing {
  url: string;
  source: string; // e.g. "craigslist_milwaukee"

  title?: string;
  price?: number;
  address?: string;
  location?: string;
  propertyType?: PropertyType;
  postedDate?: Date;
  description?: string;

  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;

  // Owner contact (when present in the post)
  ownerName?: string;
  ownerPhone?: string;

  // Enrichment fields (zillow/realtor/redfin/propwire)
  zestimate?: number;
  zpid?: string;
  realtorEstimate?: number;
  redfinEstimate?: number;
  propwireEstimate?: number;
}

/** Underwriting result computed by the scoring engine */
export interface UnderwritingResult {
  dealScore: DealScore;
  equityEstimate?: number; // ARV - price
}

/** What the DB repository accepts — RawListing + underwriting */
export type ListingUpsertPayload = RawListing & Partial<UnderwritingResult>;
