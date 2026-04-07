import prisma from "./client";
import { Listing } from "../types/listing";

export async function upsertListing(listing: Listing) {
  const where = {
    source_externalId: {
      source: listing.source,
      externalId: listing.externalId,
    },
  } as any;
  // Prisma upsert using the unique compound defined in schema
  return prisma.listing.upsert({
    where: {
      source_externalId: {
        source: listing.source,
        externalId: listing.externalId,
      },
    } as any,
    update: {
      title: listing.title,
      price: listing.price,
      url: listing.url,
      raw: listing.raw,
    },
    create: {
      source: listing.source,
      externalId: listing.externalId,
      title: listing.title,
      price: listing.price,
      url: listing.url,
      raw: listing.raw,
    },
  });
}

export async function findRecent(limit = 50) {
  return prisma.listing.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
