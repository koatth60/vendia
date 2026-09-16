-- Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md). Migracion aditiva: ninguna
-- columna existente cambia de tipo ni de default, y toda fila anterior queda valida tal cual.

-- Pieza 4: la ultima lista que el servidor le presento de verdad al cliente, en orden. Resuelve "el 3"
-- del turno siguiente sin depender de que el modelo recuerde su propia lista.
ALTER TABLE "Conversation" ADD COLUMN "lastPresentedProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Pieza 7: una fila por turno del agente. Reemplaza el cruce a mano de AiUsageLog + Message +
-- mediaSentProductIds que hasta ahora era la unica forma de saber que hizo un turno.
CREATE TABLE "AgentTurn" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "toolsCalled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "forcedTool" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'none',
    "blocks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mediaProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTurn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTurn_businessId_createdAt_idx" ON "AgentTurn"("businessId", "createdAt");
CREATE INDEX "AgentTurn_conversationId_createdAt_idx" ON "AgentTurn"("conversationId", "createdAt");

ALTER TABLE "AgentTurn" ADD CONSTRAINT "AgentTurn_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
