/**
 * Enrichment services - address normalization, estimate matching, and property linking
 */

export { AddressNormalizerService, type EstimateSource, type NormalizedAddress } from "./address-normalizer";
export { findEstimateMatch, type EstimateMatch } from "./estimate-matcher";
export { enrichListingsBySource, type EnrichmentStats } from "./enrichment-pipeline";
