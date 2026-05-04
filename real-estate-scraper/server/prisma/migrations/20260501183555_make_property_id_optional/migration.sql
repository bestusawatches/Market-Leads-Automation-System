-- DropForeignKey
ALTER TABLE "Listing" DROP CONSTRAINT "Listing_propertyId_fkey";

-- AlterTable
ALTER TABLE "Listing" ALTER COLUMN "propertyId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;
