import { prisma } from "../db/client";

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
  data: { type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO"; label: string; details: string }
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
  data: Partial<{ type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO"; label: string; details: string; active: boolean }>
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
