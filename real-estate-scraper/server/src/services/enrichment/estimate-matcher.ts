/**
 * Estimate matcher service
 * Finds matching listings in reference tables (Zillow, Redfin, Propwire)
 * based on normalized addresses and extracts estimate values
 */

import { prisma } from "../../db/client";
import { logger } from "../../utils/logger";
import { EstimateSource } from "./address-normalizer";

export interface EstimateMatch {
  found: boolean;
  estimateSource: EstimateSource;
  estimateValue: number | null;
  matchedAddress: string | null;
  sourceListingId: string | null; // ID of the ZillowListing/RedfinListing/etc.
}

/**
 * Find matching listing record for a normalized address
 * Queries the appropriate *Listing table based on estimate source
 */
export async function findEstimateMatch(
  normalizedAddress: string,
  estimateSource: EstimateSource
): Promise<EstimateMatch> {
  try {
    if (!normalizedAddress) {
      return {
        found: false,
        estimateSource,
        estimateValue: null,
        matchedAddress: null,
        sourceListingId: null,
      };
    }

    let estimateValue: number | null = null;
    let matchedAddress: string | null = null;
    let sourceListingId: string | null = null;

    if (estimateSource === "zillow") {
      // Query ZillowListing table by address
      const zillowMatch = await prisma.zillowListing.findFirst({
        where: {
          address: {
            contains: normalizedAddress,
            mode: "insensitive",
          },
        },
      });

      if (zillowMatch) {
        estimateValue = zillowMatch.zestimate;
        matchedAddress = zillowMatch.address;
        sourceListingId = zillowMatch.id;
      }
    } else if (estimateSource === "redfin") {
      // Query RedfinListing table by address
      const redfinMatch = await prisma.redfinListing.findFirst({
        where: {
          address: {
            contains: normalizedAddress,
            mode: "insensitive",
          },
        },
      });

      if (redfinMatch) {
        estimateValue = redfinMatch.estimate;
        matchedAddress = redfinMatch.address;
        sourceListingId = redfinMatch.id;
      }
    } else if (estimateSource === "propwire") {
      // Query PropwireListing table by address
      const propwireMatch = await prisma.propwireListing.findFirst({
        where: {
          address: {
            contains: normalizedAddress,
            mode: "insensitive",
          },
        },
      });

      if (propwireMatch) {
        estimateValue = propwireMatch.estimate;
        matchedAddress = propwireMatch.address;
        sourceListingId = propwireMatch.id;
      }
    }

    return {
      found: estimateValue !== null && estimateValue !== undefined,
      estimateSource,
      estimateValue,
      matchedAddress,
      sourceListingId,
    };
  } catch (error) {
    logger.error(
      `[EstimateMatcher] Error matching ${estimateSource} listing for address "${normalizedAddress}":`,
      error
    );
    return {
      found: false,
      estimateSource,
      estimateValue: null,
      matchedAddress: null,
      sourceListingId: null,
    };
  }
}
