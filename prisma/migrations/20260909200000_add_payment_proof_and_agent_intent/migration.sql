-- AlterTable
ALTER TABLE "Business" ADD COLUMN "requirePaymentProof" BOOLEAN NOT NULL DEFAULT true;

-- AlterEnum
ALTER TYPE "ConversationIntent" ADD VALUE 'SOLICITA_AGENTE';
