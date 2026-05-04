/**
 * Normalize Investorlift addresses to Propwire format
 * 
 * Propwire format: "Street Address, City, State, ZipCode"
 * Example: "367 Effington Ln, Columbus, OH, 43207"
 * 
 * Note: Investorlift doesn't include street addresses, so we format with available data
 */

import { RawListing } from "../../../types/listing";

interface PropwireAddressComponents {
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
export function extractPropwireAddressComponents(
  investorliftAddress: string | undefined
): PropwireAddressComponents {
  if (!investorliftAddress) {
    return {};
  }

  const parts = investorliftAddress.split(",").map((p) => p.trim());

  let city: string | undefined;
  let county: string | undefined;
  let state: string | undefined;
  let zip: string | undefined;

  // Typical format: ["City", "County", "State", "Zip"]
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
 * Format address in Propwire style
 * Format: "City, State, ZipCode" (no street available from Investorlift)
 */
export function formatPropwireAddress(
  components: PropwireAddressComponents
): string | undefined {
  const { city, state, zip } = components;

  if (!city || !state) {
    return undefined;
  }

  // Build format: "City, State, ZipCode"
  const parts = [city, state];
  if (zip) parts.push(zip);

  return parts.join(", ");
}

/**
 * Normalize Investorlift listing to Propwire address format
 */
export function normalizeToPropwireFormat(listing: RawListing): string | undefined {
  const components = extractPropwireAddressComponents(listing.address);
  return formatPropwireAddress(components);
}
