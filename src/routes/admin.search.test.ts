import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { adminRouter } from "./admin";

// Cubre GET /api/search (Fase 5 - buscador global, ver ONIX-CRM-REORG-PLAN.md). Real HTTP a traves
// del router, sesion falsa inyectada directo (mismo patron que admin.orderCancel.test.ts).

let server: Server;
let baseUrl: string;
let businessId: string;
let otherBusinessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Search Test ${randomUUID()}`, email: `search-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const other = await prisma.business.create({
    data: { name: `Other ${randomUUID()}`, email: `search-other-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  otherBusinessId = other.id;

  await prisma.customer.create({ data: { businessId, phoneNumber: "573001234567", name: "Ludy Numpaque" } });
  await prisma.product.create({ data: { businessId, name: "Smartwatch Serie 11", description: "x", price: 100000, currency: "COP" } });
  await prisma.faqEntry.create({ data: { businessId, question: "¿Hacen envíos a toda Colombia?", answer: "Sí" } });
  // Fila con el mismo texto pero en OTRO negocio - no debe aparecer nunca en los resultados de arriba.
  await prisma.customer.create({ data: { businessId: otherBusinessId, phoneNumber: "573009999999", name: "Ludy Ajena" } });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId?: string; role?: string } }).session = { businessId, role: "OWNER" };
    next();
  });
  app.use(adminRouter);
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  await prisma.faqEntry.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
  await prisma.business.deleteMany({ where: { id: { in: [businessId, otherBusinessId] } } });
});

test("busca por nombre de cliente sin cruzar negocios", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=ludy`);
  const data = (await res.json()) as { customers: { name: string }[] };
  assert.equal(data.customers.length, 1);
  assert.equal(data.customers[0].name, "Ludy Numpaque");
});

test("busca productos y FAQ por texto parcial", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=smartwatch`);
  const data = (await res.json()) as { products: { name: string }[] };
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].name, "Smartwatch Serie 11");

  const res2 = await fetch(`${baseUrl}/api/search?q=envíos`);
  const data2 = (await res2.json()) as { faq: unknown[] };
  assert.equal(data2.faq.length, 1);
});

test("un texto de menos de 2 caracteres devuelve todo vacío en vez de traer el negocio entero", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=a`);
  const data = await res.json();
  assert.deepEqual(data, { customers: [], products: [], orders: [], faq: [] });
});

test("sin resultados devuelve listas vacías, no un error", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=xyzxyzxyz`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { customers: unknown[]; products: unknown[] };
  assert.equal(data.customers.length, 0);
  assert.equal(data.products.length, 0);
});
