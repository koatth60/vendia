-- CreateEnum
CREATE TYPE "ConversationIntent" AS ENUM ('PQR', 'DEVOLUCION', 'NO_RECIBIDO');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "intent" "ConversationIntent";
