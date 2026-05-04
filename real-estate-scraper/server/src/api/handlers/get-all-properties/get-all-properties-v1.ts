import { Request, Response, NextFunction } from "express";
import { getAllPropertiesWithListings } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Get all properties with their related listings and estimates
 * @route GET /api/v1/properties
 * @returns {Object} { status, data, message? }
 */
export const getAllProperties = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit = 1000 } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string) || 1000, 10000);

    logger.info(`[GET /properties] Fetching all properties with listings and estimates (limit: ${parsedLimit})`);

    const properties = await getAllPropertiesWithListings(parsedLimit);

    logger.info(`[GET /properties] Successfully fetched ${properties.length} properties`);

    res.status(200).json({
      status: "ok",
      data: {
        count: properties.length,
        properties,
      },
      message: `Retrieved ${properties.length} properties with listings and estimates`,
    });
  } catch (error) {
    logger.error(`[GET /properties] Error fetching properties:`, error);
    next(error);
  }
};
