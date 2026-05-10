import { Request, Response, NextFunction } from "express";
import { getRedfinListings } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Get all Redfin listings from the RedfinListing table
 * @route GET /api/v1/listings/redfin
 * @returns {Object} { status, data, message? }
 */
export const getRedfinListingsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit = 1000 } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string) || 1000, 10000);

    logger.info(
      `[GET /listings/redfin] Fetching Redfin listings (limit: ${parsedLimit})`
    );

    const listings = await getRedfinListings(parsedLimit);

    logger.info(`[GET /listings/redfin] Successfully fetched ${listings.length} Redfin listings`);

    res.status(200).json({
      status: "ok",
      data: {
        count: listings.length,
        listings,
      },
      message: `Retrieved ${listings.length} Redfin listings`,
    });
  } catch (error) {
    logger.error(`[GET /listings/redfin] Error fetching Redfin listings:`, error);
    next(error);
  }
};
