/*
  Warnings:

  - You are about to drop the column `description` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `excludeKeywords` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `locations` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `maxBathrooms` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `maxBedrooms` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `maxSquareFeet` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `minArv` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `minBathrooms` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `minBedrooms` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `minEquity` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `minSquareFeet` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `postedAfter` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `postedBefore` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `propertyTypes` on the `SavedFilter` table. All the data in the column will be lost.
  - You are about to drop the column `source` on the `SavedFilter` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "SavedFilter_isActive_idx";

-- DropIndex
DROP INDEX "SavedFilter_source_idx";

-- AlterTable
ALTER TABLE "SavedFilter" DROP COLUMN "description",
DROP COLUMN "excludeKeywords",
DROP COLUMN "isActive",
DROP COLUMN "locations",
DROP COLUMN "maxBathrooms",
DROP COLUMN "maxBedrooms",
DROP COLUMN "maxSquareFeet",
DROP COLUMN "minArv",
DROP COLUMN "minBathrooms",
DROP COLUMN "minBedrooms",
DROP COLUMN "minEquity",
DROP COLUMN "minSquareFeet",
DROP COLUMN "name",
DROP COLUMN "postedAfter",
DROP COLUMN "postedBefore",
DROP COLUMN "propertyTypes",
DROP COLUMN "source",
ADD COLUMN     "allowedLocations" TEXT[],
ADD COLUMN     "allowedPropertyTypes" TEXT[],
ADD COLUMN     "propertyTypeTokens" TEXT[];
