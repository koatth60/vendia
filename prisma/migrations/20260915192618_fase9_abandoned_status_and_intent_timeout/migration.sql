-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentIncidentKind" ADD VALUE 'CONVERSATION_ABANDONED';
ALTER TYPE "AgentIncidentKind" ADD VALUE 'INTENT_ESCALATION_TIMEOUT';

-- AlterEnum
ALTER TYPE "ConversationStatus" ADD VALUE 'ABANDONED';

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "abandonedAfterHours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "cartRecoveryTemplateLanguage" TEXT NOT NULL DEFAULT 'es',
ADD COLUMN     "cartRecoveryTemplateName" TEXT,
ADD COLUMN     "intentEscalationTimeoutHours" INTEGER NOT NULL DEFAULT 48;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "cartRecoverySentAt" TIMESTAMP(3),
ADD COLUMN     "intentExplicit" BOOLEAN;
