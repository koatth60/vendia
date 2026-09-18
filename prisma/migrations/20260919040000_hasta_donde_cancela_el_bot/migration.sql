-- Hasta que punto puede cancelar el bot un pedido sin que el dueno haga nada.
-- El default reproduce exactamente lo que el sistema hacia antes: hasta antes de despachar.
CREATE TYPE "CancelacionPorElBot" AS ENUM ('NUNCA', 'ANTES_DE_DESPACHAR', 'ANTES_DE_ENTREGAR');

ALTER TABLE "Business"
  ADD COLUMN "cancelacionPorElBot" "CancelacionPorElBot" NOT NULL DEFAULT 'ANTES_DE_DESPACHAR';
