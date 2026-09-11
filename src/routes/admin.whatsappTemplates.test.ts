import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { adminRouter } from "./admin";

// Covers GET /api/whatsapp-templates (backs the "plantilla aprobada" dropdown in the business settings
// tab, src/routes/admin.ts) - real HTTP through the router, fake session injected directly (no cookie
// jar needed), only the outbound WhatsApp Graph API call is stubbed.

let server: Server;
let baseUrl: string;
let businessId: string;
let sessionRole: string = "OWNER";
let originalFetch: typeof fetch;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId?: string; role?: string } }).session = { businessId, role: sessionRole };
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
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sessionRole = "OWNER";
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("GET /api/whatsapp-templates returns approved templates when the business has a WABA ID configured", async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappAccessToken: "fake-token",
      whatsappBusinessAccountId: "1400084061566358",
    },
  });
  businessId = business.id;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              name: "onix_owner_alert",
              status: "APPROVED",
              language: "es",
              components: [{ type: "BODY", text: "Onix: {{1}}\n\nEntra a zaqisolutions.com y anda a Conversaciones para atender." }],
            },
            { name: "seguimiento_post_venta", status: "PENDING", language: "es", components: [{ type: "BODY", text: "no deberia aparecer" }] },
          ],
        }),
      } as Response;
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  const res = await fetch(`${baseUrl}/api/whatsapp-templates`);
  assert.equal(res.status, 200);
  const body = await res.json() as { templates: unknown[]; note?: string; error?: string };
  assert.deepEqual(body.templates, [
    { name: "onix_owner_alert", language: "es", bodyText: "Onix: {{1}}\n\nEntra a zaqisolutions.com y anda a Conversaciones para atender." },
  ]);
});

test("GET /api/whatsapp-templates returns an empty list with a note when the business has no WABA ID configured", async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappAccessToken: "fake-token",
    },
  });
  businessId = business.id;

  const res = await fetch(`${baseUrl}/api/whatsapp-templates`);
  assert.equal(res.status, 200);
  const body = await res.json() as { templates: unknown[]; note?: string; error?: string };
  assert.deepEqual(body.templates, []);
  assert.match(body.note ?? "", /WhatsApp Business Account/);
});

test("GET /api/whatsapp-templates reports an error (not a crash) when the WhatsApp API call fails", async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappAccessToken: "fake-token",
      whatsappBusinessAccountId: "1400084061566358",
    },
  });
  businessId = business.id;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com")) {
      return { ok: false, status: 401, text: async () => "unauthorized" } as Response;
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  const res = await fetch(`${baseUrl}/api/whatsapp-templates`);
  assert.equal(res.status, 502);
  const body = await res.json() as { templates: unknown[]; note?: string; error?: string };
  assert.deepEqual(body.templates, []);
  assert.ok(body.error);
});

test("GET /api/whatsapp-templates/all returns every status, not just approved", async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappAccessToken: "fake-token",
      whatsappBusinessAccountId: "1400084061566358",
    },
  });
  businessId = business.id;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { name: "onix_owner_alert", status: "APPROVED", language: "es", category: "UTILITY", components: [{ type: "BODY", text: "ok" }] },
            { name: "seguimiento_post_venta", status: "PENDING", language: "es", category: "UTILITY", components: [{ type: "BODY", text: "pendiente" }] },
            { name: "promo_vieja", status: "REJECTED", language: "es", category: "MARKETING", components: [{ type: "BODY", text: "rechazada" }] },
          ],
        }),
      } as Response;
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  const res = await fetch(`${baseUrl}/api/whatsapp-templates/all`);
  assert.equal(res.status, 200);
  const body = await res.json() as { templates: { name: string; status: string }[] };
  assert.equal(body.templates.length, 3);
  assert.ok(body.templates.some((t) => t.status === "PENDING"));
  assert.ok(body.templates.some((t) => t.status === "REJECTED"));
});

test("POST /api/whatsapp-templates normalizes the name, forwards to Meta, and rejects a body with variables", async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappAccessToken: "fake-token",
      whatsappBusinessAccountId: "1400084061566358",
    },
  });
  businessId = business.id;

  let sentBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com") && (init?.method ?? "GET") === "POST") {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return { ok: true, json: async () => ({ id: "123", status: "PENDING" }) } as Response;
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  const res = await fetch(`${baseUrl}/api/whatsapp-templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Descuento de Fin de Semana!!", category: "MARKETING", bodyText: "Tenemos ofertas especiales este finde." }),
  });
  assert.equal(res.status, 201);
  assert.ok(sentBody, "expected the create call to reach the WhatsApp API");
  assert.equal((sentBody as unknown as { name: string }).name, "descuento_de_fin_de_semana");
  assert.equal((sentBody as unknown as { category: string }).category, "MARKETING");

  const resWithVariable = await fetch(`${baseUrl}/api/whatsapp-templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "otra", category: "UTILITY", bodyText: "Hola {{1}}, gracias por tu compra." }),
  });
  assert.equal(resWithVariable.status, 400, "variables aren't supported from the panel yet, must be rejected before calling Meta");
});

test("POST /api/whatsapp-templates is blocked for a non-owner team member", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x", whatsappAccessToken: "fake-token", whatsappBusinessAccountId: "1400084061566358" },
  });
  businessId = business.id;
  sessionRole = "MEMBER";

  const res = await fetch(`${baseUrl}/api/whatsapp-templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "algo", category: "UTILITY", bodyText: "texto" }),
  });
  assert.equal(res.status, 403);
});

test("DELETE /api/whatsapp-templates/:name forwards to the WhatsApp API", async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappAccessToken: "fake-token",
      whatsappBusinessAccountId: "1400084061566358",
    },
  });
  businessId = business.id;

  let deletedName = "";
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com")) {
      deletedName = new URL(String(url)).searchParams.get("name") ?? "";
      return { ok: true, json: async () => ({ success: true }) } as Response;
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  const res = await fetch(`${baseUrl}/api/whatsapp-templates/promo_vieja`, { method: "DELETE" });
  assert.equal(res.status, 204);
  assert.equal(deletedName, "promo_vieja");
});
