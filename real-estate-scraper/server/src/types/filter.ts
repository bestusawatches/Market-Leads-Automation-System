/**
 * Filter Types
 * Defines the structure of filter objects used throughout the scraper system
 */

/**
 * Core filtering criteria for property searches
 * Used by all scrapers to narrow down listings
 */
export interface PropertyFilter {
  // ── Price range ──────────────────────────────────────────────────────────
  minPrice?: number;
  maxPrice?: number;

  // ── Property types ───────────────────────────────────────────────────────
  propertyTypes?: string[]; // ["single_family", "multi_family", "duplex"]

  // ── Location ──────────────────────────────────────────────────────────────
  locations?: string[]; // ["Cleveland, OH", "Milwaukee, WI"]
  state?: string; // "OH" | "WI"
  city?: string;

  // ── Keyword matching ──────────────────────────────────────────────────────
  keywords?: string[]; // terms to include
  excludeKeywords?: string[]; // terms to exclude

  // ── Property details ──────────────────────────────────────────────────────
  minBedrooms?: number;
  maxBedrooms?: number;
  minBathrooms?: number;
  maxBathrooms?: number;
  minSquareFeet?: number;
  maxSquareFeet?: number;

  // ── Date range (for 30-day filtering) ──────────────────────────────────
  postedAfter?: Date;
  postedBefore?: Date;

  // ── Enrichment criteria ───────────────────────────────────────────────────
  minEquity?: number; // ARV - price
  minArv?: number; // minimum home value
}

/**
 * Dynamic filter builder for applying filters to listings
 * Returned by parsers/enrichers to indicate which filters passed
 */
export interface FilterResult {
  passed: boolean;
  reason?: string; // explanation if failed
  matchedKeywords?: string[];
}

/**
 * Scraper-specific filter options
 * Extends PropertyFilter with scraper runtime behavior
 */
export interface ScraperFilterOptions extends PropertyFilter {
  // ── Pagination limits ─────────────────────────────────────────────────────
  maxPages?: number;
  maxListings?: number;

  // ── Behavior flags ────────────────────────────────────────────────────────
  skipEnrichment?: boolean; // if true, don't fetch additional data
  strictMatching?: boolean; // if true, all criteria must match (AND logic)
  caseSensitive?: boolean; // keyword matching case sensitivity
}

/**
 * Date range filter helper
 */
export interface DateRangeFilter {
  after?: Date;
  before?: Date;
  /** Number of days ago to include (e.g., 30 for last 30 days) */
  daysAgo?: number;
}

/**
 * Compose a date range filter for recent listings
 * @example
 * const thirtyDaysAgo = createDateFilter({ daysAgo: 30 });
 */
export function createDateFilter(options: DateRangeFilter): {
  postedAfter?: Date;
  postedBefore?: Date;
} {
  const result: { postedAfter?: Date; postedBefore?: Date } = {};

  if (options.after) result.postedAfter = options.after;
  if (options.before) result.postedBefore = options.before;

  if (options.daysAgo && options.daysAgo > 0) {
    const now = new Date();
    result.postedAfter = new Date(now.getTime() - options.daysAgo * 24 * 60 * 60 * 1000);
  }

  return result;
}

/**
 * Apply PropertyFilter to a set of criteria
 * Returns true if criteria passes all enabled filters
 */
export function matchesFilter(
  criteria: {
    price?: number;
    propertyType?: string;
    location?: string;
    bedrooms?: number;
    bathrooms?: number;
    squareFeet?: number;
    postedDate?: Date;
    equity?: number;
    arv?: number;
    description?: string;
  },
  filter: PropertyFilter,
  options?: { strictMatching?: boolean; caseSensitive?: boolean }
): FilterResult {
  const strict = options?.strictMatching ?? false;
  const caseSensitive = options?.caseSensitive ?? false;

  // ── Price check ───────────────────────────────────────────────────────────
  if (criteria.price !== undefined) {
    if (filter.minPrice !== undefined && criteria.price < filter.minPrice) {
      return { passed: false, reason: `Price ${criteria.price} below minimum ${filter.minPrice}` };
    }
    if (filter.maxPrice !== undefined && criteria.price > filter.maxPrice) {
      return { passed: false, reason: `Price ${criteria.price} above maximum ${filter.maxPrice}` };
    }
  }

  // ── Property type check ───────────────────────────────────────────────────
  if (criteria.propertyType && filter.propertyTypes && filter.propertyTypes.length > 0) {
    const normalizedType = criteria.propertyType.toLowerCase();
    const matches = filter.propertyTypes.some((t) =>
      caseSensitive ? t === criteria.propertyType : t.toLowerCase() === normalizedType
    );
    if (!matches) {
      return {
        passed: false,
        reason: `Property type "${criteria.propertyType}" not in allowed types`,
      };
    }
  }

  // ── Location check ───────────────────────────────────────────────────────
  if (criteria.location && filter.locations && filter.locations.length > 0) {
    const normalizedLocation = criteria.location.toLowerCase();
    const matches = filter.locations.some((l) =>
      normalizedLocation.includes(l.toLowerCase()) || l.toLowerCase().includes(normalizedLocation)
    );
    if (!matches) {
      return { passed: false, reason: `Location "${criteria.location}" not in allowed locations` };
    }
  }

  // ── Bedrooms check ───────────────────────────────────────────────────────
  if (criteria.bedrooms !== undefined) {
    if (filter.minBedrooms !== undefined && criteria.bedrooms < filter.minBedrooms) {
      return {
        passed: false,
        reason: `Bedrooms ${criteria.bedrooms} below minimum ${filter.minBedrooms}`,
      };
    }
    if (filter.maxBedrooms !== undefined && criteria.bedrooms > filter.maxBedrooms) {
      return {
        passed: false,
        reason: `Bedrooms ${criteria.bedrooms} above maximum ${filter.maxBedrooms}`,
      };
    }
  }

  // ── Bathrooms check ──────────────────────────────────────────────────────
  if (criteria.bathrooms !== undefined) {
    if (filter.minBathrooms !== undefined && criteria.bathrooms < filter.minBathrooms) {
      return {
        passed: false,
        reason: `Bathrooms ${criteria.bathrooms} below minimum ${filter.minBathrooms}`,
      };
    }
    if (filter.maxBathrooms !== undefined && criteria.bathrooms > filter.maxBathrooms) {
      return {
        passed: false,
        reason: `Bathrooms ${criteria.bathrooms} above maximum ${filter.maxBathrooms}`,
      };
    }
  }

  // ── Square feet check ────────────────────────────────────────────────────
  if (criteria.squareFeet !== undefined) {
    if (filter.minSquareFeet !== undefined && criteria.squareFeet < filter.minSquareFeet) {
      return {
        passed: false,
        reason: `Square feet ${criteria.squareFeet} below minimum ${filter.minSquareFeet}`,
      };
    }
    if (filter.maxSquareFeet !== undefined && criteria.squareFeet > filter.maxSquareFeet) {
      return {
        passed: false,
        reason: `Square feet ${criteria.squareFeet} above maximum ${filter.maxSquareFeet}`,
      };
    }
  }

  // ── Date check ───────────────────────────────────────────────────────────
  if (criteria.postedDate) {
    if (filter.postedAfter && criteria.postedDate < filter.postedAfter) {
      return { passed: false, reason: `Posted date before minimum date` };
    }
    if (filter.postedBefore && criteria.postedDate > filter.postedBefore) {
      return { passed: false, reason: `Posted date after maximum date` };
    }
  }

  // ── Equity check ─────────────────────────────────────────────────────────
  if (criteria.equity !== undefined && filter.minEquity !== undefined) {
    if (criteria.equity < filter.minEquity) {
      return {
        passed: false,
        reason: `Equity ${criteria.equity} below minimum ${filter.minEquity}`,
      };
    }
  }

  // ── ARV check ────────────────────────────────────────────────────────────
  if (criteria.arv !== undefined && filter.minArv !== undefined) {
    if (criteria.arv < filter.minArv) {
      return { passed: false, reason: `ARV ${criteria.arv} below minimum ${filter.minArv}` };
    }
  }

  // ── Keyword matching ─────────────────────────────────────────────────────
  if (
    criteria.description &&
    (filter.keywords?.length || 0) > 0 ||
    (filter.excludeKeywords?.length || 0) > 0
  ) {
    const description = caseSensitive ? criteria.description : criteria.description.toLowerCase();

    // Check exclude keywords first (hard stop)
    if (filter.excludeKeywords && filter.excludeKeywords.length > 0) {
      for (const keyword of filter.excludeKeywords) {
        const normalizedKeyword = caseSensitive ? keyword : keyword.toLowerCase();
        if (description.includes(normalizedKeyword)) {
          return {
            passed: false,
            reason: `Description contains excluded keyword "${keyword}"`,
          };
        }
      }
    }

    // Check include keywords (if strict, all must match; otherwise any)
    if (filter.keywords && filter.keywords.length > 0) {
      const normalizedKeywords = filter.keywords.map((k) =>
        caseSensitive ? k : k.toLowerCase()
      );

      if (strict) {
        // All keywords must be present
        const allPresent = normalizedKeywords.every((k) => description.includes(k));
        if (!allPresent) {
          return { passed: false, reason: `Not all required keywords found in description` };
        }
      } else {
        // At least one keyword must be present
        const anyPresent = normalizedKeywords.some((k) => description.includes(k));
        if (!anyPresent) {
          return { passed: false, reason: `No matching keywords found in description` };
        }
      }

      const matchedKeywords = normalizedKeywords.filter((k) => description.includes(k));
      return { passed: true, matchedKeywords: matchedKeywords };
    }
  }

  return { passed: true };
}

/**
 * Merge multiple filters with AND logic (all must pass)
 */
export function mergeFilters(...filters: PropertyFilter[]): PropertyFilter {
  const merged: PropertyFilter = {};

  for (const filter of filters) {
    // Price: use most restrictive (highest min, lowest max)
    if (filter.minPrice !== undefined) {
      merged.minPrice = Math.max(merged.minPrice ?? 0, filter.minPrice);
    }
    if (filter.maxPrice !== undefined) {
      merged.maxPrice = Math.min(merged.maxPrice ?? Infinity, filter.maxPrice);
    }

    // Arrays: combine (intersection for types, union for locations/keywords)
    if (filter.propertyTypes) {
      merged.propertyTypes = merged.propertyTypes
        ? merged.propertyTypes.filter((t) => filter.propertyTypes!.includes(t))
        : filter.propertyTypes;
    }
    if (filter.locations) {
      merged.locations = [...new Set([...(merged.locations || []), ...filter.locations])];
    }
    if (filter.keywords) {
      merged.keywords = [...new Set([...(merged.keywords || []), ...filter.keywords])];
    }
    if (filter.excludeKeywords) {
      merged.excludeKeywords = [...new Set([...(merged.excludeKeywords || []), ...filter.excludeKeywords])];
    }

    // Bedrooms/bathrooms: use most restrictive
    if (filter.minBedrooms !== undefined) {
      merged.minBedrooms = Math.max(merged.minBedrooms ?? 0, filter.minBedrooms);
    }
    if (filter.maxBedrooms !== undefined) {
      merged.maxBedrooms = Math.min(merged.maxBedrooms ?? Infinity, filter.maxBedrooms);
    }

    // Dates: use most restrictive
    if (filter.postedAfter) {
      merged.postedAfter = merged.postedAfter
        ? new Date(Math.max(merged.postedAfter.getTime(), filter.postedAfter.getTime()))
        : filter.postedAfter;
    }
    if (filter.postedBefore) {
      merged.postedBefore = merged.postedBefore
        ? new Date(Math.min(merged.postedBefore.getTime(), filter.postedBefore.getTime()))
        : filter.postedBefore;
    }
  }

  return merged;
}
