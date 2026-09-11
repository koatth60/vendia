-- CreateEnum
CREATE TYPE "OwnerMessageDirection" AS ENUM ('OUT', 'IN');

-- CreateTable
CREATE TABLE "OwnerMessageLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "direction" "OwnerMessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerMessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerMessageLog_businessId_createdAt_idx" ON "OwnerMessageLog"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "OwnerMessageLog" ADD CONSTRAINT "OwnerMessageLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
