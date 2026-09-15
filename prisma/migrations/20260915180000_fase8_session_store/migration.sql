-- Fase 8, punto 5: store de sesiones en Postgres (connect-pg-simple).
-- La forma de la tabla la fija connect-pg-simple; no la elegimos nosotros.

-- CreateTable
CREATE TABLE "session" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE INDEX "session_expire_idx" ON "session"("expire");
