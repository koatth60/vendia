import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { resolveSendableMedia } from "./mediaUpload";
import { sendMediaWithSpacing, UnsendableMediaError } from "./productMedia";
import { runCatalogTool, type ToolContext } from "../ai/tools";

// E17 (2026-09-18): una foto que pesa mas que el tope de WhatsApp no se intenta enviar.
//
// Antes se intentaba igual: Meta devolvia un wamid, el envio parecia exitoso, y el rechazo llegaba
// horas despues por el webhook de estados ("Image file has size 6303812 bytes but must be atmost
// 5242880 bytes and non-empty", produccion 2026-09-16). La clienta nunca veia la foto y la duena no se
// enteraba, porque el panel ya se la mostraba como cargada.

const FOTO_RECHAZADA_BYTES = 6303812;
const CREDENCIALES = { phoneNumberId: "linea-de-prueba", accessToken: "token-de-prueba" };

let businessId: string;
let productId: string;
let customerId: string;
let s3Key: string;
let originalFetch: typeof fetch;
let llamadasAMeta: string[];

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000000",
      contactName: "Owner",
    },
  });
  businessId = business.id;

  const product = await prisma.product.create({
    data: { businessId, name: "Diadema M4", description: "Diadema de prueba", price: 40000, currency: "COP", stock: 5 },
  });
  productId = product.id;

  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573001${Date.now()}` } });
  customerId = customer.id;

  s3Key = `images/${randomUUID()}.jpg`;
  await prisma.productMedia.create({
    data: { productId, type: "IMAGE", url: "https://bucket.s3.amazonaws.com/foto.jpg?X-Amz-Signature=1", s3Key, bytes: FOTO_RECHAZADA_BYTES },
  });

  // Cualquier salida a la red seria una llamada a Meta: el punto de la etapa es que no ocurra ninguna.
  originalFetch = globalThis.fetch;
  llamadasAMeta = [];
  globalThis.fetch = (async (input: unknown) => {
    llamadasAMeta.push(String(input));
    throw new Error("no deberia haberse llamado a la red");
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  // Conversation cuelga de Customer y ese borrado no cascadea desde Business: se limpia a mano, igual
  // que en src/ai/tools.test.ts.
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.business.delete({ where: { id: businessId } });
});

test("una foto que pesa de mas no produce ninguna llamada a Meta", async () => {
  const resultado = await resolveSendableMedia(CREDENCIALES, { url: "https://bucket.s3.amazonaws.com/foto.jpg", s3Key });

  assert.equal(resultado.ok, false);
  assert.equal(llamadasAMeta.length, 0, "no se subio el archivo ni se intento enviarlo");
  if (!resultado.ok) {
    assert.match(resultado.reason, /6\.0 MB/);
    assert.match(resultado.reason, /5\.0 MB/);
  }
});

test("el envio se detiene y queda registrado como fallo de entrega con el motivo", async () => {
  await assert.rejects(
    () =>
      sendMediaWithSpacing(businessId, CREDENCIALES, "573001112233", `conversacion-${randomUUID()}`, productId, "Diadema M4", [
        { type: "IMAGE", url: "https://bucket.s3.amazonaws.com/foto.jpg", s3Key },
      ]),
    UnsendableMediaError
  );

  assert.equal(llamadasAMeta.length, 0, "el envio no llego a la red");

  // El motivo tiene que quedar donde la duena lo ve (Bot > Salud), no solo en el log: descubrirlo por el
  // reclamo de la clienta es exactamente lo que esta etapa saca del sistema.
  const fallos = await prisma.deliveryFailure.findMany({ where: { businessId } });
  assert.equal(fallos.length, 1);
  assert.match(fallos[0].errorMessage, /Diadema M4/);
  assert.match(fallos[0].errorMessage, /6\.0 MB/);
  assert.equal(fallos[0].resolved, false);
});

test("una foto que todavia no se midio no se bloquea", async () => {
  // Todo el catalogo cargado antes de esta columna tiene `bytes` en null. Bloquear lo no medido habria
  // dejado sin fotos a catalogos enteros el dia del despliegue. Con un id ya subido a Meta, el envio
  // sigue igual que siempre y no hace falta ni bajar el archivo de S3.
  const sinMedir = `images/${randomUUID()}.jpg`;
  await prisma.productMedia.create({
    data: {
      productId,
      type: "IMAGE",
      url: "https://bucket.s3.amazonaws.com/sin-medir.jpg",
      s3Key: sinMedir,
      bytes: null,
      whatsappMediaId: "1234567890123456",
      whatsappMediaAt: new Date(),
      whatsappMediaPhoneId: CREDENCIALES.phoneNumberId,
    },
  });

  const resultado = await resolveSendableMedia(CREDENCIALES, { url: "https://bucket.s3.amazonaws.com/sin-medir.jpg", s3Key: sinMedir });

  assert.equal(resultado.ok, true);
  if (resultado.ok) assert.equal(resultado.value, "1234567890123456");
  assert.equal(llamadasAMeta.length, 0);
});

test("el turno NO se cae: la herramienta devuelve que la foto no salio y por que", async () => {
  // Antes de E17 esa foto se "enviaba" con exito aparente y el turno seguia normal. Si ahora ademas de
  // no llegar cortara la respuesta entera, la clienta quedaria peor que antes - y la regla de no
  // regresion dice que ninguna etapa puede empeorar lo que hay. El modelo recibe el motivo y sigue.
  const conversation = await prisma.conversation.create({ data: { customerId } });
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Mandame la foto" } });
  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId,
    credentials: CREDENCIALES,
    recipientPhone: "573001112233",
  };

  const resultado = (await runCatalogTool(context, "send_product_media", { productId })) as {
    sent: boolean;
    reason?: string;
  };

  assert.equal(resultado.sent, false);
  assert.match(resultado.reason ?? "", /6\.0 MB/);
  assert.equal(llamadasAMeta.length, 0);
});
