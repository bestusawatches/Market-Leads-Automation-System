/*
  Warnings:

  - You are about to drop the column `address` on the `Listing` table. All the data in the column will be lost.
  - You are about to drop the column `propwireEstimate` on the `Listing` table. All the data in the column will be lost.
  - You are about to drop the column `realtorEstimate` on the `Listing` table. All the data in the column will be lost.
  - You are about to drop the column `redfinEstimate` on the `Listing` table. All the data in the column will be lost.
  - You are about to drop the column `zestimate` on the `Listing` table. All the data in the column will be lost.
  - Added the required column `propertyId` to the `Listing` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "address",
DROP COLUMN "propwireEstimate",
DROP COLUMN "realtorEstimate",
DROP COLUMN "redfinEstimate",
DROP COLUMN "zestimate",
ADD COLUMN     "propertyId" TEXT NOT NULL,
ADD COLUMN     "rawAddress" TEXT;

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "normalizedAddress" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Property_normalizedAddress_key" ON "Property"("normalizedAddress");

-- CreateIndex
CREATE INDEX "Property_city_state_idx" ON "Property"("city", "state");

-- CreateIndex
CREATE INDEX "Estimate_source_idx" ON "Estimate"("source");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_propertyId_source_key" ON "Estimate"("propertyId", "source");

-- CreateIndex
CREATE INDEX "Listing_propertyId_idx" ON "Listing"("propertyId");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
