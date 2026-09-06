-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('BASICO', 'EMPRENDEDOR', 'NEGOCIO');

-- AlterTable: add new columns as nullable first
ALTER TABLE "Business" ADD COLUMN "email" TEXT;
ALTER TABLE "Business" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "Business" ADD COLUMN "planTier" "PlanTier" NOT NULL DEFAULT 'BASICO';
ALTER TABLE "Business" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Business" ADD COLUMN "whatsappPhoneNumberId" TEXT;
ALTER TABLE "Business" ADD COLUMN "whatsappAccessToken" TEXT;

-- Backfill existing rows with placeholder credentials (to be reset via script)
UPDATE "Business" SET
  "email" = 'pendiente-' || "id" || '@vendiahub.online',
  "passwordHash" = '__PENDING__'
WHERE "email" IS NULL;

-- Now enforce NOT NULL + UNIQUE
ALTER TABLE "Business" ALTER COLUMN "email" SET NOT NULL;
ALTER TABLE "Business" ALTER COLUMN "passwordHash" SET NOT NULL;
CREATE UNIQUE INDEX "Business_email_key" ON "Business"("email");
CREATE UNIQUE INDEX "Business_whatsappPhoneNumberId_key" ON "Business"("whatsappPhoneNumberId");

-- CreateTable
CREATE TABLE "ActivationKey" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "planTier" "PlanTier" NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedByBusinessId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "ActivationKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivationKey_code_key" ON "ActivationKey"("code");
CREATE UNIQUE INDEX "ActivationKey_usedByBusinessId_key" ON "ActivationKey"("usedByBusinessId");
