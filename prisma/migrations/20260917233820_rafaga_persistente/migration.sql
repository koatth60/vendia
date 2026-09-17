-- E08 de ONIX-PLAN.md: la rafaga de mensajes entrantes deja de vivir en la memoria del proceso.
-- Migracion puramente aditiva: una tabla nueva y sus indices. Nada existente se toca, asi que revertir
-- es revertir el codigo y dejar la tabla muerta.
--
-- NOTA: `prisma migrate dev` habia generado tambien un `DROP INDEX
-- "Conversation_pendingConfirmationNextAttemptAt_idx"`, que se quito a mano. Ese indice es deriva
-- previa entre schema.prisma y las migraciones, no tiene nada que ver con esta etapa, y el plan
-- prohibe que una migracion borre nada. Que hacer con esa deriva se decide aparte.

-- CreateTable
CREATE TABLE "PendingBurst" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "selectedProductId" TEXT,
    "customerSentAt" TIMESTAMP(3) NOT NULL,
    "flushAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingBurst_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingBurst_claimedAt_flushAt_idx" ON "PendingBurst"("claimedAt", "flushAt");

-- CreateIndex
CREATE INDEX "PendingBurst_conversationId_claimedAt_idx" ON "PendingBurst"("conversationId", "claimedAt");

-- AddForeignKey
ALTER TABLE "PendingBurst" ADD CONSTRAINT "PendingBurst_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
