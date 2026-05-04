/**
 * Normalize Craigslist addresses to Zillow format
 * 
 * Zillow format: "Street Address, City, State ZipCode, City, State, ZipCode"
 * Example: "1035 Lanedale St NW, Massillon, OH 44647, Massillon, OH, 44647"
 */

import { RawListing } from "../../../types/listing";

interface ZillowAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Craigslist data
 */
export function extractZillowAddressComponents(
  craigslistAddress: string | undefined,
  craigslistLocation: string | undefined,
  sourceName: string
): ZillowAddressComponents {
  // Clean the street address - remove descriptors like "near FIRST FLOOR"
  let street = craigslistAddress
    ?.replace(/\s+near\s+.+$/i, "")
    .replace(/\s+on\s+[a-z]+\s+(side|floor|level)$/i, "")
    .trim();

  // Extract city from location or source
  let city = craigslistLocation?.trim();
  if (!city) {
    const match = sourceName.match(/craigslist_(\w+)/);
    if (match) {
      city = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
  }

  // Determine state from city (Ohio and Wisconsin are primary markets)
  let state: string | undefined;
  const cityLower = city?.toLowerCase();
  if (
    cityLower === "toledo" ||
    cityLower === "cleveland" ||
    cityLower === "columbus" ||
    cityLower === "akron"
  ) {
    state = "OH";
  } else if (cityLower === "milwaukee" || cityLower === "madison") {
    state = "WI";
  }

  // Try to extract zip from address
  let zip: string | undefined;
  if (craigslistAddress) {
    const zipMatch = craigslistAddress.match(/(\d{5})/);
    if (zipMatch) zip = zipMatch[1];
  }

  return { street, city, state, zip };
}

/**
 * Format address in Zillow style
 * Format: "Street, City, State ZipCode, City, State, ZipCode"
 */
export function formatZillowAddress(components: ZillowAddressComponents): string | undefined {
  const { street, city, state, zip } = components;

  if (!street || !city || !state) {
    return undefined;
  }

  // Build standard format: "Street, City, State ZipCode, City, State, ZipCode"
  const firstPart = zip ? `${street}, ${city}, ${state} ${zip}` : `${street}, ${city}, ${state}`;
  const secondPart = zip ? `${city}, ${state}, ${zip}` : `${city}, ${state}`;

  return `${firstPart}, ${secondPart}`;
}

/**
 * Normalize Craigslist listing to Zillow address format
 */
export function normalizeToZillowFormat(listing: RawListing): string | undefined {
  const components = extractZillowAddressComponents(
    listing.address,
    listing.location,
    listing.source
  );

  return formatZillowAddress(components);
}
