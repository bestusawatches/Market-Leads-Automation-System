import { Request, Response, NextFunction } from "express";
import { upsertFilter, getFilter, SavedFilterInput } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Update or create the single filter record
 * @route PUT /api/v1/filters
 * @returns {Object} { status, data, message? }
 */
export const updateFilterHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const filterData: SavedFilterInput = req.body;

    // Validation
    if (!filterData.name || !filterData.name.trim()) {
      return res.status(400).json({
        status: "error",
        message: "Filter name is required",
      });
    }

    if (!filterData.source || !filterData.source.trim()) {
      return res.status(400).json({
        status: "error",
        message: "Filter source is required",
      });
    }

    logger.info(`[PUT /filters] Upserting filter: ${filterData.name}`);

    const filter = await upsertFilter(filterData);

    logger.info(`[PUT /filters] Successfully upserted filter: ${filter.name}`);

    res.status(200).json({
      status: "ok",
      data: filter,
      message: "Filter saved successfully",
    });
  } catch (error) {
    logger.error(`[PUT /filters] Error saving filter:`, error);
    next(error);
  }
};

/**
 * Get the single filter record
 * @route GET /api/v1/filters
 * @returns {Object} { status, data, message? }
 */
export const getFilterHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    logger.info(`[GET /filters] Fetching filter`);

    const filter = await getFilter();

    if (!filter) {
      return res.status(200).json({
        status: "ok",
        data: null,
        message: "No filter configured yet",
      });
    }

    logger.info(`[GET /filters] Successfully fetched filter`);

    res.status(200).json({
      status: "ok",
      data: filter,
      message: "Filter retrieved successfully",
    });
  } catch (error) {
    logger.error(`[GET /filters] Error fetching filter:`, error);
    next(error);
  }
};

