import { Router } from "express";
import { getDashboardSummary } from "../../crm/dashboard";
import { listUnresolvedDeliveryFailures, resolveDeliveryFailure } from "../../delivery/failures";
import { listOwnerMessages } from "../../delivery/ownerLog";
import { businessIdOf } from "./shared";

// Fase 3 (ver ONIX-CRM-REORG-PLAN.md): lo que el backend ya registraba pero el dueño no podia ver
// desde su propio panel - fallos de entrega (solo visibles desde el panel interno de Zaqi) y la
// conversacion bot <-> dueño (idem). Ambos ya tenian servicio; lo unico que faltaba era exponerlos
// al negocio dueño de esos datos.
export const dashboardRouter = Router();

dashboardRouter.get("/api/dashboard", async (req, res) => {
  const summary = await getDashboardSummary(businessIdOf(req));
  res.json(summary);
});

dashboardRouter.get("/api/delivery-failures", async (req, res) => {
  const failures = await listUnresolvedDeliveryFailures(businessIdOf(req));
  res.json(failures);
});

dashboardRouter.post("/api/delivery-failures/:id/resolve", async (req, res) => {
  try {
    await resolveDeliveryFailure(businessIdOf(req), String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo marcar como resuelto" });
  }
});

dashboardRouter.get("/api/owner-log", async (req, res) => {
  const messages = await listOwnerMessages(businessIdOf(req));
  res.json(messages);
});
