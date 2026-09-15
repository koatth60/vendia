import { prisma } from "../db/client";
import { WHATSAPP_WINDOW_HOURS, countConversationsWithQueuedOutbound } from "../conversation/service";

export type AgentIncidentKind =
  | "LOOP_EXHAUSTED"
  | "BACKSTOP_INTERVENTION"
  | "DEGRADED_REPLY"
  | "EXTERNAL_API_FAILURE"
  | "STALE_REPLY_DISCARDED";

// Fase F, 2026-09-13 audit (F9): none of agent.ts's backend safety nets left any queryable trace before
// this - only a console.error/warn nobody reads unless tailing production logs. Best-effort on purpose:
// a logging failure here must never break the real customer-facing reply, so every call site awaits this
// but never lets it propagate.
export async function recordAgentIncident(
  businessId: string,
  kind: AgentIncidentKind,
  detail: string,
  conversationId?: string,
  guard?: string
): Promise<void> {
  try {
    await prisma.agentIncident.create({ data: { businessId, kind, detail, conversationId, guard } });
  } catch (error) {
    console.error("No se pudo registrar un AgentIncident (no bloqueante):", error);
  }
}

export interface AgentIncidentSummary {
  loopExhausted: number;
  backstopInterventions: number;
  degradedReplies: number;
  stalledConversations: number;
  // De esas estancadas, cuantas ya no se pueden contestar con texto libre porque paso la ventana de 24h
  // de WhatsApp. Es el caso mas caro y el mas invisible: el dueno entra al chat, escribe, WhatsApp
  // devuelve un wamid que parece exitoso y el cliente nunca recibe nada (incidente real 2026-09-14).
  // Solo se desbloquean mandando una plantilla aprobada desde el panel.
  unreachableConversations: number;
  // Mensajes que el equipo ya dejo escritos esperando a que el cliente vuelva a escribir.
  conversationsWithQueuedOutbound: number;
  // Respuestas que tardaron tanto en generarse que se tiraron sin mandar (ver STALE_REPLY_DISCARDED).
  staleRepliesDiscarded: number;
  externalApiFailures: number;
  // El texto del ultimo fallo externo, para que el panel pueda decir QUE se rompio y no solo cuantas
  // veces: "0 escalaciones" y "la llave esta mal" se ven igual desde un contador.
  lastExternalApiFailure: { detail: string; createdAt: Date } | null;
}

// Fase 0 del plan de estabilizacion (2026-09-15): el detalle de lo que encontro el chequeo automatico de
// conversaciones, agrupado por tipo y con la conversacion de cada caso. Hasta ahora el panel solo mostraba
// CUANTAS intervenciones hubo; un contador no dice si el bot prometio fotos que no mando o si una venta
// se cerro sin quedar registrada, que es justo lo que el dueno necesita ver. Ver jobs/conversationHealth.ts.
export interface HealthFindingRow {
  kind: string;
  detail: string;
  conversationId: string | null;
  createdAt: Date;
}

export async function getHealthFindings(businessId: string, sinceHours = 24): Promise<HealthFindingRow[]> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const rows = await prisma.agentIncident.findMany({
    where: { businessId, createdAt: { gte: since }, detail: { startsWith: "[chequeo]" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { detail: true, conversationId: true, createdAt: true },
  });
  return rows.map((r) => {
    // "[chequeo] TIPO: texto" -> { kind: "TIPO", detail: "texto" }
    const match = r.detail.match(/^\[chequeo\]\s+([A-Z_]+):\s*([\s\S]*)$/);
    return {
      kind: match?.[1] ?? "DESCONOCIDO",
      detail: match?.[2] ?? r.detail,
      conversationId: r.conversationId,
      createdAt: r.createdAt,
    };
  });
}

// Powers the admin panel's "salud del bot" numbers - counts over the trailing window, plus a live count
// of conversations currently stuck (humanControl:true, not sold/lost - see the Fase A watchdog fields).
export async function getAgentIncidentSummary(businessId: string, sinceDays = 7): Promise<AgentIncidentSummary> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const windowCutoff = new Date(Date.now() - WHATSAPP_WINDOW_HOURS * 60 * 60 * 1000);
  const [grouped, stalledConversations, unreachableConversations, conversationsWithQueuedOutbound, lastFailure] = await Promise.all([
    prisma.agentIncident.groupBy({
      by: ["kind"],
      where: { businessId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.conversation.count({
      where: { customer: { businessId }, humanControl: true, status: { notIn: ["SOLD", "LOST"] } },
    }),
    // Estancada Y fuera de ventana: no tiene NINGUN mensaje del cliente dentro de las ultimas 24h, asi
    // que cualquier texto libre que se le mande desde el panel se pierde en silencio.
    prisma.conversation.count({
      where: {
        customer: { businessId },
        humanControl: true,
        status: { notIn: ["SOLD", "LOST"] },
        messages: { none: { role: "CUSTOMER", createdAt: { gte: windowCutoff } } },
      },
    }),
    countConversationsWithQueuedOutbound(businessId),
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
    staleRepliesDiscarded: counts.STALE_REPLY_DISCARDED ?? 0,
    unreachableConversations,
    conversationsWithQueuedOutbound,
    externalApiFailures: counts.EXTERNAL_API_FAILURE ?? 0,
    lastExternalApiFailure: lastFailure,
  };
}

// P5 de la linea base (Fase 0 del plan maestro, 2026-09-15): intervenciones de backstop desglosadas
// por guard. El objetivo de esta metrica no es que baje, es que cada fase la borre por completo para
// un guard dado - un total agregado no distingue "el guard X ya no existe" de "el guard X interviene
// menos". Filas de antes de esta fase quedan con guard null y se agrupan como "(sin guard registrado)".
export interface BackstopByGuardRow {
  guard: string;
  count: number;
}

export async function getBackstopInterventionsByGuard(businessId: string, sinceDays = 7): Promise<BackstopByGuardRow[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const grouped = await prisma.agentIncident.groupBy({
    by: ["guard"],
    where: { businessId, kind: "BACKSTOP_INTERVENTION", createdAt: { gte: since } },
    _count: { _all: true },
  });
  return grouped
    .map((row) => ({ guard: row.guard ?? "(sin guard registrado)", count: row._count._all }))
    .sort((a, b) => b.count - a.count);
}
