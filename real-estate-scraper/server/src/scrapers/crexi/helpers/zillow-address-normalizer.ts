/**
 * Crexi to Zillow Address Normalizer
 * Zillow format: "Street Address, City, State ZipCode, City, State, ZipCode"
 * 
 * Note: Crexi does not provide address data; location info is extracted from title
 */

interface CrexiListing {
  url?: string;
  source?: string;
  title?: string;
  price?: number;
  propertyType?: string;
  description?: string;
}

interface AddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

/**
 * Extracts address components from Crexi listing data
 * Crexi provides limited location info in title; attempts to parse it
 */
function extractAddressComponents(listing: CrexiListing): AddressComponents {
  const components: AddressComponents = {};

  // Crexi title format: "Description (Location markers or city names)"
  // Example: "Great Investment Turnkey (Dalton, Fuller, E 117th)"
  // We can extract potential city names from parentheses
  if (listing.title) {
    const titleMatch = listing.title.match(/\(([^)]+)\)/);
    if (titleMatch) {
      // Extract potential cities/locations from parentheses
      const locations = titleMatch[1].split(/,/).map((s) => s.trim());
      if (locations.length > 0) {
        components.city = locations[0]; // Use first location as city
      }
    }
  }

  // Crexi does not provide street, state, or zip - these remain undefined
  return components;
}

/**
 * Formats extracted components to Zillow address format
 * Zillow format: "Street Address, City, State ZipCode, City, State, ZipCode"
 */
function formatAddress(components: AddressComponents): string {
  const parts: string[] = [];

  // Street address (not available from Crexi)
  if (components.street) {
    parts.push(components.street);
  }

  // City, State ZipCode
  if (components.city) {
    let cityPart = components.city;
    if (components.state) {
      cityPart += `, ${components.state}`;
      if (components.zipCode) {
        cityPart += ` ${components.zipCode}`;
      }
    }
    parts.push(cityPart);
  }

  // Repeat City, State, ZipCode for Zillow format
  if (components.city) {
    let repeatPart = components.city;
    if (components.state) {
      repeatPart += `, ${components.state}`;
      if (components.zipCode) {
        repeatPart += `, ${components.zipCode}`;
      }
    }
    parts.push(repeatPart);
  }

  return parts.join(", ");
}

/**
 * Normalizes Crexi listing to Zillow address format
 */
export function normalizeToZillowFormat(listing: CrexiListing): string {
  const components = extractAddressComponents(listing);
  return formatAddress(components);
}
