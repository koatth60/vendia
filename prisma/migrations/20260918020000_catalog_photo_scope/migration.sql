-- Vitrina de categoria (2026-09-17).
CREATE TYPE "CatalogPhotoScope" AS ENUM ('PRODUCT', 'CATEGORY', 'CATALOG');

ALTER TABLE "Business" ADD COLUMN "catalogPhotoScope" "CatalogPhotoScope" NOT NULL DEFAULT 'PRODUCT';

ALTER TABLE "Conversation" ADD COLUMN "browsePhotoProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
