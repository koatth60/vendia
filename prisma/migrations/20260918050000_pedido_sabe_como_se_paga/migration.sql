-- El pedido recuerda cuando se paga y cuanto se cobra al entregar (2026-09-17).
ALTER TABLE "Order" ADD COLUMN "shippingModality" "ShippingPaymentModality";
ALTER TABLE "Order" ADD COLUMN "amountOnDelivery" DECIMAL(12,2);
