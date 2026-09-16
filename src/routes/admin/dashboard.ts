import { Router } from "express";
import { getDashboardSummary } from "../../crm/dashboard";
import { listUnresolvedDeliveryFailures, resolveDeliveryFailure } from "../../delivery/failures";
import { listOwnerMessages } from "../../delivery/ownerLog";
import {
  customerDisplayName,
  findOpenPendingConfirmationsForBusiness,
  findOpenPendingOwnerQuestionsForBusiness,
  resolvePendingOwnerQuestion,
} from "../../conversation/service";
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

// "Preguntas del bot sin responder" en Inicio llevaba a la Bandeja en general, sin decir cuál
// pregunta ni forma de sacarla de la lista sin escribirle al cliente (feedback del dueño, ver
// ONIX-CRM-REORG-PLAN.md). Lista + resolver manual, mismo patrón que delivery-failures arriba.
dashboardRouter.get("/api/pending-questions", async (req, res) => {
  const pending = await findOpenPendingOwnerQuestionsForBusiness(businessIdOf(req));
  res.json(pending);
});

dashboardRouter.post("/api/pending-questions/:id/resolve", async (req, res) => {
  const resolved = await resolvePendingOwnerQuestion(businessIdOf(req), String(req.params.id));
  if (!resolved) {
    res.status(404).json({ error: "Pregunta no encontrada" });
    return;
  }
  res.json({ ok: true });
});

// Confirmaciones de venta sin responder (2026-09-16). Es lo mas urgente que puede haber en el panel: el
// cliente ya pago y el pedido NO se crea hasta que el dueno confirme, asi que cada minuto que pasa es un
// cliente esperando por plata que ya entrego. Solo lectura y sin accion de "resolver": la unica forma
// valida de cerrarla es que el dueno conteste si el pago llego o no - resolverla desde el panel
// equivaldria a saltearse la confirmacion, que es justo lo que no se negocia.
dashboardRouter.get("/api/pending-confirmations", async (req, res) => {
  const pending = await findOpenPendingConfirmationsForBusiness(businessIdOf(req));
  res.json(
    pending.map((conversation) => ({
      conversationId: conversation.id,
      customerId: conversation.customer.id,
      customerName: customerDisplayName(conversation.customer),
      summary: conversation.pendingOrderSummary,
      askedAt: conversation.pendingConfirmationAskedAt,
      remindedAt: conversation.pendingConfirmationRemindedAt,
      attempts: conversation.pendingConfirmationAttempts,
      // Cuando sale el proximo aviso. El intervalo crece con el numero de intento, asi que "cada cuanto"
      // no es un dato fijo que el panel pueda deducir solo.
      nextAttemptAt: conversation.pendingConfirmationNextAttemptAt,
      templatesSent: conversation.pendingConfirmationTemplatesSent,
      // Por donde salio el ultimo intento. NONE significa que no salio por ninguna via y que el
      // perseguidor lo va a volver a intentar; el dueno tiene que poder distinguir "no contesto" de
      // "nunca le llego".
      channel: conversation.pendingConfirmationChannel,
      // Salio por plantilla y el mensaje con botones todavia le debe llegar.
      buttonsQueued: conversation.pendingConfirmationButtonsQueued,
    }))
  );
});
