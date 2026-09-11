import { Router } from "express";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { requirePlatformAdmin } from "../auth/requirePlatformAdmin";
import { generateActivationCode } from "../auth/service";

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
      createdAt: true,
    },
  });
  res.json(businesses);
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
