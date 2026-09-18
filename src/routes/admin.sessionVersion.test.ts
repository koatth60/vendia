import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { adminRouter } from "./admin";

// E28 (2026-09-18). Borrar o desactivar a un miembro le cierra la sesion EN EL ACTO.
//
// Antes no existia sessionVersion en ningun modelo: requireAuth solo miraba que la cookie tuviera un
// businessId. O sea que quitarle el acceso a alguien no surtia efecto hasta que su cookie expirara
// sola - seguia entrando al panel, con las conversaciones y el catalogo del negocio.

let server: Server;
let baseUrl: string;
let businessId: string;
let memberId: string;
// La sesion que el harness inyecta, mutable: es la "cookie" de esta prueba.
let sesion: Record<string, unknown>;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const member = await prisma.teamMember.create({
    data: { businessId, email: `emp-${randomUUID()}@example.com`, name: "Empleado", passwordHash: "x" },
  });
  memberId = member.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = sesion;
    next();
  });
  app.use(adminRouter);
  server = app.listen(0);
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  await prisma.teamMember.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

const pedirAlPanel = () => fetch(`${baseUrl}/api/conversations`);

test("E28: la sesion de un empleado activo funciona", async () => {
  sesion = { businessId, role: "EMPLOYEE", teamMemberId: memberId, sessionVersion: 0 };
  assert.equal((await pedirAlPanel()).status, 200);
});

test("E28: desactivar al miembro le corta la sesion abierta, sin esperar a que expire", async () => {
  sesion = { businessId, role: "EMPLOYEE", teamMemberId: memberId, sessionVersion: 0 };
  assert.equal((await pedirAlPanel()).status, 200, "arranca adentro");

  // Exactamente lo que hace la ruta PUT /api/team/:id al desactivar.
  await prisma.teamMember.update({
    where: { id: memberId },
    data: { active: false, sessionVersion: { increment: 1 } },
  });

  // La MISMA cookie de antes. No se vuelve a entrar.
  assert.equal((await pedirAlPanel()).status, 401, "desactivado no puede seguir adentro");

  await prisma.teamMember.update({ where: { id: memberId }, data: { active: true } });
});

test("E28: una version de sesion vieja no vale aunque el miembro siga activo", async () => {
  await prisma.teamMember.update({ where: { id: memberId }, data: { sessionVersion: { increment: 1 } } });
  const actual = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });

  sesion = { businessId, role: "EMPLOYEE", teamMemberId: memberId, sessionVersion: actual.sessionVersion - 1 };
  assert.equal((await pedirAlPanel()).status, 401, "una cookie emitida antes del corte no sirve");

  sesion = { businessId, role: "EMPLOYEE", teamMemberId: memberId, sessionVersion: actual.sessionVersion };
  assert.equal((await pedirAlPanel()).status, 200, "la emitida despues si");
});

test("E28: un empleado no puede usar su sesion contra otro negocio", async () => {
  const otro = await prisma.business.create({
    data: { name: `Otro ${randomUUID()}`, email: `otro-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const actual = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });
  try {
    // Cookie con el businessId cambiado a mano: el miembro es real y su version es la buena, pero
    // pertenece a OTRO negocio. Sin este chequeo la sesion serviria para leer el panel ajeno.
    sesion = { businessId: otro.id, role: "EMPLOYEE", teamMemberId: memberId, sessionVersion: actual.sessionVersion };
    assert.equal((await pedirAlPanel()).status, 401);
  } finally {
    await prisma.business.deleteMany({ where: { id: otro.id } });
  }
});

test("E28: al dueño tambien se le puede cortar, subiendo la version del negocio", async () => {
  const negocio = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  sesion = { businessId, role: "OWNER", sessionVersion: negocio.sessionVersion };
  assert.equal((await pedirAlPanel()).status, 200, "arranca adentro");

  await prisma.business.update({ where: { id: businessId }, data: { sessionVersion: { increment: 1 } } });
  assert.equal((await pedirAlPanel()).status, 401, "subir la version del negocio corta a sus dueños");
});
