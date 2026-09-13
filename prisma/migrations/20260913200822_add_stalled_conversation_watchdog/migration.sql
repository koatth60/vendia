-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "humanControlSince" TIMESTAMP(3),
ADD COLUMN     "stalledReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "stalledReminderStage" INTEGER NOT NULL DEFAULT 0;
