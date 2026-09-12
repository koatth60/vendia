-- CreateTable
CREATE TABLE "ShippingCityRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "normalizedCity" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingCityRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShippingCityRule_businessId_idx" ON "ShippingCityRule"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingCityRule_businessId_normalizedCity_key" ON "ShippingCityRule"("businessId", "normalizedCity");

-- AddForeignKey
ALTER TABLE "ShippingCityRule" ADD CONSTRAINT "ShippingCityRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
