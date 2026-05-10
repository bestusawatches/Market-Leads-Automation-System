/**
 * Enrichment pipeline: Normalize addresses and match against reference tables
 * 1. Normalizes address to zillow/redfin/propwire formats
 * 2. Finds matching records in corresponding *Listing tables
 * 3. Creates Property and Estimate records when matches are found
 */

import { prisma } from "../../db/client";
import { AddressNormalizerService, EstimateSource } from "./address-normalizer";
import { findEstimateMatch } from "./estimate-matcher";
import { logger } from "../../utils/logger";

export interface EnrichmentStats {
  processed: number;
  linked: number;
  estimatesCreated: number;
  skipped: number;
  failed: number;
  duration_ms: number;
}

// Estimate sources to try for each listing
const ESTIMATE_SOURCES: EstimateSource[] = ["zillow", "redfin", "propwire"];

/**
 * Enrich all unlinked listings for a specific source
 * Normalizes addresses to different formats and matches against reference tables
 */
export async function enrichListingsBySource(source: string): Promise<EnrichmentStats> {
  const startTime = Date.now();
  let processed = 0;
  let linked = 0;
  let estimatesCreated = 0;
  let skipped = 0;
  let failed = 0;

  logger.info(`[Enrichment] Starting enrichment for source: ${source}`);

  // Check if this source has normalizers
  if (!AddressNormalizerService.supportsSource(source)) {
    logger.info(`[Enrichment] Source ${source} not yet supported for enrichment — skipping`);
    return {
      processed: 0,
      linked: 0,
      estimatesCreated: 0,
      skipped: 0,
      failed: 0,
      duration_ms: 0,
    };
  }

  try {
    // Get all unlinked listings for this source
    const unlinkedListings = await prisma.listing.findMany({
      where: {
        source,
        propertyId: null,
      },
    });

    logger.info(
      `[Enrichment] Found ${unlinkedListings.length} unlinked listings for ${source}`
    );

    // Process each listing
    for (const listing of unlinkedListings) {
      try {
        let propertyId: string | null = null;

        // Try each estimate source (zillow, redfin, propwire)
        for (const estimateSource of ESTIMATE_SOURCES) {
          try {
            // Normalize address to this estimate source's format
            const normalized = AddressNormalizerService.normalize(listing, estimateSource);

            if (!normalized.address) {
              logger.debug(
                `[Enrichment] Listing ${listing.id} could not normalize to ${estimateSource} format`
              );
              continue;
            }

            // Find matching record in reference table
            const match = await findEstimateMatch(normalized.address, estimateSource);

            if (match.found && match.estimateValue) {
              logger.debug(
                `[Enrichment] Found ${estimateSource} match for listing ${listing.id}: ${match.estimateValue}`
              );

              // Create or find Property using the normalized address as canonical key
              const property = await prisma.property.upsert({
                where: { normalizedAddress: normalized.address },
                create: {
                  normalizedAddress: normalized.address,
                  address: listing.rawAddress || match.matchedAddress || undefined,
                  url: listing.url,
                },
                update: {
                  url: listing.url,
                  updatedAt: new Date(),
                },
              });

              propertyId = property.id;

              // Create Estimate record with sourceListingId
              await prisma.estimate.upsert({
                where: {
                  propertyId_source: {
                    propertyId: property.id,
                    source: estimateSource,
                  },
                },
                create: {
                  propertyId: property.id,
                  source: estimateSource,
                  value: match.estimateValue,
                  sourceListingId: match.sourceListingId,
                },
                update: {
                  value: match.estimateValue,
                  sourceListingId: match.sourceListingId,
                  fetchedAt: new Date(),
                },
              });

              estimatesCreated++;
            }
          } catch (error) {
            logger.error(
              `[Enrichment] Error processing ${estimateSource} for listing ${listing.id}:`,
              error
            );
          }
        }

        // If we found matches and created a property, link the listing
        if (propertyId) {
          await prisma.listing.update({
            where: { id: listing.id },
            data: { propertyId },
          });
          linked++;
        } else {
          skipped++;
        }

        processed++;
      } catch (error) {
        logger.error(
          `[Enrichment] Error processing listing ${listing.id}:`,
          error
        );
        failed++;
        processed++;
      }
    }

    const duration_ms = Date.now() - startTime;

    logger.info(
      `[Enrichment] Completed for ${source}: ${linked} linked, ${estimatesCreated} estimates created, ${skipped} skipped, ${failed} failed in ${duration_ms}ms`
    );

    return { processed, linked, estimatesCreated, skipped, failed, duration_ms };
  } catch (error) {
    logger.error(`[Enrichment] Fatal error enriching source ${source}:`, error);
    throw error;
  }
}
