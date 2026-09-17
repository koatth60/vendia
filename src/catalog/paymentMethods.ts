import { prisma } from "../db/client";
import { normalizeForMatch, tokenize } from "../search/text";

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

/**
 * La misma etiqueta escrita de las dos formas que el español admite: "Contraentrega" y "Contra entrega".
 * Se comparan las dos sin espacios ni signos, porque el espacio ahí no significa nada.
 *
 * Defecto real de produccion: la duena tiene cargado "Contraentrega", el agente escribio "Contra entrega
 * total", y el guard lo rechazo - ni la igualdad exacta ni la comparacion por tokens podian verlas
 * iguales ("contra"+"entrega"+"total" contra el unico token "contraentrega"). El cierre quedaba
 * bloqueado y el cliente leia que el sistema no dejaba cerrar la venta.
 */
function squash(text: string): string {
  return normalizeForMatch(text).replace(/[^a-z0-9]/g, "");
}

/**
 * CUAL de las formas de pago configuradas nombro el agente, no solo si nombro alguna.
 *
 * Devolver la forma REAL es lo que importa: lo que se guarda en el pedido pasa a ser la etiqueta que la
 * duena cargo, no la que el modelo haya escrito. Su redaccion queda donde corresponde, en el mensaje al
 * cliente, y deja de poder entrar a la base.
 *
 * Un empate (dos formas configuradas que encajan con lo mismo) NO elige: devuelve null y el guard
 * bloquea, igual que antes. Adivinar con que metodo pago alguien es exactamente lo que no se hace.
 */
export function resolveConfiguredPaymentMethod<T extends { label: string }>(label: string, realMethods: T[]): T | null {
  const escrito = squash(label);
  if (!escrito) return null;

  const exacta = realMethods.filter((m) => squash(m.label) === escrito);
  if (exacta.length === 1) return exacta[0];

  // Una contiene a la otra: "contraentregatotal" contiene "contraentrega", y "nequi" esta dentro de
  // "nequillaveodaviplata". Las dos direcciones, porque el agente tanto agrega palabras como recorta.
  const contenidas = realMethods.filter((m) => {
    const real = squash(m.label);
    return real.length > 0 && (escrito.includes(real) || real.includes(escrito));
  });
  if (contenidas.length === 1) return contenidas[0];

  // Ultimo recurso, el criterio viejo: todas las palabras de lo escrito estan en la forma real.
  const inputTokens = tokenize(label.trim());
  if (inputTokens.length === 0) return null;
  const porTokens = realMethods.filter((m) => {
    const realTokens = new Set(tokenize(m.label));
    return inputTokens.every((t) => realTokens.has(t));
  });
  return porTokens.length === 1 ? porTokens[0] : null;
}

export function matchesConfiguredPaymentMethod(label: string, realMethods: { label: string }[]): boolean {
  return resolveConfiguredPaymentMethod(label, realMethods) !== null;
}
