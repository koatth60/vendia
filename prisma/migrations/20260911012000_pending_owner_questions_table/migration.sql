-- CreateTable
CREATE TABLE "PendingOwnerQuestion" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingOwnerQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingOwnerQuestion_wamid_key" ON "PendingOwnerQuestion"("wamid");

-- CreateIndex
CREATE INDEX "PendingOwnerQuestion_conversationId_idx" ON "PendingOwnerQuestion"("conversationId");

-- AddForeignKey
ALTER TABLE "PendingOwnerQuestion" ADD CONSTRAINT "PendingOwnerQuestion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry forward any live in-flight escalation instead of silently dropping it. The original question
-- text isn't stored anywhere else for these older rows, so it's backfilled with a placeholder - the
-- owner's reply still gets matched and relayed correctly, only the (unused, informational) question
-- column is generic for this one-time migrated batch.
INSERT INTO "PendingOwnerQuestion" ("id", "conversationId", "wamid", "question", "createdAt")
SELECT substr(md5(random()::text || clock_timestamp()::text), 1, 25), "id", "pendingOwnerQuestionMessageId", '(pregunta anterior a la migracion)', "updatedAt"
FROM "Conversation"
WHERE "pendingOwnerQuestionMessageId" IS NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "pendingOwnerQuestionMessageId";
