// src/scrapers/registry.ts
// ─────────────────────────────────────────────────────────────────────────────
// To add a new scraping source:
//   1. Create src/scrapers/<site>/<site>.scraper.ts extending BaseScraper
//   2. Import it here and add an entry to SCRAPER_REGISTRY
//   3. Run: ts-node index.ts --source <key>
// That's it — storage, filtering, dedup are all handled automatically.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseScraper } from "./base.scraper";
import { CraigslistScraper } from "./craigslist/craigslist.scraper";
import { ZillowScraper } from "./zillow/zillow.scraper";
import { config } from "../config";

/** Each entry returns a ready-to-run BaseScraper instance */
export type ScraperFactory = () => BaseScraper;

export const SCRAPER_REGISTRY: Record<string, ScraperFactory> = {
  // ── Craigslist cities ─────────────────────────────────────────────────────
  craigslist_milwaukee: () =>
    new CraigslistScraper(config.sources.craigslist.milwaukee),

  craigslist_columbus: () =>
    new CraigslistScraper(config.sources.craigslist.columbus),

  craigslist_cleveland: () =>
    new CraigslistScraper(config.sources.craigslist.cleveland),

  craigslist_toledo: () =>
    new CraigslistScraper(config.sources.craigslist.toledo),

  // ── Zillow ────────────────────────────────────────────────────────────────
  zillow: () => new ZillowScraper(config.sources.zillow),

  // ── Groups ────────────────────────────────────────────────────────────────
  /** Alias: run all Craigslist cities at once */
  craigslist: () => {
    throw new Error(
      'Use source "craigslist_milwaukee", "craigslist_columbus" etc., or source "all"'
    );
  },
};

/** Expand "all" into every registered key (excluding group aliases) */
export function resolveSourceKeys(source: string): string[] {
  if (source === "all") {
    return Object.keys(SCRAPER_REGISTRY).filter(
      (k) => k !== "craigslist" // exclude the alias
    );
  }
  if (source.startsWith("craigslist") && source === "craigslist") {
    return Object.keys(SCRAPER_REGISTRY).filter((k) =>
      k.startsWith("craigslist_")
    );
  }
  if (!SCRAPER_REGISTRY[source]) {
    throw new Error(
      `Unknown source "${source}". Available: ${Object.keys(SCRAPER_REGISTRY).join(", ")}`
    );
  }
  return [source];
}
