-- E31: estados reales del pedido y su historia.
--
-- Aditiva de punta a punta, y escrita a mano por la deriva de esquema del 2026-09-17. NO se borra el
-- valor PENDING del enum ni se reescribe ninguna fila: PENDING es el estado que tienen todos los
-- pedidos existentes, y la maquina de estados lo trata como sinonimo de PENDING_PAYMENT.
ALTER TYPE "OrderFulfillmentStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
ALTER TYPE "OrderFulfillmentStatus" ADD VALUE IF NOT EXISTS 'PAID';
ALTER TYPE "OrderFulfillmentStatus" ADD VALUE IF NOT EXISTS 'PREPARING';
ALTER TYPE "OrderFulfillmentStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "OrderFulfillmentStatus" ADD VALUE IF NOT EXISTS 'RETURNED';
ALTER TYPE "OrderFulfillmentStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

CREATE TYPE "OrderEventActor" AS ENUM ('OWNER', 'EMPLOYEE', 'AGENT', 'JOB', 'SYSTEM');

CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "from" "OrderFulfillmentStatus" NOT NULL,
    "to" "OrderFulfillmentStatus" NOT NULL,
    "actor" "OrderEventActor" NOT NULL,
    "actorLabel" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");
CREATE INDEX "OrderEvent_businessId_createdAt_idx" ON "OrderEvent"("businessId", "createdAt");

ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
