-- AlterTable
ALTER TABLE "Message" ADD COLUMN "whatsappMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_whatsappMessageId_key" ON "Message"("whatsappMessageId");
