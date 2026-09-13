import { prisma } from "../db/client";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { listApprovedTemplates } from "../whatsapp/client";

export interface ConfigHealth {
  hasContactPhone: boolean;
  hasCategoriesConfigured: boolean;
  hasPaymentMethods: boolean;
  // null = couldn't check (WhatsApp Business Account not connected yet, or the Graph API call failed) -
  // distinct from `false` (checked for real, genuinely not approved) so the panel doesn't warn about
  // something it was never able to actually verify.
  hasApprovedOwnerAlertTemplate: boolean | null;
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

  const [categorizedProductCount, paymentMethods] = await Promise.all([
    prisma.product.count({ where: { businessId, active: true, category: { not: null } } }),
    listActivePaymentMethods(businessId),
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
  };
}
