import { prisma } from "../db/client";
import { contradiceLaModalidad } from "../catalog/pagoSegunModalidad";
import type { ShippingPaymentModality } from "@prisma/client";
import { getProductById } from "../catalog/products";
import { resolveShippingRateForCity } from "../catalog/shippingRates";
import { computeCheckoutState, type CheckoutFacts, type CheckoutState } from "./checkoutState";
import { getBusinessLocale } from "../config/businessConfig";
import { getAgreedPrices, applyAgreedPrices } from "./agreedPrices";
import { Money, sumarParaMostrar, totalDeLinea } from "../config/dinero";
import { precioDeVenta, precioDeVentaConPromocion } from "../catalog/precioDeVenta";
import { promocionesVigentes, descuentoDeCarrito } from "../catalog/promotions";

// Fase 2 del plan maestro (2026-09-15), causa raiz C1. Unico dueno de lectura/escritura de SaleState -
// ver ONIX-PLAN-MAESTRO.md seccion 1.3 y 4 (Fase 2) para el diseno completo. Nada fuera de este archivo
// escribe la tabla SaleState directamente.
//
// Principio del plan: "se deriva, no se duplica". `missing`, `subtotal`, `total`, `shippingCost` (y la
// ciudad/zona de envio) NUNCA se guardan - se recalculan aca mismo en cada lectura a partir de `items` y
// `address`, reusando computeCheckoutState (orders/checkoutState.ts) tal cual ya existe, para que nunca
// puedan desincronizarse de la base real.

export interface SaleStateItem {
  productId: string;
  productName: string;
  variantId: string | null;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  currency: string;
}

export interface SaleStateSnapshot {
  conversationId: string;
  items: SaleStateItem[];
  customerName: string | null;
  idNumber: string | null;
  deliveryPhone: string | null;
  address: string | null;
  city: string | null;
  shippingLabel: string | null;
  shippingCost: number | null;
  /** Descuento del pedido entero (Promotion con alcance CART). 0 si el negocio no tiene ninguna. */
  cartDiscount: number;
  /** Nombre de esa promocion, para poder nombrarla en el resumen. null si no aplico ninguna. */
  cartDiscountLabel: string | null;
  shippingModality: ShippingPaymentModality | null;
  paymentMethodId: string | null;
  paymentMethodLabel: string | null;
  blockedBy: string | null;
  checkout: CheckoutState;
  subtotal: number;
  total: number;
}

export interface SaleStateToolError {
  ok: false;
  reason: string;
  error: string;
  availableVariants?: { id: string; color: string | null; size: string | null }[];
  availableStock?: number;
  validCodes?: string[];
  validMethods?: { id: string; label: string }[];
}

async function isEnabled(businessId: string): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { saleStateEnabled: true } });
  return business?.saleStateEnabled ?? false;
}

function parseItems(raw: unknown): SaleStateItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is SaleStateItem =>
      i && typeof i === "object" && typeof (i as SaleStateItem).productId === "string" && typeof (i as SaleStateItem).quantity === "number"
  );
}

// Misma extraccion que checkoutStateFromDb.ts ya usaba: la ciudad no tiene campo propio, se infiere de
// la direccion probando cada linea/segmento contra las reglas reales del negocio (ShippingCityRule).
async function resolveCityAndShipping(
  businessId: string,
  address: string | null
): Promise<{ city: string | null; label: string | null; cost: number | null }> {
  if (!address) return { city: null, label: null, cost: null };
  for (const trozo of address.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)) {
    const tarifa = await resolveShippingRateForCity(businessId, trozo);
    if (tarifa) return { city: trozo, label: tarifa.label, cost: Number(tarifa.cost) };
  }
  return { city: null, label: null, cost: null };
}

// Lee el estado completo, con fallback al perfil del Customer para lo que esta conversacion todavia no
// escribio (ver comentario del modelo en schema.prisma) - asi un cliente que vuelve no pierde lo que ya
// dio antes, pero cualquier dato nuevo que escriba EN esta conversacion manda sobre lo viejo.
export async function getSaleState(conversationId: string): Promise<SaleStateSnapshot | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      saleState: true,
      customer: { select: { businessId: true, name: true, idNumber: true, deliveryPhone: true, address: true } },
    },
  });
  if (!conversation) return null;
  const { businessId } = conversation.customer;
  const state = conversation.saleState;

  const customerName = state?.customerName ?? conversation.customer.name;
  const idNumber = state?.idNumber ?? conversation.customer.idNumber;
  const deliveryPhone = state?.deliveryPhone ?? conversation.customer.deliveryPhone;
  const address = state?.address ?? conversation.customer.address;
  // EL PRECIO ACORDADO (2026-09-16). Se aplica al LEER y no al escribir, por el mismo principio que ya
  // rige este archivo ("se deriva, no se duplica"): la duena puede autorizar un descuento despues de que
  // el item ya estaba en el pedido - que es exactamente lo que paso en el caso real - y un precio escrito
  // en el momento del set_order_item se habria quedado con el del catalogo para siempre. Asi el subtotal
  // y el total de abajo salen solos del precio correcto.
  const items = applyAgreedPrices(parseItems(state?.items), await getAgreedPrices(conversationId));

  const { city, label: shippingLabel, cost: shippingCost } = await resolveCityAndShipping(businessId, address);

  let paymentMethodLabel: string | null = null;
  if (state?.paymentMethodId) {
    const method = await prisma.paymentMethod.findFirst({ where: { id: state.paymentMethodId, businessId } });
    paymentMethodLabel = method?.label ?? null;
  }

  let varianteFaltante = false;
  for (const item of items) {
    if (item.variantId) continue;
    const product = await prisma.product.findFirst({
      where: { id: item.productId, businessId },
      select: { variants: { where: { active: true }, select: { id: true } } },
    });
    if ((product?.variants.length ?? 0) > 0) {
      varianteFaltante = true;
      break;
    }
  }

  // Fase 11: el pais y la regla de documento salen de Business, no de una constante colombiana.
  const negocio = await getBusinessLocale(businessId);

  const facts: CheckoutFacts = {
    pais: negocio.countryCode,
    productos: items.map((i) => ({ nombre: i.productName, cantidad: i.quantity, variante: i.variantLabel })),
    varianteFaltante,
    nombre: customerName,
    documento: idNumber,
    telefono: deliveryPhone,
    ciudad: city,
    direccion: address,
    formaPago: paymentMethodLabel,
    zonaEnvio: shippingLabel,
  };
  const checkout = computeCheckoutState(facts, negocio.requirements);

  // E33 (2026-09-18): el mismo arreglo que en createOrder, y por el mismo motivo -- este es el total que
  // el bot le DICE a la clienta antes de comprar. Si difiere del que despues se guarda en el pedido, la
  // clienta ve un precio y le cobran otro.
  //
  // `sumar` tira si las lineas traen monedas distintas. Aca eso no se deja explotar hacia el cliente: un
  // pedido a medio armar con monedas mezcladas no puede tumbar la conversacion entera, asi que se cae al
  // total viejo y se grita en los logs. En createOrder SI se deja explotar, porque ahi hay plata de
  // verdad y un pedido mal sumado es peor que un pedido que no se crea.
  const moneda = items[0]?.currency ?? "COP";
  const subtotalExacto = sumarParaMostrar(
    items.map((i) => totalDeLinea(i.unitPrice, i.quantity, i.currency)),
    moneda,
    `el pedido en curso de la conversacion ${conversationId}`,
  );
  const subtotal = subtotalExacto.comoNumeroParaMostrar();

  // DESCUENTO DEL PEDIDO ENTERO (2026-09-19). Sale de una Promotion con alcance CART, que el camino por
  // linea ignora a proposito -- ver descuentoDeCarrito y el comentario de PromotionScope.CART. Sin
  // ninguna cargada da cero y el total es exactamente el de antes.
  //
  // Se cuenta `items.length` (productos distintos) y no la suma de unidades: es lo que significa
  // "llevando dos productos" en la FAQ de un negocio.
  const { descuento: descuentoCarrito, promocion: promocionDeCarrito } = descuentoDeCarrito(
    await promocionesVigentes(businessId),
    subtotalExacto,
    items.length,
  );
  const total = subtotalExacto
    .menos(descuentoCarrito)
    .mas(Money.de(shippingCost ?? 0, moneda))
    .comoNumeroParaMostrar();

  return {
    conversationId,
    items,
    cartDiscount: descuentoCarrito.comoNumeroParaMostrar(),
    cartDiscountLabel: promocionDeCarrito?.name ?? null,
    customerName,
    idNumber,
    deliveryPhone,
    address,
    city,
    shippingLabel,
    shippingCost,
    shippingModality: state?.shippingModality ?? null,
    paymentMethodId: state?.paymentMethodId ?? null,
    paymentMethodLabel,
    blockedBy: state?.blockedBy ?? null,
    checkout,
    subtotal,
    total,
  };
}

// Texto fijo que agent.ts inyecta como mensaje system en cada turno (mismo canal que ya usa "FOTOS/
// VIDEOS YA ENVIADOS") - el modelo lo lee, nunca lo escribe.
//
// UN PEDIDO EN CURSO QUE NO EXISTE NO SE ANUNCIA (2026-09-17, etapa E03 de ONIX-PLAN.md).
//
// Hasta hoy la condicion era `items.length === 0 && faltan.length === 0`, que no se cumple nunca:
// sin productos elegidos, `computeCheckoutState` siempre tiene algo en `faltan`. O sea que el bloque
// salia SIEMPRE, incluso cuando no habia ninguna venta en curso.
//
// EL DEFECTO QUE CIERRA, medido en produccion. Andres escribio el 2026-09-17 a las 11:42 preguntando
// por un pedido que ya estaba despachado. No habia ninguna venta en curso. El bloque igual salio, y
// decia:
//
//   PEDIDO EN CURSO: (todavia sin productos). Falta: que producto quieres y cuantas unidades, tu
//   nombre y apellido, tu barrio, la direccion exacta, y si es casa o apartamento con piso, como
//   prefieres pagar.
//
// El modelo le pidio exactamente eso. **No desobedecio: obedecio un dato falso que le dimos nosotros.**
// El mismo dia le paso a Ariadna. Este era el defecto, y no estaba en el modelo.
//
// La regla nueva: sin un solo producto elegido no hay venta en curso, y lo que falte para despachar
// todavia no falta - no hay nada que despachar. En cuanto el cliente elige un producto el bloque
// aparece con lo que falta, igual que antes. Quien el cliente ES sigue viajando en todos los turnos,
// en su propio bloque y como dato (src/crm/customerFacts.ts), que es donde corresponde: los datos de
// la persona no son el estado de una venta.
export function formatSaleStateForPrompt(state: SaleStateSnapshot): string {
  if (state.items.length === 0) return "";
  const itemsText =
    state.items.length > 0
      ? state.items.map((i) => `${i.quantity}x ${i.productName}${i.variantLabel ? ` (${i.variantLabel})` : ""}`).join(", ")
      : "(todavia sin productos)";
  const faltan = state.checkout.faltan.length > 0 ? state.checkout.faltan.join(", ") : "nada, ya esta completo";
  return `PEDIDO EN CURSO: ${itemsText}. Falta: ${faltan}.`;
}

async function upsertSaleState(conversationId: string, data: Record<string, unknown>) {
  return prisma.saleState.upsert({
    where: { conversationId },
    create: { conversationId, ...data },
    update: data,
  });
}

export async function setOrderItem(
  businessId: string,
  conversationId: string,
  input: { productId: string; variantId?: string | null; quantity: number }
): Promise<{ ok: true; item: SaleStateItem; state: SaleStateSnapshot } | SaleStateToolError> {
  const quantity = Math.floor(Number(input.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { ok: false, reason: "invalid_quantity", error: "La cantidad tiene que ser un numero entero de al menos 1." };
  }

  const product = await getProductById(businessId, input.productId);
  if (!product || !product.active) {
    return { ok: false, reason: "product_not_found", error: `No se encontro ningun producto activo con id "${input.productId}".` };
  }

  const activeVariants = product.variants.filter((v) => v.active);
  let variantId: string | null = null;
  let variantLabel: string | null = null;
  let stock = product.stock;
  let varianteElegida: { price: import("@prisma/client").Prisma.Decimal | null } | null = null;

  if (activeVariants.length > 0) {
    if (!input.variantId) {
      return {
        ok: false,
        reason: "needs_variant",
        error: `"${product.name}" tiene variantes - falta elegir cual.`,
        availableVariants: activeVariants.map((v) => ({ id: v.id, color: v.color, size: v.size })),
      };
    }
    const variant = activeVariants.find((v) => v.id === input.variantId);
    if (!variant) {
      return {
        ok: false,
        reason: "invalid_variant",
        error: `La variante "${input.variantId}" no existe o no esta activa en "${product.name}".`,
        availableVariants: activeVariants.map((v) => ({ id: v.id, color: v.color, size: v.size })),
      };
    }
    variantId = variant.id;
    variantLabel = [variant.color, variant.size].filter(Boolean).join(" / ") || null;
    stock = variant.stock;
    // E36: la variante elegida se retiene para ponerle precio a la linea. Antes solo se usaba para el
    // stock y la etiqueta, y el precio salia del producto aunque la XL costara mas que la S.
    varianteElegida = variant;
  }

  if (quantity > stock) {
    return {
      ok: false,
      reason: "insufficient_stock",
      error: `Solo quedan ${stock} unidades disponibles de "${product.name}"${variantLabel ? ` (${variantLabel})` : ""}.`,
      availableStock: stock,
    };
  }

  const current = await getSaleState(conversationId);
  const items = current?.items ?? [];
  const key = (i: SaleStateItem) => `${i.productId}|${i.variantId ?? ""}`;
  const newItem: SaleStateItem = {
    productId: product.id,
    productName: product.name,
    variantId,
    variantLabel,
    quantity,
    // E36: el precio de la VARIANTE cuando la tiene; el del producto cuando no. E37: con la promocion
    // del negocio ya aplicada. Un solo lugar decide esto (src/catalog/precioDeVenta.ts), compartido con
    // createOrder: si divergieran, la clienta veria un precio mientras arma el pedido y le cobrarian
    // otro al cerrarlo.
    unitPrice: precioDeVentaConPromocion(product, varianteElegida, {
      promociones: await promocionesVigentes(businessId),
      cantidad: quantity,
    }).precio.comoNumeroParaMostrar(),
    currency: product.currency,
  };
  const thisKey = `${product.id}|${variantId ?? ""}`;
  const nextItems = [...items.filter((i) => key(i) !== thisKey), newItem];

  await upsertSaleState(conversationId, { items: nextItems });
  const state = await getSaleState(conversationId);
  return { ok: true, item: newItem, state: state! };
}

export async function removeOrderItem(
  conversationId: string,
  input: { productId: string; variantId?: string | null }
): Promise<{ ok: true; state: SaleStateSnapshot } | SaleStateToolError> {
  const current = await getSaleState(conversationId);
  const items = current?.items ?? [];
  const nextItems = input.variantId
    ? items.filter((i) => !(i.productId === input.productId && i.variantId === input.variantId))
    : items.filter((i) => i.productId !== input.productId);

  if (nextItems.length === items.length) {
    return { ok: false, reason: "not_found", error: "No hay ese producto en el pedido en curso." };
  }

  await upsertSaleState(conversationId, { items: nextItems });
  const state = await getSaleState(conversationId);
  return { ok: true, state: state! };
}

export async function setShippingModality(
  businessId: string,
  conversationId: string,
  code: string
): Promise<{ ok: true; state: SaleStateSnapshot } | SaleStateToolError> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { shippingPaymentModalities: true } });
  const valid = business?.shippingPaymentModalities ?? [];
  if (!valid.includes(code as ShippingPaymentModality)) {
    return {
      ok: false,
      reason: "invalid_modality",
      error: `"${code}" no es una modalidad de pago de envio configurada por este negocio.`,
      validCodes: valid,
    };
  }
  await upsertSaleState(conversationId, { shippingModality: code as ShippingPaymentModality });
  const state = await getSaleState(conversationId);
  return { ok: true, state: state! };
}

export async function setPaymentMethod(
  businessId: string,
  conversationId: string,
  paymentMethodId: string
): Promise<{ ok: true; state: SaleStateSnapshot } | SaleStateToolError> {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, businessId, active: true } });
  if (!method) {
    const active = await prisma.paymentMethod.findMany({ where: { businessId, active: true }, select: { id: true, label: true } });
    return {
      ok: false,
      reason: "invalid_payment_method",
      error: `El metodo de pago "${paymentMethodId}" no existe o no esta activo en este negocio.`,
      validMethods: active,
    };
  }
  // E15b: un metodo que contradice la modalidad ya elegida NO se guarda en silencio.
  //
  // En la conversacion de Dennis (2026-09-18) el cliente eligio "Contraentrega" para el envio y despues
  // "Nequi" para el producto; el pedido quedo con Contraentrega y nadie le dijo que su segunda respuesta
  // se habia descartado. Elegir dos veces y que una se pierda sin avisar es peor que preguntar una vez.
  //
  // La contradiccion se calcula, no se interpreta: PaymentMethod.settlement contra
  // SaleState.shippingModality (ver src/catalog/pagoSegunModalidad.ts). Rechazarla frena el cierre, que
  // es lo que pide la etapa: el pedido no avanza hasta que el cliente resuelva cual de las dos vale.
  const actual = await getSaleState(conversationId);
  const choque = contradiceLaModalidad(method, actual?.shippingModality ?? null);
  if (choque) {
    return { ok: false, reason: "contradice_la_modalidad", error: choque };
  }

  await upsertSaleState(conversationId, { paymentMethodId: method.id });
  const state = await getSaleState(conversationId);
  return { ok: true, state: state! };
}

// Llamado por save_customer_contact_info/save_customer_name en tools.ts - dual-write ademas de lo que
// esas herramientas ya guardan en Customer (ver comentario del modelo SaleState en schema.prisma sobre
// por que no alcanza con leer solo Customer).
//
// 2026-09-15: dejo de estar detras de Business.saleStateEnabled. La bandera mezclaba dos cosas distintas
// y ahora estan separadas: REGISTRAR el estado corre siempre (es una proyeccion del servidor de lo que
// ya paso), EXPONER y APLICAR ese estado - las saleStateTools en el esquema, getSaleState inyectado al
// prompt, blockedBy, el directive del prompt - sigue solo con la bandera. Con la bandera apagada el
// cliente ve exactamente lo mismo que antes y el prompt pesa exactamente lo mismo; lo unico que cambia
// es que queda rastro en la base, que es de donde sale el disparador de los efectos requeridos.
export async function saveDeliveryDataToSaleState(
  conversationId: string,
  data: { customerName?: string; idNumber?: string; deliveryPhone?: string; address?: string }
): Promise<void> {
  const payload: Record<string, string> = {};
  if (data.customerName) payload.customerName = data.customerName;
  if (data.idNumber) payload.idNumber = data.idNumber;
  if (data.deliveryPhone) payload.deliveryPhone = data.deliveryPhone;
  if (data.address) payload.address = data.address;
  if (Object.keys(payload).length === 0) return;
  await upsertSaleState(conversationId, payload);
}

// Fase 4 del plan maestro (2026-09-15), causa raiz C2: la escalacion al dueno pasa a ser un estado real
// en vez de una frase que el modelo inventa. blockedBy es deliberadamente independiente de
// saleStateEnabled (a diferencia del resto de este archivo) - no llevar el pedido no es motivo para
// dejar que el bot prometa consultas que nunca hace, asi que esto corre para cualquier negocio.
export async function getBlockedBy(conversationId: string): Promise<string | null> {
  const state = await prisma.saleState.findUnique({ where: { conversationId }, select: { blockedBy: true } });
  return state?.blockedBy ?? null;
}

export async function setBlockedBy(conversationId: string, reason: string): Promise<void> {
  await upsertSaleState(conversationId, { blockedBy: reason });
}

// Llamado desde conversation/service.ts cada vez que se borra una PendingOwnerQuestion (respuesta del
// dueno por WhatsApp, resolucion manual desde el panel, o limpieza masiva) - solo desbloquea si no queda
// ninguna otra pregunta pendiente en la misma conversacion.
export async function clearBlockedByIfNoPendingQuestions(conversationId: string): Promise<void> {
  // E56: solo las ABIERTAS. Desde que resolver es marcar y no borrar, contar todas dejaria la
  // conversacion bloqueada para siempre por una pregunta que el dueno ya contesto.
  const stillPending = await prisma.pendingOwnerQuestion.count({ where: { conversationId, resolvedAt: null } });
  if (stillPending > 0) return;
  await prisma.saleState.updateMany({ where: { conversationId, blockedBy: { not: null } }, data: { blockedBy: null } });
}

// Fase 5 del plan maestro (2026-09-15), causa raiz C2: lista de fotos/videos ya mandados de verdad en
// esta conversacion, escrita por tools.ts en el momento del envio real (send_product_media,
// get_product_details auto-send) - reemplaza reconstruirla leyendo el historial con
// MEDIA_CAPTION_PATTERN. Independiente de saleStateEnabled, igual que blockedBy: no repetir una foto ya
// mandada no es una funcion del motor de venta.
export async function getMediaSent(conversationId: string): Promise<string[]> {
  const state = await prisma.saleState.findUnique({ where: { conversationId }, select: { mediaSent: true } });
  return state?.mediaSent ?? [];
}

// Proyeccion del servidor: los items que el cliente REALMENTE vio en un resumen de pedido. Los escribe
// show_order_summary con lo que ya resolvio contra el catalogo (resolveOrderItems valida nombre, variante
// y precio linea por linea), nunca con lo que el modelo escribio en prosa. Con saleStateEnabled activo el
// resumen ya sale de SaleState, asi que ahi no se llama: no hay nada que espejar.
export async function recordOrderItemsShown(conversationId: string, items: SaleStateItem[]): Promise<void> {
  if (items.length === 0) return;
  await upsertSaleState(conversationId, { items });
}

// Proyeccion del servidor: la ciudad para la que get_shipping_rate_for_city encontro una tarifa real.
// Solo se escribe cuando hubo match contra ShippingCityRule, o sea cuando la ciudad existe en la
// configuracion del negocio - no cuando el cliente la nombro.
export async function recordShippingCity(conversationId: string, city: string): Promise<void> {
  await upsertSaleState(conversationId, { shippingCity: city });
}

/**
 * Lo que el SERVIDOR escribio sobre esta conversacion, leido crudo de la fila y sin ninguna derivacion.
 * Es la unica entrada del disparador de efectos requeridos: nada de esto lo escribe el modelo ni el
 * cliente. Deliberadamente separado de getSaleState - ese calcula ciudad, envio, faltantes y checkout, y
 * alimenta el prompt de los negocios con la bandera activa; tocarlo cambiaria esos prompts.
 */
export async function getServerSaleEvidence(
  conversationId: string
): Promise<{ items: SaleStateItem[]; mediaSent: string[]; shippingCity: string | null }> {
  const state = await prisma.saleState.findUnique({
    where: { conversationId },
    select: { items: true, mediaSent: true, shippingCity: true },
  });
  return {
    items: parseItems(state?.items),
    mediaSent: state?.mediaSent ?? [],
    shippingCity: state?.shippingCity ?? null,
  };
}

export async function recordMediaSent(conversationId: string, label: string): Promise<void> {
  const current = await getMediaSent(conversationId);
  if (current.includes(label)) return;
  await prisma.saleState.upsert({
    where: { conversationId },
    create: { conversationId, mediaSent: [label] },
    update: { mediaSent: { push: label } },
  });
}

// EL SERVIDOR REGISTRA CUANDO EL CLIENTE VIO LOS DATOS DE PAGO (2026-09-18), independiente de que el
// modelo haya llamado get_payment_methods. Ver el comentario de SaleState.paymentDataShownAt en
// schema.prisma y momentoEnQueSePasaronLosDatosDePago en orders/paymentProof.ts, que es quien lo lee.
// Se escribe una sola vez: la primera vez que el bloque salio es el momento real, y sobreescribirlo en
// cada turno siguiente correria la fecha hacia adelante sin motivo.
export async function recordPaymentDataShown(conversationId: string): Promise<void> {
  const state = await prisma.saleState.findUnique({ where: { conversationId }, select: { paymentDataShownAt: true } });
  if (state?.paymentDataShownAt) return;
  await prisma.saleState.upsert({
    where: { conversationId },
    create: { conversationId, paymentDataShownAt: new Date() },
    update: { paymentDataShownAt: new Date() },
  });
}

// Fase 5 del plan maestro (2026-09-15): reemplazo del contador de rondas de identificacion por foto que
// antes se calculaba escaneando el historial con PHOTO_ID_CLARIFY_PATTERN (una frase del modelo). Ahora
// es un contador de verdad: agent.ts lo sube cuando el cliente manda una foto/video y el turno no la
// resuelve (ni un envio real ni una escalacion al dueno), y lo resetea apenas se resuelve.
export async function getPhotoIdStreak(conversationId: string): Promise<number> {
  const state = await prisma.saleState.findUnique({ where: { conversationId }, select: { photoIdStreak: true } });
  return state?.photoIdStreak ?? 0;
}

export async function bumpPhotoIdStreak(conversationId: string): Promise<void> {
  await prisma.saleState.upsert({
    where: { conversationId },
    create: { conversationId, photoIdStreak: 1 },
    update: { photoIdStreak: { increment: 1 } },
  });
}

export async function resetPhotoIdStreak(conversationId: string): Promise<void> {
  await prisma.saleState.updateMany({ where: { conversationId, photoIdStreak: { not: 0 } }, data: { photoIdStreak: 0 } });
}

export { isEnabled as isSaleStateEnabled };
