import "dotenv/config";
import { register } from "./src/scrapers/registry";
import CraigslistScraper from "./src/scrapers/craigslist/craigslist.scraper";
import ZillowScraper from "./src/scrapers/zillow/zillow.scraper";
import runSource from "./src/runner";

register("craigslist", CraigslistScraper as any);
register("zillow", ZillowScraper as any);

async function main() {
  const args = process.argv.slice(2);
  const source = args[0] || "craigslist";
  await runSource(source);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
