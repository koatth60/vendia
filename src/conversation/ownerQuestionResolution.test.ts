import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  createPendingOwnerQuestion,
  findOpenPendingOwnerQuestionsForConversation,
  findOpenPendingOwnerQuestionsForBusiness,
  findPendingOwnerQuestionsDueForReminder,
  findPendingOwnerQuestionsPastTimeout,
  findConversationByPendingOwnerQuestion,
  markPendingOwnerQuestionResolved,
  markConversationOwnerQuestionsResolved,
  resolvePendingOwnerQuestion,
  recordMessage,
} from "./service";
import { verifyRequiredEffects } from "../ai/requiredEffects";

// E56: "Lo que el dueño contesta a mano deja de tirarse".
//
// Resolver una pregunta al dueño era BORRAR la fila, y eso costaba dos cosas a la vez:
//  1. el par pregunta-del-cliente / respuesta-del-dueño, que es la materia prima del ciclo de
//     aprendizaje de la FAQ, se perdia entero cuando la dueña contestaba desde el panel;
//  2. `ownerWasNotifiedSince` prueba que una imagen quedo atendida contando filas POSTERIORES a ella,
//     asi que al borrarlas la imagen quedaba "sin atender" para siempre y cada turno volvia a exigir
//     el efecto, a forzar ask_owner_about_photo y a reenviarle al cliente la misma respuesta.
//
// Estas pruebas cubren las dos, mas la parte aburrida y peligrosa del cambio: que "abierta" siga
// significando abierta en TODAS las consultas ahora que las filas no desaparecen.

let businessId: string;
let customerId: string;
let conversationId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `E56 ${randomUUID()}`, email: `e56-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573009${Date.now()}` } });
  customerId = customer.id;
});

beforeEach(async () => {
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customerId } } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.learnedFaqCandidate.deleteMany({ where: { businessId } });
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
});

after(async () => {
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customerId } } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.learnedFaqCandidate.deleteMany({ where: { businessId } });
  await prisma.faqEntry.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
});

async function preguntaAbierta(texto = "¿Tienen envio a Leticia?"): Promise<string> {
  const wamid = `wamid-${randomUUID()}`;
  await createPendingOwnerQuestion(conversationId, wamid, texto);
  const fila = await prisma.pendingOwnerQuestion.findUnique({ where: { wamid }, select: { id: true } });
  return fila!.id;
}

test("resolver deja la fila en la base, no la borra", async () => {
  const id = await preguntaAbierta();
  await markPendingOwnerQuestionResolved(id);

  const fila = await prisma.pendingOwnerQuestion.findUnique({ where: { id } });
  assert.ok(fila, "la fila se borro: se perdio la evidencia que esta etapa existe para conservar");
  assert.ok(fila.resolvedAt, "la fila quedo sin marcar como resuelta");
});

test("una pregunta resuelta deja de estar abierta en todas las consultas", async () => {
  const id = await preguntaAbierta();
  const antiguedad = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await prisma.pendingOwnerQuestion.update({ where: { id }, data: { createdAt: antiguedad } });
  const wamid = (await prisma.pendingOwnerQuestion.findUnique({ where: { id }, select: { wamid: true } }))!.wamid;

  assert.equal((await findOpenPendingOwnerQuestionsForConversation(conversationId)).length, 1);
  assert.equal((await findOpenPendingOwnerQuestionsForBusiness(businessId)).length, 1);
  assert.equal((await findPendingOwnerQuestionsDueForReminder(businessId, new Date())).length, 1);
  assert.equal((await findPendingOwnerQuestionsPastTimeout(businessId, new Date())).length, 1);
  assert.ok(await findConversationByPendingOwnerQuestion(wamid));

  await markPendingOwnerQuestionResolved(id);

  // Si alguna de estas siguiera viendola, el bot se creeria bloqueado por una pregunta ya contestada:
  // no volveria a escalar nada, y el job de recordatorios le escribiria al dueño por algo resuelto.
  assert.equal((await findOpenPendingOwnerQuestionsForConversation(conversationId)).length, 0);
  assert.equal((await findOpenPendingOwnerQuestionsForBusiness(businessId)).length, 0);
  assert.equal((await findPendingOwnerQuestionsDueForReminder(businessId, new Date())).length, 0);
  assert.equal((await findPendingOwnerQuestionsPastTimeout(businessId, new Date())).length, 0);
  // Y si el dueño vuelve a citar ese mismo aviso viejo, no se reabre nada.
  assert.equal(await findConversationByPendingOwnerQuestion(wamid), null);
});

test("el panel resuelve marcando, y de paso aprende del par pregunta/respuesta", async () => {
  await preguntaAbierta("¿De que ciudad son ustedes?");
  // La pregunta REAL es la del cliente, no la que el bot le escribio al dueño: recordAskOwnerResolution
  // la busca en el historial. Sin este mensaje la sugerencia saldria con el texto del bot.
  await recordMessage(businessId, conversationId, "CUSTOMER", "¿De que ciudad son ustedes disculpe?");

  const resueltas = await markConversationOwnerQuestionsResolved(conversationId, {
    businessId,
    answer: "Somos una tienda virtual en Bogota y enviamos a todo el pais por Interrapidisimo.",
  });
  assert.equal(resueltas, 1);

  const candidatos = await prisma.learnedFaqCandidate.findMany({ where: { businessId } });
  // Este es el agujero que cerraba la ficha: contestar desde el panel tiraba el dato entero.
  assert.equal(candidatos.length, 1, "contestar desde el panel no dejo ningun candidato de FAQ");
  assert.match(candidatos[0].answer, /Bogota/);
});

test("una plantilla cierra la pregunta pero no se aprende de ella", async () => {
  await preguntaAbierta();
  await markConversationOwnerQuestionsResolved(conversationId);

  assert.equal((await findOpenPendingOwnerQuestionsForConversation(conversationId)).length, 0);
  assert.equal(await prisma.learnedFaqCandidate.count({ where: { businessId } }), 0);
});

test("contestada la pregunta, un turno posterior NO vuelve a exigir el aviso por la imagen", async () => {
  // La foto del cliente, y el aviso al dueño que la atendio.
  const laImagen = new Date(Date.now() - 60 * 60 * 1000);
  const id = await preguntaAbierta("¿Es ese el mismo reloj?");
  await prisma.pendingOwnerQuestion.update({
    where: { id },
    data: { kind: "PHOTO_PRODUCT", createdAt: new Date(laImagen.getTime() + 60 * 1000) },
  });

  const efecto = [
    {
      kind: "OWNER_NOTIFIED_ABOUT_IMAGE" as const,
      tool: "ask_owner_about_photo",
      reason: "el cliente mando una foto sin atender",
      since: laImagen,
    },
  ];
  assert.deepEqual(await verifyRequiredEffects(conversationId, efecto), [], "el aviso no se reconocio ni estando abierta");

  // La dueña contesta. Antes de E56 esto BORRABA la fila y, con ella, la prueba de que se aviso: el
  // turno siguiente volvia a exigir el efecto, a forzar ask_owner_about_photo y a mandarle al cliente
  // la misma identificacion de producto por segunda vez.
  await markPendingOwnerQuestionResolved(id);

  assert.deepEqual(
    await verifyRequiredEffects(conversationId, efecto),
    [],
    "contestar la pregunta borro la prueba del aviso: el bot volveria a reenviar la misma respuesta"
  );
});

test("resolver a mano desde Bot > Salud tambien marca en vez de borrar, y solo dentro del negocio", async () => {
  const id = await preguntaAbierta();

  const otroNegocio = await prisma.business.create({
    data: { name: `Ajeno ${randomUUID()}`, email: `ajeno-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    assert.equal(await resolvePendingOwnerQuestion(otroNegocio.id, id), false, "un negocio ajeno pudo resolverla");
    assert.equal((await findOpenPendingOwnerQuestionsForConversation(conversationId)).length, 1);

    assert.equal(await resolvePendingOwnerQuestion(businessId, id), true);
    assert.ok((await prisma.pendingOwnerQuestion.findUnique({ where: { id } }))?.resolvedAt);
    // Resolverla dos veces no es un error, pero tampoco vuelve a pasar por resuelta.
    assert.equal(await resolvePendingOwnerQuestion(businessId, id), false);
  } finally {
    await prisma.business.delete({ where: { id: otroNegocio.id } });
  }
});
