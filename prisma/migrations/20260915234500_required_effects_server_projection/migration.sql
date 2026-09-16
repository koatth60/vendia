-- Efectos requeridos: el disparador se apoya solo en evidencia que escribe el servidor.
-- Ciudad con tarifa de envio real confirmada en la conversacion (la escribe get_shipping_rate_for_city
-- cuando matchea, no el modelo).
ALTER TABLE "SaleState" ADD COLUMN "shippingCity" TEXT;

-- Conversacion que origino cada aviso al dueno, para poder probar con un SELECT por conversacion que el
-- aviso salio de verdad. Nullable: todos los avisos historicos y los que no nacen de una conversacion.
ALTER TABLE "OwnerMessageLog" ADD COLUMN "conversationId" TEXT;
CREATE INDEX "OwnerMessageLog_conversationId_createdAt_idx" ON "OwnerMessageLog"("conversationId", "createdAt");
