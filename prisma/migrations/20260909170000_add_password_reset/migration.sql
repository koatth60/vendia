-- AlterTable
ALTER TABLE "Business" ADD COLUMN "passwordResetCode" TEXT,
ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);
