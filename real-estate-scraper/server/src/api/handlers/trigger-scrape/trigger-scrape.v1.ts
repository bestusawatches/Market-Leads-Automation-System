import { Request, Response, NextFunction } from "express";
import { spawn } from "child_process";
import { resolveSourceKeys } from "../../../scrapers/registry";
import { logger } from "../../../utils/logger";

/**
 * Trigger all scrapers (equivalent to npm run scrape:all)
 * @route POST /api/v1/scrape/trigger
 * @param {string} [source=all] - Optional source to scrape (all, specific source, or comma-separated list)
 * @returns {Object} { status, message, scrapingStartedAt }
 *
 * IMPORTANT: Spawns as a separate child process to avoid OOM kills.
 * The server (512MB) and scraper (with Chromium) each get their own heap.
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

    // ── Spawn as separate child process to avoid OOM ──────────────────────
    // The scraper (Chromium + browser) runs in its own heap (400MB).
    // The Express server keeps its own 512MB separate.
    // This prevents the OOM killer from terminating the entire container.
    const child = spawn(
      "node",
      [
        "--max-old-space-size=400",
        "-r",
        "./polyfill-file.js",
        "-r",
        "ts-node/register",
        "index.ts",
        "--source",
        sourceKeys.join(","),
      ],
      {
        detached: true,                    // allow child to outlive parent
        stdio: "inherit",                  // inherit stdout/stderr (Render sees child logs)
        env: process.env,                  // pass environment (including .env vars)
      }
    );

    child.unref();                         // don't block server shutdown on child
    logger.info(`[POST /scrape/trigger] Spawned scraper as child process (PID: ${child.pid})`);

    // Respond immediately
    res.status(202).json({
      status: "ok",
      message: `Scraping started for sources: ${sourceKeys.join(", ")} in detached process`,
      data: {
        sources: sourceKeys,
        scrapingStartedAt,
        childPid: child.pid,
      },
    });
  } catch (error) {
    logger.error(`[POST /scrape/trigger] Unexpected error:`, error);
    next(error);
  }
};
