/**
 * Normalize LoopNet addresses to Redfin format
 *
 * Redfin format: "Street, City, State, ZipCode"
 */

import { RawListing } from "../../../types/listing";

interface RedfinAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

function extractRedfinAddressComponents(
  loopnetAddress: string | undefined,
  loopnetLocation: string | undefined,
  sourceName: string
): RedfinAddressComponents {
  let street = loopnetAddress?.replace(/\s+near\s+.+$/i, "").trim();

  let city: string | undefined;
  if (loopnetLocation) {
    const m = loopnetLocation.match(/^([A-Za-z\s\.]+),?\s*([A-Z]{2})?/);
    if (m) city = m[1].trim();
  }
  if (!city) {
    const match = sourceName.match(/loopnet[_-]?(.*)/i);
    if (match && match[1]) city = match[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  let state: string | undefined;
  if (loopnetLocation) {
    const m = loopnetLocation.match(/,\s*([A-Z]{2})$/);
    if (m) state = m[1];
  }

  let zip: string | undefined;
  if (loopnetAddress) {
    const z = loopnetAddress.match(/(\d{5})/);
    if (z) zip = z[1];
  }

  return { street, city, state, zip };
}

function formatRedfinAddress(components: RedfinAddressComponents): string | undefined {
  const { street, city, state, zip } = components;
  if (!street || !city || !state) return undefined;
  const parts = [street, city, state];
  if (zip) parts.push(zip);
  return parts.join(", ");
}

export function normalizeToRedfinFormat(listing: RawListing): string | undefined {
  const components = extractRedfinAddressComponents(listing.address, listing.location, listing.source);
  return formatRedfinAddress(components);
}
