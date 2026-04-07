import { Listing } from "../types/listing";

export abstract class BaseScraper {
  abstract source: string;
  abstract scrape(): Promise<Listing[]>;
}
