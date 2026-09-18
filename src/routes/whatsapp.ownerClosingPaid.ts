import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { handleOwnerReply } from "./whatsapp";
import type { WhatsappCredentials } from "../whatsapp/outbound";

// *Paid.ts, NO *.test.ts: esta prueba le habla a DeepSeek de verdad y cuesta plata. Vivia dentro de
// src/routes/whatsapp.test.ts, con el comentario "Real DeepSeek call (no mocking)" y todo, asi que
// `npm test` la corria (y la pagaba) en cada push. Cuarta vez que pasa lo mismo en este repo; las tres
// anteriores estan anotadas en CLAUDE.md. Se movio aca el 2026-09-18, junto con el cambio que le deja
// a CI una key invalida para que un descuido asi no pueda volver a facturar en silencio.
// Las otras 8 pruebas del archivo original NO llaman al modelo - medido, no supuesto: con una key
// invalida las 8 pasan y solo esta falla. Se quedaron donde estaban.
//
// Corre con: npm run test:paid

let credentials: WhatsappCredentials;
let originalFetch: typeof fetch;
let sentMessages: { to: string; body: string }[];

before(() => {
  credentials = { phoneNumberId: "test-id", accessToken: "test-token" };
});

after(() => {
  // No queda nada que limpiar aca: el negocio de la prueba se borra en su propio `finally`.
});

// Se intercepta el fetch de salida de WhatsApp para no mandarle un mensaje a nadie. Ojo: esto NO tapa
// la llamada a DeepSeek - el SDK no pasa por este globalThis.fetch, y justamente por eso la prueba es
// paga. Si algun dia lo tapara, esta prueba dejaria de probar lo que dice probar.
beforeEach(() => {
  originalFetch = globalThis.fetch;
  sentMessages = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text") sentMessages.push({ to, body: body.text?.body ?? "" });
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Cubre el arreglo donde el camino determinista de "el dueño confirma el pago" mandaba siempre un
// cierre generico hardcodeado, ignorando el guion de cierre que el negocio tiene escrito en
// customInstructions (por ejemplo la plantilla "Etapa 4: Cierre Oficial" de MAG.IMP, con placeholders).
test("handleOwnerReply confirms payment and follows the business's own closing script from customInstructions, filling in real order data", async () => {
  const business2 = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000002",
      contactName: "Owner2",
      customInstructions: `Etapa de cierre (REGLA MANDATORIA): una vez el pago este confirmado, cierra la
conversacion enviando UNICAMENTE este mensaje exacto, reemplazando los placeholders con los datos reales
del pedido, sin agregar ni modificar nada mas:
"Listo [Nombre del cliente], tu pedido por un total de [Total] quedo cerrado. Gracias por tu compra."`,
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business2.id, phoneNumber: `57300${Date.now()}9`, name: "Camila" },
  });
  const wamid = `wamid.confirm-${randomUUID()}`;
  const conversation = await prisma.conversation.create({
    data: {
      customerId: customer.id,
      pendingConfirmationMessageId: wamid,
      pendingOrderSummary: "1x Producto Test",
      pendingOrderItems: {
        items: [{ productId: "test-product-id", productName: "Producto Test", quantity: 1, unitPrice: 50000, currency: "COP" }],
        shippingAddress: "Calle 1, Bogota",
        paymentMethodLabel: "Nequi",
        shippingCost: 0,
      },
    },
  });
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Ya pague" } });

  try {
    await handleOwnerReply(business2.id, credentials, "573000000002", {
      type: "text",
      text: { body: "si" },
      context: { id: wamid },
    });

    const sentToCustomer = sentMessages.find((m) => m.to === customer.phoneNumber);
    assert.ok(sentToCustomer, "expected a closing message sent to the customer");
    assert.match(sentToCustomer!.body, /Camila/, "must use the business's own template, filled with the real customer name");
    assert.match(sentToCustomer!.body, /50\s?\.?000/, "must fill in the real order total, not a placeholder");

    const order = await prisma.order.findUnique({ where: { conversationId: conversation.id } });
    assert.ok(order, "expected an order to actually be created");
  } finally {
    await prisma.order.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});
