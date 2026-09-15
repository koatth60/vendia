import { prisma } from "../db/client";
import { resolveShippingRateForCity } from "../catalog/shippingRates";
import { computeCheckoutState, type CheckoutFacts, type CheckoutState } from "./checkoutState";
import { getBusinessLocale } from "../config/businessConfig";

// Etapa 1 del rediseno (ver el diseno del estado de pedido): el estado se CALCULA y se observa, pero
// todavia no entra al prompt ni cambia una sola respuesta. La idea es comparar durante unos dias lo que
// el estado dice que falta contra lo que el bot realmente pidio; si no coinciden, el estado esta mal y se
// corrige sin que ningun cliente lo note. Es la leccion directa del 15 de septiembre, cuando un cambio
// grande desplegado de golpe rompio tres conversaciones en veinte minutos.
//
// Deliberadamente NO crea tabla nueva: se deriva de Customer y Conversation.pendingOrderItems, que ya son
// la verdad. Un estado guardado aparte podria quedar desincronizado de los datos reales, que es
// exactamente el problema que este rediseno viene a eliminar.

interface PendingItem {
  productName?: unknown;
  quantity?: unknown;
  variantLabel?: unknown;
}

export async function buildCheckoutState(conversationId: string): Promise<CheckoutState | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      pendingOrderItems: true,
      customer: {
        select: { businessId: true, name: true, idNumber: true, deliveryPhone: true, address: true },
      },
      order: {
        select: {
          paymentMethodLabel: true,
          shippingAddress: true,
          items: { select: { productName: true, quantity: true, variantLabel: true } },
        },
      },
    },
  });
  if (!conversation) return null;

  // Los productos salen del pedido ya creado si existe, y si no de pendingOrderItems.
  //
  // Hallazgo de la etapa de observacion (2026-09-15): ninguna de las dos fuentes se llena mientras la
  // venta esta EN CURSO. pendingOrderItems solo se escribe en el paso de confirmacion, y el Order recien
  // existe al cerrar - o sea que hoy no hay ningun lugar que registre que producto esta eligiendo el
  // cliente: eso vive solo en la cabeza del modelo. Es la pieza que falta para la etapa 2 y no se puede
  // resolver leyendo mejor la base, hay que capturarlo cuando el cliente elige.
  const rawItems = Array.isArray(conversation.pendingOrderItems) ? (conversation.pendingOrderItems as PendingItem[]) : [];
  const productos =
    conversation.order?.items && conversation.order.items.length > 0
      ? conversation.order.items.map((i) => ({
          nombre: i.productName,
          cantidad: i.quantity,
          variante: i.variantLabel?.trim() ? i.variantLabel : null,
        }))
      : rawItems
          .filter((i) => typeof i?.productName === "string")
          .map((i) => ({
            nombre: String(i.productName),
            cantidad: Number(i.quantity) || 1,
            variante: typeof i.variantLabel === "string" && i.variantLabel.trim() ? String(i.variantLabel) : null,
          }));

  // Si algun producto pedido tiene variantes activas y todavia no se eligio cual, falta el color/talla.
  let varianteFaltante = false;
  for (const item of productos) {
    if (item.variante) continue;
    const producto = await prisma.product.findFirst({
      where: { businessId: conversation.customer.businessId, name: item.nombre },
      select: { variants: { where: { active: true }, select: { id: true } } },
    });
    if ((producto?.variants.length ?? 0) > 0) {
      varianteFaltante = true;
      break;
    }
  }

  // La ciudad no tiene campo propio: se infiere de la direccion guardada resolviendola contra las
  // tarifas reales del negocio. Si resuelve, ademas queda la zona ("Bogota", "Soacha", "Nacional"), que
  // es lo que decide si hay que pedir la cedula.
  const direccion = conversation.customer.address ?? conversation.order?.shippingAddress ?? null;
  let ciudad: string | null = null;
  let zonaEnvio: string | null = null;
  if (direccion) {
    for (const trozo of direccion.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)) {
      const tarifa = await resolveShippingRateForCity(conversation.customer.businessId, trozo);
      if (tarifa) {
        ciudad = trozo;
        zonaEnvio = tarifa.label ?? null;
        break;
      }
    }
  }

  // Fase 11: el pais y la regla de documento salen del negocio, no de una constante.
  const negocio = await getBusinessLocale(conversation.customer.businessId);

  const facts: CheckoutFacts = {
    pais: negocio.countryCode,
    productos,
    varianteFaltante,
    nombre: conversation.customer.name,
    documento: conversation.customer.idNumber,
    telefono: conversation.customer.deliveryPhone,
    ciudad,
    direccion,
    formaPago: conversation.order?.paymentMethodLabel ?? null,
    zonaEnvio,
  };
  return computeCheckoutState(facts, negocio.requirements);
}
