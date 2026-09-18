import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "./client";

// E30 (2026-09-18). Un secreto corrupto no tumba la plataforma.
//
// whatsappAccessToken se guarda cifrado y la extension de lectura de src/db/client.ts lo descifra en
// CADA lectura. decryptSecret llama a decipher.final(), que tira cuando el tag de autenticacion no
// cierra: token escrito con otra TOKEN_ENCRYPTION_KEY, fila truncada, base copiada entre entornos.
// Sin try/catch ese throw sale por el findMany y se lleva puesta la consulta ENTERA - o sea, todos los
// inquilinos quedan sin servicio por una sola fila mala.

const creados: string[] = [];

after(async () => {
  await prisma.business.deleteMany({ where: { id: { in: creados } } });
});

async function crearNegocio(): Promise<string> {
  const b = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappPhoneNumberId: `phone-${randomUUID()}`,
      whatsappAccessToken: "token-de-verdad",
    },
  });
  creados.push(b.id);
  return b.id;
}

test("E30: una fila con el secreto corrupto no impide listar los demas negocios", async () => {
  const roto = await crearNegocio();
  const sano = await crearNegocio();

  // Se corrompe el texto cifrado por SQL directo, saltando la extension (que volveria a cifrarlo bien).
  // El formato es el real - v1.iv.tag.cipher, con el punto que usa secretBox - para que isEncrypted lo
  // acepte y el fallo ocurra donde tiene que ocurrir: en decipher.final() al no cerrar el tag, no en el
  // parseo. Con un formato que isEncrypted rechaza, decryptSecret devuelve el texto tal cual y esta
  // prueba no probaria nada.
  const corrupto = ["v1", Buffer.alloc(12).toString("base64"), Buffer.alloc(16).toString("base64"), Buffer.from("basura").toString("base64")].join(".");
  await prisma.$executeRaw`UPDATE "Business" SET "whatsappAccessToken" = ${corrupto} WHERE "id" = ${roto}`;

  // Esto es lo que se caia entero antes del arreglo.
  const listados = await prisma.business.findMany({ where: { id: { in: [roto, sano] } } });
  assert.equal(listados.length, 2, "listar negocios no puede fallar por una fila corrupta");

  const filaRota = listados.find((b) => b.id === roto)!;
  const filaSana = listados.find((b) => b.id === sano)!;
  assert.equal(filaRota.whatsappAccessToken, null, "el token ilegible queda en null, no a medias");
  assert.equal(filaSana.whatsappAccessToken, "token-de-verdad", "el negocio sano se lee normal");

  // Y queda marcado, para que "roto" no se confunda con "nunca conecto WhatsApp". La marca se escribe
  // sin await desde la extension, asi que se le da una vuelta al bucle de eventos.
  await new Promise((r) => setTimeout(r, 120));
  const despues = await prisma.business.findUniqueOrThrow({ where: { id: roto } });
  assert.equal(despues.secretsBroken, true, "la fila rota tiene que quedar marcada");
  const sanoDespues = await prisma.business.findUniqueOrThrow({ where: { id: sano } });
  assert.equal(sanoDespues.secretsBroken, false, "y la sana no");
});
