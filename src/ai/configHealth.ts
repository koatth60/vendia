import { prisma } from "../db/client";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { listShippingRates } from "../catalog/shippingRates";
import { listApprovedTemplates } from "../whatsapp/outbound";

export interface ConfigHealth {
  hasContactPhone: boolean;
  hasCategoriesConfigured: boolean;
  hasPaymentMethods: boolean;
  // null = couldn't check (WhatsApp Business Account not connected yet, or the Graph API call failed) -
  // distinct from `false` (checked for real, genuinely not approved) so the panel doesn't warn about
  // something it was never able to actually verify.
  hasApprovedOwnerAlertTemplate: boolean | null;
  // Fase 6 del plan maestro (2026-09-15): las mismas dos compuertas de SaleGate, ya calculadas, para que
  // el panel muestre la tarjeta de bloqueo sin pedirle a este endpoint una segunda consulta.
  canConverse: boolean;
  canSell: boolean;
  missingForSale: string[];
}

// Fase 6 del plan maestro (2026-09-15), causa raiz C5 + riesgo R8: configHealth pasaba de informativo a
// compuerta real. "Puede vender" es deliberadamente mas angosto que ConfigHealth completo (no depende de
// la plantilla de WhatsApp aprobada, que requiere una llamada a la Graph API) - es la unica parte que
// bloquea herramientas en tools.ts, así que se computa aparte y barato (solo Postgres) para que cada
// llamada a show_order_summary/set_payment_method/close_conversation no dependa de Meta.
export interface SaleGate {
  canConverse: boolean;
  canSell: boolean;
  // Etiquetas en español, listas para mostrarle al cliente o al dueño tal cual ("faltan: X, Y").
  missing: string[];
}

export async function getSaleGate(businessId: string): Promise<SaleGate> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });

  const [activeProductCount, paymentMethods, shippingRates] = await Promise.all([
    prisma.product.count({ where: { businessId, active: true } }),
    listActivePaymentMethods(businessId),
    listShippingRates(businessId),
  ]);

  const missing: string[] = [];
  if (paymentMethods.length === 0) missing.push("métodos de pago");
  if (shippingRates.length === 0) missing.push("tarifas de envío");
  if (!business.contactPhone) missing.push("teléfono de contacto");

  return {
    canConverse: activeProductCount > 0,
    canSell: missing.length === 0,
    missing,
  };
}

// Fase G, 2026-09-13 audit (robustez multi-negocio): each of these is a real, silent production failure
// mode for a business that isn't configured "like the pilot" - F5 (no contactPhone: every escalation is an
// empty promise), F7 (no categories: the color/category attribute-filter forcing never engages), F3 (no
// approved onix_owner_alert template: a nighttime escalation never reaches the owner outside the 24h
// window), and a missing payment method (get_payment_methods always returns empty, close_conversation's
// payment guard has nothing real to check against). None of these produce an error anywhere today - this
// is the one place that checks all four and says so plainly.
export async function getConfigHealth(businessId: string): Promise<ConfigHealth> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });

  const [categorizedProductCount, paymentMethods, saleGate] = await Promise.all([
    prisma.product.count({ where: { businessId, active: true, category: { not: null } } }),
    listActivePaymentMethods(businessId),
    getSaleGate(businessId),
  ]);

  let hasApprovedOwnerAlertTemplate: boolean | null = null;
  if (business.whatsappAccessToken && business.whatsappBusinessAccountId) {
    try {
      const templates = await listApprovedTemplates(business.whatsappAccessToken, business.whatsappBusinessAccountId);
      hasApprovedOwnerAlertTemplate = templates.some((t) => t.name === "onix_owner_alert");
    } catch (error) {
      console.error("No se pudo verificar la plantilla onix_owner_alert para el chequeo de salud de configuracion:", error);
    }
  }

  return {
    hasContactPhone: Boolean(business.contactPhone),
    hasCategoriesConfigured: categorizedProductCount > 0,
    hasPaymentMethods: paymentMethods.length > 0,
    hasApprovedOwnerAlertTemplate,
    canConverse: saleGate.canConverse,
    canSell: saleGate.canSell,
    missingForSale: saleGate.missing,
  };
}
