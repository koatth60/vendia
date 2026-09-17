import type { PaymentSettlement, ShippingPaymentModality } from "@prisma/client";
import { prisma } from "../db/client";
import { resolveShippingRateForCity } from "../catalog/shippingRates";
import { getServerSaleEvidence } from "./saleState";

// CUANDO SE PAGA ESTE PEDIDO (2026-09-17, fase 3).
//
// El pedido guardaba el total y con que metodo, pero no CUANDO se cobra. Por eso "¿cuanto le cobro al
// mensajero?" - la pregunta que el dueno se hace en cada despacho - solo se podia responder releyendo el
// chat entero. Estas dos funciones lo resuelven con datos: la modalidad y el monto quedan escritos en el
// Order y no dependen de que nadie se acuerde.

const MODALIDADES: ShippingPaymentModality[] = ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"];

/**
 * Lo que hay que cobrar al entregar, segun la modalidad. `null` cuando no sabemos la modalidad: es
 * distinto de cero y no se puede inventar. Un cero dice "no le cobres nada", y decirle eso a un mensajero
 * por una modalidad que nadie resolvio seria regalar el pedido.
 */
export function montoACobrarAlEntregar(
  modality: ShippingPaymentModality | null,
  montos: { itemsTotal: number; shippingCost: number }
): number | null {
  switch (modality) {
    case "PREPAID_ALL":
      return 0;
    case "PREPAID_PRODUCT_COD_SHIPPING":
      return montos.shippingCost;
    case "COD_ALL":
      return montos.itemsTotal + montos.shippingCost;
    default:
      return null;
  }
}

/**
 * La modalidad de ESTE pedido, resuelta contra datos reales y nunca inventada.
 *
 * Orden, de lo mas confiable a lo menos:
 *
 *   1. La que se declaro al cerrar, SI aplica en la zona del cliente. Una modalidad que el negocio no
 *      ofrece en esa ciudad se descarta: es el mismo criterio con el que el bot se la ofrecio.
 *   2. El metodo de pago cobra al recibir (PaymentMethod.settlement = ON_DELIVERY). Ahi no hay nada
 *      pagado por adelantado, asi que la modalidad es contraentrega total. Es un dato, no una deduccion.
 *   3. La zona (o el negocio) admite UNA sola modalidad. Con una sola opcion no hubo nada que elegir.
 *   4. Nada: `null`, y el pedido queda diciendo honestamente que no se sabe.
 */
export async function resolverModalidadDelPedido(
  businessId: string,
  opts: {
    /** La que llego en el cierre, si llego alguna. */
    declarada?: string | null;
    /** PaymentMethod.settlement del metodo elegido es ON_DELIVERY (ver requiresPaymentConfirmation). */
    cobraAlRecibir: boolean;
    /** La ciudad de entrega, si el servidor la resolvio contra sus propias reglas. */
    city?: string | null;
  }
): Promise<ShippingPaymentModality | null> {
  const disponibles = await modalidadesDisponibles(businessId, opts.city);

  const declarada = opts.declarada?.trim();
  if (declarada && MODALIDADES.includes(declarada as ShippingPaymentModality)) {
    // Se acepta si aplica en la zona. Y tambien cuando el negocio no configuro NINGUNA modalidad: sin esa
    // lista no hay dato que la contradiga, y descartarla seria inventarse una restriccion que nadie puso.
    if (disponibles.length === 0 || disponibles.includes(declarada as ShippingPaymentModality)) {
      return declarada as ShippingPaymentModality;
    }
  }

  if (opts.cobraAlRecibir) return "COD_ALL";

  if (disponibles.length === 1) return disponibles[0];

  return null;
}

/** Las modalidades que aplican para este pedido: las de su zona si la hay, si no las del negocio. */
async function modalidadesDisponibles(businessId: string, city?: string | null): Promise<ShippingPaymentModality[]> {
  const ciudad = city?.trim();
  if (ciudad) {
    const zona = await resolveShippingRateForCity(businessId, ciudad);
    if (zona) return zona.paymentModalities;
  }
  const negocio = await prisma.business.findUnique({
    where: { id: businessId },
    select: { shippingPaymentModalities: true },
  });
  return negocio?.shippingPaymentModalities ?? [];
}

/**
 * Saca de la lista los metodos que se cobran al recibir cuando la zona del cliente no admite pagar TODO
 * al recibir. Un metodo "Contraentrega" configurado a nivel negocio no significa que aplique en cada
 * ciudad: MAG.IMP lo hace en Bogota y Soacha y no fuera, y sin esto se le ofrecia igual a una clienta de
 * Cali.
 *
 * No filtra nada en dos casos, los dos a proposito:
 *   - La ciudad todavia no se resolvio. No sabemos a donde va el pedido, y esconder un metodo por las
 *     dudas es el error opuesto: dejaria sin forma de pagar a alguien que si podia.
 *   - Ni la zona ni el negocio tienen modalidades configuradas. Sin ese dato no hay nada contra que
 *     decidir, y es exactamente el comportamiento anterior a que estas listas existieran.
 */
export async function filtrarMetodosPorZona<T extends { settlement: PaymentSettlement }>(
  businessId: string,
  metodos: T[],
  conversationId: string
): Promise<T[]> {
  if (!metodos.some((m) => m.settlement === "ON_DELIVERY")) return metodos;

  const evidencia = await getServerSaleEvidence(conversationId);
  const ciudad = evidencia?.shippingCity?.trim();
  if (!ciudad) return metodos;

  const disponibles = await modalidadesDisponibles(businessId, ciudad);
  if (disponibles.length === 0) return metodos;
  if (disponibles.includes("COD_ALL")) return metodos;

  return metodos.filter((m) => m.settlement !== "ON_DELIVERY");
}
