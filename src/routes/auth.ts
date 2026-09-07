import { Router } from "express";
import { prisma } from "../db/client";
import { hashPassword, verifyPassword } from "../auth/service";

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { businessName, email, password, contactPhone, activationKey } = req.body;

  if (!businessName || !email || !password || !activationKey) {
    res.status(400).json({ error: "Faltan campos obligatorios" });
    return;
  }

  const key = await prisma.activationKey.findUnique({ where: { code: String(activationKey).trim() } });
  if (!key || key.used) {
    res.status(400).json({ error: "La clave de activación no es válida o ya fue usada" });
    return;
  }

  const existing = await prisma.business.findUnique({ where: { email } });
  if (existing) {
    res.status(400).json({ error: "Ya existe una cuenta con ese email" });
    return;
  }

  const passwordHash = await hashPassword(password);

  const business = await prisma.business.create({
    data: {
      name: businessName,
      email,
      passwordHash,
      contactPhone: contactPhone || null,
      planTier: key.planTier,
      active: true,
    },
  });

  await prisma.activationKey.update({
    where: { id: key.id },
    data: { used: true, usedByBusinessId: business.id, usedAt: new Date() },
  });

  req.session.businessId = business.id;
  req.session.role = "OWNER";
  res.status(201).json({ id: business.id, name: business.name, email: business.email, planTier: business.planTier });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Faltan email o contraseña" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { email } });
  if (business) {
    if (!business.active) {
      res.status(401).json({ error: "Credenciales inválidas" });
      return;
    }
    const valid = await verifyPassword(password, business.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Credenciales inválidas" });
      return;
    }
    req.session.businessId = business.id;
    req.session.role = "OWNER";
    res.json({ id: business.id, name: business.name, email: business.email, planTier: business.planTier });
    return;
  }

  const member = await prisma.teamMember.findUnique({ where: { email }, include: { business: true } });
  if (!member || !member.active || !member.business.active) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }
  const validMember = await verifyPassword(password, member.passwordHash);
  if (!validMember) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }
  req.session.businessId = member.business.id;
  req.session.role = "EMPLOYEE";
  res.json({ id: member.business.id, name: member.business.name, email: member.email, planTier: member.business.planTier });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.status(204).send();
  });
});

authRouter.get("/me", async (req, res) => {
  if (!req.session.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const business = await prisma.business.findUnique({ where: { id: req.session.businessId } });
  if (!business) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  res.json({
    id: business.id,
    name: business.name,
    email: business.email,
    planTier: business.planTier,
    whatsappConnected: Boolean(business.whatsappPhoneNumberId),
    role: req.session.role ?? "OWNER",
  });
});
