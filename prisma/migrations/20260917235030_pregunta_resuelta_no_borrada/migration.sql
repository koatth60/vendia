-- E56 de ONIX-PLAN.md: la pregunta al dueno se marca resuelta en vez de borrarse.
-- Aditiva: una columna nullable y un indice. Las filas viejas quedan con resolvedAt NULL, que es
-- "abierta" - correcto, porque las que ya se resolvieron fueron borradas y no estan.
--
-- NOTA (la misma de la migracion 20260917233820): `prisma migrate dev` vuelve a proponer un
-- `DROP INDEX "Conversation_pendingConfirmationNextAttemptAt_idx"` que se quito a mano. Es deriva
-- previa entre schema.prisma y las migraciones, ajena a esta etapa, y ninguna migracion de este plan
-- borra nada.

-- AlterTable
ALTER TABLE "PendingOwnerQuestion" ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PendingOwnerQuestion_conversationId_resolvedAt_idx" ON "PendingOwnerQuestion"("conversationId", "resolvedAt");
