import { normalizeForMatch } from "../../search/text";
import { formatPrice } from "../../config/money";

// EL PLACEHOLDER NO SE LE PIDE AL MODELO, LO RESUELVE EL SERVIDOR (2026-09-17).
//
// El defecto, tal cual le llego al cliente:
//
//   "Listo Andrés en total serían [Precio total (Productos + envio)] pesos a pagar contra entrega."
//
// CLOSING_MESSAGE_PROMPT le pedia al modelo que usara la plantilla de cierre del negocio "reemplazando
// cada placeholder con los datos reales". No lo hizo, y el mensaje salio igual: no habia nada que
// verificara el resultado antes de enviarlo.
//
// Dos piezas, en este orden:
//   1. Se sustituye en CODIGO todo placeholder que se pueda mapear a un dato real del pedido.
//   2. Si queda aunque sea UNO sin resolver, el mensaje NO sale. El llamador cae al cierre compuesto por
//      el servidor, que no tiene placeholders porque no tiene plantilla.
//
// La garantia la da el paso 2, no el 1: el paso 1 es comodidad (aprovecha la plantilla del negocio), el
// paso 2 es el que hace imposible que un corchete sin resolver llegue a un cliente. Por eso el mapeo por
// palabras clave es aceptable aca y no lo seria como unica defensa - cuando falla, falla hacia el
// mensaje seguro.

export interface ClosingFacts {
  customerName: string | null;
  summary: string;
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shippingCost: number | null;
  totalAmount: number;
  /**
   * Lo que el cliente paga AL RECIBIR (Order.amountOnDelivery). Null cuando no se resolvio la modalidad.
   *
   * Sin este dato, un placeholder que decia "a pagar contra entrega" caia en la regla de "total" y
   * resolvia al total del pedido. En un pedido donde el cliente ya pago el producto y solo debe el flete,
   * eso le dice al cliente que le debe al mensajero $154.000 cuando le debe $9.000.
   */
  amountOnDelivery: number | null;
  /** Lo que el cliente YA pago por adelantado: el total menos lo que paga al recibir. */
  amountPrepaid: number | null;
  /** El precio de los productos, sin el envio. */
  itemsTotal: number;
  currency: string;
  locale: string;
}

/**
 * Los dos formatos de placeholder que se ven en las plantillas que los duenos escriben a mano:
 * `[Precio total]` y `{{total}}`. No hay una tercera convencion inventada aca.
 */
const PLACEHOLDER = /\[([^\]\n]{1,80})\]|\{\{([^}\n]{1,80})\}\}/g;

/**
 * Que dato del pedido pide cada placeholder. El orden importa: "precio total del envio" tiene que caer en
 * total, no en envio, asi que las claves mas especificas van primero.
 */
function resolveField(label: string, facts: ClosingFacts): string | null {
  const l = normalizeForMatch(label);
  const has = (...words: string[]) => words.some((w) => l.includes(w));

  // Lo que se paga AL RECIBIR va primero, y por eso: "total a pagar contra entrega" tiene las dos
  // palabras, y la que manda es la que dice CUANDO. Sin modalidad resuelta devuelve null, o sea que el
  // placeholder queda sin resolver y el mensaje entero cae al cierre generico - preferible a mandarle al
  // cliente una cifra que no le corresponde pagar.
  // De lo mas especifico a lo mas general. Las tres primeras son CIFRAS distintas que en una plantilla se
  // escriben todas parecido, y confundirlas le dice al cliente que debe una plata que no debe.
  const esCifra = has("precio", "valor", "monto", "costo");

  if (has("contra entrega", "contraentrega", "al recibir", "al entregar", "contrapago")) {
    return facts.amountOnDelivery != null ? formatPrice(facts.amountOnDelivery, facts.currency, facts.locale) : null;
  }
  // "[Precio del monto cancelado]" - lo que el cliente ya transfirio, que en un pedido con flete
  // contraentrega NO es el total. Caso textual de la plantilla de un negocio real: sin esta regla el
  // placeholder no resolvia y el cierre entero caia al mensaje generico.
  if (has("cancelado", "pagado", "abonado", "transferido", "consignado")) {
    return facts.amountPrepaid != null ? formatPrice(facts.amountPrepaid, facts.currency, facts.locale) : null;
  }
  if (has("total", "a pagar", "valor final")) {
    return formatPrice(facts.totalAmount, facts.currency, facts.locale);
  }
  if (has("envio", "flete", "domicilio")) {
    return facts.shippingCost != null ? formatPrice(facts.shippingCost, facts.currency, facts.locale) : null;
  }
  // "[Precio del producto]" es una cifra; "[Producto]" a secas es el resumen. Sin esta distincion, al
  // cliente le llegaba "el valor cancelado del producto fue de 1x Reloj Serie 11 Mini pesos" - otro caso
  // textual de una plantilla real.
  if (esCifra && has("producto", "articulo", "mercancia")) {
    return formatPrice(facts.itemsTotal, facts.currency, facts.locale);
  }
  if (has("forma de pago", "metodo de pago", "medio de pago")) return facts.paymentMethodLabel;
  if (has("direccion", "domicilio de entrega", "entrega")) return facts.shippingAddress;
  if (has("nombre", "cliente", "destinatario")) return facts.customerName;
  if (has("producto", "pedido", "resumen", "articulo", "compra")) return facts.summary;
  return null;
}

export interface FilledClosing {
  text: string;
  /** Los placeholders que quedaron sin dato real. Si hay alguno, este texto NO se manda. */
  unresolved: string[];
}

export function fillClosingPlaceholders(text: string, facts: ClosingFacts): FilledClosing {
  const unresolved: string[] = [];
  const filled = text.replace(PLACEHOLDER, (match, corchetes?: string, llaves?: string) => {
    const label = (corchetes ?? llaves ?? "").trim();
    const value = resolveField(label, facts);
    if (value === null || value === "") {
      unresolved.push(match);
      return match;
    }
    return value;
  });
  return { text: filled, unresolved };
}
