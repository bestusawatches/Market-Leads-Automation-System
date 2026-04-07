import { getScraper } from "./scrapers/registry";
import logger from "./utils/logger";
import { upsertListing } from "./db/repository";

export async function runSource(name: string) {
  const ctor = getScraper(name);
  if (!ctor) throw new Error(`No scraper registered for ${name}`);
  const scraper = new ctor();
  logger.info(`Running scraper for ${name}`);
  const listings = await scraper.scrape();
  for (const l of listings) {
    await upsertListing(l);
  }
  logger.info(`Finished ${name}: ${listings.length} listings processed`);
}

export default runSource;
