-- CreateEnum
CREATE TYPE "LearnedFaqCandidateStatus" AS ENUM ('PENDING', 'APPROVED', 'DISCARDED');

-- CreateTable
CREATE TABLE "LearnedFaqCandidate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "conversationId" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "status" "LearnedFaqCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnedFaqCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LearnedFaqCandidate_businessId_status_idx" ON "LearnedFaqCandidate"("businessId", "status");

-- AddForeignKey
ALTER TABLE "LearnedFaqCandidate" ADD CONSTRAINT "LearnedFaqCandidate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
