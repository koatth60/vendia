import { test } from "node:test";
import assert from "node:assert/strict";
import { combineBurstItems, type ReplyBurstItem } from "./whatsapp";

// Prueba de la combinacion pura que usa runGenerateAndSend (Fase 10, eje 19) - separada de
// runGenerateAndSend en si porque esa si hace I/O real (DB, generateReply, WhatsApp). Solo le
// interesan los tres campos que combineBurstItems lee; el resto se castea porque no importa para
// esta prueba.
function fakeItem(rawText: string, customerSentAt: number, overrides: Partial<ReplyBurstItem> = {}): ReplyBurstItem {
  return {
    rawText,
    customerSentAt,
    business: { id: "biz-1" } as ReplyBurstItem["business"],
    customer: { id: "cust-1" } as ReplyBurstItem["customer"],
    credentials: { phoneNumberId: "p", accessToken: "t" },
    from: "573000000000",
    ...overrides,
  };
}

test("combineBurstItems concatena el texto de los items en orden", () => {
  const items = [fakeItem("Hola", 1000), fakeItem("como va el pedido", 1500), fakeItem("sigo aca", 2000)];
  const { combinedRawText } = combineBurstItems(items);
  assert.equal(combinedRawText, "Hola\ncomo va el pedido\nsigo aca");
});

test("combineBurstItems usa la hora del PRIMER mensaje como referencia de espera", () => {
  const items = [fakeItem("uno", 1000), fakeItem("dos", 1800), fakeItem("tres", 2900)];
  const { customerSentAt } = combineBurstItems(items);
  assert.equal(customerSentAt, 1000);
});

test("combineBurstItems usa el negocio/cliente/credenciales del ULTIMO mensaje de la rafaga", () => {
  const items = [
    fakeItem("uno", 1000, { from: "573000000001" }),
    fakeItem("dos", 1500, { from: "573000000002" }),
  ];
  const { last } = combineBurstItems(items);
  assert.equal(last.from, "573000000002");
});

test("combineBurstItems con un solo item se comporta igual que el flujo de antes de la Fase 10", () => {
  const items = [fakeItem("mensaje suelto", 5000)];
  const { combinedRawText, customerSentAt, last } = combineBurstItems(items);
  assert.equal(combinedRawText, "mensaje suelto");
  assert.equal(customerSentAt, 5000);
  assert.equal(last, items[0]);
});
