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
  const activo = Boolean(req.body?.active);
  const updated = await prisma.teamMember.update({
    where: { id: member.id },
    data: {
      active: activo,
      // E28: desactivarlo le corta las sesiones abiertas EN EL ACTO. Sin esto seguia entrando al panel
      // hasta que su cookie expirara sola. Reactivarlo no sube la version: no hay nada que cortar, y
      // subirla echaria a alguien que quedo trabajando entre medio.
      ...(activo ? {} : { sessionVersion: { increment: 1 } }),
    },
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
  // E28: se sube la version ANTES de borrar. La fila desaparece, asi que la sesion del borrado ya no
  // valida contra nada y cae igual; el increment esta para que, si el borrado falla a mitad de camino,
  // el acceso quede cortado lo mismo. Cortar primero y borrar despues, nunca al reves.
  await prisma.teamMember.update({ where: { id: member.id }, data: { sessionVersion: { increment: 1 } } });
  await prisma.teamMember.delete({ where: { id: member.id } });
  res.status(204).send();
});

