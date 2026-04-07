import { BaseScraper } from "./base.scraper";

type ScraperCtor = new (...args: any[]) => BaseScraper;

const registry = new Map<string, ScraperCtor>();

export function register(name: string, ctor: ScraperCtor) {
  registry.set(name, ctor);
}

export function getScraper(name: string): ScraperCtor | undefined {
  return registry.get(name);
}

export function listSources() {
  return Array.from(registry.keys());
}

export default registry;
