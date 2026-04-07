import { BaseScraper } from "../base.scraper";
import { Listing } from "../../types/listing";

export class ZillowScraper extends BaseScraper {
  source = "zillow";

  async scrape(): Promise<Listing[]> {
    // Stub: implement Zillow scraping here
    return [];
  }
}

export default ZillowScraper;
