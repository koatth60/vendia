import { prisma } from "../db/client";
import type { AgreedPriceSource } from "@prisma/client";
import { formatPrice } from "../config/money";

// EL PRECIO ACORDADO (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 12). Unico dueno de lectura/escritura de
// AgreedPrice: nada fuera de este archivo toca esa tabla.
//
// El defecto, medido en produccion el 2026-09-16 (conversacion cmu4gykpm003le82keve7ngck, negocio
// MAGByLizN): la duena escribio en el chat "Pro 3 70 / Alexa $65" y el agente siguio cobrando 75.000 y
// 70.000 - los del catalogo - dos veces seguidas, hasta que la clienta le dicto los precios ella misma.
// La causa no es que el modelo se haya olvidado: un precio acordado NO EXISTIA en la base, asi que el
// agente usaba lo unico que tenia.
//
// Desde aca, el precio de un item sale de la base y de ningun otro lado: el acordado si existe, el de
// catalogo si no. Esa es la decision que esta fase le quita al modelo.
//
// REGLA ABSOLUTA: un precio dicho por el CLIENTE nunca vale. Esta tabla tiene exactamente dos escritores
// y los dos son la duena - la confirmacion explicita de una PendingOwnerQuestion de kind PRICE
// (src/routes/whatsapp.ts) y el panel (src/routes/admin/conversations.ts). No existe un camino desde el
// mensaje de un cliente hasta aca, y hay una prueba que lo fija.

/** Un item con precio, en la forma que comparten SaleStateItem y ResolvedOrderItem. */
export interface PricedItem {
  productId: string;
  variantId?: string | null;
  unitPrice: number;
  currency: string;
}

export interface AgreedPriceEntry {
  productId: string;
  variantKey: string;
  unitPrice: number;
  currency: string;
}

/** Clave de un item: producto mas variante, con "" cuando no hay variante (ver AgreedPrice.variantKey). */
export function agreedKey(productId: string, variantId?: string | null): string {
  return `${productId}|${variantId ?? ""}`;
}

export type AgreedPriceMap = Map<string, AgreedPriceEntry>;

/**
 * El precio acordado de un item, o null. PURO: la decision de que gana esta escrita una sola vez, aca, y
 * no repetida en cada llamador.
 */
export function agreedUnitPriceOf(item: PricedItem, agreed: AgreedPriceMap): number | null {
  const found = agreed.get(agreedKey(item.productId, item.variantId));
  return found ? found.unitPrice : null;
}

/**
 * Los mismos items con el precio acordado aplicado donde existe. PURO, sin base: el catalogo queda como
 * el valor por DEFECTO y el acordado como la verdad, que es la regla entera de esta fase en una funcion.
 */
export function applyAgreedPrices<T extends PricedItem>(items: readonly T[], agreed: AgreedPriceMap): T[] {
  if (agreed.size === 0) return items.map((item) => ({ ...item }));
  return items.map((item) => {
    const price = agreedUnitPriceOf(item, agreed);
    return price === null ? { ...item } : { ...item, unitPrice: price };
  });
}

// ---------------------------------------------------------------------------
// La interpretacion de la respuesta de la duena: PROPUESTA, nunca precio vigente
// ---------------------------------------------------------------------------
//
// Sacar dos precios de "Pro 3 70 / Alexa $65" seria interpretar prosa, y este repositorio no admite un
// guard que adivina que quiso decir alguien. Lo que lo hace admisible es que la pregunta la hizo el
// SERVIDOR y sabe exactamente cuantas ranuras espera llenar: N items, un numero cada uno, en el orden en
// que se los numero. No es lectura libre, es llenar un formulario.
//
// Y aun asi el resultado no es un precio: es una PROPUESTA. El precio recien existe cuando la duena
// confirma la propuesta ya formateada que le devuelve el servidor. Si la respuesta no se resuelve sin
// ambiguedad, o si la confirmacion no llega, NO SE ESCRIBE NADA y se vuelve a preguntar con formato
// explicito. Nunca se adivina.
//
// Sin una sola expresion regular nueva: el barrido es caracter por caracter, igual que extractPrices en
// src/catalog/outputValidation.ts.

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isSeparator(char: string): boolean {
  return char === "." || char === "," || char === "'";
}

/**
 * Los numeros que trae un texto, en orden. Un separador seguido de EXACTAMENTE tres digitos es de miles
 * ("70.000" es setenta mil); seguido de uno o dos, es decimal ("65,50" es sesenta y cinco con cincuenta).
 * Es una regla de forma, no de intencion: no depende de que moneda sea ni de que quiso decir quien
 * escribio.
 */
export function extractNumbers(text: string): number[] {
  const found: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text[i])) {
      i++;
      continue;
    }
    let integer = "";
    while (i < text.length) {
      while (i < text.length && isDigit(text[i])) integer += text[i++];
      if (i >= text.length || !isSeparator(text[i])) break;
      // Cuantos digitos seguidos vienen despues del separador.
      let run = 0;
      while (i + 1 + run < text.length && isDigit(text[i + 1 + run])) run++;
      if (run !== 3) break;
      i++; // el separador de miles se descarta
    }
    let fraction = "";
    if (i < text.length && isSeparator(text[i])) {
      let run = 0;
      while (i + 1 + run < text.length && isDigit(text[i + 1 + run])) run++;
      if (run === 1 || run === 2) {
        i++;
        while (i < text.length && isDigit(text[i])) fraction += text[i++];
      }
    }
    const value = Number(fraction ? `${integer}.${fraction}` : integer);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/** Una ranura de la pregunta: un item del pedido con el precio que tiene HOY, escrito por el servidor. */
export interface PriceSlot {
  productId: string;
  variantKey: string;
  productName: string;
  variantLabel: string | null;
  quantity: number;
  /** El precio vigente cuando se mando la pregunta - el tope contra el que se valida la respuesta. */
  unitPrice: number;
  currency: string;
}

export type PriceReplyParse =
  | { ok: true; prices: number[] }
  | { ok: false; reason: "sin_numeros" | "cantidad_distinta"; found: number };

/**
 * La respuesta de la duena contra las ranuras de la pregunta. Un numero por ranura, en el mismo orden en
 * que se numeraron los items. Cualquier otra cantidad de numeros es ambigua por definicion - "Te dejaria
 * los dos en 135 mil / Pro 3 70 / Alexa $65" trae cuatro numeros para dos ranuras, y ahi el servidor
 * vuelve a preguntar en vez de elegir cuales dos son.
 */
export function parseOwnerPriceReply(text: string, slotCount: number): PriceReplyParse {
  const numbers = extractNumbers(text);
  if (numbers.length === 0) return { ok: false, reason: "sin_numeros", found: 0 };
  if (numbers.length !== slotCount) return { ok: false, reason: "cantidad_distinta", found: numbers.length };
  return { ok: true, prices: numbers };
}

export type PriceValidation = { ok: true } | { ok: false; reason: "no_positivo" | "mayor_al_catalogo"; slot: PriceSlot; value: number };

/**
 * Las validaciones las hace el SERVIDOR, en codigo, sin modelo: un precio por item, cada uno mayor que
 * cero y menor o igual al del catalogo. Un precio que no cumple se rechaza entero y se vuelve a
 * preguntar - no se corrige, no se acerca al valor mas parecido.
 *
 * El tope es el precio vigente al mandar la pregunta: un "descuento" por encima del catalogo no es un
 * descuento, y aceptarlo seria dejar que una respuesta mal escrita le suba el precio a un cliente.
 */
export function validateProposedPrices(slots: readonly PriceSlot[], prices: readonly number[]): PriceValidation {
  for (let i = 0; i < slots.length; i++) {
    const value = prices[i];
    const slot = slots[i];
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: "no_positivo", slot, value };
    if (value > slot.unitPrice) return { ok: false, reason: "mayor_al_catalogo", slot, value };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// La base
// ---------------------------------------------------------------------------

export async function getAgreedPrices(conversationId: string): Promise<AgreedPriceMap> {
  const rows = await prisma.agreedPrice.findMany({ where: { conversationId } });
  const map: AgreedPriceMap = new Map();
  for (const row of rows) {
    map.set(agreedKey(row.productId, row.variantKey || null), {
      productId: row.productId,
      variantKey: row.variantKey,
      unitPrice: Number(row.unitPrice),
      currency: row.currency,
    });
  }
  return map;
}

/**
 * Escribe (o pisa) los precios acordados de una conversacion. Los dos llamadores reales son la
 * confirmacion de la duena por WhatsApp y el panel; `source` dice cual fue, y no existe un tercer valor.
 */
export async function setAgreedPrices(
  conversationId: string,
  entries: readonly AgreedPriceEntry[],
  source: AgreedPriceSource
): Promise<void> {
  for (const entry of entries) {
    await prisma.agreedPrice.upsert({
      where: {
        conversationId_productId_variantKey: {
          conversationId,
          productId: entry.productId,
          variantKey: entry.variantKey,
        },
      },
      create: {
        conversationId,
        productId: entry.productId,
        variantKey: entry.variantKey,
        unitPrice: entry.unitPrice,
        currency: entry.currency,
        source,
      },
      update: { unitPrice: entry.unitPrice, currency: entry.currency, source },
    });
  }
}

/** Saca un precio acordado y devuelve el item al precio de catalogo. Lo usa el panel. */
export async function clearAgreedPrice(conversationId: string, productId: string, variantKey: string): Promise<boolean> {
  const deleted = await prisma.agreedPrice.deleteMany({ where: { conversationId, productId, variantKey } });
  return deleted.count > 0;
}

/**
 * Los precios acordados de esta conversacion, listos para entrar al turno como DATO ESTRUCTURADO - misma
 * forma que `productFacts` (7efb9f0) y que el bloque de pedidos del cliente (7a9c608): JSON leido de la
 * base, sin una sola directiva alrededor sobre que hacer con el. El modelo puede desobedecer una
 * instruccion; no puede ignorar un dato que tiene delante.
 *
 * Trae el precio de lista al lado del acordado a proposito: sin el, el agente no puede decirle al cliente
 * cuanto se le esta descontando, que es justo lo que la clienta del caso real pedia.
 */
export async function getAgreedPriceFacts(
  businessId: string,
  conversationId: string,
  opts: { currency: string; locale: string }
): Promise<{ producto: string; variante: string | null; precioAcordado: string; precioDeLista: string }[]> {
  const rows = await prisma.agreedPrice.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
  if (rows.length === 0) return [];
  const facts: { producto: string; variante: string | null; precioAcordado: string; precioDeLista: string }[] = [];
  for (const row of rows) {
    const product = await prisma.product.findFirst({
      where: { id: row.productId, businessId },
      select: { name: true, price: true, currency: true, variants: { select: { id: true, color: true, size: true } } },
    });
    if (!product) continue;
    const variant = row.variantKey ? product.variants.find((v) => v.id === row.variantKey) ?? null : null;
    const currency = product.currency || opts.currency;
    facts.push({
      producto: product.name,
      variante: variant ? [variant.color, variant.size].filter(Boolean).join(" / ") || null : null,
      precioAcordado: `$${formatPrice(Number(row.unitPrice), currency, opts.locale)}`,
      precioDeLista: `$${formatPrice(Number(product.price), currency, opts.locale)}`,
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Los textos que compone el SERVIDOR
// ---------------------------------------------------------------------------
//
// Los tres salen de datos leidos de la base y no tienen modelo adentro: la pregunta a la duena, la
// propuesta que tiene que confirmar y el aviso al cliente cuando el precio ya esta escrito. Ese ultimo
// es el que hace que esto sea garantia y no mitigacion - si el turno del agente falla, el precio igual
// existe y el cliente igual se entera.

function priceOf(value: number, currency: string, locale: string): string {
  return `$${formatPrice(value, currency, locale)}`;
}

function slotLabel(slot: PriceSlot): string {
  return `${slot.quantity}x ${slot.productName}${slot.variantLabel ? ` (${slot.variantLabel})` : ""}`;
}

/** Los items con su precio de hoy, numerados. El orden de esta lista ES el orden de las ranuras. */
export function formatPriceSlotsForOwner(slots: readonly PriceSlot[], locale: string): string {
  return slots.map((slot, i) => `${i + 1}. ${slotLabel(slot)} — ${priceOf(slot.unitPrice, slot.currency, locale)}`).join("\n");
}

/**
 * El formato explicito que se le pide a la duena. Es lo que hace que la respuesta sea llenar un
 * formulario y no escribir prosa: un numero por linea de arriba, en ese orden. El ejemplo se arma con
 * los precios reales para que no haya que adivinar la escala.
 */
export function ownerPriceFormatHint(slots: readonly PriceSlot[], locale: string): string {
  const ejemplo = slots.map((slot) => String(Math.trunc(slot.unitPrice))).join(", ");
  const cuantos = slots.length === 1 ? "el precio" : `los ${slots.length} precios, en ese mismo orden`;
  return [
    `Respondeme citando (mantén presionado y "Responder") este mismo mensaje con ${cuantos}, solo los números y en pesos completos.`,
    `Ejemplo con los precios de ahora: ${ejemplo}`,
    `Si no quieres hacer precio especial, responde "no".`,
  ].join("\n");
}

/**
 * La propuesta ya formateada que la duena tiene que confirmar. Hasta que responda que si, no hay ningun
 * precio acordado: esto es lo unico que existe.
 */
export function formatProposalForOwner(slots: readonly PriceSlot[], prices: readonly number[], locale: string): string {
  const lineas = slots.map((slot, i) => `${slotLabel(slot)} — ${priceOf(prices[i], slot.currency, locale)}`).join("\n");
  return [`¿Confirmás estos precios para este cliente?`, lineas, `Respondé "si" o "no" citando este mensaje.`].join("\n\n");
}

/**
 * Lo que se le dice al cliente cuando el precio ya quedo escrito. Texto FIJO del servidor con cifras
 * leidas de la base: es el fallback sin modelo adentro que exige la regla de admision de efectos
 * requeridos, y corre siempre, tambien cuando el turno del agente anduvo bien.
 */
export function formatAgreedPricesForCustomer(slots: readonly PriceSlot[], prices: readonly number[], locale: string): string {
  const lineas = slots
    .map((slot, i) => `${slot.productName}${slot.variantLabel ? ` (${slot.variantLabel})` : ""}: ${priceOf(prices[i], slot.currency, locale)}`)
    .join("\n");
  return `¡Buenas noticias! Te confirmo el precio especial:\n\n${lineas}`;
}

/** Las ranuras guardadas en PendingOwnerQuestion.payload, releidas con la forma esperada o vacio. */
export function parsePriceSlots(payload: unknown): PriceSlot[] {
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (slot): slot is PriceSlot =>
      !!slot &&
      typeof slot === "object" &&
      typeof (slot as PriceSlot).productId === "string" &&
      typeof (slot as PriceSlot).unitPrice === "number" &&
      typeof (slot as PriceSlot).productName === "string"
  );
}

/** La propuesta guardada en PendingOwnerQuestion.payload, si el servidor ya interpreto una respuesta. */
export function parseProposedPrices(payload: unknown): number[] | null {
  const propuesta = (payload as { propuesta?: unknown } | null)?.propuesta;
  if (!Array.isArray(propuesta)) return null;
  const prices = propuesta.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return prices.length === propuesta.length && prices.length > 0 ? prices : null;
}
