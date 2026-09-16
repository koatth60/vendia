import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCustomerCommerceState, type CommerceRows } from "./customerCommerceState";

// Pieza 6 del plan de catalogo y medios. Todo lo que decide QUE ve el modelo vive en una funcion pura,
// asi que estas pruebas no tocan la base, ni la red, ni el modelo. La lectura real (por cliente, nunca
// por conversacion) se prueba de punta a punta en src/ai/agent.customerOrders.test.ts.

const OPTS = { currency: "COP", locale: "es-CO" };
const ACTUAL = "conv-actual";
const OTRA = "conv-otra";

function rows(partial: Partial<CommerceRows>): CommerceRows {
  return { orders: [], conversations: [], ...partial };
}

function order(over: Partial<CommerceRows["orders"][number]> = {}) {
  return {
    conversationId: OTRA,
    summary: "1x PARLANTE TIPO ALEXA",
    totalAmount: 80000,
    currency: "COP",
    fulfillmentStatus: "PENDING",
    createdAt: new Date("2026-09-15T14:00:00.000Z"),
    ...over,
  };
}

test("el caso real: un pedido abierto en otra conversacion entra al estado, marcado como de otra conversacion", () => {
  // Produccion 2026-09-15: pedido cmu3hv4y600ag4k2kanuuooyr creado en la conversacion cmu3hp5ve008f4k2ko22vdf2f,
  // la clienta pidio cancelarlo desde la cmu3hw2qp00ar4k2ku58i0b5f y para el modelo no existia.
  const state = buildCustomerCommerceState(rows({ orders: [order()] }), ACTUAL, OPTS);

  assert.equal(state.pedidos.length, 1);
  assert.equal(state.pedidos[0].resumen, "1x PARLANTE TIPO ALEXA");
  assert.equal(state.pedidos[0].estado, "pendiente");
  assert.equal(state.pedidos[0].total, "$80.000");
  assert.equal(state.pedidos[0].creado, "2026-09-15");
  assert.equal(state.pedidos[0].enEstaConversacion, false, "el pedido es de otra conversacion del mismo cliente");
});

test("un pedido de esta misma conversacion queda marcado como tal", () => {
  const state = buildCustomerCommerceState(rows({ orders: [order({ conversationId: ACTUAL })] }), ACTUAL, OPTS);
  assert.equal(state.pedidos[0].enEstaConversacion, true);
});

test("sin pedidos el estado queda vacio: un cliente nuevo no agrega nada al turno", () => {
  const state = buildCustomerCommerceState(rows({}), ACTUAL, OPTS);
  assert.deepEqual(state, { pedidos: [], ventaEnCurso: null, ultimaListaPresentada: null });
});

test("un pedido abierto viejo no se pierde detras de los cerrados recientes", () => {
  // El pedido que rompio en produccion tenia dias. Recortar por recencia a secas lo volveria a esconder.
  const viejoAbierto = order({ summary: "1x PARLANTE viejo", createdAt: new Date("2026-08-01T10:00:00.000Z") });
  const cerrados = Array.from({ length: 6 }, (_, i) =>
    order({
      summary: `entregado ${i}`,
      fulfillmentStatus: "SHIPPED",
      createdAt: new Date(`2026-09-${10 + i}T10:00:00.000Z`),
    })
  );
  const state = buildCustomerCommerceState(rows({ orders: [...cerrados, viejoAbierto] }), ACTUAL, OPTS);

  assert.equal(state.pedidos[0].resumen, "1x PARLANTE viejo", "el abierto va primero");
  assert.equal(state.pedidos.filter((p) => p.estado === "enviado").length, 2, "solo dos cerrados acompanan");
  assert.ok(state.pedidos.length <= 5);
});

test("el estado de cada pedido sale de la base, no de una interpretacion", () => {
  const state = buildCustomerCommerceState(
    rows({
      orders: [
        order({ fulfillmentStatus: "PENDING", summary: "a" }),
        order({ fulfillmentStatus: "SHIPPED", summary: "b" }),
        order({ fulfillmentStatus: "CANCELED", summary: "c" }),
      ],
    }),
    ACTUAL,
    OPTS
  );
  assert.deepEqual(
    state.pedidos.map((p) => [p.resumen, p.estado]),
    [
      ["a", "pendiente"],
      ["b", "enviado"],
      ["c", "cancelado"],
    ]
  );
});

test("el total se formatea con la moneda y el locale del negocio", () => {
  const mx = buildCustomerCommerceState(
    rows({ orders: [order({ totalAmount: 1234.5, currency: "MXN" })] }),
    ACTUAL,
    { currency: "MXN", locale: "es-MX" }
  );
  assert.equal(mx.pedidos[0].total, "$1,234.50");
});

test("la venta en curso de esta conversacion gana sobre la de otra", () => {
  const state = buildCustomerCommerceState(
    rows({
      conversations: [
        {
          id: OTRA,
          lastPresentedProductIds: [],
          pendingConfirmationAskedAt: null,
          saleState: { items: [{ productName: "vieja", quantity: 1 }] },
        },
        {
          id: ACTUAL,
          lastPresentedProductIds: [],
          pendingConfirmationAskedAt: null,
          saleState: { items: [{ productName: "AIRPODS SERIE 4", variantLabel: "Blanco", quantity: 2 }] },
        },
      ],
    }),
    ACTUAL,
    OPTS
  );

  assert.equal(state.ventaEnCurso?.enEstaConversacion, true);
  assert.deepEqual(state.ventaEnCurso?.items, [{ producto: "AIRPODS SERIE 4", variante: "Blanco", cantidad: 2 }]);
  assert.equal(state.ventaEnCurso?.esperandoConfirmacionDePago, false);
});

test("una venta esperando que el dueno confirme el pago cuenta como venta en curso aunque no tenga items", () => {
  const state = buildCustomerCommerceState(
    rows({
      conversations: [
        { id: OTRA, lastPresentedProductIds: [], pendingConfirmationAskedAt: new Date(), saleState: null },
      ],
    }),
    ACTUAL,
    OPTS
  );
  assert.equal(state.ventaEnCurso?.conversationId, OTRA);
  assert.equal(state.ventaEnCurso?.esperandoConfirmacionDePago, true);
  assert.equal(state.ventaEnCurso?.enEstaConversacion, false);
});

test("la ultima lista presentada sale de otra conversacion solo si esta no tiene ninguna", () => {
  const otraConLista = { id: OTRA, lastPresentedProductIds: ["p1", "p2"], pendingConfirmationAskedAt: null, saleState: null };
  const actualSinLista = { id: ACTUAL, lastPresentedProductIds: [], pendingConfirmationAskedAt: null, saleState: null };
  const actualConLista = { id: ACTUAL, lastPresentedProductIds: ["p9"], pendingConfirmationAskedAt: null, saleState: null };

  const sinLocal = buildCustomerCommerceState(rows({ conversations: [otraConLista, actualSinLista] }), ACTUAL, OPTS);
  assert.deepEqual(sinLocal.ultimaListaPresentada, { conversationId: OTRA, enEstaConversacion: false, productIds: ["p1", "p2"] });

  const conLocal = buildCustomerCommerceState(rows({ conversations: [otraConLista, actualConLista] }), ACTUAL, OPTS);
  assert.deepEqual(conLocal.ultimaListaPresentada, { conversationId: ACTUAL, enEstaConversacion: true, productIds: ["p9"] });
});

test("items de SaleState con forma invalida no rompen el estado", () => {
  const state = buildCustomerCommerceState(
    rows({
      conversations: [
        { id: ACTUAL, lastPresentedProductIds: [], pendingConfirmationAskedAt: null, saleState: { items: "basura" } },
      ],
    }),
    ACTUAL,
    OPTS
  );
  assert.equal(state.ventaEnCurso, null);
});
