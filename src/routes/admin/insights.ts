import { Router } from "express";
import { getAiUsageSummary, getPlanUsage } from "../../ai/usage";
import { getAgentIncidentSummary } from "../../ai/incidents";
import { getConfigHealth } from "../../ai/configHealth";
import { getAnalyticsSummary } from "../../analytics/service";
import { businessIdOf } from "./shared";

export const insightsRouter = Router();

insightsRouter.get("/api/ai-usage", async (req, res) => {
  const businessId = businessIdOf(req);
  const [summary, planUsage] = await Promise.all([getAiUsageSummary(businessId), getPlanUsage(businessId)]);
  res.json({ ...summary, planUsage });
});

// Fase F, 2026-09-13 audit (F9): surfaces what used to only exist as console.error/warn lines in
// production logs - loop exhaustions, backstop interventions, degraded replies (last 7 days) plus a live
// count of conversations currently stuck with humanControl:true (Fase A's watchdog fields).
insightsRouter.get("/api/agent-incidents", async (req, res) => {
  const summary = await getAgentIncidentSummary(businessIdOf(req));
  res.json(summary);
});

// Fase G, 2026-09-13 audit: surfaces the config gaps that today fail silently in production - see
// configHealth.ts for exactly which ones and why each matters.
insightsRouter.get("/api/config-health", async (req, res) => {
  const health = await getConfigHealth(businessIdOf(req));
  res.json(health);
});


insightsRouter.get("/api/analytics", async (req, res) => {
  const summary = await getAnalyticsSummary(businessIdOf(req));
  res.json(summary);
});

