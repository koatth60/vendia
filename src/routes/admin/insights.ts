import { Router } from "express";
import { getAiUsageSummary } from "../../ai/usage";
import { getChatUsage } from "../../billing/chats";
import { getAgentIncidentSummary, getHealthFindings } from "../../ai/incidents";
import { getConfigHealth } from "../../ai/configHealth";
import { getShadowValidationSummary, getAgentAuthorshipSummary } from "../../ai/agentTurns";
import { getAnalyticsSummary, getBaselineMetrics } from "../../analytics/service";
import { businessIdOf } from "./shared";

export const insightsRouter = Router();

insightsRouter.get("/api/ai-usage", async (req, res) => {
  const businessId = businessIdOf(req);
  const [summary, planUsage] = await Promise.all([getAiUsageSummary(businessId), getChatUsage(businessId)]);
  res.json({ ...summary, planUsage });
});

// Fase F, 2026-09-13 audit (F9): surfaces what used to only exist as console.error/warn lines in
// production logs - loop exhaustions, backstop interventions, degraded replies (last 7 days) plus a live
// count of conversations currently stuck with humanControl:true (Fase A's watchdog fields).
insightsRouter.get("/api/agent-incidents", async (req, res) => {
  const summary = await getAgentIncidentSummary(businessIdOf(req));
  res.json(summary);
});

// Fase 0 (2026-09-15): el detalle de lo que encontro el chequeo automatico en las ultimas 24h, para que
// "salud del bot" deje de ser solo contadores y diga QUE paso en cada conversacion.
insightsRouter.get("/api/health-findings", async (req, res) => {
  const findings = await getHealthFindings(businessIdOf(req));
  res.json({ findings });
});

// Pieza 5 del plan de catalogo y medios (2026-09-16), MODO SOMBRA: cuantos mensajes del bot HABRIAN
// quedado marcados por la validacion contra el catalogo real, y cuales. No cambia ni una respuesta -
// es el numero con el que se decide, dentro de 48 horas, si la validacion se activa o no.
insightsRouter.get("/api/catalog-shadow", async (req, res) => {
  const summary = await getShadowValidationSummary(businessIdOf(req));
  res.json(summary);
});

// E76 (2026-09-18): cuantos de los turnos que exigian un efecto los resolvio el AGENTE y cuantos los
// termino escribiendo el SERVIDOR, mas las lineas del prompt en la misma respuesta. Las dos mitades de
// la medida del norte juntas: el prompt bajando con la tasa de servidor subiendo no es progreso.
insightsRouter.get("/api/agent-authorship", async (req, res) => {
  const requested = Number(req.query.days);
  const days = ANALYTICS_RANGES.includes(requested) ? requested : 7;
  const summary = await getAgentAuthorshipSummary(businessIdOf(req), days);
  res.json(summary);
});

// Fase G, 2026-09-13 audit: surfaces the config gaps that today fail silently in production - see
// configHealth.ts for exactly which ones and why each matters.
insightsRouter.get("/api/config-health", async (req, res) => {
  const health = await getConfigHealth(businessIdOf(req));
  res.json(health);
});


// El panel ofrece 7 / 30 / 90 dias. Cualquier otro valor cae a 30 en vez de
// dejar que el front pida un rango arbitrario contra la base.
const ANALYTICS_RANGES = [7, 30, 90];

insightsRouter.get("/api/analytics", async (req, res) => {
  const requested = Number(req.query.days);
  const days = ANALYTICS_RANGES.includes(requested) ? requested : 30;
  const summary = await getAnalyticsSummary(businessIdOf(req), days);
  res.json({ ...summary, days });
});

// Fase 0 del plan maestro (2026-09-15): linea base P1-P7 contra la que se compara cada fase siguiente.
insightsRouter.get("/api/baseline", async (req, res) => {
  const requested = Number(req.query.days);
  const days = ANALYTICS_RANGES.includes(requested) ? requested : 30;
  const baseline = await getBaselineMetrics(businessIdOf(req), days);
  res.json(baseline);
});

