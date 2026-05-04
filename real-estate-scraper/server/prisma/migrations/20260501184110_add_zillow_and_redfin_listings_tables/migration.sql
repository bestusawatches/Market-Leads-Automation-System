-- CreateTable
CREATE TABLE "ZillowListing" (
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
    "zestimate" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZillowListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedfinListing" (
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

    CONSTRAINT "RedfinListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZillowListing_url_key" ON "ZillowListing"("url");

-- CreateIndex
CREATE INDEX "ZillowListing_price_idx" ON "ZillowListing"("price");

-- CreateIndex
CREATE INDEX "ZillowListing_location_idx" ON "ZillowListing"("location");

-- CreateIndex
CREATE UNIQUE INDEX "RedfinListing_url_key" ON "RedfinListing"("url");

-- CreateIndex
CREATE INDEX "RedfinListing_price_idx" ON "RedfinListing"("price");

-- CreateIndex
CREATE INDEX "RedfinListing_location_idx" ON "RedfinListing"("location");
