// src/enrichers/zillow/test.ts
import { enrichRawListings } from "./zillow.enricher";
import { RawListing } from "../../types/listing";

// Real addresses that exist on Zillow
const testListings: RawListing[] = [
  {
    url: "https://www.zillow.com/homedetails/7285-Summerhill-Dr-Concord-Township-OH-44077/34464985_zpid/",
    source: "test",
    title: "Test Property 1",
    address: "7285 Summerhill Dr, Concord Township, OH 44077",
    price: 425000,
  },
  {
    url: "https://www.zillow.com/homedetails/2114-Bigelow-Ave-Seattle-WA-98109/48749465_zpid/",
    source: "test",
    title: "Test Property 2",
    address: "2114 Bigelow Ave, Seattle, WA 98109",
    price: 1895000,
  },
  {
    url: "https://www.zillow.com/homedetails/1600-Pennsylvania-Ave-NW-Washington-DC-20500/84074482_zpid/",
    source: "test",
    title: "Test Property 3",
    address: "1600 Pennsylvania Ave NW, Washington, DC 20500",
    price: 0,
  },
];

async function main() {
  console.log("Starting Zillow enricher test...\n");
  console.log("Input listings:");
  testListings.forEach((l) => console.log(`  • ${l.address} @ $${l.price}`));
  console.log("");

  const enriched = await enrichRawListings(testListings);

  console.log("\nResults:");
  enriched.forEach((l) => {
    const found = l.zestimate
      ? `✓ Zestimate: $${l.zestimate.toLocaleString()}`
      : "✗ No zestimate found";
    console.log(`  • ${l.address} → ${found}`);
  });
}

main().catch(console.error);