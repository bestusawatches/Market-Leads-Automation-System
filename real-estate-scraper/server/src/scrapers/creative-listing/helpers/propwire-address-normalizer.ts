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
 * Creative Listing stores full address as concatenated string: "Street, City, State ZipCode"
 */
export function extractPropwireAddressComponents(
  fullAddress: string | undefined
): PropwireAddressComponents {
  if (!fullAddress) return {};

  // Parse address in format: "Street, City, State ZipCode"
  // Example: "286 Alhambra Way, Akron, OH 44302"
  const parts = fullAddress.split(",").map(p => p.trim());

  let street: string | undefined;
  let city: string | undefined;
  let state: string | undefined;
  let zip: string | undefined;

  if (parts.length >= 1) {
    street = parts[0];
  }

  if (parts.length >= 2) {
    city = parts[1];
  }

  if (parts.length >= 3) {
    // Last part is "State ZipCode"
    const stateZip = parts[2].trim();
    const stateZipParts = stateZip.split(/\s+/);
    if (stateZipParts.length >= 1) {
      state = stateZipParts[0];
    }
    if (stateZipParts.length >= 2) {
      zip = stateZipParts[1];
    }
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
  // Creative listing stores full address as concatenated string
  const components = extractPropwireAddressComponents(listing.address);

  return formatPropwireAddress(components);
}
