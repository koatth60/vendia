-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "saleStateEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SaleState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "customerName" TEXT,
    "idNumber" TEXT,
    "deliveryPhone" TEXT,
    "address" TEXT,
    "shippingModality" "ShippingPaymentModality",
    "paymentMethodId" TEXT,
    "blockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaleState_conversationId_key" ON "SaleState"("conversationId");

-- AddForeignKey
ALTER TABLE "SaleState" ADD CONSTRAINT "SaleState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
