/**
 * Normalize Craigslist addresses to Propwire format
 * 
 * Propwire format: "Street Address, City, State, ZipCode"
 * Example: "367 Effington Ln, Columbus, OH, 43207"
 */

import { RawListing } from "../../../types/listing";

interface PropwireAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Craigslist data for Propwire format
 */
export function extractPropwireAddressComponents(
  craigslistAddress: string | undefined,
  craigslistLocation: string | undefined,
  sourceName: string
): PropwireAddressComponents {
  // Clean street address by removing location descriptors
  let street = craigslistAddress
    ?.replace(/\s+near\s+.+$/i, "")
    ?.replace(/\s+on\s+[a-z]+\s+(side|floor|level)$/i, "")
    ?.replace(/\s+at\s+.+$/i, "")
    .trim();

  // Extract city from location or derive from source
  let city = craigslistLocation?.trim();
  if (!city) {
    const match = sourceName.match(/craigslist_(\w+)/);
    if (match) {
      city = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
  }

  // Map city to state code
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
  };
  state = cityStateMap[cityLower || ""];

  // Extract zip code if present
  let zip: string | undefined;
  if (craigslistAddress) {
    const zipMatch = craigslistAddress.match(/(\d{5})/);
    if (zipMatch) zip = zipMatch[1];
  }

  return { street, city, state, zip };
}

/**
 * Format address in Propwire style
 * Format: "Street, City, State, ZipCode"
 */
export function formatPropwireAddress(components: PropwireAddressComponents): string | undefined {
  const { street, city, state, zip } = components;

  if (!street || !city || !state) {
    return undefined;
  }

  // Build Propwire format with or without zip
  const parts = [street, city, state];
  if (zip) parts.push(zip);

  return parts.join(", ");
}

/**
 * Normalize Craigslist listing to Propwire address format
 */
export function normalizeToPropwireFormat(listing: RawListing): string | undefined {
  const components = extractPropwireAddressComponents(
    listing.address,
    listing.location,
    listing.source
  );

  return formatPropwireAddress(components);
}
