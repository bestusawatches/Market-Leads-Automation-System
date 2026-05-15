import { Request, Response, NextFunction } from "express";
import { requestStop, getStatus } from "../../../scrape/status";
import { logger } from "../../../utils/logger";

/**
 * Request to stop the currently running scraper
 * @route POST /api/v1/scrape/stop
 * @returns {Object} { status, message, isStopping }
 */

export const stopScrapeHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const status = getStatus();

    if (!status.running) {
      logger.warn(`[POST /scrape/stop] Stop requested but no scrape is running`);
      return res.status(400).json({
        status: "error",
        message: "No scrape is currently running",
      });
    }

    logger.info(`[POST /scrape/stop] Stop requested for scraping ID: ${status.scrapingId}`);

    // Request the stop
    requestStop();

    res.status(200).json({
      status: "ok",
      message: "Stop request sent. The current scraper will finish its task and stop.",
      data: {
        isStopping: true,
        scrapingId: status.scrapingId,
      },
    });
  } catch (error) {
    logger.error(`[POST /scrape/stop] Unexpected error:`, error);
    next(error);
  }
};
