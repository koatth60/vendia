-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'READ');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "whatsappConnectionBrokenAt" TIMESTAMP(3),
ADD COLUMN     "whatsappTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "whatsappTokenExpiryNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "deliveryStatus" "MessageDeliveryStatus",
ADD COLUMN     "deliveryStatusAt" TIMESTAMP(3);
