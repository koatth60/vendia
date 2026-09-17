import type { ShippingPaymentModality } from "@prisma/client";
import { prisma } from "../db/client";
import { resolveShippingRateForCity } from "../catalog/shippingRates";

// CUANDO SE PAGA ESTE PEDIDO (2026-09-17, fase 3).
//
// El pedido guardaba el total y con que metodo, pero no CUANDO se cobra. Por eso "¿cuanto le cobro al
// mensajero?" - la pregunta que el dueno se hace en cada despacho - solo se podia responder releyendo el
// chat entero. Estas dos funciones lo resuelven con datos: la modalidad y el monto quedan escritos en el
// Order y no dependen de que nadie se acuerde.

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
  if (declarada && disponibles.includes(declarada as ShippingPaymentModality)) {
    return declarada as ShippingPaymentModality;
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
