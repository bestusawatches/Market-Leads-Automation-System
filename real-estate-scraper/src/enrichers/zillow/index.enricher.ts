// ── Add to your existing index.ts ──────────────────────────────────────────
// This snippet shows what to ADD to your index.ts to support --enrich flags.
// Your existing scraper logic stays unchanged.

import { logger } from "../../utils/logger";
import { runZillowEnricher } from "./zillow.enricher";

// In your main() function, add an enricher branch alongside the scraper branch:

async function main() {
  const args = process.argv.slice(2);

  // ── Enricher branch ──────────────────────────────────────────────────────
  const enrichIndex = args.indexOf("--enrich");
  if (enrichIndex !== -1) {
    const enrichTarget = args[enrichIndex + 1];
    const limitIndex   = args.indexOf("--limit");
    const limit        = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : 30;
    const dryRun       = args.includes("--dry-run");

    if (enrichTarget === "zillow") {
      logger.info(`Running Zillow enricher (limit: ${limit}, dryRun: ${dryRun})`);
      await runZillowEnricher({ limit, dryRun });
      return;
    }

    logger.error(`Unknown enricher: ${enrichTarget}. Available: zillow`);
    process.exit(1);
  }

  // ── Your existing scraper logic below (unchanged) ────────────────────────
  // const source = args.find(...) etc.
}

// src/enrichers/zillow/index.enricher.ts
export { runZillowEnricher, enrichRawListings } from "./zillow.enricher";

// ── Add to package.json scripts ─────────────────────────────────────────────
// "enrich:zillow":     "node -r ./polyfill-file.js -r ts-node/register index.ts --enrich zillow",
// "enrich:zillow:dry": "node -r ./polyfill-file.js -r ts-node/register index.ts --enrich zillow --dry-run",