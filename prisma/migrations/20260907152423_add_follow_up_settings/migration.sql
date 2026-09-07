-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "followUpDelayHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "followUpTemplateLanguage" TEXT NOT NULL DEFAULT 'es',
ADD COLUMN     "followUpTemplateName" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "followUpSentAt" TIMESTAMP(3);
