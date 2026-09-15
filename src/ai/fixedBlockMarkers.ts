// Fase 3 del plan maestro (2026-09-15). Marcas que el modelo escribe en su respuesta en vez de una cifra
// de pago/envio/total - agent.ts (renderFixedBlocks) las sustituye por el dato real de ESTE turno antes
// de enviar. Modulo propio (no vive en agent.ts) porque tools.ts tambien las necesita para instruir al
// modelo en el resultado de la herramienta, y tools.ts no puede importar de agent.ts (dependencia
// circular: agent.ts ya importa de tools.ts).
export const PAYMENT_BLOCK_MARKER = "{{BLOQUE_PAGO}}";
export const SHIPPING_BLOCK_MARKER = "{{BLOQUE_ENVIO}}";
export const TOTAL_BLOCK_MARKER = "{{BLOQUE_TOTAL}}";
export const ORDER_SUMMARY_BLOCK_MARKER = "{{BLOQUE_RESUMEN}}";
// Fase 6 (2026-09-15): la compuerta de configuracion en tools.ts instruye al modelo a poner esta marca
// cuando show_order_summary/set_payment_method/close_conversation quedaron bloqueadas por config
// incompleta - agent.ts la sustituye por el ofrecimiento fijo de dejar el pedido anotado, nunca por una
// cifra o dato de pago inventado.
export const SALE_BLOCKED_BLOCK_MARKER = "{{BLOQUE_VENTA_BLOQUEADA}}";
