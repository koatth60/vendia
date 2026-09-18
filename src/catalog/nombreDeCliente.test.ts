import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db/client";
import { porQueNoEsUnNombre } from "./nombreDeCliente";

// Las tres clases de "nombre" que no son un nombre, cada una con el caso real que la descubrio.
// Ver src/catalog/nombreDeCliente.ts para por que se comprueban propiedades y no una lista de palabras.

async function montar() {
  const business = await prisma.business.create({
    data: {
      name: `Nombres ${Math.random().toString(36).slice(2, 8)}`,
      email: `nombres-${Math.random().toString(36).slice(2, 8)}@test.local`,
      passwordHash: "x",
      whatsappPhoneNumberId: `pnid-${Math.random().toString(36).slice(2, 8)}`,
      whatsappAccessToken: "token",
      currency: "COP",
    },
  });
  await prisma.product.create({
    data: { businessId: business.id, name: "Smartwatch V20 Caballero", description: "reloj inteligente", price: 140000, currency: "COP", stock: 5, category: "smartwatches" },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, phoneNumber: `57300${Date.now() % 10000000}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  return { business, customer, conversation };
}

async function desmontar(businessId: string) {
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
}

test("un nombre que el cliente escribio se acepta", async () => {
  const { business, customer, conversation } = await montar();
  try {
    await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "hola, soy Carlos Perez" } });
    assert.equal(await porQueNoEsUnNombre({ businessId: business.id, customerId: customer.id, nombre: "Carlos Perez" }), null);
  } finally {
    await desmontar(business.id);
  }
});

test("el mensaje entero con cedula y celular adentro no es un nombre", async () => {
  const { business, customer, conversation } = await montar();
  try {
    const dicho = "Hernan Gil, cedula 1098765432, celular 3112223344, Calle 10 #5-20";
    await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: dicho } });
    const rechazo = await porQueNoEsUnNombre({ businessId: business.id, customerId: customer.id, nombre: dicho });
    assert.equal(rechazo?.motivo, "digitos");
  } finally {
    await desmontar(business.id);
  }
});

test("un producto del catalogo no es el nombre de quien lo compra", async () => {
  const { business, customer, conversation } = await montar();
  try {
    // El cliente SI escribio esas palabras -- por eso no alcanza con mirar lo que dijo.
    await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "quiero el Smartwatch V20 Caballero" } });
    const rechazo = await porQueNoEsUnNombre({ businessId: business.id, customerId: customer.id, nombre: "Smartwatch V20 Caballero" });
    assert.equal(rechazo?.motivo, "producto");
  } finally {
    await desmontar(business.id);
  }
});

test("lo que el bot dice cuando no hay nombre no se guarda como nombre", async () => {
  const { business, customer, conversation } = await montar();
  try {
    await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "hola, quiero comprar" } });
    await prisma.message.create({ data: { conversationId: conversation.id, role: "ASSISTANT", content: "Nombre: No especificado" } });
    for (const inventado of ["No proporcionado", "No especificado", "Sin nombre aun", "Pendiente", "Cliente"]) {
      const rechazo = await porQueNoEsUnNombre({ businessId: business.id, customerId: customer.id, nombre: inventado });
      assert.equal(rechazo?.motivo, "no-lo-dijo", `"${inventado}" tendria que rechazarse`);
    }
  } finally {
    await desmontar(business.id);
  }
});

test("el nombre se busca en los mensajes del cliente sin importar tildes ni mayusculas", async () => {
  const { business, customer, conversation } = await montar();
  try {
    await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "me llamo MARÍA JOSÉ" } });
    assert.equal(await porQueNoEsUnNombre({ businessId: business.id, customerId: customer.id, nombre: "Maria Jose" }), null);
  } finally {
    await desmontar(business.id);
  }
});
