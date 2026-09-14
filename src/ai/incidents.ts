import { prisma } from "../db/client";

export type AgentIncidentKind =
  | "LOOP_EXHAUSTED"
  | "BACKSTOP_INTERVENTION"
  | "DEGRADED_REPLY"
  | "EXTERNAL_API_FAILURE";

// Fase F, 2026-09-13 audit (F9): none of agent.ts's backend safety nets left any queryable trace before
// this - only a console.error/warn nobody reads unless tailing production logs. Best-effort on purpose:
// a logging failure here must never break the real customer-facing reply, so every call site awaits this
// but never lets it propagate.
export async function recordAgentIncident(
  businessId: string,
  kind: AgentIncidentKind,
  detail: string,
  conversationId?: string
): Promise<void> {
  try {
    await prisma.agentIncident.create({ data: { businessId, kind, detail, conversationId } });
  } catch (error) {
    console.error("No se pudo registrar un AgentIncident (no bloqueante):", error);
  }
}

export interface AgentIncidentSummary {
  loopExhausted: number;
  backstopInterventions: number;
  degradedReplies: number;
  stalledConversations: number;
  externalApiFailures: number;
  // El texto del ultimo fallo externo, para que el panel pueda decir QUE se rompio y no solo cuantas
  // veces: "0 escalaciones" y "la llave esta mal" se ven igual desde un contador.
  lastExternalApiFailure: { detail: string; createdAt: Date } | null;
}

// Powers the admin panel's "salud del bot" numbers - counts over the trailing window, plus a live count
// of conversations currently stuck (humanControl:true, not sold/lost - see the Fase A watchdog fields).
export async function getAgentIncidentSummary(businessId: string, sinceDays = 7): Promise<AgentIncidentSummary> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const [grouped, stalledConversations, lastFailure] = await Promise.all([
    prisma.agentIncident.groupBy({
      by: ["kind"],
      where: { businessId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.conversation.count({
      where: { customer: { businessId }, humanControl: true, status: { notIn: ["SOLD", "LOST"] } },
    }),
    prisma.agentIncident.findFirst({
      where: { businessId, kind: "EXTERNAL_API_FAILURE", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { detail: true, createdAt: true },
    }),
  ]);

  const counts: Record<string, number> = {};
  for (const row of grouped) counts[row.kind] = row._count._all;

  return {
    loopExhausted: counts.LOOP_EXHAUSTED ?? 0,
    backstopInterventions: counts.BACKSTOP_INTERVENTION ?? 0,
    degradedReplies: counts.DEGRADED_REPLY ?? 0,
    stalledConversations,
    externalApiFailures: counts.EXTERNAL_API_FAILURE ?? 0,
    lastExternalApiFailure: lastFailure,
  };
}
