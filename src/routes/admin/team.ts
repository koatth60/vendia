import { Router } from "express";
import { prisma } from "../../db/client";
import { requireOwner } from "../../auth/requireOwner";
import { hashPassword } from "../../auth/service";
import { businessIdOf } from "./shared";

export const teamRouter = Router();

teamRouter.get("/api/team", requireOwner, async (req, res) => {
  const members = await prisma.teamMember.findMany({
    where: { businessId: businessIdOf(req) },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
  res.json(members);
});

teamRouter.post("/api/team", requireOwner, async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || !password) {
    res.status(400).json({ error: "Faltan email, nombre o contraseña" });
    return;
  }
  const existing = await prisma.teamMember.findUnique({ where: { email } });
  const existingBusiness = await prisma.business.findUnique({ where: { email } });
  if (existing || existingBusiness) {
    res.status(400).json({ error: "Ya existe una cuenta con ese email" });
    return;
  }
  const passwordHash = await hashPassword(password);
  const member = await prisma.teamMember.create({
    data: { businessId: businessIdOf(req), email, name, passwordHash },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
  res.status(201).json(member);
});

teamRouter.put("/api/team/:id", requireOwner, async (req, res) => {
  const member = await prisma.teamMember.findFirst({ where: { id: String(req.params.id), businessId: businessIdOf(req) } });
  if (!member) {
    res.status(404).json({ error: "Miembro no encontrado" });
    return;
  }
  const updated = await prisma.teamMember.update({
    where: { id: member.id },
    data: { active: Boolean(req.body?.active) },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
  res.json(updated);
});

teamRouter.delete("/api/team/:id", requireOwner, async (req, res) => {
  const member = await prisma.teamMember.findFirst({ where: { id: String(req.params.id), businessId: businessIdOf(req) } });
  if (!member) {
    res.status(404).json({ error: "Miembro no encontrado" });
    return;
  }
  await prisma.teamMember.delete({ where: { id: member.id } });
  res.status(204).send();
});

