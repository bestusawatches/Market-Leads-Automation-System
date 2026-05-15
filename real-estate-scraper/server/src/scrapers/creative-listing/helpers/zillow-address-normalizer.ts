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
 */
export function extractZillowAddressComponents(
  address: string | undefined,
  city: string | undefined,
  state: string | undefined,
  zip: string | undefined
): ZillowAddressComponents {
  // Creative listing has clean separate fields
  let street: string | undefined;
  
  // Parse street from address field if it contains more than just city/state/zip
  if (address) {
    // Remove the city, state, zip if they're appended to the address
    street = address
      .replace(new RegExp(`${city}.*`, "i"), "")
      .replace(new RegExp(`${state}.*`, "i"), "")
      .replace(new RegExp(`${zip}.*`, "i"), "")
      .trim();
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
  // Creative listing has address, city, state, zip as separate fields
  const components = extractZillowAddressComponents(
    listing.address,
    listing.city,
    listing.state,
    listing.zip
  );

  return formatZillowAddress(components);
}
