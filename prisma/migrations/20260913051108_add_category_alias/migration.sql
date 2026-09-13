-- CreateTable
CREATE TABLE "CategoryAlias" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "synonym" TEXT NOT NULL,
    "normalizedSynonym" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategoryAlias_businessId_idx" ON "CategoryAlias"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryAlias_businessId_normalizedSynonym_key" ON "CategoryAlias"("businessId", "normalizedSynonym");

-- AddForeignKey
ALTER TABLE "CategoryAlias" ADD CONSTRAINT "CategoryAlias_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
