import { prisma } from "../db/client";
import { resolveShippingRateForCity } from "../catalog/shippingRates";
import { computeCheckoutState, type CheckoutFacts, type CheckoutState } from "./checkoutState";

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
      order: { select: { paymentMethodLabel: true, shippingAddress: true } },
    },
  });
  if (!conversation) return null;

  const rawItems = Array.isArray(conversation.pendingOrderItems) ? (conversation.pendingOrderItems as PendingItem[]) : [];
  const productos = rawItems
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

  const facts: CheckoutFacts = {
    // Hoy siempre CO. Cuando se venda en Mexico esto sale de la ciudad/zona resuelta, no de una constante.
    pais: "CO",
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
  return computeCheckoutState(facts);
}
