import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { adminRouter } from "./admin";
import { getBusinessLocale } from "../config/businessConfig";

// Fase 11 del plan maestro (2026-09-15): pais, moneda, zona horaria, horario de atencion y la regla de
// documento de identidad se editan desde el panel. HTTP real contra el router, sesion falsa inyectada;
// no se llama a ningun servicio externo.

let server: Server;
let baseUrl: string;
let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId?: string; role?: string } }).session = { businessId, role: "OWNER" };
    next();
  });
  app.use(adminRouter);
  server = app.listen(0);
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  await prisma.business.deleteMany({ where: { id: businessId } });
});

async function put(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/business`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test", ...body }),
  });
}

test("un negocio arranca en Colombia con las zonas exentas vacias", async () => {
  const negocio = await getBusinessLocale(businessId);
  assert.equal(negocio.countryCode, "CO");
  assert.equal(negocio.currency, "COP");
  assert.equal(negocio.timezone, "America/Bogota");
  assert.equal(negocio.businessHours, null);
});

test("el panel puede pasar el negocio a Mexico sin tocar codigo", async () => {
  const res = await put({
    countryCode: "MX",
    currency: "MXN",
    timezone: "America/Mexico_City",
    requiresIdDocument: false,
    idDocumentExemptZones: [],
    businessHours: { mon: ["09:00", "18:00"], sat: ["10:00", "14:00"] },
  });
  assert.equal(res.status, 200);

  const negocio = await getBusinessLocale(businessId);
  assert.equal(negocio.countryCode, "MX");
  assert.equal(negocio.currency, "MXN");
  assert.equal(negocio.locale, "es-MX");
  assert.equal(negocio.country.documentLabel, "identificación");
  assert.equal(negocio.requirements.requiresIdDocument, false);
  assert.deepEqual(negocio.businessHours, { mon: ["09:00", "18:00"], sat: ["10:00", "14:00"] });
});

test("un pais que el producto no soporta no se guarda", async () => {
  await put({ countryCode: "XX" });
  const negocio = await getBusinessLocale(businessId);
  assert.equal(negocio.countryCode, "MX", "se queda con el ultimo pais valido, no con uno que el bot no sabe usar");
});

test("las zonas sin documento se guardan como las escribe el dueno", async () => {
  await put({ countryCode: "CO", requiresIdDocument: true, idDocumentExemptZones: [" Bogota ", "Soacha", ""] });
  const negocio = await getBusinessLocale(businessId);
  assert.deepEqual(negocio.requirements.idDocumentExemptZones, ["Bogota", "Soacha"]);
});

test("un horario mal formado no se guarda a medias, y null lo borra", async () => {
  await put({ businessHours: { mon: ["9", "18"] } });
  assert.equal((await getBusinessLocale(businessId)).businessHours, null);

  await put({ businessHours: { tue: ["08:00", "17:00"] } });
  assert.deepEqual((await getBusinessLocale(businessId)).businessHours, { tue: ["08:00", "17:00"] });

  await put({ businessHours: null });
  assert.equal((await getBusinessLocale(businessId)).businessHours, null);
});

test("la lista de paises la sirve el backend, no una copia del panel", async () => {
  const res = await fetch(`${baseUrl}/api/countries`);
  const { countries } = (await res.json()) as { countries: { code: string; defaultCurrency: string }[] };
  assert.deepEqual(countries.map((c) => c.code), ["CO", "MX"]);
  assert.equal(countries.find((c) => c.code === "MX")?.defaultCurrency, "MXN");
});
