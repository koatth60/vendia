import { prisma } from "../db/client";

// EL BOT NO DECLARA UN PAGO RECIBIDO (2026-09-18).
//
// Defecto real, medido en una conversación de prueba con el catálogo y la configuración reales:
//
//   CLIENTE | [IMAGE] ya te transferi, aqui esta el comprobante
//     ONIX  | Vale listo, si veo, ya llego, te vamos a generar el pedido
//
// Nadie miró ese comprobante. El negocio tiene `requirePaymentProof` encendido, el pedido quedó con
// `paymentStatus: UNPAID` y la verificación seguía esperando al dueño. El servidor nunca dijo que el
// pago estuviera confirmado -- su texto de cierre sólo sale DESPUÉS de que el dueño confirma, y ahí es
// verdad. La frase la puso el modelo.
//
// Lo que NO se puede hacer, por la regla de admisión del proyecto: detectar la frase. Un disparador
// leído de la prosa -- del cliente o del modelo -- es el guard de clase D que las fases anteriores
// vinieron a borrar, y no converge nunca.
//
// Lo que sí: el estado que hace falta ya está en la base, y se responde con SELECT.
//
//   - el negocio exige comprobante
//   - el pago de esta venta es por adelantado (PaymentMethod.settlement distinto de ON_DELIVERY)
//   - el cliente mandó una imagen DESPUÉS de que se le pasaron los datos de pago
//   - y el pedido, si ya existe, sigue sin marcarse como pagado
//
// Cuando esas cuatro se cumplen, el hecho es "hay un comprobante sin verificar", y ese hecho lo dice el
// servidor. Al modelo no le queda la decisión de declarar el pago recibido.

/**
 * El momento en que a esta conversación se le pasaron los datos de pago, o null.
 *
 * Misma definición que usa `faltaComprobanteDePago`: sale de `AgentTurn.toolsCalled`, el registro de lo
 * que el servidor hizo de verdad, no de lo que el bot escribió.
 */
async function momentoDeLosDatosDePago(conversationId: string): Promise<Date | null> {
  const turno = await prisma.agentTurn.findFirst({
    where: { conversationId, toolsCalled: { has: "get_payment_methods" } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return turno?.createdAt ?? null;
}

/** True cuando hay un comprobante que nadie verificó todavía. Cuatro SELECT, ninguna lectura de prosa. */
export async function comprobanteEsperandoVerificacion(businessId: string, conversationId: string): Promise<boolean> {
  const negocio = await prisma.business.findUnique({
    where: { id: businessId },
    select: { requirePaymentProof: true },
  });
  if (!negocio?.requirePaymentProof) return false;

  // Si el pedido ya existe y alguien lo marcó pagado, no hay nada en revisión.
  const pedido = await prisma.order.findFirst({
    where: { conversationId },
    select: { paymentStatus: true, paymentMethodLabel: true },
  });
  if (pedido?.paymentStatus === "PAID") return false;

  // Por adelantado o contraentrega. En contraentrega no hay comprobante que revisar porque el pago
  // todavía no ocurrió, y decir que algo está en revisión sería inventar un trámite que no existe.
  const estado = await prisma.saleState.findFirst({
    where: { conversationId },
    select: { paymentMethodId: true },
  });
  const metodoId = estado?.paymentMethodId;
  if (metodoId) {
    const metodo = await prisma.paymentMethod.findUnique({ where: { id: metodoId }, select: { settlement: true } });
    if (!metodo || metodo.settlement === "ON_DELIVERY") return false;
  } else if (pedido?.paymentMethodLabel) {
    const metodo = await prisma.paymentMethod.findFirst({
      where: { businessId, label: pedido.paymentMethodLabel },
      select: { settlement: true },
    });
    if (!metodo || metodo.settlement === "ON_DELIVERY") return false;
  } else {
    // Sin método resuelto no se afirma nada: una venta no se llena de avisos por una duda nuestra.
    return false;
  }

  const desde = await momentoDeLosDatosDePago(conversationId);
  if (!desde) return false;

  const imagen = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER", mediaType: "IMAGE", createdAt: { gte: desde } },
    select: { id: true },
  });
  return Boolean(imagen);
}

/**
 * Lo que el servidor le dice al cliente sobre ese comprobante.
 *
 * Es un hecho, no una regla de conversación: dice en qué estado está el pago y nada más. Cómo saluda,
 * cómo lo acompaña o qué pregunta después sigue siendo del modelo.
 */
export const BLOQUE_COMPROBANTE_EN_REVISION =
  "Recibimos tu comprobante. El equipo lo esta verificando y te confirmamos apenas quede validado.";
