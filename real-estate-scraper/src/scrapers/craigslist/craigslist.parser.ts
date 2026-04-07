import { Listing } from "../../types/listing";

export function parseCraigslistItem(el: any): Listing {
  // Minimal example parser — replace with real parsing logic
  return {
    source: "craigslist",
    externalId: el.id || String(Date.now()),
    title: el.title || "untitled",
    price: el.price ? Number(el.price) : undefined,
    url: el.url || "",
    raw: el,
  };
}
