// src/db/repository.ts
// ─────────────────────────────────────────────────────────────────────────────
// ALL database operations live here.
// Scrapers never touch Prisma directly.
// ─────────────────────────────────────────────────────────────────────────────

import { Listing, Prisma } from "@prisma/client";
import { prisma } from "./client";
import { ListingUpsertPayload } from "../types/listing";
import { logger } from "../utils/logger";
import pLimit from "p-limit";

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a single listing to the general Listing table.
 * Raw data only — no estimates or property linking.
 */
export async function upsertListing(
  payload: ListingUpsertPayload,
): Promise<Listing> {
  const listingData: Prisma.ListingCreateInput = {
    url: payload.url,
    source: payload.source,
    title: payload.title,
    price: payload.price,
    rawAddress: payload.address,
    location: payload.location,
    propertyType: payload.propertyType,
    bedrooms: payload.bedrooms,
    bathrooms: payload.bathrooms,
    squareFeet: payload.squareFeet,
    description: payload.description,
    ownerName: payload.ownerName,
    ownerPhone: payload.ownerPhone,
    postedDate: payload.postedDate ?? payload.listedAt,
    lastSeenAt: new Date(),
  };

  return prisma.listing.upsert({
    where: { url: payload.url },
    create: listingData,
    update: {
      title: payload.title,
      price: payload.price,
      rawAddress: payload.address,
      location: payload.location,
      propertyType: payload.propertyType,
      bedrooms: payload.bedrooms,
      bathrooms: payload.bathrooms,
      squareFeet: payload.squareFeet,
      description: payload.description,
      ownerName: payload.ownerName,
      ownerPhone: payload.ownerPhone,
      postedDate: payload.postedDate ?? payload.listedAt,
      lastSeenAt: new Date(),
    },
  });
}

/**
 * Upsert many listings (batch version)
 * Uses transaction for better performance.
 */
export async function upsertMany(
  payloads: ListingUpsertPayload[],
): Promise<{ created: number; updated: number }> {
  if (payloads.length === 0) return { created: 0, updated: 0 };

  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 5;
  const limit = pLimit(concurrency);

  const tasks = payloads.map((p) =>
    limit(() =>
      prisma.listing.upsert({
        where: { url: p.url },
        create: {
          url: p.url,
          source: p.source,
          title: p.title,
          price: p.price,
          rawAddress: p.address,
          location: p.location,
          propertyType: p.propertyType,
          bedrooms: p.bedrooms ?? (p as any).beds,
          bathrooms: p.bathrooms ?? (p as any).baths,
          squareFeet: p.squareFeet,
          description: p.description,
          ownerName: p.ownerName,
          ownerPhone: p.ownerPhone,
          postedDate: p.postedDate ?? (p as any).listedAt,
          lastSeenAt: new Date(),
        },
        update: {
          title: p.title,
          price: p.price,
          rawAddress: p.address,
          location: p.location,
          propertyType: p.propertyType,
          bedrooms: p.bedrooms ?? (p as any).beds,
          bathrooms: p.bathrooms ?? (p as any).baths,
          squareFeet: p.squareFeet,
          description: p.description,
          ownerName: p.ownerName,
          ownerPhone: p.ownerPhone,
          postedDate: p.postedDate ?? (p as any).listedAt,
          lastSeenAt: new Date(),
        },
      })
    )
  );

  await Promise.all(tasks);

  logger.info(`[db] Successfully upserted ${payloads.length} listings (concurrency=${concurrency})`);
  return { created: 0, updated: 0 };
}

// ── Zillow Listings ───────────────────────────────────────────────────────────

export async function upsertZillowListings(
  payloads: Array<ListingUpsertPayload & { zestimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 5;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.zillowListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              zestimate: p.zestimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              zestimate: p.zestimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "zillow",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Zillow listings to both ZillowListing and Listing tables (concurrency=${concurrency})`);
}

// ── Redfin Listings ───────────────────────────────────────────────────────────

export async function upsertRedfinListings(
  payloads: Array<ListingUpsertPayload & { estimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  // Flatten all operations: each payload creates 2 upsert operations (RedfinListing + Listing)
  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 5;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.redfinListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "redfin",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Redfin listings to both RedfinListing and Listing tables (concurrency=${concurrency})`);
}

// ── Realtor Listings ──────────────────────────────────────────────────────────

export async function upsertRealtorListings(
  payloads: Array<ListingUpsertPayload & { estimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  // Flatten all operations: each payload creates 2 upsert operations (RealtorListing + Listing)
  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 5;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.realtorListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "realtor",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Realtor listings to both RealtorListing and Listing tables (concurrency=${concurrency})`);
}

// ── Propwire Listings ─────────────────────────────────────────────────────────

export async function upsertPropwireListings(
  payloads: Array<ListingUpsertPayload & { estimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  // Flatten all operations: each payload creates 2 upsert operations (PropwireListing + Listing)
  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 5;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.propwireListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "propwire",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Propwire listings to both PropwireListing and Listing tables (concurrency=${concurrency})`);
}

// ── Read ──────────────────────────────────────────────────────────────────────

export interface ListingFilters {
  source?: string;
  minPrice?: number;
  maxPrice?: number;
  location?: string;
  dealScore?: string;
  propertyType?: string;
}

export async function getListings(
  filters: ListingFilters = {},
  limit = 500,
): Promise<Listing[]> {
  const where: Prisma.ListingWhereInput = {};

  if (filters.source) where.source = { contains: filters.source };
  if (filters.location)
    where.location = { contains: filters.location, mode: "insensitive" };
  if (filters.dealScore) where.dealScore = filters.dealScore;
  if (filters.propertyType) where.propertyType = filters.propertyType;

  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    where.price = {};
    if (filters.minPrice !== undefined) where.price.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) where.price.lte = filters.maxPrice;
  }

  return prisma.listing.findMany({
    where,
    include: {
      property: true,
      // estimates: true,   // uncomment if you want estimates included
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function urlExists(url: string): Promise<boolean> {
  const count = await prisma.listing.count({ where: { url } });
  return count > 0;
}

export async function getExistingUrls(source: string): Promise<Set<string>> {
  const rows = await prisma.listing.findMany({
    where: { source },
    select: { url: true },
  });
  return new Set(rows.map((r) => r.url));
}

/**
 * Get all properties with related listings and estimates
 * @param limit - maximum number of properties to return
 */
export async function getAllPropertiesWithListings(limit = 1000) {
  return prisma.property.findMany({
    select: {
      id: true,
      normalizedAddress: true,
      address: true,
      url: true,
      city: true,
      state: true,
      zip: true,
      latitude: true,
      longitude: true,
      createdAt: true,
      updatedAt: true,
      listings: {
        select: {
          id: true,
          url: true,
          source: true,
          title: true,
          price: true,
          rawAddress: true,
          location: true,
          propertyType: true,
          bedrooms: true,
          bathrooms: true,
          squareFeet: true,
          description: true,
          dealScore: true,
          equityEstimate: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      estimates: {
        select: {
          id: true,
          source: true,
          value: true,
          fetchedAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Get all listings with optional related property data
 * @param limit - maximum number of listings to return
 */
export async function getAllListings(limit = 1000) {
  // Exclude listings originating from source-specific tables
  // (we want only canonical/general listings, not source-specific lists)
  const excludedSources = ["propwire", "zillow", "redfin", "realtor"];

  return prisma.listing.findMany({
    where: {
      NOT: {
        source: { in: excludedSources },
      },
    },
    include: {
      property: {
        select: {
          id: true,
          normalizedAddress: true,
          address: true,
          city: true,
          state: true,
          zip: true,
          latitude: true,
          longitude: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ── Filters (Singleton Pattern) ───────────────────────────────────────────
// Only one filter record exists in the database

export interface SavedFilterInput {
  name: string;
  description?: string;
  source: string;
  minPrice?: number;
  maxPrice?: number;
  propertyTypes?: string[];
  locations?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  postedAfter?: Date;
  postedBefore?: Date;
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

/**
 * Upsert single filter record (create if not exists, update if exists)
 * Since only one filter record should exist, this handles both create and update
 */
export async function upsertFilter(data: SavedFilterInput) {
  // Get existing filter (should be only one)
  const existingFilter = await prisma.savedFilter.findFirst();

  if (existingFilter) {
    // Update existing filter
    return prisma.savedFilter.update({
      where: { id: existingFilter.id },
      data: {
        name: data.name,
        description: data.description,
        source: data.source,
        minPrice: data.minPrice,
        maxPrice: data.maxPrice,
        propertyTypes: data.propertyTypes || [],
        locations: data.locations || [],
        keywords: data.keywords || [],
        excludeKeywords: data.excludeKeywords || [],
        postedAfter: data.postedAfter,
        postedBefore: data.postedBefore,
        minBedrooms: data.minBedrooms,
        maxBedrooms: data.maxBedrooms,
        minBathrooms: data.minBathrooms,
        maxBathrooms: data.maxBathrooms,
        minSquareFeet: data.minSquareFeet,
        maxSquareFeet: data.maxSquareFeet,
        minEquity: data.minEquity,
        minArv: data.minArv,
        isActive: data.isActive !== undefined ? data.isActive : true,
      },
    });
  } else {
    // Create new filter
    return prisma.savedFilter.create({
      data: {
        name: data.name,
        description: data.description,
        source: data.source,
        minPrice: data.minPrice,
        maxPrice: data.maxPrice,
        propertyTypes: data.propertyTypes || [],
        locations: data.locations || [],
        keywords: data.keywords || [],
        excludeKeywords: data.excludeKeywords || [],
        postedAfter: data.postedAfter,
        postedBefore: data.postedBefore,
        minBedrooms: data.minBedrooms,
        maxBedrooms: data.maxBedrooms,
        minBathrooms: data.minBathrooms,
        maxBathrooms: data.maxBathrooms,
        minSquareFeet: data.minSquareFeet,
        maxSquareFeet: data.maxSquareFeet,
        minEquity: data.minEquity,
        minArv: data.minArv,
        isActive: data.isActive !== undefined ? data.isActive : true,
      },
    });
  }
}

/**
 * Get the single filter record (or null if none exists)
 */
export async function getFilter() {
  return prisma.savedFilter.findFirst();
}

// ── Read Source-Specific Listings ──────────────────────────────────────────

export async function getZillowListings(limit = 1000): Promise<any[]> {
  return (prisma.zillowListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getRedfinListings(limit = 1000): Promise<any[]> {
  return (prisma.redfinListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getRealtorListings(limit = 1000): Promise<any[]> {
  return (prisma.realtorListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getPropwireListings(limit = 1000): Promise<any[]> {
  return (prisma.propwireListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ── Underwriting ─────────────────────────────────────────────────────────────

export async function updateDealScore(
  url: string,
  dealScore: string,
  equityEstimate?: number,
): Promise<void> {
  await prisma.listing.update({
    where: { url },
    data: { dealScore, equityEstimate },
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function getSummaryStats(): Promise<{
  total: number;
  bySource: Record<string, number>;
  byDealScore: Record<string, number>;
}> {
  const total = await prisma.listing.count();
  const bySrc = await prisma.listing.groupBy({ by: ["source"], _count: true });
  const byScore = await prisma.listing.groupBy({ by: ["dealScore"], _count: true });

  return {
    total,
    bySource: Object.fromEntries(bySrc.map((r) => [r.source, r._count])),
    byDealScore: Object.fromEntries(
      byScore.map((r) => [r.dealScore ?? "unscored", r._count])
    ),
  };
}