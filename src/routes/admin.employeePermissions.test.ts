import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../db/client";
import { adminRouter } from "./admin";

// Fase 8, punto 4 del plan maestro (2026-09-15), decision D5 del diagnostico: que puede hacer un
// EMPLOYEE. Puede usar la bandeja y el catalogo; no puede tocar la conexion de WhatsApp, el equipo,
// los pagos, los envios, ni cancelar pedidos.
//
// Esta prueba es la que sostiene esa decision: sin ella, la proxima ruta que alguien agregue vuelve a
// quedar abierta para todos por omision, que es exactamente como llegamos aca.

let server: import("node:http").Server;
let baseUrl: string;
let businessId: string;
let sessionRole: "OWNER" | "EMPLOYEE";
// E28 (2026-09-18): la sesion de un empleado ahora se valida contra SU fila, asi que el harness deja de
// inventar un empleado que no existe y crea uno de verdad.
let teamMemberId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const member = await prisma.teamMember.create({
    data: { businessId, email: `emp-${randomUUID()}@example.com`, name: "Empleado", passwordHash: "x" },
  });
  teamMemberId = member.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session =
      sessionRole === "EMPLOYEE"
        ? { businessId, role: sessionRole, teamMemberId, sessionVersion: 0 }
        : { businessId, role: sessionRole, sessionVersion: 0 };
    next();
  });
  app.use("/admin", adminRouter);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.teamMember.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Cada entrada es una accion que un empleado NO puede hacer. El cuerpo es deliberadamente incompleto:
// requireOwner corta antes de mirarlo, asi que ninguna de estas llamadas llega a escribir nada.
const OWNER_ONLY = [
  // La mas grave: completar este flujo reemplaza el phoneNumberId y el token del negocio.
  { method: "POST", path: "/admin/api/whatsapp/connect", body: {} },
  { method: "PUT", path: "/admin/api/orders/no-existe/cancel" },
  { method: "POST", path: "/admin/api/team", body: {} },
  { method: "PUT", path: "/admin/api/team/no-existe", body: {} },
  { method: "DELETE", path: "/admin/api/team/no-existe" },
  { method: "GET", path: "/admin/api/team" },
  { method: "POST", path: "/admin/api/payment-methods", body: {} },
  { method: "PUT", path: "/admin/api/payment-methods/no-existe", body: {} },
  { method: "DELETE", path: "/admin/api/payment-methods/no-existe" },
  { method: "POST", path: "/admin/api/shipping-rates", body: {} },
  { method: "PUT", path: "/admin/api/shipping-rates/no-existe", body: {} },
  { method: "DELETE", path: "/admin/api/shipping-rates/no-existe" },
  { method: "POST", path: "/admin/api/shipping-city-rules", body: {} },
  { method: "DELETE", path: "/admin/api/shipping-city-rules/no-existe" },
  { method: "PUT", path: "/admin/api/business", body: {} },
];

test("un EMPLOYEE no puede tocar WhatsApp, equipo, pagos, envios ni cancelar pedidos", async () => {
  sessionRole = "EMPLOYEE";
  for (const route of OWNER_ONLY) {
    const response = await call(route.method, route.path, route.body);
    assert.equal(response.status, 403, `${route.method} ${route.path} tendria que ser 403 para un empleado`);
  }
});

test("las mismas rutas no rebotan con 403 cuando entra el dueno", async () => {
  sessionRole = "OWNER";
  // Se prueban las dos que no escriben nada con un cuerpo/id invalido: lo que importa es que el rechazo
  // deje de ser por rol. Un 400 o un 404 significa que el dueno si paso el control de acceso.
  const connect = await call("POST", "/admin/api/whatsapp/connect", {});
  assert.equal(connect.status, 400, "al dueno le tiene que faltar el cuerpo, no el permiso");

  const cancel = await call("PUT", "/admin/api/orders/no-existe/cancel");
  assert.equal(cancel.status, 404, "al dueno le tiene que faltar el pedido, no el permiso");
});

test("un EMPLOYEE si puede usar la bandeja y el catalogo", async () => {
  sessionRole = "EMPLOYEE";

  const inbox = await call("GET", "/admin/api/conversations");
  assert.equal(inbox.status, 200);

  const listed = await call("GET", "/admin/api/products");
  assert.equal(listed.status, 200);

  const created = await call("POST", "/admin/api/products", {
    name: `Producto ${randomUUID()}`,
    description: "producto de prueba",
    price: 10000,
    currency: "COP",
    stock: 1,
  });
  assert.equal(created.status, 201, "el catalogo es parte del trabajo de un empleado");
  const product = (await created.json()) as { id: string };
  const removed = await call("DELETE", `/admin/api/products/${product.id}`);
  assert.equal(removed.status, 204);
});
