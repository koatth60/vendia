-- Confirmacion de venta: garantizar que la pregunta al dueno LLEGUE y que se insista hasta que responda.
--
-- 1. Saber si llego. El webhook de estados de Meta matchea por wamid contra `Message`; los mensajes al
--    dueno viven en `OwnerMessageLog`, que no guardaba el wamid, asi que el acuse de entrega llegaba y se
--    descartaba.
CREATE TYPE "OwnerConfirmationChannel" AS ENUM ('BUTTONS', 'TEXT', 'TEMPLATE', 'NONE');

ALTER TABLE "OwnerMessageLog" ADD COLUMN "wamid" TEXT;
ALTER TABLE "OwnerMessageLog" ADD COLUMN "deliveryStatus" "MessageDeliveryStatus";
ALTER TABLE "OwnerMessageLog" ADD COLUMN "deliveryStatusAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "OwnerMessageLog_wamid_key" ON "OwnerMessageLog"("wamid");

-- 2. Estado de la confirmacion pendiente. `pendingConfirmationMessageId` no alcanza como marca de
--    "hay una confirmacion viva": cuando los tres escalones de envio fallan no hay wamid y la
--    confirmacion existe igual. La marca pasa a ser `pendingConfirmationAskedAt`.
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationAskedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationRemindedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationChannel" "OwnerConfirmationChannel";
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationButtonsQueued" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: toda confirmacion que hoy esta abierta salio por botones o por texto y ya fue entregada
-- (era la unica forma de que quedara escrito el wamid). Sin esto el perseguidor las ignoraria para
-- siempre, que es exactamente el agujero que esta migracion viene a cerrar.
UPDATE "Conversation"
SET "pendingConfirmationAskedAt" = "updatedAt",
    "pendingConfirmationAttempts" = 1,
    "pendingConfirmationChannel" = 'BUTTONS'
WHERE "pendingConfirmationMessageId" IS NOT NULL;

CREATE INDEX "Conversation_pendingConfirmationAskedAt_idx" ON "Conversation"("pendingConfirmationAskedAt");

