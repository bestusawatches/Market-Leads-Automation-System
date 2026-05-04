/**
 * Normalize Investorlift addresses to Redfin format
 * 
 * Redfin format: "Street Address, City, State, ZipCode"
 * Example: "7017 Colgate Ave Front, 7015 Colgate Rear Ave, Cleveland, OH, 44102"
 * 
 * Note: Investorlift provides "City, County, State, Zip" without street address
 */

import { RawListing } from "../../../types/listing";

interface RedfinAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  county?: string;
  zip?: string;
}

/**
 * Extract address components from Investorlift data
 * Investorlift format: "City, County, State, Zip"
 */
export function extractRedfinAddressComponents(
  investorliftAddress: string | undefined
): RedfinAddressComponents {
  if (!investorliftAddress) {
    return {};
  }

  const parts = investorliftAddress.split(",").map((p) => p.trim());

  let city: string | undefined;
  let county: string | undefined;
  let state: string | undefined;
  let zip: string | undefined;

  // Investorlift typical: ["City", "County", "State", "Zip"]
  if (parts.length >= 4) {
    city = parts[0];
    county = parts[1];
    state = parts[2];
    zip = parts[3];
  } else if (parts.length === 3) {
    city = parts[0];
    state = parts[1];
    zip = parts[2];
  }

  return { city, state, county, zip };
}

/**
 * Format address in Redfin style
 * Format: "City, State, ZipCode" (Investorlift lacks street address)
 */
export function formatRedfinAddress(
  components: RedfinAddressComponents
): string | undefined {
  const { city, state, zip } = components;

  if (!city || !state) {
    return undefined;
  }

  // Build Redfin format: "City, State, ZipCode"
  const parts = [city, state];
  if (zip) parts.push(zip);

  return parts.join(", ");
}

/**
 * Normalize Investorlift listing to Redfin address format
 */
export function normalizeToRedfinFormat(listing: RawListing): string | undefined {
  const components = extractRedfinAddressComponents(listing.address);
  return formatRedfinAddress(components);
}
