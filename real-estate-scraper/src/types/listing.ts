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

  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  description?: string;
  postedDate?: Date;

  // Zillow-specific extras (carried through so they land in the DB)
  zestimate?: number;
  zpid?: string;
}

/** Underwriting result computed by the scoring engine */
export interface UnderwritingResult {
  dealScore: DealScore;
  equityEstimate?: number; // ARV - price
}

/** What the DB repository accepts — RawListing + underwriting */
export type ListingUpsertPayload = RawListing & Partial<UnderwritingResult>;
