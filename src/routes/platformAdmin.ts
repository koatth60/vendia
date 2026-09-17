import { Router } from "express";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { requirePlatformAdmin } from "../auth/requirePlatformAdmin";
import { generateActivationCode } from "../auth/service";
import { listOwnerMessages } from "../delivery/ownerLog";
import { listDeliveryFailuresForBusiness, resolveDeliveryFailure } from "../delivery/failures";
import { periodStartOf } from "../billing/chats";
import { defaultCeilingUsd } from "../billing/spendCeiling";

export const platformAdminRouter = Router();

platformAdminRouter.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (
    !env.platformAdmin.email ||
    !env.platformAdmin.password ||
    email !== env.platformAdmin.email ||
    password !== env.platformAdmin.password
  ) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }
  req.session.platformAdmin = true;
  res.json({ ok: true });
});

platformAdminRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.status(204).send();
  });
});

platformAdminRouter.get("/me", (req, res) => {
  if (!req.session.platformAdmin) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  res.json({ ok: true });
});

platformAdminRouter.use(requirePlatformAdmin);

platformAdminRouter.get("/businesses", async (_req, res) => {
  const businesses = await prisma.business.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      planTier: true,
      active: true,
      contactName: true,
      contactPhone: true,
      whatsappPhoneNumberId: true,
      whatsappPhoneNumber: true,
      whatsappBusinessAccountId: true,
      whatsappTokenExpiresAt: true,
      whatsappConnectionBrokenAt: true,
      aiSpendCeilingUsd: true,
      createdAt: true,
    },
  });

  // Cuanto lleva gastado cada uno este mes, para que el techo no sea un numero a ciegas: subirlo o
  // bajarlo sin ver contra que se compara es adivinar. Una sola consulta agrupada, no una por negocio.
  const periodStart = periodStartOf(new Date());
  const spendByBusiness = await prisma.aiUsageLog.groupBy({
    by: ["businessId"],
    where: { createdAt: { gte: periodStart } },
    _sum: { costUsd: true },
  });
  const spent = new Map(spendByBusiness.map((row) => [row.businessId, row._sum.costUsd ?? 0]));

  res.json(
    businesses.map((b) => ({
      ...b,
      spentUsd: spent.get(b.id) ?? 0,
      effectiveCeilingUsd: b.aiSpendCeilingUsd ?? defaultCeilingUsd(b.planTier),
      ceilingIsDefault: b.aiSpendCeilingUsd == null,
    }))
  );
});

// El techo de gasto de IA de un negocio (ver src/billing/spendCeiling.ts). Vive en el panel de
// PLATAFORMA y no en el del negocio a proposito: es plata nuestra, no del cliente.
platformAdminRouter.patch("/businesses/:id/spend-ceiling", async (req, res) => {
  const raw = req.body?.aiSpendCeilingUsd;
  // null/"" = volver al default del plan. Es una opcion real, no un campo sin llenar.
  const ceiling = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0)) {
    res.status(400).json({ error: "El techo tiene que ser un número mayor que 0, o vacío para usar el del plan" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!business) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }

  await prisma.business.update({
    where: { id: business.id },
    // Subir el techo tiene que DESPAUSAR el bot en el acto. spendCeilingNotifiedAt es lo unico que
    // recuerda que ya se aviso en este periodo; sin limpiarlo, el proximo cruce del mes pasaria mudo.
    data: { aiSpendCeilingUsd: ceiling, spendCeilingNotifiedAt: null },
  });

  res.json({ ok: true });
});

platformAdminRouter.patch("/businesses/:id/whatsapp", async (req, res) => {
  const { phoneNumberId, phoneNumber, accessToken, businessAccountId } = req.body;
  if (!phoneNumberId || !phoneNumber || !accessToken) {
    res.status(400).json({ error: "Faltan phoneNumberId, phoneNumber o accessToken" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: req.params.id } });
  if (!business) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }

  await prisma.business.update({
    where: { id: business.id },
    data: {
      whatsappPhoneNumberId: phoneNumberId,
      whatsappPhoneNumber: phoneNumber,
      whatsappAccessToken: accessToken,
      whatsappBusinessAccountId: businessAccountId || null,
    },
  });

  res.json({ ok: true });
});

// Merges the bot<->owner message log and Meta's async delivery-failure reports into one chronological
// timeline, so the platform admin can see "did this business's owner actually get alerted" without
// grepping pm2 logs. Not exposed to the business's own /admin panel - the owner already sees their
// side of these messages live in WhatsApp.
platformAdminRouter.get("/businesses/:id/owner-log", async (req, res) => {
  const businessId = req.params.id;
  const [messages, failures] = await Promise.all([
    listOwnerMessages(businessId),
    listDeliveryFailuresForBusiness(businessId),
  ]);

  const timeline = [
    ...messages.map((m) => ({
      kind: "message" as const,
      id: m.id,
      direction: m.direction,
      body: m.body,
      success: m.success,
      errorMessage: m.errorMessage,
      createdAt: m.createdAt,
    })),
    ...failures.map((f) => ({
      kind: "delivery_failure" as const,
      id: f.id,
      direction: "OUT" as const,
      body: null,
      success: false,
      errorMessage: `Meta reporto que el envio a ${f.recipientPhone} fallo: ${f.errorMessage}`,
      critical: f.critical,
      resolved: f.resolved,
      createdAt: f.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  res.json(timeline);
});

platformAdminRouter.post("/businesses/:id/delivery-failures/:failureId/resolve", async (req, res) => {
  try {
    await resolveDeliveryFailure(req.params.id, req.params.failureId);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo marcar como visto" });
  }
});

platformAdminRouter.get("/key-requests", async (_req, res) => {
  const requests = await prisma.keyRequest.findMany({ orderBy: { createdAt: "desc" } });
  res.json(requests);
});

platformAdminRouter.patch("/key-requests/:id", async (req, res) => {
  const { handled } = req.body;
  await prisma.keyRequest.update({
    where: { id: req.params.id },
    data: { handled: Boolean(handled) },
  });
  res.json({ ok: true });
});

// Bandeja de cuentas esperando activacion. No hay tabla propia a proposito: la solicitud ES el
// Business con active=false, asi que esta lista no puede quedar desincronizada de la realidad.
platformAdminRouter.get("/pending-activations", async (_req, res) => {
  const pending = await prisma.business.findMany({
    where: { active: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      contactPhone: true,
      planTier: true,
      createdAt: true,
    },
  });
  res.json(pending);
});

// Activar es un solo campo. El plan se confirma aqui porque el que trae la cuenta es el que el
// cliente pidio en el formulario, no uno que Zaqi haya cobrado todavia.
platformAdminRouter.post("/pending-activations/:id/activate", async (req, res) => {
  const { planTier } = req.body;
  if (planTier !== undefined && !["BASICO", "EMPRENDEDOR", "NEGOCIO"].includes(planTier)) {
    res.status(400).json({ error: "Plan inválido" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: req.params.id } });
  if (!business) {
    res.status(404).json({ error: "No existe esa cuenta" });
    return;
  }

  const updated = await prisma.business.update({
    where: { id: business.id },
    data: {
      active: true,
      ...(planTier ? { planTier } : {}),
    },
    select: { id: true, name: true, email: true, planTier: true, active: true },
  });

  res.json(updated);
});

platformAdminRouter.get("/activation-keys", async (_req, res) => {
  const keys = await prisma.activationKey.findMany({ orderBy: { createdAt: "desc" } });
  const businessIds = keys.map((k) => k.usedByBusinessId).filter((id): id is string => Boolean(id));
  const businesses = await prisma.business.findMany({
    where: { id: { in: businessIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(businesses.map((b) => [b.id, b.name]));

  res.json(
    keys.map((k) => ({
      id: k.id,
      code: k.code,
      planTier: k.planTier,
      used: k.used,
      usedByBusinessName: k.usedByBusinessId ? (nameById.get(k.usedByBusinessId) ?? null) : null,
      createdAt: k.createdAt,
      usedAt: k.usedAt,
    }))
  );
});

platformAdminRouter.post("/activation-keys", async (req, res) => {
  const { planTier } = req.body;
  if (!["BASICO", "EMPRENDEDOR", "NEGOCIO"].includes(planTier)) {
    res.status(400).json({ error: "Plan inválido" });
    return;
  }

  const code = generateActivationCode();
  const key = await prisma.activationKey.create({ data: { code, planTier } });
  res.status(201).json({ code: key.code, planTier: key.planTier });
});
