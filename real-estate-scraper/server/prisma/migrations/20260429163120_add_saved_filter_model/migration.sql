-- CreateTable
CREATE TABLE "SavedFilter" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "minPrice" INTEGER,
    "maxPrice" INTEGER,
    "propertyTypes" TEXT[],
    "locations" TEXT[],
    "keywords" TEXT[],
    "excludeKeywords" TEXT[],
    "postedAfter" TIMESTAMP(3),
    "postedBefore" TIMESTAMP(3),
    "minBedrooms" INTEGER,
    "maxBedrooms" INTEGER,
    "minBathrooms" DOUBLE PRECISION,
    "maxBathrooms" DOUBLE PRECISION,
    "minSquareFeet" INTEGER,
    "maxSquareFeet" INTEGER,
    "minEquity" INTEGER,
    "minArv" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedFilter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedFilter_source_idx" ON "SavedFilter"("source");

-- CreateIndex
CREATE INDEX "SavedFilter_isActive_idx" ON "SavedFilter"("isActive");
