-- Cuando paga el cliente puede decidirse ciudad por ciudad, no solo por tarifa (2026-09-17).
ALTER TABLE "ShippingCityRule" ADD COLUMN "paymentModalities" "ShippingPaymentModality"[] DEFAULT ARRAY[]::"ShippingPaymentModality"[];
