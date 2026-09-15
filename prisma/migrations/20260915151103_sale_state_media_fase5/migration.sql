-- AlterTable
ALTER TABLE "SaleState" ADD COLUMN     "mediaSent" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "photoIdStreak" INTEGER NOT NULL DEFAULT 0;
