import { prisma } from "../db/client";
import { getConfigHealth } from "../ai/configHealth";
import { getAgentIncidentSummary } from "../ai/incidents";

// Resumen de la pantalla Inicio (Fase 3, ver ONIX-CRM-REORG-PLAN.md).
//
// Una sola llamada en vez de seis: Inicio es lo primero que carga al entrar al panel, y encadenar un
// fetch por tarjeta hacia media docena de endpoints era la forma mas facil de que la pantalla mas vista
// del producto fuera tambien la mas lenta. Todo lo de aca ya existia en el backend - lo que no existia
// era un lugar donde el dueño lo viera junto (P6 del diagnostico: el chequeo de configuracion y los
// incidentes vivian al final de la pestaña de facturacion de tokens).

export interface DashboardActionItem {
  kind: "HUMAN_WAITING" | "OWNER_QUESTION" | "ORDER_PENDING" | "DELIVERY_FAILURE" | "FAQ_CANDIDATE";
  count: number;
  // Muestra acotada para que la tarjeta pueda decir de quien se trata sin una segunda consulta.
  sample: { id: string; label: string; detail: string | null; createdAt: Date }[];
}

export async function getDashboardSummary(businessId: string) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    humanWaiting,
    ownerQuestions,
    pendingOrders,
    deliveryFailures,
    faqCandidates,
    monthOrders,
    conversations30,
    csatOrders,
    activeConversations,
    incidents,
    health,
  ] = await Promise.all([
    prisma.conversation.findMany({
      where: { customer: { businessId }, humanControl: true },
      orderBy: { humanControlSince: "asc" },
      take: 5,
      select: {
        id: true,
        humanControlSince: true,
        updatedAt: true,
        intent: true,
        customer: { select: { id: true, name: true, phoneNumber: true } },
      },
    }),
    prisma.pendingOwnerQuestion.findMany({
      where: { conversation: { customer: { businessId } } },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: {
        id: true,
        question: true,
        createdAt: true,
        conversation: { select: { id: true, customer: { select: { id: true, name: true, phoneNumber: true } } } },
      },
    }),
    prisma.order.findMany({
      where: { businessId, fulfillmentStatus: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: { id: true, summary: true, createdAt: true, customer: { select: { name: true, phoneNumber: true } } },
    }),
    prisma.deliveryFailure.findMany({
      where: { businessId, resolved: false },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, recipientPhone: true, errorMessage: true, critical: true, createdAt: true },
    }),
    prisma.learnedFaqCandidate.findMany({
      where: { businessId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, question: true, createdAt: true },
    }),
    prisma.order.findMany({
      where: { businessId, createdAt: { gte: monthStart }, fulfillmentStatus: { not: "CANCELED" } },
      select: { totalAmount: true, currency: true },
    }),
    prisma.conversation.findMany({
      where: { customer: { businessId }, createdAt: { gte: since30 } },
      select: { status: true },
    }),
    prisma.order.findMany({
      where: { businessId, csatRating: { not: null }, createdAt: { gte: since30 } },
      select: { csatRating: true },
    }),
    prisma.conversation.count({
      where: { customer: { businessId }, status: { notIn: ["SOLD", "LOST", "ABANDONED"] } },
    }),
    getAgentIncidentSummary(businessId),
    getConfigHealth(businessId),
  ]);

  const [humanWaitingCount, ownerQuestionCount, pendingOrderCount, deliveryFailureCount, faqCandidateCount] =
    await Promise.all([
      prisma.conversation.count({ where: { customer: { businessId }, humanControl: true } }),
      prisma.pendingOwnerQuestion.count({ where: { conversation: { customer: { businessId } } } }),
      prisma.order.count({ where: { businessId, fulfillmentStatus: "PENDING" } }),
      prisma.deliveryFailure.count({ where: { businessId, resolved: false } }),
      prisma.learnedFaqCandidate.count({ where: { businessId, status: "PENDING" } }),
    ]);

  const monthSales = monthOrders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
  const sold = conversations30.filter((c) => c.status === "SOLD").length;
  const lost = conversations30.filter((c) => c.status === "LOST").length;
  const closed = sold + lost;
  const csatCount = csatOrders.length;
  const avgCsat = csatCount > 0 ? csatOrders.reduce((sum, o) => sum + (o.csatRating ?? 0), 0) / csatCount : null;

  const actions: DashboardActionItem[] = [
    {
      kind: "HUMAN_WAITING",
      count: humanWaitingCount,
      sample: humanWaiting.map((c) => ({
        id: c.customer.id,
        label: c.customer.name || c.customer.phoneNumber,
        detail: c.intent,
        createdAt: c.humanControlSince ?? c.updatedAt,
      })),
    },
    {
      kind: "OWNER_QUESTION",
      count: ownerQuestionCount,
      sample: ownerQuestions.map((q) => ({
        id: q.conversation.customer.id,
        label: q.conversation.customer.name || q.conversation.customer.phoneNumber,
        detail: q.question,
        createdAt: q.createdAt,
      })),
    },
    {
      kind: "ORDER_PENDING",
      count: pendingOrderCount,
      sample: pendingOrders.map((o) => ({
        id: o.id,
        label: o.customer.name || o.customer.phoneNumber,
        detail: o.summary,
        createdAt: o.createdAt,
      })),
    },
    {
      kind: "DELIVERY_FAILURE",
      count: deliveryFailureCount,
      sample: deliveryFailures.map((f) => ({
        id: f.id,
        label: f.critical ? `${f.recipientPhone} (critico)` : f.recipientPhone,
        detail: f.errorMessage,
        createdAt: f.createdAt,
      })),
    },
    {
      kind: "FAQ_CANDIDATE",
      count: faqCandidateCount,
      sample: faqCandidates.map((c) => ({
        id: c.id,
        label: c.question,
        detail: null,
        createdAt: c.createdAt,
      })),
    },
  ];

  return {
    actions,
    kpis: {
      monthSales,
      currency: monthOrders[0]?.currency ?? "COP",
      monthOrderCount: monthOrders.length,
      conversionRate: closed > 0 ? sold / closed : 0,
      sold,
      lost,
      activeConversations,
      avgCsat,
      csatCount,
    },
    incidents,
    health,
  };
}
