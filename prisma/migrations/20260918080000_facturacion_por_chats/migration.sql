-- Los planes pasan de venderse por MENSAJES a venderse por CHATS (2026-09-17). Un chat es una
-- interaccion completa con un cliente; se abre con su primer mensaje y se cierra sola a las 48 horas
-- sin actividad. Ver el comentario del modelo BillableChat en schema.prisma.
--
-- Migracion puramente aditiva: crea la tabla vacia. Ningun negocio arranca con chats contados, asi que
-- el primer mes despues del despliegue cuenta desde cero. No se intenta reconstruir el historico a
-- partir de Message: la ventana de 48 horas se puede recomputar hacia atras, pero el resultado seria
-- una cifra de facturacion inventada por una consulta, no medida - y a nadie se le cobra por eso.
CREATE TABLE "BillableChat" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "conversationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageCount" INTEGER NOT NULL DEFAULT 1,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillableChat_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BillableChat_businessId_periodStart_idx" ON "BillableChat"("businessId", "periodStart");
CREATE INDEX "BillableChat_customerId_lastMessageAt_idx" ON "BillableChat"("customerId", "lastMessageAt");

ALTER TABLE "BillableChat" ADD CONSTRAINT "BillableChat_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillableChat" ADD CONSTRAINT "BillableChat_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
