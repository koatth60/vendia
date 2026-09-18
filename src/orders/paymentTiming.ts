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
  const mods = disponibles.mods;

  const declarada = opts.declarada?.trim();
  if (declarada && MODALIDADES.includes(declarada as ShippingPaymentModality)) {
    // Se acepta si aplica en la zona. Y tambien cuando el negocio no configuro NINGUNA modalidad: sin esa
    // lista no hay dato que la contradiga, y descartarla seria inventarse una restriccion que nadie puso.
    const esCodTotal = declarada === "COD_ALL";
    const aplica = esCodTotal
      ? admitePagoTotalAlRecibir(disponibles)
      : mods.length === 0 || mods.includes(declarada as ShippingPaymentModality);
    if (aplica) return declarada as ShippingPaymentModality;
  }

  // El metodo elegido se cobra al recibir. Eso solo puede volverse contraentrega TOTAL donde la zona la
  // admite: si no, el pedido queda sin modalidad resuelta (null) en vez de escribir en la base que el
  // mensajero cobra el producto entero en una ciudad donde el negocio nunca dijo que puede cobrarlo.
  if (opts.cobraAlRecibir) {
    if (admitePagoTotalAlRecibir(disponibles)) return "COD_ALL";
    return null;
  }

  if (mods.length === 1 && (mods[0] !== "COD_ALL" || admitePagoTotalAlRecibir(disponibles))) return mods[0];

  return null;
}

/**
 * Las modalidades que aplican para este pedido: las de su zona si la hay, si no las del negocio.
 *
 * COBRAR TODO AL RECIBIR EXIGE UNA ZONA QUE LO DIGA (2026-09-18). La lista del negocio es un respaldo
 * para cuando la ciudad no cae en ninguna zona configurada, y de ahi COD_ALL se saca siempre.
 *
 * El motivo es de plata y es asimetrico. Las otras dos modalidades se pagan por transferencia y se
 * pueden hacer desde cualquier parte: ofrecerlas de mas no arriesga nada. Cobrar todo al recibir depende
 * de si el negocio LLEGA ahi con un mensajero que cobre, y eso lo sabe zona por zona, nunca "en
 * general". Heredar COD_ALL de la lista del negocio equivale a decir "cobramos al recibir en cualquier
 * ciudad del pais", que no es lo que ese campo quiso decir nunca.
 *
 * Medido en produccion el 2026-09-18: MAGByLizN acepta pagar todo al recibir solo en Bogota y Soacha
 * (asi estan sus tarifas), pero su lista de negocio incluia COD_ALL, y 9 de sus ultimos 25 pedidos
 * fueron a ciudades sin regla cargada - Ocaña, Santa Rosa de Cabal, El Zulia. En todas ellas el bot
 * podia ofrecer y cerrar contraentrega total. El negocio despacharia la mercancia sin haber cobrado.
 */
async function modalidadesDisponibles(
  businessId: string,
  city?: string | null
): Promise<{ mods: ShippingPaymentModality[]; zonaResuelta: boolean }> {
  const ciudad = city?.trim();
  if (ciudad) {
    const zona = await resolveShippingRateForCity(businessId, ciudad);
    if (zona) return { mods: zona.paymentModalities, zonaResuelta: true };
  }
  const negocio = await prisma.business.findUnique({
    where: { id: businessId },
    select: { shippingPaymentModalities: true },
  });
  // La zona no se resolvio. Si este negocio DISTINGUE por zona - o sea, alguna de sus tarifas o reglas
  // de ciudad declara sus propias modalidades - entonces su lista general no puede hablar por una ciudad
  // que el no clasifico, y COD_ALL no se hereda. Si no distingue por zona en ningun lado, su lista
  // general es la unica verdad que existe y sigue valiendo como antes: un negocio que nunca uso el
  // concepto no pierde nada.
  return { mods: negocio?.shippingPaymentModalities ?? [], zonaResuelta: !(await distinguePorZona(businessId)) };
}

/** ¿Este negocio declara modalidades zona por zona? Si lo hace, su lista general deja de ser autoridad sobre COD_ALL. */
async function distinguePorZona(businessId: string): Promise<boolean> {
  const [tarifas, reglas] = await Promise.all([
    prisma.shippingRate.findMany({ where: { businessId }, select: { paymentModalities: true } }),
    prisma.shippingCityRule.findMany({ where: { businessId }, select: { paymentModalities: true } }),
  ]);
  return [...tarifas, ...reglas].some((fila) => fila.paymentModalities.length > 0);
}

/**
 * La regla de plata, en una linea y en un solo lugar: cobrar TODO al recibir exige una zona resuelta que
 * lo admita. Sin zona no hay COD total, aunque el negocio lo tenga en su lista general.
 */
function admitePagoTotalAlRecibir(d: { mods: ShippingPaymentModality[]; zonaResuelta: boolean }): boolean {
  // Ciudad declarada que no cae en ninguna zona, en un negocio que SI clasifica por zona: no hay dato
  // que lo autorice, y este es el unico caso en que se niega por defecto.
  if (!d.zonaResuelta) return false;
  // Sin ninguna modalidad configurada no hay dato que lo contradiga: se mantiene el comportamiento
  // anterior a que estas listas existieran, igual que en el resto de este archivo.
  return d.mods.length === 0 || d.mods.includes("COD_ALL");
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
  if (admitePagoTotalAlRecibir(disponibles)) return metodos;
  // Una ciudad declarada que no cae en ninguna zona configurada tambien se filtra, aunque el negocio
  // tenga COD_ALL en su lista general: es el caso de Ocaña o Piedecuesta, donde nadie dijo que el
  // negocio llegue con un mensajero que cobre (2026-09-18).
  return metodos.filter((m) => m.settlement !== "ON_DELIVERY");
}
