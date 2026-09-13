import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  listCustomersForBusiness,
  getCustomerProfile,
  updateCustomerProfile,
  addCustomerNote,
  deleteCustomerNote,
  createCustomerTag,
  listCustomerTags,
  getCustomerTimeline,
  touchCustomerLastContact,
} from "./customers";

// Cubre la capa CRM de clientes (Fase 2). Sin IA: todo es Postgres real contra la DB de desarrollo,
// asi que vive como *.test.ts y corre en `npm test` sin costo.

const createdBusinessIds: string[] = [];

async function seedBusiness() {
  const business = await prisma.business.create({
    data: { name: `CRM Test ${randomUUID()}`, email: `crm-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  createdBusinessIds.push(business.id);
  return business;
}

after(async () => {
  // Conversation.customer no tiene onDelete: Cascade (relacion existente, no se toca), asi que el
  // borrado va en orden de dependencia igual que DELETE /api/reset-test-data.
  const where = { businessId: { in: createdBusinessIds } };
  await prisma.message.deleteMany({ where: { conversation: { customer: where } } });
  await prisma.order.deleteMany({ where });
  await prisma.conversation.deleteMany({ where: { customer: where } });
  await prisma.customer.deleteMany({ where });
  await prisma.business.deleteMany({ where: { id: { in: createdBusinessIds } } });
});

test("la lista ordena por lastContactAt descendente y pagina por cursor sin repetir filas", async () => {
  const business = await seedBusiness();
  const base = Date.now();
  for (let i = 0; i < 5; i++) {
    await prisma.customer.create({
      data: {
        businessId: business.id,
        phoneNumber: `5730010000${i}`,
        name: `Cliente ${i}`,
        lastContactAt: new Date(base - i * 60_000),
      },
    });
  }

  const first = await listCustomersForBusiness(business.id, { limit: 2 });
  assert.equal(first.customers.length, 2);
  assert.equal(first.customers[0].name, "Cliente 0");
  assert.equal(first.customers[1].name, "Cliente 1");
  assert.ok(first.nextCursor);

  const second = await listCustomersForBusiness(business.id, { limit: 2, cursor: first.nextCursor! });
  assert.equal(second.customers.length, 2);
  assert.equal(second.customers[0].name, "Cliente 2");

  const seen = new Set([...first.customers, ...second.customers].map((c) => c.id));
  assert.equal(seen.size, 4, "ninguna fila se repite entre paginas");

  const last = await listCustomersForBusiness(business.id, { limit: 2, cursor: second.nextCursor! });
  assert.equal(last.customers.length, 1);
  assert.equal(last.nextCursor, null, "la ultima pagina no ofrece cursor");
});

test("la busqueda encuentra por nombre y por telefono aunque el input traiga espacios", async () => {
  const business = await seedBusiness();
  await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573001234567", name: "Ludy Numpaque", lastContactAt: new Date() },
  });
  await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573009999999", name: "Otro Cliente", lastContactAt: new Date() },
  });

  const byName = await listCustomersForBusiness(business.id, { q: "ludy" });
  assert.equal(byName.customers.length, 1);
  assert.equal(byName.customers[0].name, "Ludy Numpaque");

  const byPhone = await listCustomersForBusiness(business.id, { q: "300 123 45" });
  assert.equal(byPhone.customers.length, 1);
  assert.equal(byPhone.customers[0].phoneNumber, "573001234567");
});

test("el filtro por etapa y por etiqueta acota la lista", async () => {
  const business = await seedBusiness();
  await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573001111111", stage: "RECURRENTE", tags: ["mayorista"], lastContactAt: new Date() },
  });
  await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573002222222", stage: "NUEVO", tags: [], lastContactAt: new Date() },
  });

  const byStage = await listCustomersForBusiness(business.id, { stage: "RECURRENTE" });
  assert.equal(byStage.customers.length, 1);
  assert.equal(byStage.customers[0].phoneNumber, "573001111111");

  const byTag = await listCustomersForBusiness(business.id, { tag: "mayorista" });
  assert.equal(byTag.customers.length, 1);

  const bogus = await listCustomersForBusiness(business.id, { stage: "NO_EXISTE" });
  assert.equal(bogus.customers.length, 2, "una etapa invalida se ignora en vez de vaciar la lista");
});

test("la ficha calcula total gastado, ticket promedio y numero de pedidos, ignorando los cancelados", async () => {
  const business = await seedBusiness();
  const customer = await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573003333333", name: "Compradora" },
  });
  for (const [amount, status] of [
    [100000, "SHIPPED"],
    [50000, "PENDING"],
    [999999, "CANCELED"],
  ] as const) {
    const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
    await prisma.order.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        conversationId: conversation.id,
        summary: `Pedido ${amount}`,
        totalAmount: amount,
        currency: "COP",
        fulfillmentStatus: status,
      },
    });
  }

  const profile = await getCustomerProfile(business.id, customer.id);
  assert.ok(profile);
  assert.equal(profile!.metrics.orderCount, 2, "el pedido cancelado no cuenta");
  assert.equal(profile!.metrics.totalSpent, 150000);
  assert.equal(profile!.metrics.avgTicket, 75000);
  assert.equal(profile!.orders.length, 3, "la lista si muestra el cancelado, solo no suma");
});

test("la ficha de otro negocio no se puede leer ni editar", async () => {
  const mine = await seedBusiness();
  const theirs = await seedBusiness();
  const customer = await prisma.customer.create({
    data: { businessId: theirs.id, phoneNumber: "573004444444", name: "Ajeno" },
  });

  assert.equal(await getCustomerProfile(mine.id, customer.id), null);
  assert.equal(await updateCustomerProfile(mine.id, customer.id, { name: "Hackeado" }), null);
  assert.equal(await getCustomerTimeline(mine.id, customer.id), null);

  const untouched = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(untouched?.name, "Ajeno");
});

test("actualizar la ficha solo escribe los campos enviados", async () => {
  const business = await seedBusiness();
  const customer = await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573005555555", name: "Original", email: "orig@example.com" },
  });

  await updateCustomerProfile(business.id, customer.id, { stage: "ACTIVO" });
  const after = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(after?.stage, "ACTIVO");
  assert.equal(after?.name, "Original", "el nombre no se toca si no viene en el payload");
  assert.equal(after?.email, "orig@example.com", "el email no se toca si no viene en el payload");
});

test("las notas se crean, se listan en la ficha y se borran", async () => {
  const business = await seedBusiness();
  const customer = await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573006666666" },
  });

  const note = await addCustomerNote(business.id, customer.id, "Pidio factura a nombre de la empresa", "Dueño");
  assert.ok(note);

  const profile = await getCustomerProfile(business.id, customer.id);
  assert.equal(profile!.notes.length, 1);
  assert.equal(profile!.notes[0].authorName, "Dueño");

  assert.equal(await deleteCustomerNote(business.id, note!.id), true);
  assert.equal(await deleteCustomerNote(business.id, note!.id), false, "borrar dos veces no explota");
});

test("crear una etiqueta que ya existe actualiza el color en vez de fallar por el unique", async () => {
  const business = await seedBusiness();
  await createCustomerTag(business.id, "mayorista", "#111111");
  await createCustomerTag(business.id, "mayorista", "#222222");

  const tags = await listCustomerTags(business.id);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].color, "#222222");
});

test("la linea de tiempo mezcla mensajes, pedidos y notas en orden cronologico inverso", async () => {
  const business = await seedBusiness();
  const customer = await prisma.customer.create({ data: { businessId: business.id, phoneNumber: "573007777777" } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });

  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Hola" } });
  await prisma.order.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      conversationId: conversation.id,
      summary: "1x Diadema",
      totalAmount: 30000,
      currency: "COP",
    },
  });
  await addCustomerNote(business.id, customer.id, "Cliente frecuente", "Dueño");

  const timeline = await getCustomerTimeline(business.id, customer.id);
  assert.ok(timeline);
  assert.equal(timeline!.length, 3);
  assert.deepEqual(new Set(timeline!.map((e) => e.kind)), new Set(["MESSAGE", "ORDER", "NOTE"]));
  for (let i = 1; i < timeline!.length; i++) {
    assert.ok(
      timeline![i - 1].createdAt.getTime() >= timeline![i].createdAt.getTime(),
      "los eventos vienen del mas nuevo al mas viejo"
    );
  }
});

test("touchCustomerLastContact mueve al cliente al tope de la lista", async () => {
  const business = await seedBusiness();
  const old = await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573008888888", name: "Viejo", lastContactAt: new Date(Date.now() - 86_400_000) },
  });
  await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: "573009999998", name: "Reciente", lastContactAt: new Date() },
  });

  const before = await listCustomersForBusiness(business.id);
  assert.equal(before.customers[0].name, "Reciente");

  await touchCustomerLastContact(old.id, new Date(Date.now() + 1000));

  const afterTouch = await listCustomersForBusiness(business.id);
  assert.equal(afterTouch.customers[0].name, "Viejo");
});
