/**
 * Normalize Craigslist addresses to Redfin format
 * 
 * Redfin format: "Street Address, City, State, ZipCode"
 * Example: "7017 Colgate Ave Front, 7015 Colgate Rear Ave, Cleveland, OH, 44102"
 */

import { RawListing } from "../../../types/listing";

interface RedfinAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Craigslist data for Redfin format
 */
export function extractRedfinAddressComponents(
  craigslistAddress: string | undefined,
  craigslistLocation: string | undefined,
  sourceName: string
): RedfinAddressComponents {
  // Clean the street address - remove descriptors
  let street = craigslistAddress
    ?.replace(/\s+near\s+.+$/i, "")
    ?.replace(/\s+on\s+[a-z]+\s+(side|floor|level)$/i, "")
    ?.replace(/\s+at\s+.+$/i, "")
    ?.replace(/\s+\(.+\)$/i, "")
    .trim();

  // Get city from location field
  let city = craigslistLocation?.trim();
  if (!city) {
    // Fallback: extract from source name
    const match = sourceName.match(/craigslist_(\w+)/);
    if (match) {
      city = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
  }

  // Normalize city name (handle "Downtown" etc)
  if (city?.toLowerCase() === "downtown") {
    // For downtown, try to infer actual city from source
    const match = sourceName.match(/craigslist_(\w+)/);
    if (match) {
      city = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
  }

  // Map city to state
  let state: string | undefined;
  const cityLower = city?.toLowerCase();
  const cityStateMap: Record<string, string> = {
    toledo: "OH",
    cleveland: "OH",
    columbus: "OH",
    akron: "OH",
    dayton: "OH",
    cincinnati: "OH",
    milwaukee: "WI",
    madison: "WI",
    appleton: "WI",
    green_bay: "WI",
    chicago: "IL",
    denver: "CO",
    phoenix: "AZ",
  };
  state = cityStateMap[cityLower || ""];

  // Extract zip code
  let zip: string | undefined;
  if (craigslistAddress) {
    const zipMatch = craigslistAddress.match(/(\d{5})/);
    if (zipMatch) zip = zipMatch[1];
  }

  return { street, city, state, zip };
}

/**
 * Format address in Redfin style
 * Format: "Street, City, State, ZipCode"
 */
export function formatRedfinAddress(components: RedfinAddressComponents): string | undefined {
  const { street, city, state, zip } = components;

  if (!street || !city || !state) {
    return undefined;
  }

  // Build Redfin format: "Street, City, State, ZipCode"
  const parts = [street, city, state];
  if (zip) parts.push(zip);

  return parts.join(", ");
}

/**
 * Normalize Craigslist listing to Redfin address format
 */
export function normalizeToRedfinFormat(listing: RawListing): string | undefined {
  const components = extractRedfinAddressComponents(
    listing.address,
    listing.location,
    listing.source
  );

  return formatRedfinAddress(components);
}
