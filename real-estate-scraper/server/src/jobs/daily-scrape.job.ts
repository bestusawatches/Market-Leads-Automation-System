import { cronManager } from "../utils/cronManager";
import { SCRAPER_REGISTRY } from "../scrapers/registry";
import { runScrapers } from "../runner";
import { logger } from "../utils/logger";
import { setRunning, setProgress } from "../scrape/status";

const PRIORITY_SCRAPERS = ["zillow", "propwire", "redfin", "realtor"];

const REMAINING_SCRAPERS = [
  "investorlift",
  "offmarket",
  "crexi",
  "creativelisting",
  "loopnet",
  "facebook",
  "facebook_marketplace",
  "craigslist",
];

export function initializeDailyScrapeJob() {
  cronManager.createJob({
    name: "Daily Scrape (4:15pm WAT)",
    schedule: "15 16 * * *",
    timeZone: process.env.SCRAPE_TIMEZONE || "Africa/Lagos",
    async onTick() {
      try {
        logger.info("[cron] Daily scrape job starting at 4:15pm WAT");

        // Combine lists and manage status across the full cron run so UI
        // progress shows the entire job (priority + remaining).
        const remaining = REMAINING_SCRAPERS.filter((s) => !PRIORITY_SCRAPERS.includes(s));
        const allSources = [...PRIORITY_SCRAPERS, ...remaining];

        const scrapingId = `${Date.now()}-cron`;
        setRunning(true, scrapingId);
        setProgress({ total: allSources.length, completed: 0 });

        // Run priority scrapers first (sequentially) without letting the
        // runner overwrite the global progress state.
        if (PRIORITY_SCRAPERS.length > 0) {
          await runScrapers({ sourceKeys: PRIORITY_SCRAPERS, factories: SCRAPER_REGISTRY, manageStatus: false });
        }

        // Then run the remaining scrapers
        if (remaining.length > 0) {
          await runScrapers({ sourceKeys: remaining, factories: SCRAPER_REGISTRY, manageStatus: false });
        }

        logger.info("[cron] Daily scrape job completed");
        setRunning(false);
      } catch (err) {
        logger.error("[cron] Daily scrape job failed", err instanceof Error ? err : String(err));
      }
    },
  });
}

export default initializeDailyScrapeJob;
