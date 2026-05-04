import { Request, Response, NextFunction } from "express";
import { getAllListings } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Get all listings with their related property data
 * @route GET /api/v1/listings
 * @returns {Object} { status, data, message? }
 */
export const getAllListingsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit = 1000 } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string) || 1000, 10000);

    logger.info(
      `[GET /listings] Fetching all listings with property data (limit: ${parsedLimit})`
    );

    const listings = await getAllListings(parsedLimit);

    logger.info(`[GET /listings] Successfully fetched ${listings.length} listings`);

    res.status(200).json({
      status: "ok",
      data: {
        count: listings.length,
        listings,
      },
      message: `Retrieved ${listings.length} listings with property data`,
    });
  } catch (error) {
    logger.error(`[GET /listings] Error fetching listings:`, error);
    next(error);
  }
};
