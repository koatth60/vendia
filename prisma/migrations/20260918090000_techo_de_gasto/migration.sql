-- El freno de gasto que reemplaza al corte por tope de mensajes (2026-09-17). Ver el comentario de
-- Business.aiSpendCeilingUsd en schema.prisma.
--
-- Las dos nullable: null en aiSpendCeilingUsd significa "usar el default que sale del plan", no "sin
-- techo". Ningun negocio queda sin freno por esta migracion, y ninguno cambia de conducta tampoco:
-- el default esta puesto muy por encima de lo que gasta un negocio real (medido el 2026-09-17 en
-- produccion: el unico negocio con trafico lleva USD 1,08 en el mes, con 2.321 llamadas a la IA).
ALTER TABLE "Business" ADD COLUMN "aiSpendCeilingUsd" DOUBLE PRECISION;
ALTER TABLE "Business" ADD COLUMN "spendCeilingNotifiedAt" TIMESTAMP(3);
