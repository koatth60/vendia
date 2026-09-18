import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { montoACobrarAlEntregar, resolverModalidadDelPedido, filtrarMetodosPorZona } from "./paymentTiming";
import { recordShippingCity } from "./saleState";

// Fase 3 (2026-09-17). El pedido guardaba el total y con que metodo, pero no CUANDO se cobra, asi que
// "¿cuanto le cobro al mensajero?" solo se respondia releyendo el chat.

test("el monto a cobrar sale de la modalidad, y sin modalidad no se inventa un cero", () => {
  const montos = { itemsTotal: 145000, shippingCost: 9000 };
  assert.equal(montoACobrarAlEntregar("PREPAID_ALL", montos), 0);
  assert.equal(montoACobrarAlEntregar("PREPAID_PRODUCT_COD_SHIPPING", montos), 9000);
  assert.equal(montoACobrarAlEntregar("COD_ALL", montos), 154000);
  // null no es cero: un cero le dice al mensajero "no le cobres nada".
  assert.equal(montoACobrarAlEntregar(null, montos), null);
});

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      shippingPaymentModalities: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING"],
    },
  });
  businessId = business.id;
  await prisma.shippingRate.create({
    data: { businessId, label: "Bogotá", cost: 9000, paymentModalities: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"] },
  });
  await prisma.shippingCityRule.create({ data: { businessId, city: "Bogotá", normalizedCity: "bogota", label: "Bogotá" } });
});

after(async () => {
  await prisma.shippingCityRule.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("la modalidad declarada se acepta si aplica en la zona del cliente", async () => {
  const m = await resolverModalidadDelPedido(businessId, { declarada: "COD_ALL", cobraAlRecibir: true, city: "Bogotá" });
  assert.equal(m, "COD_ALL");
});

test("una modalidad que el negocio no ofrece en esa zona se descarta", async () => {
  // Es el mismo criterio con el que el bot se la ofrecio: fuera de Bogota no hay contraentrega total.
  const m = await resolverModalidadDelPedido(businessId, { declarada: "COD_ALL", cobraAlRecibir: false, city: "Cali" });
  assert.notEqual(m, "COD_ALL");
});

test("un metodo que cobra al recibir resuelve contraentrega total sin que nadie lo declare", async () => {
  // El dato es PaymentMethod.settlement, no una deduccion sobre la prosa.
  const m = await resolverModalidadDelPedido(businessId, { cobraAlRecibir: true, city: "Bogotá" });
  assert.equal(m, "COD_ALL");
});

test("con una sola modalidad posible no hubo nada que elegir", async () => {
  const solo = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      shippingPaymentModalities: ["PREPAID_ALL"],
    },
  });
  try {
    const m = await resolverModalidadDelPedido(solo.id, { cobraAlRecibir: false });
    assert.equal(m, "PREPAID_ALL");
  } finally {
    await prisma.business.deleteMany({ where: { id: solo.id } });
  }
});

test("sin nada con que resolver queda null, no una suposicion", async () => {
  const m = await resolverModalidadDelPedido(businessId, { cobraAlRecibir: false });
  assert.equal(m, null);
});

test("un metodo que cobra al recibir no se ofrece en una zona que no lo admite", async () => {
  // Sin esto, "Contraentrega" es un metodo del negocio entero y se le ofrecia a cualquiera. MAG.IMP lo
  // hace en Bogotá y Soacha y no fuera: a una clienta de Cali el bot le prometia algo que el negocio no
  // iba a cumplir.
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `5732${Date.now()}` } });
  const conv = await prisma.conversation.create({ data: { customerId: customer.id } });
  const metodos = [
    { label: "Nequi", settlement: "PREPAID" as const },
    { label: "Contraentrega", settlement: "ON_DELIVERY" as const },
  ];
  try {
    // Sin ciudad resuelta todavia no se esconde nada: no sabemos a donde va el pedido.
    assert.equal((await filtrarMetodosPorZona(businessId, metodos, conv.id)).length, 2);

    await recordShippingCity(conv.id, "Cali");
    const enCali = await filtrarMetodosPorZona(businessId, metodos, conv.id);
    assert.deepEqual(enCali.map((m) => m.label), ["Nequi"], "en Cali no se paga todo al recibir");

    await recordShippingCity(conv.id, "Bogotá");
    const enBogota = await filtrarMetodosPorZona(businessId, metodos, conv.id);
    assert.equal(enBogota.length, 2, "en Bogotá sí, y el metodo vuelve a estar disponible");
  } finally {
    await prisma.saleState.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// PAGAR TODO AL RECIBIR EXIGE UNA ZONA QUE LO DIGA (2026-09-18).
//
// El negocio de arriba NO tiene COD_ALL en su lista general, y por eso sus pruebas pasaban. Produccion
// si lo tiene: MAGByLizN acepta contraentrega total solo en Bogota y Soacha (asi estan sus tarifas) pero
// su lista de negocio incluia COD_ALL, y esa lista es el respaldo cuando la ciudad no cae en ninguna
// zona cargada. 9 de sus ultimos 25 pedidos fueron a ciudades sin regla - Ocaña, Santa Rosa de Cabal,
// El Zulia - y en todas ellas el bot podia ofrecer y cerrar contraentrega total. El negocio despacharia
// la mercancia sin haber cobrado el producto.

let conCodGeneral: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      // La forma exacta de produccion.
      shippingPaymentModalities: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"],
    },
  });
  conCodGeneral = business.id;
  await prisma.shippingRate.create({
    data: { businessId: conCodGeneral, label: "Bogotá", cost: 9000, paymentModalities: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"] },
  });
  await prisma.shippingRate.create({
    data: { businessId: conCodGeneral, label: "Nacional", cost: 18500, paymentModalities: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING"] },
  });
  await prisma.shippingCityRule.create({ data: { businessId: conCodGeneral, city: "Bogotá", normalizedCity: "bogota", label: "Bogotá" } });
  await prisma.shippingCityRule.create({ data: { businessId: conCodGeneral, city: "Tunja", normalizedCity: "tunja", label: "Nacional" } });
});

after(async () => {
  await prisma.shippingCityRule.deleteMany({ where: { businessId: conCodGeneral } });
  await prisma.shippingRate.deleteMany({ where: { businessId: conCodGeneral } });
  await prisma.business.deleteMany({ where: { id: conCodGeneral } });
});

test("una ciudad SIN regla cargada no puede cerrar contraentrega total, aunque el negocio la ofrezca en general", async () => {
  // Ocaña no es ninguna de las zonas del negocio. Antes heredaba COD_ALL de la lista general y el pedido
  // quedaba escrito como "el mensajero cobra $154.000" en una ciudad donde el negocio nunca dijo que
  // llega a cobrar.
  assert.equal(await resolverModalidadDelPedido(conCodGeneral, { cobraAlRecibir: true, city: "Ocaña" }), null);
  assert.equal(await resolverModalidadDelPedido(conCodGeneral, { declarada: "COD_ALL", cobraAlRecibir: true, city: "Ocaña" }), null);
});

test("en Bogotá, donde la tarifa SI lo dice, nada cambia", async () => {
  assert.equal(await resolverModalidadDelPedido(conCodGeneral, { cobraAlRecibir: true, city: "Bogotá" }), "COD_ALL");
  assert.equal(await resolverModalidadDelPedido(conCodGeneral, { declarada: "COD_ALL", cobraAlRecibir: true, city: "Bogotá" }), "COD_ALL");
});

test("en una zona cargada que no admite pagar todo al recibir tampoco se cierra", async () => {
  assert.equal(await resolverModalidadDelPedido(conCodGeneral, { cobraAlRecibir: true, city: "Tunja" }), null);
  // Y la modalidad que SI aplica ahi se sigue aceptando igual que antes.
  assert.equal(
    await resolverModalidadDelPedido(conCodGeneral, { declarada: "PREPAID_PRODUCT_COD_SHIPPING", cobraAlRecibir: false, city: "Tunja" }),
    "PREPAID_PRODUCT_COD_SHIPPING"
  );
});

test("a una ciudad sin regla tampoco se le OFRECE el metodo que cobra al recibir", async () => {
  const customer = await prisma.customer.create({ data: { businessId: conCodGeneral, phoneNumber: `5733${Date.now()}` } });
  const conv = await prisma.conversation.create({ data: { customerId: customer.id } });
  const metodos = [
    { label: "Nequi", settlement: "PREPAID" as const },
    { label: "Contraentrega", settlement: "ON_DELIVERY" as const },
  ];
  try {
    await recordShippingCity(conv.id, "Ocaña");
    const enOcana = await filtrarMetodosPorZona(conCodGeneral, metodos, conv.id);
    assert.deepEqual(enOcana.map((m) => m.label), ["Nequi"], "sin zona cargada no se ofrece pagar todo al recibir");

    await recordShippingCity(conv.id, "Bogotá");
    const enBogota = await filtrarMetodosPorZona(conCodGeneral, metodos, conv.id);
    assert.equal(enBogota.length, 2, "en Bogotá sigue disponible");
  } finally {
    await prisma.saleState.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});
