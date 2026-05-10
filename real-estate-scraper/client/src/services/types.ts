export interface ApiResponse<Data> {
  status: "ok" | "error";
  data: Data;
  message?: string;
}

export interface FilterCriteria {
  name: string;
  description?: string;
  source: string;
  minPrice?: number;
  maxPrice?: number;
  propertyTypes?: string[];
  locations?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  postedAfter?: string | null;
  postedBefore?: string | null;
  minBedrooms?: number;
  maxBedrooms?: number;
  minBathrooms?: number;
  maxBathrooms?: number;
  minSquareFeet?: number;
  maxSquareFeet?: number;
  minEquity?: number;
  minArv?: number;
  isActive?: boolean;
}

export interface SavedFilter extends FilterCriteria {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListingProperty {
  id: string;
  normalizedAddress?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
}

export interface Listing {
  id: string;
  url: string;
  source: string;
  title?: string;
  price?: number;
  rawAddress?: string;
  location?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  description?: string;
  dealScore?: string;
  equityEstimate?: number;
  createdAt: string;
  updatedAt: string;
  property?: ListingProperty | null;
}

export interface PropertyListing {
  id: string;
  url: string;
  source: string;
  title?: string;
  price?: number;
  rawAddress?: string;
  location?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  description?: string;
  dealScore?: string;
  equityEstimate?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyEstimate {
  id: string;
  source: string;
  value: number;
  fetchedAt: string;
}

export interface Property {
  id: string;
  normalizedAddress?: string;
  address?: string;
  url?: string;
  city?: string;
  state?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  listings: PropertyListing[];
  estimates: PropertyEstimate[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ListingsPayload {
  count: number;
  listings: Listing[];
}

export interface PropertiesPayload {
  count: number;
  properties: Property[];
}

export const AVAILABLE_SOURCES = [
  { label: "All Sources", value: "all" },
  { label: "Facebook Marketplace", value: "facebook_marketplace" },
  { label: "Facebook", value: "facebook" },
  { label: "Offmarket", value: "offmarket" },
  { label: "InvestorLift", value: "investorlift" },
  { label: "Crexi", value: "crexi" },
  { label: "LoopNet", value: "loopnet" },
  { label: "Craigslist - Milwaukee", value: "craigslist_milwaukee" },
  { label: "Craigslist - Columbus", value: "craigslist_columbus" },
  { label: "Craigslist - Cleveland", value: "craigslist_cleveland" },
  { label: "Craigslist - Toledo", value: "craigslist_toledo" },
  { label: "Zillow", value: "zillow" },
  { label: "Realtor.com", value: "realtor" },
  { label: "Redfin", value: "redfin" },
  { label: "Propwire", value: "propwire" },
] as const;

export type SourceValue = typeof AVAILABLE_SOURCES[number]["value"];

export interface ScraperTriggerResponse {
  status: "ok" | "error";
  message: string;
  data?: {
    sources: string[];
    scrapingStartedAt: string;
  };
}

export interface UseScrapeReturn {
  triggering: boolean;
  error: Error | null;
  success: boolean;
  lastTriggeredAt: string | null;
  trigger: (source: string) => Promise<void>;
  reset: () => void;
}

// Source-specific listing types
export interface ZillowListing {
  id: string;
  url: string;
  title?: string;
  price?: number;
  address?: string;
  location?: string;
  propertyType?: string;
  postedDate?: string;
  description?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  zestimate?: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface RedfinListing {
  id: string;
  url: string;
  title?: string;
  price?: number;
  address?: string;
  location?: string;
  propertyType?: string;
  postedDate?: string;
  description?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  estimate?: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface RealtorListing {
  id: string;
  url: string;
  title?: string;
  price?: number;
  address?: string;
  location?: string;
  propertyType?: string;
  postedDate?: string;
  description?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  estimate?: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface PropwireListing {
  id: string;
  url: string;
  title?: string;
  price?: number;
  address?: string;
  location?: string;
  propertyType?: string;
  postedDate?: string;
  description?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  estimate?: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export type SourceListing = ZillowListing | RedfinListing | RealtorListing | PropwireListing;

export interface SourceListingsPayload {
  count: number;
  listings: SourceListing[];
}

export interface SourceListingsResponse {
  status: "ok" | "error";
  data: SourceListingsPayload;
  message?: string;
}
