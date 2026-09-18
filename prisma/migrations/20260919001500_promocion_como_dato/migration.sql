-- E37: una promocion es un dato del negocio, no una frase en customInstructions.
CREATE TYPE "PromotionKind" AS ENUM ('PERCENT', 'AMOUNT');
CREATE TYPE "PromotionScope" AS ENUM ('GLOBAL', 'CATEGORY', 'PRODUCT');

CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "scope" "PromotionScope" NOT NULL,
    "categoryNormalized" TEXT,
    "categoryLabel" TEXT,
    "productId" TEXT,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Promotion_businessId_active_idx" ON "Promotion"("businessId", "active");
CREATE INDEX "Promotion_productId_idx" ON "Promotion"("productId");

ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
