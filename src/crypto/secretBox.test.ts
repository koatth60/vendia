import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encryptSecret, decryptSecret, isEncrypted, resetKeyCache } from "./secretBox";
import { prisma } from "../db/client";

// Fase 8, punto 2. Lo que importa no es solo que el ida y vuelta funcione, sino que lo que QUEDA
// GUARDADO en Postgres no contenga el token: ese es el riesgo real (una copia de seguridad, un volcado
// de la base). Por eso la ultima prueba lee la columna con SQL crudo, sin pasar por la extension.

const ORIGINAL_KEY = process.env.TOKEN_ENCRYPTION_KEY;

before(() => {
  process.env.TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY ?? "clave-de-prueba";
  resetKeyCache();
});

after(() => {
  process.env.TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY;
  resetKeyCache();
});

test("cifrar y descifrar devuelve el mismo token", () => {
  const token = "EAAG" + randomUUID();
  const stored = encryptSecret(token);
  assert.notEqual(stored, token);
  assert.equal(isEncrypted(stored), true);
  assert.equal(decryptSecret(stored), token);
});

test("el mismo token cifrado dos veces da dos ciphertexts distintos (IV aleatorio)", () => {
  const token = "EAAG-token-fijo";
  assert.notEqual(encryptSecret(token), encryptSecret(token));
});

test("un ciphertext alterado no descifra: GCM autentica, no devuelve basura", () => {
  const stored = encryptSecret("EAAG-token");
  const parts = stored.split(".");
  const tampered = Buffer.from(parts[3], "base64");
  tampered[0] = tampered[0] ^ 0xff;
  parts[3] = tampered.toString("base64");
  assert.throws(() => decryptSecret(parts.join(".")));
});

test("un valor en texto plano heredado se devuelve tal cual, no se intenta descifrar", () => {
  assert.equal(isEncrypted("EAAGtoken-viejo-en-texto-plano"), false);
  assert.equal(decryptSecret("EAAGtoken-viejo-en-texto-plano"), "EAAGtoken-viejo-en-texto-plano");
});

test("con otra clave el token no se puede leer", () => {
  const stored = encryptSecret("EAAG-token");
  process.env.TOKEN_ENCRYPTION_KEY = "otra-clave-distinta";
  resetKeyCache();
  assert.throws(() => decryptSecret(stored));
  process.env.TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY ?? "clave-de-prueba";
  resetKeyCache();
});

test("lo que queda escrito en Postgres no contiene el token, y Prisma lo devuelve descifrado", async () => {
  const token = "EAAG-token-de-un-cliente-" + randomUUID();
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappAccessToken: token,
    },
  });

  try {
    const stored = await prisma.$queryRaw<{ whatsappAccessToken: string | null }[]>`
      SELECT "whatsappAccessToken" FROM "Business" WHERE id = ${business.id}
    `;
    const atRest = stored[0].whatsappAccessToken!;
    assert.equal(atRest.includes(token), false, "el token no puede quedar legible en la base");
    assert.equal(isEncrypted(atRest), true);

    // El resto del codigo no sabe nada de esto: lee el token y le llega en claro.
    const read = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    assert.equal(read.whatsappAccessToken, token);
    const listed = await prisma.business.findMany({ where: { id: business.id } });
    assert.equal(listed[0].whatsappAccessToken, token);
  } finally {
    await prisma.business.deleteMany({ where: { id: business.id } });
  }
});
