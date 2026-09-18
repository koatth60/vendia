import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runCatalogTool, type ToolContext } from "./tools";
import { isExactConfiguredPaymentMethod } from "../catalog/paymentMethods";

// UNA FORMA DE PAGO NO ES UN NOMBRE (2026-09-17).
//
// Defecto real de produccion: una clienta quedo guardada como "Contraentrega" en la ficha del CRM y en
// la lista de pedidos. Archivo propio y no un caso dentro de tools.test.ts porque ese archivo depende
// del orden de sus tests (uno de ellos necesita un negocio SIN ninguna forma de pago cargada), y este
// necesita exactamente lo contrario.

let businessId: string;
let customerId: string;
let conversationId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  businessId = business.id;

  await prisma.paymentMethod.createMany({
    data: [
      { businessId, type: "EFECTIVO", label: "Contraentrega", details: "Pagas al recibir", settlement: "ON_DELIVERY" },
      { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "3200000000" },
    ],
  });

  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `573000${Date.now()}` },
  });
  customerId = customer.id;

  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function context(): ToolContext {
  return {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573000000000",
  };
}

test("save_customer_name no guarda una forma de pago del negocio como nombre", async () => {
  const result = (await runCatalogTool(context(), "save_customer_name", { name: "Contraentrega" })) as {
    saved: boolean;
    note?: string;
  };

  assert.equal(result.saved, false);
  assert.match(result.note ?? "", /forma de pago/i);

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(customer.name, null, "la ficha del cliente no puede quedar con el nombre de un metodo de pago");
});

test("el rechazo no depende de mayusculas ni de como se escriba", async () => {
  for (const escrito of ["contraentrega", "CONTRA ENTREGA", "  Nequi  "]) {
    const result = (await runCatalogTool(context(), "save_customer_name", { name: escrito })) as { saved: boolean };
    assert.equal(result.saved, false, `deberia rechazar ${JSON.stringify(escrito)}`);
  }

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(customer.name, null);
});

test("un nombre de persona se sigue guardando igual que siempre", async () => {
  // Lo dice el cliente, que es la unica forma en que un nombre llega a guardarse.
  await prisma.message.create({ data: { conversationId, role: "CUSTOMER", content: "me llamo Katiuska Peña" } });
  const result = (await runCatalogTool(context(), "save_customer_name", { name: "Katiuska Peña" })) as {
    saved: boolean;
    name?: string;
  };

  assert.equal(result.saved, true);
  assert.equal(result.name, "Katiuska Peña");

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(customer.name, "Katiuska Peña");
});

test("isExactConfiguredPaymentMethod exige igualdad, no que una contenga a la otra", () => {
  const metodos = [{ label: "Bancolombia" }, { label: "Contraentrega" }];

  assert.equal(isExactConfiguredPaymentMethod("Contraentrega", metodos), true);
  assert.equal(isExactConfiguredPaymentMethod("contra entrega", metodos), true, "mismo texto, otra separacion");
  // El apellido Colombia existe y esta contenido en "Bancolombia": con la regla de contencion de
  // resolveConfiguredPaymentMethod, este cliente no podria guardar su nombre nunca.
  assert.equal(isExactConfiguredPaymentMethod("Colombia", metodos), false);
  assert.equal(isExactConfiguredPaymentMethod("Katiuska Peña", metodos), false);
  assert.equal(isExactConfiguredPaymentMethod("", metodos), false);
});
