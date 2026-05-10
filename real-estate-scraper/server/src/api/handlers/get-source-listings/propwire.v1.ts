import { Request, Response, NextFunction } from "express";
import { getPropwireListings } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Get all Propwire listings from the PropwireListing table
 * @route GET /api/v1/listings/propwire
 * @returns {Object} { status, data, message? }
 */
export const getPropwireListingsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit = 1000 } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string) || 1000, 10000);

    logger.info(
      `[GET /listings/propwire] Fetching Propwire listings (limit: ${parsedLimit})`
    );

    const listings = await getPropwireListings(parsedLimit);

    logger.info(`[GET /listings/propwire] Successfully fetched ${listings.length} Propwire listings`);

    res.status(200).json({
      status: "ok",
      data: {
        count: listings.length,
        listings,
      },
      message: `Retrieved ${listings.length} Propwire listings`,
    });
  } catch (error) {
    logger.error(`[GET /listings/propwire] Error fetching Propwire listings:`, error);
    next(error);
  }
};
