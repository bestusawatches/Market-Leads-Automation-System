import { Request, Response, NextFunction } from "express";
import { getZillowListings } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Get all Zillow listings from the ZillowListing table
 * @route GET /api/v1/listings/zillow
 * @returns {Object} { status, data, message? }
 */
export const getZillowListingsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit = 1000 } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string) || 1000, 10000);

    logger.info(
      `[GET /listings/zillow] Fetching Zillow listings (limit: ${parsedLimit})`
    );

    const listings = await getZillowListings(parsedLimit);

    logger.info(`[GET /listings/zillow] Successfully fetched ${listings.length} Zillow listings`);

    res.status(200).json({
      status: "ok",
      data: {
        count: listings.length,
        listings,
      },
      message: `Retrieved ${listings.length} Zillow listings`,
    });
  } catch (error) {
    logger.error(`[GET /listings/zillow] Error fetching Zillow listings:`, error);
    next(error);
  }
};
