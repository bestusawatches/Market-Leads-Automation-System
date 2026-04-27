/*
  Warnings:

  - You are about to drop the column `zpid` on the `Listing` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "zpid";

-- CreateIndex
CREATE INDEX "Listing_propertyType_idx" ON "Listing"("propertyType");

-- CreateIndex
CREATE INDEX "Listing_ownerPhone_idx" ON "Listing"("ownerPhone");
