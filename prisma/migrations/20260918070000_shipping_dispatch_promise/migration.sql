-- Cuando sale y cuando llega un pedido de esta zona (2026-09-17, etapa E05 de ONIX-PLAN.md).
-- Todas nullable o con valor por defecto: una tarifa sin nada cargado no promete ninguna fecha, que es
-- exactamente el comportamiento anterior a estas columnas. Migracion aditiva y reversible.
ALTER TABLE "ShippingRate" ADD COLUMN "cutoffTime" TEXT;
ALTER TABLE "ShippingRate" ADD COLUMN "sameDayBeforeCutoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShippingRate" ADD COLUMN "deliveryDaysMin" INTEGER;
ALTER TABLE "ShippingRate" ADD COLUMN "deliveryDaysMax" INTEGER;
ALTER TABLE "ShippingRate" ADD COLUMN "noDispatchWeekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
