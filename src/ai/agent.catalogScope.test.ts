import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import type { ToolContext } from "./tools";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md). Los tres casos reales de
// produccion del 2026-09-15/16, contra generateReply de verdad, con el modelo mockeado (deepseek es una
// instancia mutable, ver ai/client.ts): cero red a DeepSeek, cero costo, ningun archivo *Paid.ts.
//
// La pieza que se prueba aca es la INTEGRACION: que los bloques del servidor salgan del turno y que la
// prosa del modelo no pueda meter productos ni precios. El alcance y el renderizado en si se prueban
// puros en src/catalog/scope.test.ts y src/catalog/presenter.test.ts.

let businessId: string;
let customerId: string;
let conversationId: string;
let context: ToolContext;
let originalCreate: typeof deepseek.chat.completions.create;
let originalFetch: typeof fetch;
let relojId: string;
let audifonosId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000019",
      contactName: "Owner",
      autoSendPhotoOnQuote: false,
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573098${Date.now()}` } });
  customerId = customer.id;

  const reloj = await prisma.product.create({
    data: {
      businessId,
      name: "Reloj Inteligente Serie 11 Mini",
      description: "Smartwatch compacto, pantalla rectangular.",
      price: 145000,
      currency: "COP",
      stock: 8,
      category: "Tecnologia (Relojes)",
      media: { create: [{ type: "IMAGE", url: "https://example.invalid/a.jpg", s3Key: "a.jpg" }] },
    },
  });
  relojId = reloj.id;
  await prisma.product.create({
    data: {
      businessId,
      name: "PARLANTE TIPO ALEXA",
      description: "Parlante inteligente.",
      price: 70000,
      currency: "COP",
      stock: 20,
      category: "Tecnologia (Audifonos)",
    },
  });
  const audifonos = await prisma.product.create({
    data: {
      businessId,
      name: "AIRPODS SERIE 4",
      description: "Audifonos inalambricos.",
      price: 65000,
      currency: "COP",
      stock: 11,
      category: "Tecnologia (Audifonos)",
      media: { create: [{ type: "IMAGE", url: "https://example.invalid/b.jpg", s3Key: "b.jpg" }] },
    },
  });
  audifonosId = audifonos.id;
});

after(async () => {
  await prisma.productMedia.deleteMany({ where: { product: { businessId } } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.agentTurn.deleteMany({ where: { businessId } });
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
  context = {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573001112233",
  };
  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }),
      text: async () => "{}",
    }) as Response) as typeof fetch;
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  globalThis.fetch = originalFetch;
  await prisma.agentTurn.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
});

function mockModel(responses: { content?: string | null; toolCalls?: { name: string; arguments: string }[] }[]): void {
  const queue = [...responses];
  // @ts-expect-error test stub, narrower shape than the real SDK type - mismo patron que agent.loopExhaustion.test.ts.
  deepseek.chat.completions.create = async () => {
    const next = queue.shift() ?? { content: "listo" };
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: next.content ?? null,
            tool_calls: (next.toolCalls ?? []).map((tc) => ({
              id: `call_${randomUUID()}`,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
        },
      ],
      usage: undefined,
    };
  };
}

function allBlockText(blocks: { text: string }[]): string {
  return blocks.map((b) => b.text).join("\n");
}

test("caso real 1: el cliente manda una foto, el bot identifica UN producto y no le llega el vecindario", async () => {
  // Produccion 2026-09-15/16: el bot identifico bien el Serie 11 Mini y despues le pego 11 productos,
  // incluidos AIRPODS SERIE 4 y PARLANTE TIPO ALEXA.
  await prisma.message.create({
    data: { conversationId, role: "CUSTOMER", content: "", mediaType: "IMAGE", mediaS3Key: "foto.jpg" },
  });
  mockModel([
    { toolCalls: [{ name: "get_product_details", arguments: JSON.stringify({ productId: relojId }) }] },
    // El modelo intenta ademas listar todo el catalogo, como hizo en produccion.
    { content: "¡Es este! Y mira todo lo demas:\n\n{{BLOQUE_CATALOGO}}" },
  ]);

  const { text, blocks } = await generateReply(conversationId, context, null, "");

  const bloques = allBlockText(blocks);
  assert.ok(bloques.includes("Reloj Inteligente Serie 11 Mini"), `salio: "${bloques}"`);
  assert.ok(!bloques.includes("PARLANTE TIPO ALEXA"), "una foto de un reloj no puede traer un parlante");
  assert.ok(!bloques.includes("AIRPODS SERIE 4"), "ni audifonos");
  assert.ok(!text.includes("PARLANTE TIPO ALEXA") && !text.includes("AIRPODS SERIE 4"));
  assert.ok(!text.includes("{{BLOQUE_CATALOGO}}"), "la marca nunca llega al cliente");
  assert.equal(blocks[0].media[0].items.length, 1, "la foto del producto sale con el mensaje");
});

test("caso real 2: 'K11 mini' tras una lista devuelve ese producto Y sus fotos, sin que el modelo decida nada", async () => {
  // Produccion: "Aqui te muestro el Combo k11 Mini:" y CERO fotos, aunque el producto tiene 3 cargadas.
  // El modelo aca no llama NINGUNA herramienta, que es exactamente el turno que fallaba.
  mockModel([{ content: "¡Claro! Te muestro el reloj:" }]);

  const { blocks } = await generateReply(conversationId, context, null, "quiero el Serie 11 Mini");

  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].text.includes("Reloj Inteligente Serie 11 Mini"));
  assert.ok(blocks[0].text.includes("$145.000"));
  assert.equal(blocks[0].media[0].items.length, 1, "las fotos salen aunque el modelo no llamo send_product_media");
});

test("caso real 3: pedir el catalogo completo sale de la base, aunque el modelo no llame ninguna herramienta", async () => {
  // Produccion 2026-09-15: el modelo contesto sin llamar ninguna herramienta e invento "Cargador iPhone
  // $60.000", "Cargador Tipo C $50.000" y "Base de Carga Inalambrica 3 en 1 $90.000" - ninguno existe.
  mockModel([
    {
      content:
        "¡Claro! Este es todo nuestro catálogo:\n1. Cargador iPhone — $60.000\n2. Cargador Tipo C — $50.000\n3. Base de Carga Inalámbrica 3 en 1 — $90.000",
    },
  ]);

  const { text, blocks } = await generateReply(
    conversationId,
    context,
    null,
    "muéstrame todo el catálogo completo con precios"
  );

  const todo = `${text}\n${allBlockText(blocks)}`;
  for (const inventado of ["Cargador iPhone", "Cargador Tipo C", "Base de Carga Inalámbrica"]) {
    assert.ok(!todo.includes(inventado), `"${inventado}" no existe en el catalogo y no puede salir. Salio: "${todo}"`);
  }
  for (const real of ["Reloj Inteligente Serie 11 Mini", "PARLANTE TIPO ALEXA", "AIRPODS SERIE 4"]) {
    assert.ok(todo.includes(real), `falta el producto real "${real}"`);
  }
  assert.ok(blocks.every((b) => b.media.length === 0), "el catalogo completo no manda fotos, las ofrece");
});

test("la ultima lista presentada queda guardada, y en el turno siguiente 'el 2' resuelve contra ella", async () => {
  mockModel([{ content: "Mira lo que tenemos:" }]);
  const primero = await generateReply(conversationId, context, null, "muéstrame el catálogo");
  const presentados = primero.blocks.flatMap((b) => b.productIds);
  assert.ok(presentados.length >= 2);

  const guardado = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { lastPresentedProductIds: true },
  });
  assert.deepEqual(guardado.lastPresentedProductIds, presentados);

  mockModel([{ content: "¡Buena elección!" }]);
  const segundo = await generateReply(conversationId, context, null, "el 2");
  assert.equal(segundo.blocks.length, 1);
  assert.deepEqual(segundo.blocks[0].productIds, [presentados[1]]);
});

test("alcance 'none': cero bloques y la respuesta del modelo sale intacta", async () => {
  mockModel([{ content: "¡Hola! ¿En qué te ayudo?" }]);
  const { text, blocks } = await generateReply(conversationId, context, null, "hola buenas tardes");
  assert.deepEqual(blocks, []);
  assert.equal(text, "¡Hola! ¿En qué te ayudo?");
});

test("cada turno deja su fila de AgentTurn con el alcance resuelto y las herramientas llamadas", async () => {
  mockModel([
    { toolCalls: [{ name: "get_product_details", arguments: JSON.stringify({ productId: audifonosId }) }] },
    { content: "Ahí va." },
  ]);
  await generateReply(conversationId, context, null, "el AIRPODS SERIE 4");

  const fila = await prisma.agentTurn.findFirstOrThrow({ where: { conversationId }, orderBy: { createdAt: "desc" } });
  assert.deepEqual(fila.toolsCalled, ["get_product_details"]);
  assert.ok(fila.scope.startsWith("one:"), `alcance registrado: ${fila.scope}`);
  assert.equal(fila.iterations, 2);
  assert.ok(fila.blocks.length > 0);
});
