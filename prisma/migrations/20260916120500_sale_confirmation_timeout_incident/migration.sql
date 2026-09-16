-- Se vencio Business.ownerQuestionTimeoutHours con una confirmacion de venta sin responder: el cliente
-- pago y el dueno nunca contesto "¿Te llego el pago?". Va en su propia migracion porque un
-- ALTER TYPE ... ADD VALUE no puede compartir transaccion con un uso del valor nuevo.
ALTER TYPE "AgentIncidentKind" ADD VALUE 'SALE_CONFIRMATION_TIMEOUT';
