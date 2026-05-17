/**
 * Normalize Creative Listing addresses to Zillow format
 * 
 * Zillow format: "Street Address, City, State ZipCode, City, State, ZipCode"
 * Example: "286 Alhambra Way, Akron, OH 44302, Akron, OH, 44302"
 */

import { RawListing } from "../../../types/listing";

interface ZillowAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Creative Listing data
 * Creative Listing stores full address as concatenated string: "Street, City, State ZipCode"
 */
export function extractZillowAddressComponents(
  fullAddress: string | undefined
): ZillowAddressComponents {
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
 * Normalize Creative Listing to Zillow address format
 */
export function normalizeToZillowFormat(listing: RawListing): string | undefined {
  // Creative listing stores full address as concatenated string
  const components = extractZillowAddressComponents(listing.address);

  return formatZillowAddress(components);
}
