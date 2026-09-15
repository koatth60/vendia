-- AlterTable
ALTER TABLE "QueuedOutboundMessage" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "QueuedOutboundMessage_sentAt_nextAttemptAt_idx" ON "QueuedOutboundMessage"("sentAt", "nextAttemptAt");
