/**
 * Crexi to Redfin Address Normalizer
 * Redfin format: "Street Address, City, State, ZipCode"
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
 * Formats extracted components to Redfin address format
 * Redfin format: "Street Address, City, State, ZipCode"
 */
function formatAddress(components: AddressComponents): string {
  const parts: string[] = [];

  // Street address (not available from Crexi)
  if (components.street) {
    parts.push(components.street);
  }

  // City
  if (components.city) {
    parts.push(components.city);
  }

  // State
  if (components.state) {
    parts.push(components.state);
  }

  // ZipCode
  if (components.zipCode) {
    parts.push(components.zipCode);
  }

  return parts.join(", ");
}

/**
 * Normalizes Crexi listing to Redfin address format
 */
export function normalizeToRedfnFormat(listing: CrexiListing): string {
  const components = extractAddressComponents(listing);
  return formatAddress(components);
}
