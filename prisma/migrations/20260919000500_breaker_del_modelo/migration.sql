-- E23: el breaker del modelo deja de vivir en memoria, para que los dos procesos compartan la decision.
CREATE TABLE "ModelBreaker" (
    "model" TEXT NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMP(3) NOT NULL,
    "detail" TEXT,

    CONSTRAINT "ModelBreaker_pkey" PRIMARY KEY ("model")
);
