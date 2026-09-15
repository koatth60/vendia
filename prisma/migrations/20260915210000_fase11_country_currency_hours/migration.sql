-- Fase 11 del plan maestro (2026-09-15), causa raiz C5: pais, moneda, zona horaria, horario de atencion
-- y la regla de documento de identidad pasan a ser configuracion por negocio.

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "businessHours" JSONB,
ADD COLUMN     "countryCode" TEXT NOT NULL DEFAULT 'CO',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'COP',
ADD COLUMN     "idDocumentExemptZones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "requiresIdDocument" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/Bogota';

-- Los negocios que ya existian corrian con la lista cableada en orders/checkoutState.ts
-- (zonasSinDocumento: ["bogota", "soacha"]). Se copia tal cual para que ninguno cambie de
-- comportamiento el dia del despliegue; de aca en adelante cada negocio la edita desde el panel.
UPDATE "Business" SET "idDocumentExemptZones" = ARRAY['bogota', 'soacha'] WHERE "countryCode" = 'CO';
