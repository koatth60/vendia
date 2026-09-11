-- CreateEnum
CREATE TYPE "OrderFulfillmentStatus" AS ENUM ('PENDING', 'SHIPPED', 'CANCELED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "fulfillmentStatus" "OrderFulfillmentStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Order" ADD COLUMN "shippedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "shipmentNote" TEXT;
ALTER TABLE "Order" ADD COLUMN "shipmentMediaS3Key" TEXT;
ALTER TABLE "Order" ADD COLUMN "shipmentMediaType" TEXT;
ALTER TABLE "Order" ADD COLUMN "canceledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Order_businessId_fulfillmentStatus_idx" ON "Order"("businessId", "fulfillmentStatus");
