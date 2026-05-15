/**
 * Normalize Creative Listing addresses to Redfin format
 * 
 * Redfin format: "Street Address, City, State, ZipCode"
 * Example: "286 Alhambra Way, Akron, OH, 44302"
 */

import { RawListing } from "../../../types/listing";

interface RedfinAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Creative Listing data for Redfin format
 */
export function extractRedfinAddressComponents(
  address: string | undefined,
  city: string | undefined,
  state: string | undefined,
  zip: string | undefined
): RedfinAddressComponents {
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
 * Format address in Redfin style
 * Format: "Street, City, State, ZipCode"
 */
export function formatRedfinAddress(components: RedfinAddressComponents): string | undefined {
  const { street, city, state, zip } = components;

  if (!street || !city || !state) {
    return undefined;
  }

  // Build Redfin format with or without zip
  const parts = [street, city, state];
  if (zip) parts.push(zip);

  return parts.join(", ");
}

/**
 * Normalize Creative Listing to Redfin address format
 */
export function normalizeToRedfinFormat(listing: RawListing): string | undefined {
  const components = extractRedfinAddressComponents(
    listing.address,
    listing.city,
    listing.state,
    listing.zip
  );

  return formatRedfinAddress(components);
}
