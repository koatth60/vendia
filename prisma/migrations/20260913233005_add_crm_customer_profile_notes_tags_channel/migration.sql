-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'MERCADOLIBRE');

-- CreateEnum
CREATE TYPE "CustomerStage" AS ENUM ('NUEVO', 'ACTIVO', 'COMPRADOR', 'RECURRENTE', 'INACTIVO');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'WHATSAPP';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "address" TEXT,
ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'WHATSAPP',
ADD COLUMN     "email" TEXT,
ADD COLUMN     "lastContactAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT,
ADD COLUMN     "stage" "CustomerStage" NOT NULL DEFAULT 'NUEVO';

-- CreateTable
CREATE TABLE "CustomerNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerTag" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#5c6e65',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerNote_customerId_createdAt_idx" ON "CustomerNote"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTag_businessId_label_key" ON "CustomerTag"("businessId", "label");

-- CreateIndex
CREATE INDEX "Customer_businessId_lastContactAt_idx" ON "Customer"("businessId", "lastContactAt");

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTag" ADD CONSTRAINT "CustomerTag_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: Customer.lastContactAt a partir del ultimo mensaje real de cada cliente, para que la
-- lista de clientes del CRM pueda ordenar por recencia desde el primer despliegue en vez de arrancar
-- con la columna entera en NULL.
UPDATE "Customer" c
SET "lastContactAt" = sub.last_at
FROM (
  SELECT conv."customerId" AS customer_id, MAX(m."createdAt") AS last_at
  FROM "Message" m
  JOIN "Conversation" conv ON conv."id" = m."conversationId"
  GROUP BY conv."customerId"
) sub
WHERE c."id" = sub.customer_id;

-- Clientes sin ningun mensaje: se usa su fecha de alta, asi ninguna fila queda sin valor de orden.
UPDATE "Customer" SET "lastContactAt" = "createdAt" WHERE "lastContactAt" IS NULL;

-- Backfill: etapa derivada del historial real de pedidos (2 o mas = RECURRENTE, 1 = COMPRADOR). Sin
-- esto todos los clientes existentes arrancarian en NUEVO, que seria falso para quien ya compro.
UPDATE "Customer" c
SET "stage" = CASE WHEN sub.order_count >= 2 THEN 'RECURRENTE'::"CustomerStage" ELSE 'COMPRADOR'::"CustomerStage" END
FROM (SELECT "customerId", COUNT(*) AS order_count FROM "Order" GROUP BY "customerId") sub
WHERE c."id" = sub."customerId";
