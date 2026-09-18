import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { adminRouter } from "./admin";

// E46 (2026-09-18). `PUT /api/business` tiene que admitir payloads parciales.
//
// Ocho campos usaban `x || null` y tres `Boolean(x)`. Omitirlos no los dejaba como estaban: los
// BORRABA. O sea que partir el guardado por seccion del panel - mandar solo lo que esa seccion edita -
// habria apagado en silencio el envio automatico de fotos, el pedido de comprobante y el nombre del
// asistente de cualquier negocio que guardara cualquier OTRA seccion.
//
// HTTP real contra el router, sesion falsa inyectada; ningun servicio externo.

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
  const res = await fetch(`${baseUrl}/api/business`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.text());
  return res;
}

test("E46: un PUT con un solo campo no toca ningun otro", async () => {
  // Se deja el negocio con valores en todos los campos que antes se borraban solos.
  await put({
    name: "Negocio de prueba",
    assistantName: "Sofia",
    botTone: "cercano",
    botDialect: "colombiano",
    botGreeting: "Hola!",
    botNeverSay: "no tenemos",
    businessCategory: "relojeria",
    followUpTemplateName: "seguimiento_1",
    cartRecoveryTemplateName: "carrito_1",
    autoSendPhotoOnQuote: true,
    offerPhotosBeforeSending: true,
    requirePaymentProof: true,
  });

  const antes = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  assert.equal(antes.assistantName, "Sofia");
  assert.equal(antes.autoSendPhotoOnQuote, true);
  assert.equal(antes.requirePaymentProof, true);

  // Ahora la seccion "Negocio" del panel guarda SOLO su campo. Antes de E46, este PUT dejaba
  // assistantName, botTone, botGreeting, botNeverSay y los tres booleanos en null/false.
  await put({ name: "Negocio renombrado" });

  const despues = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  assert.equal(despues.name, "Negocio renombrado", "lo que SI se mando tiene que cambiar");
  assert.equal(despues.assistantName, "Sofia");
  assert.equal(despues.botTone, "cercano");
  assert.equal(despues.botDialect, "colombiano");
  assert.equal(despues.botGreeting, "Hola!");
  assert.equal(despues.botNeverSay, "no tenemos");
  assert.equal(despues.businessCategory, "relojeria");
  assert.equal(despues.followUpTemplateName, "seguimiento_1");
  assert.equal(despues.cartRecoveryTemplateName, "carrito_1");
  assert.equal(despues.autoSendPhotoOnQuote, true, "un booleano ausente no puede apagarse solo");
  assert.equal(despues.offerPhotosBeforeSending, true);
  assert.equal(despues.requirePaymentProof, true);
});

test("E46: mandar el campo VACIO sigue borrandolo, que es lo que hace el formulario", async () => {
  await put({ assistantName: "Sofia", botGreeting: "Hola!" });
  await put({ assistantName: "" });

  const despues = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  assert.equal(despues.assistantName, null, "vaciar el campo en el formulario tiene que borrarlo");
  assert.equal(despues.botGreeting, "Hola!", "y no puede arrastrarse a los que no se mandaron");
});

test("E46: mandar un booleano en false SI lo apaga", async () => {
  await put({ requirePaymentProof: true });
  await put({ requirePaymentProof: false });

  const despues = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  assert.equal(despues.requirePaymentProof, false, "false explicito no es lo mismo que ausente");
});
