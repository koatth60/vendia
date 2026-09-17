import { prisma } from "../db/client";

/** Ver PaymentSettlement en prisma/schema.prisma: CUANDO entra la plata, no por que canal. */
export type PaymentSettlement = "PREPAID" | "ON_DELIVERY";

/** Lo unico que se acepta desde el panel: un valor de afuera de la lista no cambia nada. */
export function parseSettlement(value: unknown): PaymentSettlement | undefined {
  return value === "ON_DELIVERY" || value === "PREPAID" ? value : undefined;
}

export async function listPaymentMethods(businessId: string) {
  return prisma.paymentMethod.findMany({
    where: { businessId },
    orderBy: { createdAt: "asc" },
  });
}

export async function listActivePaymentMethods(businessId: string) {
  return prisma.paymentMethod.findMany({
    where: { businessId, active: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createPaymentMethod(
  businessId: string,
  data: { type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO"; label: string; details: string; settlement?: PaymentSettlement }
) {
  return prisma.paymentMethod.create({ data: { ...data, businessId } });
}

export async function deletePaymentMethod(businessId: string, id: string) {
  const method = await prisma.paymentMethod.findFirst({ where: { id, businessId } });
  if (!method) throw new Error("Metodo de pago no encontrado");
  return prisma.paymentMethod.delete({ where: { id } });
}

export async function togglePaymentMethod(businessId: string, id: string, active: boolean) {
  const method = await prisma.paymentMethod.findFirst({ where: { id, businessId } });
  if (!method) throw new Error("Metodo de pago no encontrado");
  return prisma.paymentMethod.update({ where: { id }, data: { active } });
}

export async function updatePaymentMethod(
  businessId: string,
  id: string,
  data: Partial<{ type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO"; label: string; details: string; active: boolean; settlement: PaymentSettlement }>
) {
  const method = await prisma.paymentMethod.findFirst({ where: { id, businessId } });
  if (!method) throw new Error("Metodo de pago no encontrado");
  return prisma.paymentMethod.update({ where: { id }, data });
}

// Fase 11 del plan maestro (2026-09-15): los ejemplos de metodo de pago que el modelo lee ("ej: Nequi,
// tarjeta") estaban escritos a mano en cuatro prompts distintos - systemPrompt.ts, tools.ts,
// extractSale.ts y visionPrompt.ts. Nequi no existe en Mexico, y un negocio colombiano que solo cobra
// contraentrega tampoco gana nada con ese ejemplo. Ahora salen de los metodos reales del negocio.
//
// Un negocio sin metodos cargados cae en dos ejemplos genericos de canal, no en nombres de marca de
// ningun pais: sin esto el texto queda como "(ej: , )" y el modelo lee un ejemplo vacio.
const GENERIC_PAYMENT_EXAMPLES = "transferencia, contraentrega";

/** Hasta tres etiquetas reales, para que el ejemplo siga siendo un ejemplo y no el catalogo de pagos. */
export function formatPaymentExamples(labels: string[]): string {
  const real = labels.map((l) => l.trim()).filter(Boolean).slice(0, 3);
  return real.length > 0 ? real.join(", ") : GENERIC_PAYMENT_EXAMPLES;
}

export async function getPaymentExamples(businessId: string): Promise<string> {
  const methods = await listActivePaymentMethods(businessId);
  return formatPaymentExamples(methods.map((m) => m.label));
}

// ¿HAY ALGO QUE CONFIRMAR ANTES DE DESPACHAR? (2026-09-17)
//
// close_conversation le pedia confirmacion al dueno en TODA venta, sin mirar nunca como se pagaba: un
// pedido contraentrega quedaba esperando un "¿te llego el pago?" por plata que, por definicion, todavia
// no existe. El dueno tenia que contestar una pregunta imposible para que el pedido se creara.
//
// La respuesta sale de un dato del negocio (PaymentMethod.settlement), no de la ciudad ni de un `if` con
// el nombre de un negocio adentro. Sirve igual para cualquier negocio de ventas: lo unico que cambia
// entre verticales es que metodos carga cada uno.
//
// Ante la duda, PREPAID: sin metodo identificable se confirma, que es el lado seguro del error (el peor
// caso es una pregunta de mas, no un pedido despachado sin cobrar).
export async function requiresPaymentConfirmation(
  businessId: string,
  chosen: { paymentMethodId?: string | null; paymentMethodLabel?: string | null }
): Promise<boolean> {
  const id = chosen.paymentMethodId?.trim();
  if (id) {
    // Sin filtro `active`, igual que close_conversation: si el dueno desactivo el metodo despues de que el
    // cliente lo eligio, la venta no tiene por que cambiar de reglas a mitad de camino.
    const byId = await prisma.paymentMethod.findFirst({ where: { id, businessId }, select: { settlement: true } });
    if (byId) return byId.settlement !== "ON_DELIVERY";
  }

  const label = chosen.paymentMethodLabel?.trim();
  if (label) {
    const byLabel = await prisma.paymentMethod.findFirst({
      where: { businessId, label: { equals: label, mode: "insensitive" } },
      select: { settlement: true },
    });
    if (byLabel) return byLabel.settlement !== "ON_DELIVERY";
  }

  return true;
}
