/**
 * Normalize LoopNet addresses to Zillow format
 *
 * Zillow format: "Street Address, City, State ZipCode, City, State, ZipCode"
 */

import { RawListing } from "../../../types/listing";

interface ZillowAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

function extractZillowAddressComponents(
  loopnetAddress: string | undefined,
  loopnetLocation: string | undefined,
  sourceName: string
): ZillowAddressComponents {
  // Street: prefer explicit address
  let street = loopnetAddress?.replace(/\s+near\s+.+$/i, "").trim();

  // City: prefer location field (often "City, ST"), fall back to source slug
  let city: string | undefined;
  if (loopnetLocation) {
    const m = loopnetLocation.match(/^([A-Za-z\s\.]+),?\s*([A-Z]{2})?/);
    if (m) city = m[1].trim();
  }
  if (!city) {
    const match = sourceName.match(/loopnet[_-]?(.*)/i);
    if (match && match[1]) {
      city = match[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  // State: try to extract from location
  let state: string | undefined;
  if (loopnetLocation) {
    const m = loopnetLocation.match(/,\s*([A-Z]{2})$/);
    if (m) state = m[1];
  }

  // Zip: look in the address string
  let zip: string | undefined;
  if (loopnetAddress) {
    const z = loopnetAddress.match(/(\d{5})/);
    if (z) zip = z[1];
  }

  return { street, city, state, zip };
}

function formatZillowAddress(components: ZillowAddressComponents): string | undefined {
  const { street, city, state, zip } = components;
  if (!street || !city || !state) return undefined;

  const firstPart = zip ? `${street}, ${city}, ${state} ${zip}` : `${street}, ${city}, ${state}`;
  const secondPart = zip ? `${city}, ${state}, ${zip}` : `${city}, ${state}`;
  return `${firstPart}, ${secondPart}`;
}

export function normalizeToZillowFormat(listing: RawListing): string | undefined {
  const components = extractZillowAddressComponents(listing.address, listing.location, listing.source);
  return formatZillowAddress(components);
}
