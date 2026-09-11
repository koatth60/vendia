-- CreateEnum
CREATE TYPE "PendingOwnerQuestionKind" AS ENUM ('TEXT', 'PHOTO_PRODUCT');

-- AlterTable
ALTER TABLE "PendingOwnerQuestion" ADD COLUMN     "kind" "PendingOwnerQuestionKind" NOT NULL DEFAULT 'TEXT';
