-- CreateTable
CREATE TABLE "DeliveryFailure" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "errorCode" INTEGER,
    "errorMessage" TEXT NOT NULL,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryFailure_businessId_resolved_idx" ON "DeliveryFailure"("businessId", "resolved");

-- AddForeignKey
ALTER TABLE "DeliveryFailure" ADD CONSTRAINT "DeliveryFailure_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
