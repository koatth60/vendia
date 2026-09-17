-- CUANDO entra la plata de cada forma de pago. PREPAID por defecto = el comportamiento que ya existia
-- (toda venta le pide confirmacion al dueno). Un negocio que marca su metodo contraentrega como
-- ON_DELIVERY deja de recibir la pregunta "¿te llego el pago?" por plata que se cobra al entregar.
CREATE TYPE "PaymentSettlement" AS ENUM ('PREPAID', 'ON_DELIVERY');

ALTER TABLE "PaymentMethod" ADD COLUMN "settlement" "PaymentSettlement" NOT NULL DEFAULT 'PREPAID';
