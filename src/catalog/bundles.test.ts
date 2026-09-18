import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { listarCombos, obtenerCombo, buscarComboPorNombre, combosDisponibles, combosParaElModelo } from "./bundles";
import { runCatalogTool, type ToolContext } from "../ai/tools";
import { resolveOrderItems, createOrder, markOrderCanceled } from "../orders/service";

// E38 (2026-09-18). Un combo es un producto compuesto, no prosa en una descripcion.
//
// El caso real que esto cierra (2026-09-13): un combo cargado como Product con su contenido escrito en
// la descripcion ("incluye pulsos en Metalico Plateado, Cuero Marron, Silicona Azul/Negra/Morada...")
// hacia que ESE producto coincidiera con casi cualquier busqueda por color.

let businessId: string;
let customerId: string;
let conversationId: string;
let pulsoPlateadoId: string;
let pulsoMarronId: string;
let comboId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `B ${randomUUID()}`, email: `b-${randomUUID()}@example.com`, passwordHash: "x", currency: "COP" },
  });
  businessId = business.id;

  pulsoPlateadoId = (
    await prisma.product.create({
      data: { businessId, name: "PULSO METALICO", description: "Pulso metalico", price: 30000, currency: "COP", stock: 10, color: "plateado", category: "Pulsos" },
    })
  ).id;
  pulsoMarronId = (
    await prisma.product.create({
      data: { businessId, name: "PULSO CUERO", description: "Pulso de cuero", price: 25000, currency: "COP", stock: 4, color: "marron", category: "Pulsos" },
    })
  ).id;

  customerId = (await prisma.customer.create({ data: { businessId, phoneNumber: `573007${Date.now()}` } })).id;
});

after(async () => {
  await prisma.order.deleteMany({ where: { businessId } });
  await prisma.bundle.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  await prisma.order.deleteMany({ where: { businessId } });
  await prisma.bundle.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  conversationId = (await prisma.conversation.create({ data: { customerId } })).id;
  await prisma.product.update({ where: { id: pulsoPlateadoId }, data: { stock: 10 } });
  await prisma.product.update({ where: { id: pulsoMarronId }, data: { stock: 4 } });

  const combo = await prisma.bundle.create({
    data: {
      businessId,
      name: "Combo Pareja",
      // La descripcion es marketing, NO el contenido: el contenido son las filas de abajo. Y encima
      // menciona colores a proposito, que es lo que rompia la busqueda cuando un combo era un Product.
      description: "El regalo perfecto: incluye pulsos en metalico plateado y cuero marron",
      price: 50000,
      currency: "COP",
      items: {
        create: [
          { productId: pulsoPlateadoId, quantity: 1 },
          { productId: pulsoMarronId, quantity: 2 },
        ],
      },
    },
  });
  comboId = combo.id;
});

test("la disponibilidad la marca el componente mas escaso, no un numero escrito a mano", async () => {
  // 10 plateados alcanzan para 10 combos; 4 marrones de a 2 alcanzan para 2. El combo son 2.
  const [combo] = await listarCombos(businessId);
  assert.equal(combo.disponibles, 2);

  await prisma.product.update({ where: { id: pulsoMarronId }, data: { stock: 1 } });
  const [despues] = await listarCombos(businessId);
  assert.equal(despues.disponibles, 0, "vender un componente suelto cambia lo que se puede prometer del combo");
});

test("un combo sin componentes no se puede prometer", () => {
  assert.equal(combosDisponibles([]), 0);
});

// EL DEFECTO QUE ESTA ETAPA CIERRA.
test("la búsqueda por color no devuelve el combo por las palabras de su descripción", async () => {
  const context: ToolContext = {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "x", accessToken: "y" },
    recipientPhone: "573001112277",
  };
  const resultado = (await runCatalogTool(context, "find_products_by_attributes", { color: "plateado" })) as {
    matches?: { productName: string }[];
  };
  const nombres = (resultado.matches ?? []).map((m) => m.productName);

  assert.ok(nombres.includes("PULSO METALICO"), "el producto que SI es plateado tiene que seguir saliendo");
  assert.equal(
    nombres.includes("Combo Pareja"),
    false,
    "un combo no es un producto del catalogo: su descripcion no puede hacerlo coincidir con un color",
  );
});

test("el combo se resuelve por id y por nombre exacto, y nunca por algo parecido", async () => {
  assert.equal((await obtenerCombo(businessId, comboId))?.name, "Combo Pareja");
  assert.equal((await buscarComboPorNombre(businessId, "combo pareja"))?.id, comboId, "la coincidencia es normalizada");
  assert.equal(await buscarComboPorNombre(businessId, "combo"), null, "un combo mal identificado es una venta con el precio de otro");
});

test("la línea del combo se cobra al precio del combo, no a la suma de sus partes", async () => {
  const { items } = await resolveOrderItems(businessId, [{ bundleId: comboId, quantity: 1 }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].productName, "Combo Pareja");
  assert.equal(items[0].bundleId, comboId);
  // Sumando las partes serian 30000 + 2x25000 = 80000. El combo vale 50000: es el motivo por el que existe.
  assert.equal(items[0].unitPrice, 50000);
});

test("vender un combo mueve el stock de cada componente, y cancelarlo lo devuelve", async () => {
  const { items } = await resolveOrderItems(businessId, [{ bundleId: comboId, quantity: 2 }]);
  const order = await createOrder({
    businessId,
    customerId,
    conversationId,
    summary: "2x Combo Pareja",
    items,
  });

  const plateado = await prisma.product.findUniqueOrThrow({ where: { id: pulsoPlateadoId } });
  const marron = await prisma.product.findUniqueOrThrow({ where: { id: pulsoMarronId } });
  assert.equal(plateado.stock, 8, "2 combos se llevan 2 pulsos plateados");
  assert.equal(marron.stock, 0, "2 combos se llevan 4 pulsos de cuero: eran 2 por combo");

  await markOrderCanceled(businessId, order.id);

  const plateadoDespues = await prisma.product.findUniqueOrThrow({ where: { id: pulsoPlateadoId } });
  const marronDespues = await prisma.product.findUniqueOrThrow({ where: { id: pulsoMarronId } });
  assert.equal(plateadoDespues.stock, 10);
  assert.equal(marronDespues.stock, 4);
});

test("el combo llega al modelo como dato, con lo que incluye y cuántos quedan", async () => {
  const [combo] = await combosParaElModelo(businessId, "es-CO");
  assert.equal(combo.combo, "Combo Pareja");
  assert.deepEqual(combo.incluye, ["1x PULSO METALICO", "2x PULSO CUERO"]);
  assert.equal(combo.disponibles, 2);
});

test("un combo apagado no se le ofrece a nadie", async () => {
  await prisma.bundle.update({ where: { id: comboId }, data: { active: false } });
  assert.deepEqual(await combosParaElModelo(businessId, "es-CO"), []);
  assert.equal(await buscarComboPorNombre(businessId, "Combo Pareja"), null);

  const { items, unresolved } = await resolveOrderItems(businessId, [{ bundleId: comboId, quantity: 1 }]);
  assert.equal(items.length, 0);
  assert.equal(unresolved.length, 1, "pedir un combo apagado no puede terminar en una linea silenciosa");
});
