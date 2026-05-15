/**
 * Normalize Creative Listing addresses to Propwire format
 * 
 * Propwire format: "Street Address, City, State, ZipCode"
 * Example: "286 Alhambra Way, Akron, OH, 44302"
 */

import { RawListing } from "../../../types/listing";

interface PropwireAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Creative Listing data for Propwire format
 */
export function extractPropwireAddressComponents(
  address: string | undefined,
  city: string | undefined,
  state: string | undefined,
  zip: string | undefined
): PropwireAddressComponents {
  // Parse street from address field
  let street: string | undefined;
  
  if (address) {
    // Remove city, state, zip if appended
    street = address
      .replace(new RegExp(`${city}.*`, "i"), "")
      .replace(new RegExp(`${state}.*`, "i"), "")
      .replace(new RegExp(`${zip}.*`, "i"), "")
      .trim();
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
 * Normalize Creative Listing to Propwire address format
 */
export function normalizeToPropwireFormat(listing: RawListing): string | undefined {
  const components = extractPropwireAddressComponents(
    listing.address,
    listing.city,
    listing.state,
    listing.zip
  );

  return formatPropwireAddress(components);
}
