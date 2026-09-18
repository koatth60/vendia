-- E20/E21: el mensaje entrante existe aunque el proceso muera.
CREATE TABLE "InboundEvent" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- La idempotencia. Ocurre ANTES de gastar en descargas, S3, vision y transcripcion.
CREATE UNIQUE INDEX "InboundEvent_dedupeKey_key" ON "InboundEvent"("dedupeKey");
-- El indice del consumidor: pendientes que ya tocan, en orden de llegada.
CREATE INDEX "InboundEvent_processedAt_nextAttemptAt_idx" ON "InboundEvent"("processedAt", "nextAttemptAt");
CREATE INDEX "InboundEvent_failedAt_idx" ON "InboundEvent"("failedAt");
