-- CreateTable
CREATE TABLE "RealtorListing" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "price" INTEGER,
    "address" TEXT,
    "location" TEXT,
    "propertyType" TEXT,
    "postedDate" TIMESTAMP(3),
    "description" TEXT,
    "bedrooms" INTEGER,
    "bathrooms" DOUBLE PRECISION,
    "squareFeet" INTEGER,
    "estimate" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtorListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropwireListing" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "price" INTEGER,
    "address" TEXT,
    "location" TEXT,
    "propertyType" TEXT,
    "postedDate" TIMESTAMP(3),
    "description" TEXT,
    "bedrooms" INTEGER,
    "bathrooms" DOUBLE PRECISION,
    "squareFeet" INTEGER,
    "estimate" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropwireListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RealtorListing_url_key" ON "RealtorListing"("url");

-- CreateIndex
CREATE INDEX "RealtorListing_price_idx" ON "RealtorListing"("price");

-- CreateIndex
CREATE INDEX "RealtorListing_location_idx" ON "RealtorListing"("location");

-- CreateIndex
CREATE UNIQUE INDEX "PropwireListing_url_key" ON "PropwireListing"("url");

-- CreateIndex
CREATE INDEX "PropwireListing_price_idx" ON "PropwireListing"("price");

-- CreateIndex
CREATE INDEX "PropwireListing_location_idx" ON "PropwireListing"("location");
