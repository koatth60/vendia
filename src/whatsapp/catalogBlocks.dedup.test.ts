import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { sendCatalogBlocks } from "./catalogBlocks";
import type { CatalogBlock } from "../catalog/presenter";

// E10: un fallo no se puede convertir en dos.
//
// sendCatalogBlocks ignoraba el resultado del envio del TEXTO del bloque - el mensaje que lleva los
// nombres y los precios - pero igual marcaba sus productos como vistos en Conversation.mediaSentProductIds.
// Como renderCatalog lee ese campo antes de adjuntar nada, el turno siguiente suprimia esas mismas fotos:
// la clienta se quedaba sin el bloque para siempre y nadie se enteraba.

const CREDENCIALES = { phoneNumberId: "linea-a", accessToken: "token" };

let businessId: string;
let customerId: string;
let productId: string;
let conversationId: string;
let originalFetch: typeof fetch;
/** Deja fallar el envio de texto y deja pasar todo lo demas, o al reves. */
let elTextoFalla = false;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000031",
      contactName: "Owner",
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573097${Date.now()}` } });
  customerId = customer.id;
  const product = await prisma.product.create({
    data: { businessId, name: "PARLANTE TIPO ALEXA", description: "Parlante.", price: 75000, currency: "COP", stock: 4 },
  });
  productId = product.id;
  // Con un id de Meta vigente, resolveSendableMedia no baja nada de S3: la prueba no toca la red real.
  await prisma.productMedia.create({
    data: {
      productId,
      type: "IMAGE",
      url: "https://bucket.s3.amazonaws.com/a.jpg",
      s3Key: `images/${randomUUID()}.jpg`,
      bytes: 120_000,
      whatsappMediaId: "1234567890123456",
      whatsappMediaAt: new Date(),
      whatsappMediaPhoneId: CREDENCIALES.phoneNumberId,
    },
  });

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const cuerpo = String(init?.body ?? "");
    if (elTextoFalla && cuerpo.includes('"type":"text"')) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "rechazado", code: 100, type: "OAuthException" } }),
        json: async () => ({}),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }),
      text: async () => JSON.stringify({ messages: [{ id: `wamid.${randomUUID()}` }] }),
    } as Response;
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.saleState.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.productMedia.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
});

beforeEach(async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
  // La ventana de 24 h se mide contra el ultimo mensaje del cliente: sin el, la capa de salida la da por
  // cerrada y no manda nada.
  await prisma.message.create({ data: { conversationId, role: "CUSTOMER", content: "que tienen" } });
});

function bloque(): CatalogBlock {
  return {
    text: "1. PARLANTE TIPO ALEXA - $75.000",
    modelText: "1. PARLANTE TIPO ALEXA - $75.000",
    kind: "lista",
    productIds: [productId],
    media: [
      {
        productId,
        productName: "PARLANTE TIPO ALEXA",
        items: [{ type: "IMAGE", url: "https://bucket.s3.amazonaws.com/a.jpg", s3Key: "images/a.jpg" }],
        caption: "1. PARLANTE TIPO ALEXA - $75.000",
      },
    ],
  } as CatalogBlock;
}

test("si el texto del bloque llego, el producto queda marcado como visto", async () => {
  elTextoFalla = false;
  await sendCatalogBlocks({ businessId, conversationId, credentials: CREDENCIALES, to: "573001112233", blocks: [bloque()] });

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { browsePhotoProductIds: true },
  });
  assert.deepEqual(conversation?.browsePhotoProductIds, [productId], "el dedup normal sigue funcionando igual que antes");
});

test("si el texto del bloque NO llego, el producto no se marca como visto", async () => {
  // Es el caso que convertia un fallo en dos: la foto salio, el texto con el precio no, y el dedup del
  // turno siguiente borraba la unica oportunidad de arreglarlo.
  elTextoFalla = true;
  await sendCatalogBlocks({ businessId, conversationId, credentials: CREDENCIALES, to: "573001112233", blocks: [bloque()] });

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { browsePhotoProductIds: true, mediaSentProductIds: true },
  });
  assert.deepEqual(conversation?.browsePhotoProductIds, [], "sin texto no hay producto visto: el turno siguiente lo vuelve a mandar");
  assert.deepEqual(conversation?.mediaSentProductIds, []);
});

test("SaleState.mediaSent si registra la foto que SI salio, aunque el texto falle", async () => {
  // Son dos hechos distintos: "la clienta ya vio este producto" (dedup) y "el servidor mando media de
  // verdad en esta conversacion" (evidencia de venta en curso que lee computeRequiredEffects). El
  // segundo es cierto aunque el texto no haya llegado, y perderlo apagaria los efectos requeridos.
  elTextoFalla = true;
  await sendCatalogBlocks({ businessId, conversationId, credentials: CREDENCIALES, to: "573001112233", blocks: [bloque()] });

  const saleState = await prisma.saleState.findUnique({ where: { conversationId }, select: { mediaSent: true } });
  assert.deepEqual(saleState?.mediaSent, ["PARLANTE TIPO ALEXA"]);
});
