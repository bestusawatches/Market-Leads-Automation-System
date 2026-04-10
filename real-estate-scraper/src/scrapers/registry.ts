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
import { InvestorLiftScraper } from "./investorlift/investorlift.scraper";
import { OffmarketScraper } from "./offmarket/offmarket.scraper";
import { config } from "../config";

/** Each entry returns a ready-to-run BaseScraper instance */
export type ScraperFactory = () => BaseScraper;

export const SCRAPER_REGISTRY: Record<string, ScraperFactory> = {
  offmarket: () => new OffmarketScraper(),
  // ── InvestorLift (highest priority per project doc §3.1) ─────────────────
  investorlift: () => new InvestorLiftScraper(),

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
};

// ── Source group aliases ──────────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  // "craigslist" runs all CL cities at once
  craigslist: Object.keys(SCRAPER_REGISTRY).filter((k) =>
    k.startsWith("craigslist_"),
  ),
  // "all" runs every registered scraper
  all: Object.keys(SCRAPER_REGISTRY),
};

/** Expand a source name or alias into concrete registry keys */
export function resolveSourceKeys(source: string): string[] {
  if (ALIASES[source]) return ALIASES[source];

  if (!SCRAPER_REGISTRY[source]) {
    const available = [
      ...Object.keys(SCRAPER_REGISTRY),
      ...Object.keys(ALIASES),
    ].join(", ");
    throw new Error(`Unknown source "${source}". Available: ${available}`);
  }

  return [source];
}
