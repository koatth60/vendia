import { prisma } from "../db/client";
import { getBackstopInterventionsByGuard } from "../ai/incidents";

const STATUSES = ["NEW", "INTERESTED", "QUOTED", "NEGOTIATING", "SOLD", "LOST"] as const;

export async function getAnalyticsSummary(businessId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const conversations = await prisma.conversation.findMany({
    where: { customer: { businessId }, createdAt: { gte: since } },
    select: { status: true },
  });

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const c of conversations) byStatus[c.status]++;

  const totalConversations = conversations.length;
  // Fase 0 del plan maestro (2026-09-15): el denominador viejo (SOLD+LOST) mentia por 52 puntos -
  // contaba una venta cerrada contra un rechazo explicito, pero ignoraba toda conversacion con
  // intencion de compra real que quedo abierta o abandonada (61% caia en NEW). El denominador
  // correcto es "conversaciones con intencion de compra": las que llegaron al menos a QUOTED.
  // Pendiente (requiere un log de tool-calls que hoy no existe, ver ONIX-PLAN-MAESTRO.md Fase 0):
  // sumar tambien las que llamaron get_product_details/show_order_summary sin que el modelo haya
  // actualizado el status - ese gap de status desactualizado es justamente lo que la Fase 2 cierra.
  const intentConversations = byStatus.QUOTED + byStatus.NEGOTIATING + byStatus.SOLD + byStatus.LOST;
  const conversionRate = intentConversations > 0 ? byStatus.SOLD / intentConversations : 0;

  const messages = await prisma.message.findMany({
    where: { conversation: { customer: { businessId } }, createdAt: { gte: since } },
    select: { role: true, createdAt: true },
  });

  const byDayMap = new Map<string, { customer: number; assistant: number }>();
  for (const m of messages) {
    if (m.role !== "CUSTOMER" && m.role !== "ASSISTANT") continue;
    const day = m.createdAt.toISOString().slice(0, 10);
    const entry = byDayMap.get(day) ?? { customer: 0, assistant: 0 };
    if (m.role === "CUSTOMER") entry.customer++;
    else entry.assistant++;
    byDayMap.set(day, entry);
  }
  const messagesByDay = Array.from(byDayMap.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topProducts = await prisma.product.findMany({
    where: { businessId, inquiryCount: { gt: 0 } },
    orderBy: { inquiryCount: "desc" },
    take: 5,
    select: { id: true, name: true, inquiryCount: true },
  });

  const csatOrders = await prisma.order.findMany({
    where: { businessId, csatRating: { not: null }, createdAt: { gte: since } },
    select: { csatRating: true },
  });
  const csatCount = csatOrders.length;
  const avgCsat = csatCount > 0 ? csatOrders.reduce((sum, o) => sum + (o.csatRating ?? 0), 0) / csatCount : null;

  return { totalConversations, byStatus, conversionRate, messagesByDay, topProducts, avgCsat, csatCount };
}

// Fase 0 del plan maestro (2026-09-15): la "linea base" contra la que se compara cada fase siguiente
// (ONIX-PLAN-MAESTRO.md seccion 2, metricas P1-P7). Solo se calculan las que ya tienen una fuente real
// hoy - P2 (turnos hasta el cierre), P3 (dato repetido) y P4 (promesa incumplida) quedan en null a
// proposito: medirlas en vivo necesita un detector nuevo, y esta fase tiene prohibido agregar regex
// nuevas (la regla del propio plan: "no se agrega un regex mas sin borrar uno"). Se recalculan a mano
// sobre los fixtures de la Fase 1 mientras tanto.
export interface BaselineMetrics {
  days: number;
  p1ConversionRate: number;
  p1IntentConversations: number;
  p1SoldConversations: number;
  p2MedianTurnsToClose: null;
  p3RepeatedDataRate: null;
  p4UnfulfilledPromiseRate: null;
  p5BackstopsPer100Turns: number;
  p5ByGuard: { guard: string; count: number }[];
  p6LatencyP50Ms: null;
  p6LatencyP95Ms: null;
  p7CostPerConversationUsd: number | null;
}

export async function getBaselineMetrics(businessId: string, days = 30): Promise<BaselineMetrics> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [conversations, assistantTurns, backstopCount, byGuard, usage] = await Promise.all([
    prisma.conversation.findMany({
      where: { customer: { businessId }, createdAt: { gte: since } },
      select: { status: true },
    }),
    prisma.message.count({
      where: { role: "ASSISTANT", conversation: { customer: { businessId } }, createdAt: { gte: since } },
    }),
    prisma.agentIncident.count({
      where: { businessId, kind: "BACKSTOP_INTERVENTION", createdAt: { gte: since } },
    }),
    getBackstopInterventionsByGuard(businessId, days),
    prisma.aiUsageLog.findMany({
      where: { businessId, createdAt: { gte: since } },
      select: { costUsd: true, conversationId: true },
    }),
  ]);

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const c of conversations) byStatus[c.status]++;
  const intentConversations = byStatus.QUOTED + byStatus.NEGOTIATING + byStatus.SOLD + byStatus.LOST;

  const totalCostUsd = usage.reduce((sum, u) => sum + u.costUsd, 0);
  const distinctConversations = new Set(usage.map((u) => u.conversationId).filter((id): id is string => Boolean(id)));

  return {
    days,
    p1ConversionRate: intentConversations > 0 ? byStatus.SOLD / intentConversations : 0,
    p1IntentConversations: intentConversations,
    p1SoldConversations: byStatus.SOLD,
    p2MedianTurnsToClose: null,
    p3RepeatedDataRate: null,
    p4UnfulfilledPromiseRate: null,
    p5BackstopsPer100Turns: assistantTurns > 0 ? Math.round((backstopCount / assistantTurns) * 10000) / 100 : 0,
    p5ByGuard: byGuard,
    p6LatencyP50Ms: null,
    p6LatencyP95Ms: null,
    p7CostPerConversationUsd: distinctConversations.size > 0 ? totalCostUsd / distinctConversations.size : null,
  };
}
