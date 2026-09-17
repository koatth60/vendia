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

  if (has("total", "a pagar", "valor final")) {
    return formatPrice(facts.totalAmount, facts.currency, facts.locale);
  }
  if (has("envio", "flete", "domicilio")) {
    return facts.shippingCost != null ? formatPrice(facts.shippingCost, facts.currency, facts.locale) : null;
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
