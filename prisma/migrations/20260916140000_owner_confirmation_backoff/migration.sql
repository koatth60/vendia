-- Perseguidor de confirmaciones de venta: espaciado creciente y tope de plantillas.
--
-- Con cadencia fija (Business.ownerReminderMinutes) y vencimiento a las 24h, la config real de
-- MAGByLizN (5 minutos / 24 horas) daba ~288 mensajes de WhatsApp al dueno por UNA venta. Tres costos,
-- en orden: la duena silencia el numero (el mecanismo que existe para que se entere garantiza que deje
-- de mirar), Meta le baja la calificacion de calidad a la MISMA linea por la que se les habla a todos
-- los clientes, y cada plantilla onix_owner_alert es UTILITY y se factura por mensaje.
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationNextAttemptAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationTemplatesSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "pendingConfirmationLastTemplateAt" TIMESTAMP(3);

-- Las confirmaciones que ya estan vivas quedan vencidas para reintento inmediato: el intervalo de cada
-- una depende de su negocio y de su numero de intento, y adivinarlo en SQL seria peor que dejar que la
-- proxima pasada del perseguidor lo recalcule con la escalera real.
UPDATE "Conversation"
SET "pendingConfirmationNextAttemptAt" = NOW()
WHERE "pendingConfirmationAskedAt" IS NOT NULL;

CREATE INDEX "Conversation_pendingConfirmationNextAttemptAt_idx" ON "Conversation"("pendingConfirmationNextAttemptAt");
