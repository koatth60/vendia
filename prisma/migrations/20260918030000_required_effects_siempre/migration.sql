-- Verificar lo que el bot dice que hizo deja de ser una casilla del panel (2026-09-17).
ALTER TABLE "Business" ALTER COLUMN "requiredEffectsEnabled" SET DEFAULT true;

-- Y se enciende en los negocios que ya existen: el default solo alcanza a los que se creen despues.
UPDATE "Business" SET "requiredEffectsEnabled" = true WHERE "requiredEffectsEnabled" = false;
