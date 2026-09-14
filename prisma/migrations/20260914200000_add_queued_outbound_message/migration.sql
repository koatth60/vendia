-- Cola de salida para la ventana de 24h de WhatsApp.
-- Cuando la ventana esta cerrada, WhatsApp no entrega texto libre: antes se mandaba una plantilla
-- generica de reenganche y el texto real que el equipo queria decir se perdia, asi que alguien tenia
-- que acordarse de reescribirlo cuando el cliente contestara (caso real 2026-09-14). Ahora queda aca y
-- el webhook lo entrega solo con el primer mensaje entrante, que es lo que reabre la ventana.
CREATE TYPE "QueuedOutboundOrigin" AS ENUM ('PANEL', 'OWNER_ANSWER');

CREATE TABLE "QueuedOutboundMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "origin" "QueuedOutboundOrigin" NOT NULL DEFAULT 'PANEL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "QueuedOutboundMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QueuedOutboundMessage_conversationId_sentAt_idx" ON "QueuedOutboundMessage"("conversationId", "sentAt");
CREATE INDEX "QueuedOutboundMessage_businessId_sentAt_idx" ON "QueuedOutboundMessage"("businessId", "sentAt");

ALTER TABLE "QueuedOutboundMessage" ADD CONSTRAINT "QueuedOutboundMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
