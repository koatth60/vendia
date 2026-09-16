-- Efectos requeridos: bandera por negocio, apagada por defecto.
ALTER TABLE "Business" ADD COLUMN "requiredEffectsEnabled" BOOLEAN NOT NULL DEFAULT false;
