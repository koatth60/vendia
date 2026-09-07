-- AlterTable
ALTER TABLE "Business" ADD COLUMN "contactName" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationMessageId" TEXT,
ADD COLUMN "pendingOrderSummary" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_pendingConfirmationMessageId_key" ON "Conversation"("pendingConfirmationMessageId");
