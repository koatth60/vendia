import { prisma } from "../db/client";
import type { OrderFulfillmentStatus, ShippingPaymentModality } from "@prisma/client";
import { OrderFulfillmentStatus as OrderFulfillmentStatusEnum } from "@prisma/client";
import { montoACobrarAlEntregar } from "./paymentTiming";
import { findConfidentProductMatch, getProductById } from "../catalog/products";
import { canonicalColors } from "../catalog/attributeTaxonomy";
import { normalizeForMatch, escapeForRegExp } from "../search/text";
import { sendToCustomer, type WhatsappCredentials } from "../whatsapp/outbound";
import { getPresignedMediaUrl } from "../media/s3";
import { emitOrderNew, emitOrderUpdated } from "../realtime/events";
import { getAgreedPrices, applyAgreedPrices, agreedUnitPriceOf } from "./agreedPrices";
import { recalcularEtapaDelCliente } from "../crm/customers";
import { transicionarPedido, TransicionNoPermitida, ESTADOS_CANCELABLES, estadosQueElBotPuedeCancelar, type Actor, type TxCliente } from "./stateMachine";
import { Money, sumar } from "../config/dinero";
import { precioDeVenta, precioDeVentaConPromocion } from "../catalog/precioDeVenta";
import { promocionesVigentes, descuentoDeCarrito } from "../catalog/promotions";
import { obtenerCombo, buscarComboPorNombre, listarCombos } from "../catalog/bundles";

export interface ResolvedOrderItem {
  // E38: en la linea de un COMBO esto va vacio y `bundleId` trae el combo. Un combo no es un producto
  // del catalogo: no tiene stock propio ni precio por variante, y su contenido son otras filas.
  productId: string;
  productName: string;
  /** E38: el combo que se vendio en esta linea, cuando la linea es un combo. */
  bundleId?: string | null;
  variantId?: string | null;
  variantLabel?: string | null;
  quantity: number;
  /** El precio que se cobra: el acordado con la duena si existe para esta conversacion, si no el de catalogo. */
  unitPrice: number;
  /**
   * El precio acordado, cuando lo hay (ver src/orders/agreedPrices.ts). null = se cobra el de catalogo.
   * `unitPrice` ya trae el valor efectivo en los dos casos; esto existe para poder DECIR de donde salio.
   */
  agreedUnitPrice?: number | null;
  currency: string;
}

export interface OrderItemInput {
  // Nombre libre (fuzzy match via findConfidentProductMatch) - unico dato disponible cuando viene del
  // modelo (nunca conoce el productId real) o del cuerpo viejo de close-sale (compatibilidad).
  productName?: string;
  // Cuando el llamador ya conoce el producto real (el panel, con su selector) - resuelve por id, sin
  // puntaje ni empate posible. Se valida que sea de este negocio y este activo (getProductById no filtra
  // por active, a diferencia de findConfidentProductMatch). productName se usa igual como texto para
  // `unresolved` si este id no resuelve.
  productId?: string;
  // Igual que productId pero para la variante (color/talla) - se valida que pertenezca a ese producto y
  // este activa. Si se da, reemplaza el matching por variantLabel de abajo.
  variantId?: string;
  // E38: el id real de un combo (tabla Bundle). Cuando viene, la linea es el combo entero: su precio es
  // el del combo, no la suma de sus partes, y el stock que se mueve es el de cada componente.
  bundleId?: string;
  quantity: number;
  // Free text describing which color/size the customer picked (e.g. "rojo", "rojo talla M") - solo se usa
  // cuando no vino variantId. Matched by the same color-synonym canonicalization used for catalog search,
  // not exact string equality.
  variantLabel?: string;
}

export interface ResolveOrderItemsResult {
  items: ResolvedOrderItem[];
  unresolved: string[];
  // Product names that DO have variants (color/size options) but the given variantLabel didn't resolve
  // to exactly one of them - either nothing was given, or it matched more than one equally. Real
  // production incident (2026-09-12): a sale closed without ever asking the customer's color. The caller
  // must refuse to close the sale while this is non-empty, not just warn about it like `unresolved`.
  needsAttribute: string[];
}

type VariantForMatch = { id: string; color: string | null; size: string | null; active: boolean };

// Scored the same way findConfidentProductMatch scores products: a hit on color (2) or size (2), refuse
// to guess on a tie or on zero evidence - see that function's comment for the "why weak evidence isn't
// enough to commit to a real order line" rationale, same logic applies here one level down.
// GENERICA desde E36 (2026-09-18): antes devolvia el tipo angosto `VariantForMatch`, asi que la variante
// que salia de aca perdia el resto de sus campos -- entre ellos el precio, que es justo lo que E36 vino a
// usar. Generica, devuelve la MISMA fila que entro, con todo lo que traiga.
function matchVariant<V extends VariantForMatch>(variants: V[], label: string): { variant: V | null; ambiguous: boolean } {
  const active = variants.filter((v) => v.active);
  if (active.length === 0) return { variant: null, ambiguous: false };
  if (active.length === 1) return { variant: active[0], ambiguous: false };

  const labelColors = canonicalColors(label);
  const labelNorm = normalizeForMatch(label);

  const scored = active
    .map((v) => {
      let score = 0;
      // Full set, not just the first canonical color - a variant labeled "negro/dorado" has two, and a
      // customer asking for "dorado" must still match it (reliability plan Phase 3, item 1, 2026-09-13).
      if (v.color && canonicalColors(v.color).some((c) => labelColors.includes(c))) score += 2;
      // Word-boundary check, not a raw substring - "labelNorm.includes(size)" used to let a variant sized
      // "M" match any customer text containing an "m" anywhere, e.g. "morado" (Phase 3, item 2).
      if (v.size) {
        const sizeNorm = normalizeForMatch(v.size).trim();
        if (sizeNorm && new RegExp(`(^|[^a-z0-9])${escapeForRegExp(sizeNorm)}($|[^a-z0-9])`, "i").test(labelNorm)) {
          score += 2;
        }
      }
      return { v, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { variant: null, ambiguous: false };
  const tied = scored.filter((s) => s.score === scored[0].score);
  if (tied.length > 1) return { variant: null, ambiguous: true };
  return { variant: scored[0].v, ambiguous: false };
}

function formatVariantLabel(color: string | null, size: string | null): string | null {
  const parts = [color, size].filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

// Matches by confidence (findConfidentProductMatch), not a blind top-of-search-results guess - a weak
// or ambiguous match here used to silently record the wrong product (and its price) on a real order.
// Items that still can't be matched confidently are reported back in `unresolved` instead of vanishing
// silently - the free-text summary carries them too, but now the caller can act on it (e.g. warn the
// owner) instead of the structured order record just quietly being short a line.
// Two input lines resolving to the same product+variant (the model split one item across two tool-call
// entries, or the customer's order was described twice) are merged into one line with summed quantity,
// instead of creating duplicate OrderItem rows.
export async function resolveOrderItems(
  businessId: string,
  items: OrderItemInput[] | undefined,
  // EL PRECIO ACORDADO (2026-09-16): con la conversacion en mano, el precio de cada linea sale de la base
  // - el acordado con la duena si existe, el de catalogo si no. Sin conversacion (ningun llamador real
  // hoy) se comporta exactamente como antes de esta fase. Es el unico punto donde se arma una linea con
  // precio, asi que alcanza con resolverlo aca para que el resumen, el cierre y el panel coincidan.
  conversationId?: string
): Promise<ResolveOrderItemsResult> {
  if (!items || items.length === 0) return { items: [], unresolved: [], needsAttribute: [] };

  // E37: una sola consulta para todo el lote. Las promociones vigentes son del negocio, no de la linea.
  const promociones = await promocionesVigentes(businessId);

  const byKey = new Map<string, ResolvedOrderItem>();
  const unresolved: string[] = [];
  const needsAttribute: string[] = [];

  for (const item of items) {
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const rawName = String(item.productName ?? "").trim();

    // E38: LA LINEA DE UN COMBO.
    //
    // Se resuelve ANTES que el producto y por id o por nombre exacto: un combo mal identificado no es un
    // producto de mas en una lista, es una venta con el precio de otro combo. Si no resuelve, cae a
    // `unresolved` igual que un producto que no existe -- nunca a "algo parecido".
    if (item.bundleId || (!item.productId && rawName)) {
      const combo = item.bundleId
        ? await obtenerCombo(businessId, item.bundleId)
        : await buscarComboPorNombre(businessId, rawName);
      if (item.bundleId && (!combo || !combo.active)) {
        unresolved.push(rawName || item.bundleId);
        continue;
      }
      if (combo && combo.active) {
        const clave = `bundle:${combo.id}`;
        const yaEsta = byKey.get(clave);
        if (yaEsta) {
          yaEsta.quantity += quantity;
        } else {
          byKey.set(clave, {
            productId: "",
            bundleId: combo.id,
            productName: combo.name,
            variantId: null,
            variantLabel: null,
            quantity,
            // El precio del combo es SU precio, no la suma de sus partes: es el motivo por el que un
            // combo existe. Las promociones no se le aplican encima -- un combo ya es el descuento.
            unitPrice: combo.price.comoNumeroParaMostrar(),
            currency: combo.currency,
          });
        }
        continue;
      }
    }

    let product: Awaited<ReturnType<typeof getProductById>> | null = null;
    if (item.productId) {
      // Resuelve por id, no por puntaje - lo usa el panel, que ya sabe exactamente que producto eligio
      // el dueno (Fase de correccion, 2026-09-15): sin esto, dos productos casi identicos empataban en
      // findConfidentProductMatch y la venta se rechazaba aunque el producto si existiera en el catalogo.
      // getProductById no filtra por `active` (a diferencia de findConfidentProductMatch), asi que un
      // producto desactivado igual se validaria aca sin este chequeo explicito - no se puede vender.
      const found = await getProductById(businessId, item.productId);
      if (found && found.active) product = found;
    } else if (rawName) {
      const match = await findConfidentProductMatch(businessId, rawName);
      product = match.product;
    }

    if (!product) {
      unresolved.push(rawName || item.productId || "(producto sin nombre)");
      continue;
    }

    let variantId: string | null = null;
    let variantLabel: string | null = null;
    // E36: la variante elegida, retenida para su precio. Los dos caminos que arman una linea tienen que
    // dar el MISMO numero: este es el que se guarda y se cobra; saleState es el que se le dice antes.
    let varianteElegida: { price: import("@prisma/client").Prisma.Decimal | null } | null = null;

    if (product.variants.length > 0) {
      if (item.variantId) {
        const variant = product.variants.find((v) => v.id === item.variantId && v.active) ?? null;
        if (!variant) {
          needsAttribute.push(`${product.name} (variante invalida o inactiva)`);
          continue;
        }
        variantId = variant.id;
        variantLabel = formatVariantLabel(variant.color, variant.size);
        varianteElegida = variant;
      } else {
        const { variant, ambiguous } = matchVariant(product.variants, item.variantLabel ?? "");
        if (!variant) {
          needsAttribute.push(`${product.name}${ambiguous ? " (color/talla ambiguo)" : ""}`);
          continue;
        }
        variantId = variant.id;
        variantLabel = formatVariantLabel(variant.color, variant.size);
        varianteElegida = variant;
      }
    }

    const key = `${product.id}|${variantId ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += quantity;
    } else {
      byKey.set(key, {
        productId: product.id,
        productName: product.name,
        variantId,
        variantLabel,
        quantity,
        // E37: la promocion vigente del negocio entra aca, en el mismo lugar que el precio por
        // variante. Lo que se GUARDA y lo que el bot DIJO salen del mismo calculo.
        unitPrice: precioDeVentaConPromocion(product, varianteElegida, { promociones, cantidad: quantity })
          .precio.comoNumeroParaMostrar(),
        currency: product.currency,
      });
    }
  }

  const resolved = Array.from(byKey.values());
  if (!conversationId) return { items: resolved, unresolved, needsAttribute };
  const agreed = await getAgreedPrices(conversationId);
  const withAgreed = applyAgreedPrices(resolved, agreed).map((item) => ({
    ...item,
    agreedUnitPrice: agreedUnitPriceOf(item, agreed),
  }));
  return { items: withAgreed, unresolved, needsAttribute };
}

export async function createOrder(params: {
  businessId: string;
  customerId: string;
  conversationId: string;
  summary: string;
  items: ResolvedOrderItem[];
  shippingAddress?: string | null;
  paymentMethodLabel?: string | null;
  shippingCost?: number | null;
  /** Ver src/orders/paymentTiming.ts: cuando se paga este pedido. Null = no se pudo resolver sin adivinar. */
  shippingModality?: ShippingPaymentModality | null;
  // E35: impuesto y descuento del pedido, cuando el negocio los usa. Entran en el total con la misma
  // aritmetica exacta que el resto (E33). Sin ellos, el total es el de siempre.
  taxAmount?: number | null;
  discountAmount?: number | null;
}) {
  const { businessId, customerId, conversationId, summary, items, shippingAddress, paymentMethodLabel, shippingCost } = params;
  // E33 (2026-09-18). ESTE ERA EL DEFECTO, y no es teorico.
  //
  // Antes: `const currency = items[0]?.currency ?? "COP"` y despues una suma de `number`s. O sea que se
  // tomaba la moneda del PRIMER item y se sumaba todo el resto como si fuera la misma unidad. Un pedido
  // con un producto en COP y otro en USD -- que el default `@default("USD")` de Product.currency hacia
  // perfectamente posible sin que nadie lo eligiera -- se guardaba como un total en COP que no era la
  // suma de nada.
  //
  // Ahora `sumar` TIRA si las monedas no coinciden, que es lo que pide el plan: "un pedido con monedas
  // mezcladas se rechaza en vez de sumar numeros sin significado". Rechazar el pedido es ruidoso y
  // molesto; cobrar mal es peor y se descubre tarde.
  const currency = items[0]?.currency ?? "COP";
  const totalDeItems = sumar(
    items.map((item) => Money.de(item.unitPrice, item.currency).por(item.quantity)),
    currency,
  );
  const envio = Money.de(shippingCost || 0, currency);
  const itemsTotal = totalDeItems.comoNumeroParaMostrar();
  // E35: total = items + envio + impuesto - descuento. Los dos ultimos son null en casi todos los
  // negocios y entonces esto da exactamente lo mismo que antes.
  const impuesto = Money.de(params.taxAmount || 0, currency);

  // DESCUENTO DE CARRITO (2026-09-19). Se calcula ACA y no en el llamador a proposito: close_conversation
  // no es el unico camino que crea pedidos -- handleOwnerReply tambien los crea, desde el borrador que
  // quedo parqueado cuando no se pudo avisar al dueno. Si el descuento lo pusiera el llamador, uno de los
  // dos caminos lo olvidaria y el mismo pedido costaria distinto segun por donde entro.
  //
  // El defecto que cierra: la FAQ de Boutique Alondra promete "$10.000 llevando dos productos", el bot lo
  // promete bien porque lo lee de ahi, y el pedido salia por el total completo. Ver descuentoDeCarrito y
  // el comentario de PromotionScope.CART en schema.prisma.
  //
  // Un `discountAmount` explicito del llamador GANA: es el descuento que alguien decidio a mano para ese
  // pedido puntual, y no lo pisa una regla general.
  const descuentoDeLaRegla =
    params.discountAmount == null
      ? descuentoDeCarrito(
          (await promocionesVigentes(businessId)) as unknown as Parameters<typeof descuentoDeCarrito>[0],
          totalDeItems,
          items.length,
        ).descuento
      : Money.de(params.discountAmount, currency);
  const descuento = descuentoDeLaRegla;
  const totalAmount = totalDeItems.mas(envio).mas(impuesto).menos(descuento).comoNumeroParaMostrar();
  // Lo que el mensajero tiene que cobrar. Se guarda calculado y no derivado al leer: el precio de un
  // producto puede cambiar manana, y lo que se acordo en este pedido no.
  const amountOnDelivery = montoACobrarAlEntregar(params.shippingModality ?? null, {
    itemsTotal,
    shippingCost: shippingCost || 0,
  });

  // Stock was never decremented on a sale - a business could sell more units than it had in the
  // catalog and never find out until it physically ran out. Decrement in the same transaction as the
  // order so a real sale always moves the counter, clamped at 0 instead of going negative (an oversell
  // is still worth recording, but a negative on-hand count is just confusing in the admin panel).
  const createdOrder = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        businessId,
        customerId,
        conversationId,
        summary,
        shippingAddress: shippingAddress || null,
        paymentMethodLabel: paymentMethodLabel || null,
        shippingCost: shippingCost || null,
        totalAmount,
        shippingModality: params.shippingModality ?? null,
        amountOnDelivery,
        taxAmount: params.taxAmount ?? null,
        discountAmount: params.discountAmount ?? null,
        currency,
        items: {
          create: items.map((item) => ({
            // E38: la linea de un combo no tiene producto. La columna ya era nullable.
            productId: item.bundleId ? null : item.productId,
            bundleId: item.bundleId ?? null,
            productName: item.productName,
            variantId: item.variantId || null,
            variantLabel: item.variantLabel || null,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            agreedUnitPrice: item.agreedUnitPrice ?? null,
            currency: item.currency,
          })),
        },
      },
      include: { items: true },
    });

    // E32 (2026-09-18). Dos cosas cambian aca, y las dos son la misma idea: que el numero diga la
    // verdad y que se pueda deshacer.
    //
    // 1. `{ decrement }` en vez de leer-restar-escribir. Lo de antes tenia una carrera real: dos
    //    ventas simultaneas del mismo producto leian el mismo stock y las dos escribian el mismo
    //    resultado, asi que una de las dos unidades no se descontaba nunca.
    // 2. Sin Math.max(0, ...). Ese recorte TAPABA la sobreventa: vender 5 con 3 en stock dejaba 0 y
    //    borraba el hecho de que faltaban 2. Peor todavia, hacia imposible devolver lo justo al
    //    cancelar - se habian descontado 3, no 5, y nadie sabia cual de los dos numeros era el bueno.
    //    Un stock negativo no es un dato corrupto: es "vendiste mas de lo que tenias", que es
    //    exactamente lo que paso. El catalogo ya lo lee bien, porque su regla es `stock <= 0` ->
    //    "(sin stock)".
    //
    // NO se rechaza la venta cuando no alcanza el stock, a proposito. Product.stock arranca en 0 y hay
    // negocios que no llevan inventario: hacerlo fallar dejaria al bot sin poder cerrar NINGUNA venta
    // en esos negocios. Rechazar es una politica por negocio - o sea una bandera - y esta etapa dice
    // "Bandera: no". Queda propuesto aparte.
    // E38: vender un combo mueve el stock de CADA componente, multiplicado por cuantos combos se
    // vendieron. Sin esto, un combo seria la unica forma de sacar mercaderia del deposito sin que el
    // inventario se entere -- y el combo existe justamente para vender varias cosas juntas.
    const combosVendidos = items.filter((item) => item.bundleId);
    if (combosVendidos.length > 0) {
      const combos = await listarCombos(businessId, { soloActivos: false });
      for (const linea of combosVendidos) {
        const combo = combos.find((c) => c.id === linea.bundleId);
        if (!combo) continue;
        for (const componente of combo.contenido) {
          const cuantos = componente.quantity * linea.quantity;
          if (componente.variantId) {
            await tx.productVariant.updateMany({
              where: { id: componente.variantId },
              data: { stock: { decrement: cuantos } },
            });
            continue;
          }
          await tx.product.updateMany({ where: { id: componente.productId }, data: { stock: { decrement: cuantos } } });
        }
      }
    }

    for (const item of items) {
      // La linea de un combo ya movio el stock de sus componentes arriba.
      if (item.bundleId) continue;
      // A variant sale decrements that variant's own stock, not the parent product's (which a
      // multi-variant product doesn't meaningfully track - see ProductVariant in schema.prisma).
      if (item.variantId) {
        await tx.productVariant.updateMany({
          where: { id: item.variantId },
          data: { stock: { decrement: item.quantity } },
        });
        continue;
      }
      await tx.product.updateMany({
        where: { id: item.productId },
        data: { stock: { decrement: item.quantity } },
      });
    }

    return order;
  });

  emitOrderNew(businessId, createdOrder.id);
  // E41: la etapa del cliente la calcula el servidor, y este es el hecho que la mueve. Va DESPUES de la
  // transaccion a proposito: si el recalculo fallara, el pedido igual quedo creado - la etapa es un dato
  // derivado y el proximo pedido (o el job diario) la vuelve a poner bien. Al reves seria peor.
  try {
    await recalcularEtapaDelCliente(businessId, customerId);
  } catch (error) {
    console.error(`No se pudo recalcular la etapa de ${customerId} tras crear el pedido:`, error);
  }

  return createdOrder;
}

const CSAT_BUTTON_RATINGS: Record<string, number> = { csat_1: 1, csat_2: 2, csat_3: 3 };

// Asked right after a sale closes, while the 24h customer-service session is still open - waiting for
// "after delivery" would need an approved WhatsApp template (see followUpTemplateName), which isn't set
// up yet. Rates the sales experience, not the product/delivery itself.
export async function askForCsat(
  credentials: WhatsappCredentials,
  orderId: string,
  customerPhone: string
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { businessId: true, conversationId: true },
  });
  if (!order) return;
  const result = await sendToCustomer({
    businessId: order.businessId,
    conversationId: order.conversationId,
    credentials,
    to: customerPhone,
    content: {
      kind: "buttons",
      text: "¿Cómo calificarías la atención que recibiste? 😊",
      buttons: [
        { id: "csat_3", title: "😃 Buena" },
        { id: "csat_2", title: "😐 Regular" },
        { id: "csat_1", title: "😞 Mala" },
      ],
    },
    // La encuesta se manda justo despues de cerrar la venta, con la ventana abierta. Si por lo que sea
    // esta cerrada, no se gasta una plantilla de reenganche en pedir una calificacion.
    onWindowClosed: "fail",
  });
  if (!result.delivered) {
    console.error("No se pudo enviar la encuesta de satisfaccion:", result.failure?.message);
    return;
  }
  await prisma.order.update({ where: { id: orderId }, data: { csatAskedAt: new Date() } });
}

export async function recordCsatReply(
  businessId: string,
  customerPhone: string,
  buttonId: string
): Promise<{ recorded: boolean; conversationId: string | null }> {
  const rating = CSAT_BUTTON_RATINGS[buttonId];
  if (!rating) return { recorded: false, conversationId: null };

  const customer = await prisma.customer.findFirst({ where: { businessId, phoneNumber: customerPhone } });
  if (!customer) return { recorded: false, conversationId: null };

  const order = await prisma.order.findFirst({
    where: { customerId: customer.id, csatAskedAt: { not: null }, csatRating: null },
    orderBy: { createdAt: "desc" },
  });
  if (!order) return { recorded: false, conversationId: null };

  await prisma.order.update({ where: { id: order.id }, data: { csatRating: rating } });
  // Devuelve la conversacion para que el agradecimiento salga por la capa de salida, que necesita saber
  // contra que conversacion verificar la ventana de 24h.
  return { recorded: true, conversationId: order.conversationId };
}

function formatOrder<T extends { totalAmount: unknown; shippingCost: unknown; items: { unitPrice: unknown }[] }>(order: T) {
  return {
    ...order,
    totalAmount: String(order.totalAmount),
    shippingCost: order.shippingCost !== null ? String(order.shippingCost) : null,
    items: order.items.map((item) => ({ ...item, unitPrice: String(item.unitPrice) })),
  };
}

// Scoped to one status + a bounded page, not "every order this business ever had" - that used to be
// refetched in full (with a presigned S3 URL generated per order with shipment media) on a 30s poll AND
// every socket reconnect, forever, so the payload and the S3 API calls only ever grew as order history
// piled up. Pendientes/Enviados/Cancelados are now separate paged requests instead of one unbounded list.
export async function listOrdersForBusiness(
  businessId: string,
  status: OrderFulfillmentStatus,
  skip: number,
  take: number
) {
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { businessId, fulfillmentStatus: status },
      include: { items: true, customer: true },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.order.count({ where: { businessId, fulfillmentStatus: status } }),
  ]);
  const formatted = await Promise.all(
    orders.map(async (order) => ({
      ...formatOrder(order),
      customer: {
        // id agregado en Fase 2 para poder enlazar un pedido con la ficha del cliente en el CRM
        // (P9 del diagnostico: antes no habia ningun salto entre pedido, cliente y conversacion).
        id: order.customer.id,
        phoneNumber: order.customer.phoneNumber,
        name: order.customer.name,
        idNumber: order.customer.idNumber,
        deliveryPhone: order.customer.deliveryPhone,
      },
      shipmentMediaUrl: order.shipmentMediaS3Key ? await getPresignedMediaUrl(order.shipmentMediaS3Key) : null,
    }))
  );
  return { orders: formatted, total };
}

// Cheap enough to poll on the same interval as before: no order rows, no presigned URLs, just 3 counts -
// used for the Pendientes/Enviados/Cancelados badge numbers regardless of which one is currently open.
export async function countOrdersByStatus(businessId: string): Promise<Record<OrderFulfillmentStatus, number>> {
  const rows = await prisma.order.groupBy({ by: ["fulfillmentStatus"], where: { businessId }, _count: true });
  // E31: se arma desde los valores del enum y no con tres literales. Con la lista escrita a mano, cada
  // estado nuevo que se agregue al esquema deja este objeto incompleto en silencio y su contador sale
  // como undefined en el panel.
  const counts = Object.fromEntries(
    Object.values(OrderFulfillmentStatusEnum).map((estado) => [estado, 0]),
  ) as Record<OrderFulfillmentStatus, number>;
  for (const row of rows) counts[row.fulfillmentStatus] = row._count;
  return counts;
}

export async function getOrderForBusiness(businessId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, businessId },
    include: { customer: true },
  });
}

// Order.conversationId is 1:1 (unique) - a second close_conversation(SOLD) call on a conversation that
// already has one used to hit that unique constraint as a raw, uncaught Prisma error, which propagated
// all the way out of generateReply's try/catch and got mislabeled "Fallo la llamada a DeepSeek" - found by
// replaying real historical conversations through the regression suite (2026-09-12). Checked here so
// close_conversation can degrade gracefully instead of crashing the whole turn.
export async function getOrderByConversationId(conversationId: string) {
  return prisma.order.findUnique({ where: { conversationId } });
}

// Looks up by customerId, not the current conversationId - Order.conversationId is 1:1 with the
// conversation it was closed in, so it can't be used to find a customer's order history across
// conversations (e.g. a new open conversation started after the sale closed the previous one).
/**
 * E34 (2026-09-18). Los pedidos de este cliente que todavia se pueden cancelar.
 *
 * "Cancelable" lo decide la maquina de estados (E31), no una lista escrita a mano aca: un pedido que ya
 * salio no se cancela desde el chat, y uno cancelado ya no existe.
 */
export async function listCancelableOrdersForCustomer(businessId: string, customerId: string) {
  // Hasta donde llega el bot lo fija el negocio (Business.cancelacionPorElBot), no una constante global:
  // el mismo calculo que usa cancel_order, para que la lista y la accion no puedan desincronizarse.
  const negocio = await prisma.business.findUnique({ where: { id: businessId }, select: { cancelacionPorElBot: true } });
  const cancelables = estadosQueElBotPuedeCancelar(negocio?.cancelacionPorElBot ?? "ANTES_DE_DESPACHAR");
  return prisma.order.findMany({
    where: { businessId, customerId, fulfillmentStatus: { in: cancelables } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      summary: true,
      totalAmount: true,
      currency: true,
      fulfillmentStatus: true,
      createdAt: true,
      cancelRequestedAt: true,
    },
  });
}

/** Un pedido puntual de este cliente, por id. Devuelve null si no es suyo: nunca se cancela lo ajeno. */
export async function getOrderOfCustomer(businessId: string, customerId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, businessId, customerId },
    select: {
      id: true,
      summary: true,
      totalAmount: true,
      currency: true,
      fulfillmentStatus: true,
      createdAt: true,
      cancelRequestedAt: true,
    },
  });
}

/** Deja la marca de "la clienta pidio cancelar", que recien el turno siguiente puede usar. */
export async function marcarCancelacionPedida(orderId: string, cuando: Date): Promise<void> {
  await prisma.order.update({ where: { id: orderId }, data: { cancelRequestedAt: cuando } });
}

/**
 * Borra las solicitudes de cancelacion de este cliente. Corre al final de cualquier turno que NO haya
 * llamado a `cancel_order`: si la clienta dijo "cancela" y despues se puso a hablar de otra cosa, la
 * marca no puede quedar esperando a que una frase cualquiera de la semana que viene la active.
 */
export async function limpiarCancelacionesPedidas(businessId: string, customerId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { businessId, customerId, cancelRequestedAt: { not: null } },
    data: { cancelRequestedAt: null },
  });
}

export async function getLatestOrderForCustomer(businessId: string, customerId: string) {
  const order = await prisma.order.findFirst({
    where: { businessId, customerId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
  return order ? formatOrder(order) : null;
}

// E31: las dos funciones que mueven el pedido pasan por la maquina de estados. Antes eran `update`
// sueltos que ni miraban el estado actual, asi que el panel podia cancelar un pedido YA ENVIADO y
// volver a enviar uno cancelado, sin dejar rastro de quien. Si la transicion no esta permitida, estas
// funciones TIRAN TransicionNoPermitida - las rutas la traducen a un 409 con el motivo en castellano.
export async function markOrderShipped(
  businessId: string,
  orderId: string,
  data: { note?: string | null; mediaS3Key?: string | null; mediaType?: string | null },
  actor: Actor = { tipo: "OWNER" }
) {
  const movido = await transicionarPedido({
    businessId,
    orderId,
    hacia: "SHIPPED",
    actor,
    datos: {
      shippedAt: new Date(),
      shipmentNote: data.note || null,
      shipmentMediaS3Key: data.mediaS3Key || null,
      shipmentMediaType: data.mediaType || null,
    },
  });
  if (!movido) return null;
  emitOrderUpdated(businessId, orderId);
  return prisma.order.findFirst({ where: { id: orderId, businessId } });
}

/**
 * E32 (2026-09-18). Cancelar devuelve el stock.
 *
 * Hasta hoy el stock se descontaba en la venta y NO volvia nunca: cada cancelacion destruia unidades
 * para siempre. Un negocio que cancelaba diez pedidos perdia diez veces esas unidades del inventario,
 * sin que nada lo dijera.
 *
 * Se devuelve exactamente lo que dice OrderItem.quantity, que es lo mismo que se descontio al crear el
 * pedido (desde E32 el descuento es exacto y no recorta en cero, justamente para que esto cierre). Va
 * DENTRO de la transaccion del cambio de estado: si la devolucion fallara, la cancelacion tampoco
 * ocurre, en vez de dejar el pedido cancelado con las unidades perdidas.
 */
async function devolverStockDelPedido(tx: TxCliente, orderId: string): Promise<void> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { productId: true, variantId: true, quantity: true, bundleId: true },
  });

  // E38: la linea de un combo devuelve el stock de CADA componente, igual que lo descontio al venderse.
  // Se lee el contenido ACTUAL del combo, y eso es lo correcto aunque el combo haya cambiado desde la
  // venta: lo que se devuelve al deposito es lo que hoy significa ese combo. Un combo borrado no
  // devuelve nada -- no queda de donde saber que tenia adentro, e inventarlo seria peor.
  const lineasDeCombo = items.filter((item) => item.bundleId);
  if (lineasDeCombo.length > 0) {
    const contenidos = await tx.bundleItem.findMany({
      where: { bundleId: { in: [...new Set(lineasDeCombo.map((l) => l.bundleId as string))] } },
      select: { bundleId: true, productId: true, variantId: true, quantity: true },
    });
    for (const linea of lineasDeCombo) {
      for (const componente of contenidos.filter((c) => c.bundleId === linea.bundleId)) {
        const cuantos = componente.quantity * linea.quantity;
        if (componente.variantId) {
          await tx.productVariant.updateMany({ where: { id: componente.variantId }, data: { stock: { increment: cuantos } } });
          continue;
        }
        await tx.product.updateMany({ where: { id: componente.productId }, data: { stock: { increment: cuantos } } });
      }
    }
  }

  for (const item of items) {
    // La linea de un combo ya devolvio el stock de sus componentes arriba.
    if (item.bundleId) continue;
    if (item.variantId) {
      await tx.productVariant.updateMany({
        where: { id: item.variantId },
        data: { stock: { increment: item.quantity } },
      });
      continue;
    }
    // productId es opcional: un item cargado a mano desde el panel puede no apuntar a ningun producto
    // del catalogo. No hay stock que devolver ahi, y forzarlo seria inventar a que producto pertenece.
    if (!item.productId) continue;
    await tx.product.updateMany({
      where: { id: item.productId },
      data: { stock: { increment: item.quantity } },
    });
  }
}

export async function markOrderCanceled(
  businessId: string,
  orderId: string,
  actor: Actor = { tipo: "OWNER" },
  motivo?: string | null
) {
  const movido = await transicionarPedido({
    businessId,
    orderId,
    hacia: "CANCELED",
    actor,
    motivo,
    datos: { canceledAt: new Date() },
    enLaMismaTransaccion: (tx) => devolverStockDelPedido(tx, orderId),
  });
  if (!movido) return null;
  emitOrderUpdated(businessId, orderId);
  return prisma.order.findFirst({ where: { id: orderId, businessId } });
}
