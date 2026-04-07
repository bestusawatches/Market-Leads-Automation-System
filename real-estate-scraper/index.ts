// index.ts — CLI entry point
// Usage:
//   ts-node index.ts --source craigslist_milwaukee
//   ts-node index.ts --source craigslist_columbus --max-pages 3
//   ts-node index.ts --source zillow
//   ts-node index.ts --source all

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { SCRAPER_REGISTRY, resolveSourceKeys } from "./src/scrapers/registry";
import { runScrapers } from "./src/runner";
import { logger } from "./src/utils/logger";
import { prisma } from "./src/db/client";
import { config } from "./src/config";

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("source", {
      alias: "s",
      type: "string",
      default: "craigslist_milwaukee",
      describe: `Source(s) to scrape. Options: ${Object.keys(SCRAPER_REGISTRY).join(", ")}, all`,
    })
    .option("max-pages", {
      type: "number",
      describe: "Override max pages per scraper",
    })
    .option("max-listings", {
      type: "number",
      describe: "Override max listings per scraper",
    })
    .help()
    .parseAsync();

  // Apply CLI overrides to config at runtime
  if (argv["max-pages"]) {
    (config as any).maxPages = argv["max-pages"];
    logger.info(`MAX_PAGES overridden → ${argv["max-pages"]}`);
  }
  if (argv["max-listings"]) {
    (config as any).maxListings = argv["max-listings"];
    logger.info(`MAX_LISTINGS overridden → ${argv["max-listings"]}`);
  }

  let sourceKeys: string[];
  try {
    sourceKeys = resolveSourceKeys(argv.source as string);
  } catch (err) {
    logger.error(`${err}`);
    process.exit(1);
  }

  logger.info(`Sources resolved: ${sourceKeys.join(", ")}`);

  try {
    await runScrapers({ sourceKeys, factories: SCRAPER_REGISTRY });
  } finally {
    await prisma.$disconnect();
    logger.info("DB connection closed");
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
