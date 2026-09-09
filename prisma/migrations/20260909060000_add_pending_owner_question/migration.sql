-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "pendingOwnerQuestionMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_pendingOwnerQuestionMessageId_key" ON "Conversation"("pendingOwnerQuestionMessageId");
