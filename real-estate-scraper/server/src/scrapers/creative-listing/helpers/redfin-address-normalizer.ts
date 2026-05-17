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
 * Creative Listing stores full address as concatenated string: "Street, City, State ZipCode"
 */
export function extractRedfinAddressComponents(
  fullAddress: string | undefined
): RedfinAddressComponents {
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
  // Creative listing stores full address as concatenated string
  const components = extractRedfinAddressComponents(listing.address);

  return formatRedfinAddress(components);
}
