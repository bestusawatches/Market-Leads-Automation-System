import { Request, Response, NextFunction } from "express";
import { SCRAPER_REGISTRY, resolveSourceKeys } from "../../../scrapers/registry";
import { runScrapers } from "../../../runner";
import { logger } from "../../../utils/logger";

/**
 * Trigger all scrapers (equivalent to npm run scrape:all)
 * @route POST /api/v1/scrape/trigger
 * @param {string} [source=all] - Optional source to scrape (all, specific source, or comma-separated list)
 * @returns {Object} { status, message, scrapingStartedAt }
*/

export const triggerScrapeHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const source = (req.body.source || req.query.source || "all") as string;
    
    logger.info(`[POST /scrape/trigger] Scrape request received for source(s): ${source}`);

    // Resolve source keys
    let sourceKeys: string[];
    try {
      sourceKeys = resolveSourceKeys(source);
    } catch (err) {
      logger.warn(`[POST /scrape/trigger] Invalid source: ${err}`);
      return res.status(400).json({
        status: "error",
        message: `${err}`,
      });
    }

    logger.info(
      `[POST /scrape/trigger] Starting scrape for sources: ${sourceKeys.join(", ")}`
    );

    const scrapingStartedAt = new Date().toISOString();

    // Start scraping in background (non-blocking)
    runScrapers({ sourceKeys, factories: SCRAPER_REGISTRY })
      .then(() => {
        logger.info(
          `[POST /scrape/trigger] Scraping completed for sources: ${sourceKeys.join(", ")}`
        );
      })
      .catch((err) => {
        logger.error(`[POST /scrape/trigger] Scraping failed:`, err);
      });

    // Respond immediately
    res.status(202).json({
      status: "ok",
      message: `Scraping started for sources: ${sourceKeys.join(", ")}`,
      data: {
        sources: sourceKeys,
        scrapingStartedAt,
      },
    });
  } catch (error) {
    logger.error(`[POST /scrape/trigger] Unexpected error:`, error);
    next(error);
  }
};
