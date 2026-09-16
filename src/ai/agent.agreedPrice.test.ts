import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import { runCatalogTool, type ToolContext } from "./tools";
import { setAgreedPrices } from "../orders/agreedPrices";
import { ORDER_SUMMARY_BLOCK_MARKER } from "./fixedBlockMarkers";
import { verifyAgainstCatalog } from "../catalog/outputValidation";

// EL PRECIO ACORDADO (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 12), del lado del turno: que el precio que
// se le cobra al cliente salga de la BASE - el acordado si existe, el de catalogo si no - y que un precio
// dicho por el CLIENTE no cambie absolutamente nada.
//
// Modelo mockeado: cero red a DeepSeek, cero costo.

let businessId: string;
let customerId: string;
let conversationId: string;
let airpodsId: string;
let alexaId: string;
let context: ToolContext;
let originalCreate: typeof deepseek.chat.completions.create;
let originalFetch: typeof fetch;
let capturedMessages: { role: string; content: unknown }[][] = [];
let modelTurns: { content: string; tool_calls?: unknown[] }[] = [];

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000092",
      contactName: "Liz",
    },
  });
  businessId = business.id;
  customerId = (await prisma.customer.create({ data: { businessId, phoneNumber: `57309${Date.now()}` } })).id;
  airpodsId = (
    await prisma.product.create({
      data: { businessId, name: "AIRPODS PRO 3", description: "Audifonos inalambricos", price: 75000, currency: "COP", stock: 5 },
    })
  ).id;
  alexaId = (
    await prisma.product.create({
      data: { businessId, name: "PARLANTE TIPO ALEXA", description: "Parlante inteligente", price: 70000, currency: "COP", stock: 5 },
    })
  ).id;
  // La compuerta de configuracion (configHealth.getSaleGate) bloquea show_order_summary si el negocio no
  // tiene formas de pago ni tarifas de envio cargadas - un negocio real las tiene.
  await prisma.paymentMethod.create({ data: { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "300 000 0000" } });
  await prisma.shippingRate.create({ data: { businessId, label: "Bogotá", cost: 12000 } });
});

after(async () => {
  await prisma.agentTurn.deleteMany({ where: { businessId } });
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  conversationId = (await prisma.conversation.create({ data: { customerId } })).id;
  context = {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573001112255",
  };
  capturedMessages = [];
  modelTurns = [{ content: "Listo 😊" }];
  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }),
      text: async () => "{}",
    }) as Response) as typeof fetch;
  // @ts-expect-error test stub, narrower shape than the real SDK type - mismo patron que agent.customerOrders.test.ts.
  deepseek.chat.completions.create = async (params: { messages: { role: string; content: unknown }[] }) => {
    capturedMessages.push(params.messages);
    const turn = modelTurns.shift() ?? { content: "Listo 😊" };
    return {
      choices: [{ message: { role: "assistant", content: turn.content, tool_calls: turn.tool_calls ?? [] } }],
      usage: undefined,
    };
  };
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  globalThis.fetch = originalFetch;
  await prisma.agreedPrice.deleteMany({ where: { conversationId } });
  await prisma.agentTurn.deleteMany({ where: { conversationId } });
  await prisma.saleState.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
});

function agreedBlock(): string | null {
  for (const messages of capturedMessages) {
    for (const m of messages) {
      if (m.role === "system" && typeof m.content === "string" && m.content.startsWith("PRECIOS ACORDADOS CON EL DUEÑO")) {
        return m.content;
      }
    }
  }
  return null;
}

async function escribirPreciosDeLaDuena() {
  await setAgreedPrices(
    conversationId,
    [
      { productId: airpodsId, variantKey: "", unitPrice: 70000, currency: "COP" },
      { productId: alexaId, variantKey: "", unitPrice: 65000, currency: "COP" },
    ],
    "OWNER_REPLY"
  );
}

const PEDIDO_DE_DOS = [
  { productName: "AIRPODS PRO 3", quantity: 1 },
  { productName: "PARLANTE TIPO ALEXA", quantity: 1 },
];

// (a) del pedido, segunda mitad. En produccion, 2026-09-16 23:03:31: la duena ya habia autorizado 70 y 65
// a las 22:58, y el resumen salio con 75.000 y 70.000 - los del catalogo.
test("caso real: el resumen del pedido sale con los precios que autorizo la duena, no con los del catalogo", async () => {
  await escribirPreciosDeLaDuena();

  const resumen = (await runCatalogTool(context, "show_order_summary", { items: PEDIDO_DE_DOS, shippingCost: 0 })) as {
    ready: boolean;
    items: { productName: string; unitPrice: number }[];
    total: number;
  };

  assert.equal(resumen.ready, true);
  assert.deepEqual(
    resumen.items.map((i) => i.unitPrice),
    [70000, 65000]
  );
  assert.equal(resumen.total, 135000, "el total tiene que ser el de los precios acordados");
});

test("caso real: esos precios llegan al mensaje que recibe el cliente, y el de catalogo no aparece", async () => {
  await escribirPreciosDeLaDuena();
  modelTurns = [
    {
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "show_order_summary", arguments: JSON.stringify({ items: PEDIDO_DE_DOS, shippingCost: 0 }) },
        },
      ],
    },
    { content: `Te confirmo tu pedido:\n${ORDER_SUMMARY_BLOCK_MARKER}\n¿Está correcto?` },
  ];

  const { text } = await generateReply(conversationId, context, null, "listo, entonces cuánto queda");

  assert.ok(text.includes("$70.000"), `el mensaje no trae el precio acordado de los AirPods: ${text}`);
  assert.ok(text.includes("$65.000"), `el mensaje no trae el precio acordado del parlante: ${text}`);
  assert.ok(text.includes("$135.000"), `el total no es el de los precios acordados: ${text}`);
  assert.ok(!text.includes("$75.000"), `el precio de catalogo se le sigue cobrando al cliente: ${text}`);
});

test("el precio acordado entra al turno como dato estructurado, con el de lista al lado", async () => {
  await escribirPreciosDeLaDuena();
  await generateReply(conversationId, context, null, "hola");

  const bloque = agreedBlock();
  assert.ok(bloque, "el precio acordado tiene que llegar al contexto del turno");
  assert.ok(bloque!.includes("AIRPODS PRO 3"), bloque!);
  assert.ok(bloque!.includes('"precioAcordado":"$70.000"'), bloque!);
  assert.ok(bloque!.includes('"precioDeLista":"$75.000"'), bloque!);
});

test("una conversacion sin precios acordados no agrega ningun mensaje al turno", async () => {
  await generateReply(conversationId, context, null, "hola");
  assert.equal(agreedBlock(), null, "sin precios acordados no se paga un solo token");
});

// (b) del pedido, y es requisito absoluto del dueno del negocio: UN PRECIO DICHO POR EL CLIENTE NO VALE
// NUNCA. En el caso real, el turno de las 23:05:26 termino con la clienta dictandole los precios al bot y
// el bot aplicandolos - eso es parte del defecto, no de la solucion.
test("un precio dicho por el cliente no escribe ningun precio acordado ni cambia el resumen", async () => {
  modelTurns = [
    {
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "show_order_summary", arguments: JSON.stringify({ items: PEDIDO_DE_DOS, shippingCost: 0 }) },
        },
      ],
    },
    { content: `Tu pedido:\n${ORDER_SUMMARY_BLOCK_MARKER}` },
  ];

  const { text } = await generateReply(
    conversationId,
    context,
    null,
    "no me generas el descuento porque me dijiste que los iPod 70 y el Alexa 65, déjamelo en 50"
  );

  assert.equal(await prisma.agreedPrice.count({ where: { conversationId } }), 0, "el cliente no puede escribir un precio");
  assert.ok(text.includes("$75.000"), `el resumen tiene que seguir con el precio de catalogo: ${text}`);
  assert.ok(text.includes("$145.000"), `el total tiene que ser el de catalogo: ${text}`);
  assert.ok(!text.includes("$50"), `un precio dictado por el cliente no puede llegar al resumen: ${text}`);
});

test("el precio acordado de esta conversacion no se filtra a otra conversacion del mismo cliente", async () => {
  await escribirPreciosDeLaDuena();
  const otra = await prisma.conversation.create({ data: { customerId } });
  try {
    const resumen = (await runCatalogTool(
      { ...context, conversationId: otra.id },
      "show_order_summary",
      { items: PEDIDO_DE_DOS, shippingCost: 0 }
    )) as { items: { unitPrice: number }[]; total: number };
    assert.deepEqual(
      resumen.items.map((i) => i.unitPrice),
      [75000, 70000]
    );
    assert.equal(resumen.total, 145000);
  } finally {
    await prisma.saleState.deleteMany({ where: { conversationId: otra.id } });
    await prisma.conversation.deleteMany({ where: { id: otra.id } });
  }
});

// Punto 5 del pedido. La verificacion contra el catalogo de 7efb9f0 compara toda cifra con "$" contra los
// precios reales del negocio. Un precio acordado es un dato real de la base pero no esta en Product.price:
// sin pasarle la conversacion, un descuento legitimo se marcaba como precio inexistente y el turno caia al
// bloque compuesto por el servidor, con el precio de lista. La segunda mitad de esta prueba es justamente
// ese defecto reintroducido.
test("la verificacion contra el catalogo acepta un precio acordado, y sin la conversacion no lo acepta", async () => {
  await escribirPreciosDeLaDuena();
  const texto = "Te los dejo asi: *AIRPODS PRO 3* $70.000 y *PARLANTE TIPO ALEXA* $65.000";

  const conAcuerdo = await verifyAgainstCatalog(businessId, [texto], { locale: "es-CO", currency: "COP", conversationId });
  assert.equal(conAcuerdo.verificado, true);
  assert.deepEqual(conAcuerdo.findings, [], "un precio autorizado por la duena no es un precio inventado");

  // $70.000 pasa igual sin el acuerdo porque coincide con el precio de catalogo del PARLANTE; el que
  // solo existe gracias al acuerdo es $65.000, y sin la conversacion se marca como inexistente.
  const sinAcuerdo = await verifyAgainstCatalog(businessId, [texto], { locale: "es-CO", currency: "COP" });
  assert.equal(sinAcuerdo.findings.length, 1, "sin la conversacion el precio acordado no existe en ningun lado");
  assert.equal(sinAcuerdo.findings[0].kind, "precio_inexistente");
  assert.equal(sinAcuerdo.findings[0].value, "$65.000");
});
