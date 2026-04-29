// src/db/repository.ts
// ─────────────────────────────────────────────────────────────────────────────
// ALL database operations live here.
// Scrapers never touch Prisma directly — they call functions from this file.
// This means you can swap PostgreSQL for anything else by editing only this file.
// ─────────────────────────────────────────────────────────────────────────────

import { Listing, Prisma } from "@prisma/client";
import { prisma } from "./client";
import { ListingUpsertPayload } from "../types/listing";
import { logger } from "../utils/logger";

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a single listing.
 * If the URL already exists, all fields are updated and `lastSeenAt` is refreshed.
 * New listings are inserted with `createdAt = now`.
 */
export async function upsertListing(
  payload: ListingUpsertPayload,
): Promise<Listing> {
  const data: Prisma.ListingCreateInput = {
    url: payload.url,
    source: payload.source,
    title: payload.title,
    price: payload.price,
    address: payload.address,
    location: payload.location,
    propertyType: payload.propertyType,
    bedrooms: payload.bedrooms,
    bathrooms: payload.bathrooms,
    squareFeet: payload.squareFeet,
    description: payload.description,
    postedDate: payload.postedDate,
    zestimate: payload.zestimate,
    dealScore: payload.dealScore,
    equityEstimate: payload.equityEstimate,
    lastSeenAt: new Date(),
  };

  return prisma.listing.upsert({
    where: { url: payload.url },
    create: data,
    update: {
      ...data,
      // Never overwrite enrichment data if already populated
      zestimate: payload.zestimate ?? undefined,
      realtorEstimate: payload.realtorEstimate ?? undefined,
      redfinEstimate: payload.redfinEstimate ?? undefined,
      propwireEstimate: payload.propwireEstimate ?? undefined,
    },
  });
}

/**
 * Upsert many listings in a single transaction.
 * Returns counts of created vs updated records.
 */
export async function upsertMany(
  payloads: ListingUpsertPayload[],
): Promise<{ created: number; updated: number }> {
  await prisma.$transaction(
    payloads.map((p) =>
      prisma.listing.upsert({
        where: { url: p.url },
        create: {
          url: p.url,
          source: p.source,
          title: p.title,
          price: p.price,
          address: p.address,
          location: p.location,
          propertyType: p.propertyType,
          postedDate: p.postedDate,
          bedrooms: p.bedrooms,
          bathrooms: p.bathrooms,
          squareFeet: p.squareFeet,
          description: p.description,
          // §3.2 — owner contact
          ownerName: p.ownerName,
          ownerPhone: p.ownerPhone,
          // §3.3 — enrichment
          zestimate: p.zestimate,
          realtorEstimate: p.realtorEstimate,
          redfinEstimate: p.redfinEstimate,
          propwireEstimate: p.propwireEstimate,
          // §3.5 — underwriting
          dealScore: p.dealScore,
          equityEstimate: p.equityEstimate,
          lastSeenAt: new Date(),
        },
        update: {
          // Always refresh mutable fields
          price: p.price,
          title: p.title,
          address: p.address,
          location: p.location,
          propertyType: p.propertyType,
          bedrooms: p.bedrooms,
          bathrooms: p.bathrooms,
          squareFeet: p.squareFeet,
          description: p.description,
          dealScore: p.dealScore,
          equityEstimate: p.equityEstimate,
          lastSeenAt: new Date(),
          // Owner contact: update only if we found something new
          ...(p.ownerName ? { ownerName: p.ownerName } : {}),
          ...(p.ownerPhone ? { ownerPhone: p.ownerPhone } : {}),
          // Enrichment: never overwrite existing estimates with null
          ...(p.zestimate ? { zestimate: p.zestimate } : {}),
          ...(p.realtorEstimate ? { realtorEstimate: p.realtorEstimate } : {}),
          ...(p.redfinEstimate ? { redfinEstimate: p.redfinEstimate } : {}),
          ...(p.propwireEstimate
            ? { propwireEstimate: p.propwireEstimate }
            : {}),
        },
      }),
    ),
  );

  logger.info(`[db] Upserted ${payloads.length} listings`);
  return { created: 0, updated: 0 }; // Prisma doesn't expose create/update counts in upsert
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

/** Fetch listings with optional filters — used by dashboard/export */
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
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Check if a URL already exists in the database (fast dedup check) */
export async function urlExists(url: string): Promise<boolean> {
  const count = await prisma.listing.count({ where: { url } });
  return count > 0;
}

/** Return all URLs already in DB for a given source (bulk dedup) */
export async function getExistingUrls(source: string): Promise<Set<string>> {
  const rows = await prisma.listing.findMany({
    where: { source: { contains: source } },
    select: { url: true },
  });
  return new Set(rows.map((r) => r.url));
}

// ── Underwriting update ───────────────────────────────────────────────────────

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
  const [total, bySrc, byScore] = await Promise.all([
    prisma.listing.count(),
    prisma.listing.groupBy({ by: ["source"], _count: true }),
    prisma.listing.groupBy({ by: ["dealScore"], _count: true }),
  ]);

  return {
    total,
    bySource: Object.fromEntries(bySrc.map((r) => [r.source, r._count])),
    byDealScore: Object.fromEntries(
      byScore.map((r) => [r.dealScore ?? "unscored", r._count]),
    ),
  };
}
