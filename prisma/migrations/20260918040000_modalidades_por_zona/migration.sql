-- La contraentrega es una politica por zona, no del negocio entero (2026-09-17).
ALTER TABLE "ShippingRate" ADD COLUMN "paymentModalities" "ShippingPaymentModality"[] DEFAULT ARRAY[]::"ShippingPaymentModality"[];
