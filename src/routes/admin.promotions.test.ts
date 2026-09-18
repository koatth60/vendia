import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../db/client";
import { promotionsRouter } from "./admin/promotions";
import { resolveOrderItems } from "../orders/service";

// E37 (2026-09-18). El panel de promociones, con el router real sobre un servidor real. Lo unico
// simulado es el login.
//
// La prueba que mas importa es la ultima: lo que la duena carga en el panel cambia el precio que se
// guarda en el pedido, sin que nadie escriba una cifra a mano en el medio.

let server: import("node:http").Server;
let baseUrl: string;
let businessId: string;
let otroBusinessId: string;
let relojId: string;
let ajenoId: string;
let sessionBusinessId: string;
let sessionRole: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `P ${randomUUID()}`, email: `p-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const otro = await prisma.business.create({
    data: { name: `O ${randomUUID()}`, email: `o-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  otroBusinessId = otro.id;
  relojId = (
    await prisma.product.create({
      data: { businessId, name: "RELOJ GEN 9", description: "Smartwatch", price: 59900, currency: "COP", stock: 5, category: "Relojes" },
    })
  ).id;
  ajenoId = (
    await prisma.product.create({
      data: { businessId: otroBusinessId, name: "AJENO", description: "De otro negocio", price: 1000, currency: "COP", stock: 1 },
    })
  ).id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId: string; role: string } }).session = {
      businessId: sessionBusinessId,
      role: sessionRole,
    };
    next();
  });
  app.use(promotionsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.promotion.deleteMany({ where: { businessId: { in: [businessId, otroBusinessId] } } });
  await prisma.product.deleteMany({ where: { businessId: { in: [businessId, otroBusinessId] } } });
  await prisma.business.deleteMany({ where: { id: { in: [businessId, otroBusinessId] } } });
});

beforeEach(async () => {
  sessionBusinessId = businessId;
  sessionRole = "OWNER";
  await prisma.promotion.deleteMany({ where: { businessId: { in: [businessId, otroBusinessId] } } });
});

async function crear(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/promotions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("la dueña carga una promoción y queda listada", async () => {
  const res = await crear({ name: "Aniversario", kind: "PERCENT", value: 20, scope: "GLOBAL" });
  assert.equal(res.status, 201);

  const lista = (await (await fetch(`${baseUrl}/api/promotions`)).json()) as { name: string; active: boolean }[];
  assert.equal(lista.length, 1);
  assert.equal(lista[0].name, "Aniversario");
  assert.equal(lista[0].active, true);
});

test("una promoción a medias no se guarda", async () => {
  // Cada uno de estos terminaria en un precio que nadie eligio, y el precio es lo que se le cobra.
  assert.equal((await crear({ name: "", kind: "PERCENT", value: 10, scope: "GLOBAL" })).status, 400);
  assert.equal((await crear({ name: "X", kind: "PERCENT", value: 200, scope: "GLOBAL" })).status, 400);
  assert.equal((await crear({ name: "X", kind: "PERCENT", value: 0, scope: "GLOBAL" })).status, 400);
  assert.equal((await crear({ name: "X", kind: "REGALO", value: 10, scope: "GLOBAL" })).status, 400);
  assert.equal((await crear({ name: "X", kind: "PERCENT", value: 10, scope: "CATEGORY" })).status, 400);
  assert.equal((await crear({ name: "X", kind: "PERCENT", value: 10, scope: "PRODUCT" })).status, 400);
  assert.equal(
    (await crear({ name: "X", kind: "PERCENT", value: 10, scope: "GLOBAL", startsAt: "2026-10-10", endsAt: "2026-10-01" })).status,
    400,
  );
  assert.equal(await prisma.promotion.count({ where: { businessId } }), 0);
});

test("no se puede apuntar una promoción al producto de otro negocio", async () => {
  const res = await crear({ name: "X", kind: "PERCENT", value: 10, scope: "PRODUCT", productId: ajenoId });
  assert.equal(res.status, 400);
});

test("un empleado no crea, edita ni borra promociones", async () => {
  sessionRole = "EMPLOYEE";
  assert.equal((await crear({ name: "X", kind: "PERCENT", value: 10, scope: "GLOBAL" })).status, 403);
});

test("el alcance manda: una promoción global no guarda categoría ni producto viejos", async () => {
  const creada = (await (await crear({
    name: "Relojes",
    kind: "PERCENT",
    value: 15,
    scope: "CATEGORY",
    categoryLabel: "Relojes",
  })).json()) as { id: string; categoryNormalized: string | null };
  assert.equal(creada.categoryNormalized, "relojes");

  const res = await fetch(`${baseUrl}/api/promotions/${creada.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Relojes", kind: "PERCENT", value: 15, scope: "GLOBAL", categoryLabel: "Relojes" }),
  });
  const actualizada = (await res.json()) as { scope: string; categoryNormalized: string | null };
  assert.equal(actualizada.scope, "GLOBAL");
  assert.equal(actualizada.categoryNormalized, null, "una promocion global con una categoria adentro es una trampa para el que la lea");
});

test("una promoción de otro negocio no se ve ni se borra desde esta sesión", async () => {
  const ajena = await prisma.promotion.create({
    data: { businessId: otroBusinessId, name: "Ajena", kind: "PERCENT", value: 50, scope: "GLOBAL" },
  });

  const lista = (await (await fetch(`${baseUrl}/api/promotions`)).json()) as unknown[];
  assert.equal(lista.length, 0);

  const res = await fetch(`${baseUrl}/api/promotions/${ajena.id}`, { method: "DELETE" });
  assert.equal(res.status, 404);
  assert.equal(await prisma.promotion.count({ where: { id: ajena.id } }), 1);
});

// LO QUE HACE QUE ESTA ETAPA SIRVA: lo cargado en el panel cambia el precio que se GUARDA.
test("lo que la dueña carga en el panel es lo que se cobra", async () => {
  const sinPromo = await resolveOrderItems(businessId, [{ productId: relojId, quantity: 1 }]);
  assert.equal(sinPromo.items[0].unitPrice, 59900);

  assert.equal((await crear({ name: "Aniversario", kind: "PERCENT", value: 20, scope: "CATEGORY", categoryLabel: "relojes" })).status, 201);

  const conPromo = await resolveOrderItems(businessId, [{ productId: relojId, quantity: 1 }]);
  assert.equal(conPromo.items[0].unitPrice, 47920, "el descuento entra en el precio guardado, no solo en lo que dice el bot");
});

test("una promoción vencida o apagada no cambia ningún precio", async () => {
  await prisma.promotion.create({
    data: { businessId, name: "Vencida", kind: "PERCENT", value: 50, scope: "GLOBAL", endsAt: new Date(Date.now() - 86400000) },
  });
  await prisma.promotion.create({
    data: { businessId, name: "Apagada", kind: "PERCENT", value: 50, scope: "GLOBAL", active: false },
  });

  const items = await resolveOrderItems(businessId, [{ productId: relojId, quantity: 1 }]);
  assert.equal(items.items[0].unitPrice, 59900);
});
