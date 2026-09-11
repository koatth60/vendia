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
let originalFetch: typeof fetch;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId?: string } }).session = { businessId };
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
            { name: "onix_owner_alert", status: "APPROVED", language: "es" },
            { name: "seguimiento_post_venta", status: "PENDING", language: "es" },
          ],
        }),
      } as Response;
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  const res = await fetch(`${baseUrl}/api/whatsapp-templates`);
  assert.equal(res.status, 200);
  const body = await res.json() as { templates: unknown[]; note?: string; error?: string };
  assert.deepEqual(body.templates, [{ name: "onix_owner_alert", language: "es" }]);
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
