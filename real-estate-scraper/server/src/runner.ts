// src/runner.ts
import { RawListing, ListingUpsertPayload, DealScore } from "./types/listing";
import { upsertMany, getSummaryStats } from "./db/repository";
import { logger } from "./utils/logger";
import { enrichRawListings } from "./enrichers/zillow/index.enricher";

// ── Underwriting engine ───────────────────────────────────────────────────────

function scoreListings(listings: RawListing[]): ListingUpsertPayload[] {
  return listings.map((listing): ListingUpsertPayload => {
    const arv = listing.zestimate ?? listing.price;
    let dealScore: DealScore = "low_potential";
    let equityEstimate: number | undefined;

    if (arv && listing.price) {
      equityEstimate = arv - listing.price;
      const ratio = listing.price / arv;
      if (ratio <= 0.7)       dealScore = "good_deal";
      else if (ratio <= 0.85) dealScore = "average_deal";
    }

    return { ...listing, dealScore, equityEstimate };
  });
}

// ── Main runner ───────────────────────────────────────────────────────────────

export interface RunOptions {
  sourceKeys: string[];
  factories: Record<string, () => import("./scrapers/base.scraper").BaseScraper>;
}

export async function runScrapers(options: RunOptions): Promise<void> {
  const { sourceKeys, factories } = options;
  logger.info(`Runner starting | sources: ${sourceKeys.join(", ")}`);

  let totalSaved = 0;

  for (const key of sourceKeys) {
    const factory = factories[key];
    if (!factory) {
      logger.error(`No factory found for source "${key}" — skipping`);
      continue;
    }

    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`Running scraper: ${key}`);
    logger.info(`${"─".repeat(60)}`);

    const scraper = factory();

    let rawListings: RawListing[] = [];
    try {
      rawListings = await scraper.run();
    } catch (err) {
      logger.error(`Scraper "${key}" threw an error: ${err}`);
      continue;
    }

    if (rawListings.length === 0) {
      logger.warn(`[${key}] No listings returned — nothing to save`);
      continue;
    }

    // ── Zillow enrichment disabled ─────────────────────────────────────
    // logger.info(
    //   `[${key}] Running Zillow enrichment on ${rawListings.length} listings`
    // );
    // try {
    //   rawListings = await enrichRawListings(rawListings);
    // } catch (err) {
    //   // Enrichment failure is non-fatal — listings still save without zestimate
    //   logger.error(
    //     `[${key}] Zillow enrichment failed — continuing without zestimates: ${err}`
    //   );
    // }

    // Score listings — zestimate is now attached where Zillow found a match,
    // so scoreListings will use real ARV instead of falling back to price
    const payloads = scoreListings(rawListings);

    try {
      await upsertMany(payloads);
      totalSaved += payloads.length;
      logger.info(`[${key}] Saved ${payloads.length} listings to DB`);
    } catch (err) {
      logger.error(`[${key}] DB save failed: ${err}`);
    }
  }

  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`Run complete | total saved: ${totalSaved}`);

  try {
    const stats = await getSummaryStats();
    logger.info(`DB totals: ${stats.total} listings across all sources`);
    logger.info(`By source: ${JSON.stringify(stats.bySource)}`);
    logger.info(`By score:  ${JSON.stringify(stats.byDealScore)}`);
  } catch {
    // Stats are non-critical
  }

  logger.info("=".repeat(60));
}