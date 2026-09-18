-- E35: el pedido sabe donde esta (transportadora, guia, entrega estimada) y si esta pagado.
CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'REFUNDED');

ALTER TABLE "Order" ADD COLUMN "carrier" TEXT;
ALTER TABLE "Order" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "estimatedDelivery" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID';
ALTER TABLE "Order" ADD COLUMN "paymentReference" TEXT;
ALTER TABLE "Order" ADD COLUMN "taxAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN "discountAmount" DECIMAL(12,2);
