import { Request, Response, NextFunction } from "express";
import { getRealtorListings } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Get all Realtor listings from the RealtorListing table
 * @route GET /api/v1/listings/realtor
 * @returns {Object} { status, data, message? }
 */
export const getRealtorListingsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit = 1000 } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string) || 1000, 10000);

    logger.info(
      `[GET /listings/realtor] Fetching Realtor listings (limit: ${parsedLimit})`
    );

    const listings = await getRealtorListings(parsedLimit);

    logger.info(`[GET /listings/realtor] Successfully fetched ${listings.length} Realtor listings`);

    res.status(200).json({
      status: "ok",
      data: {
        count: listings.length,
        listings,
      },
      message: `Retrieved ${listings.length} Realtor listings`,
    });
  } catch (error) {
    logger.error(`[GET /listings/realtor] Error fetching Realtor listings:`, error);
    next(error);
  }
};
