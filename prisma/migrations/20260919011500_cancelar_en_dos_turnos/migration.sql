-- E34: cancelar nunca ocurre en el mismo turno en que se pide. La primera llamada solo deja la marca.
ALTER TABLE "Order" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
