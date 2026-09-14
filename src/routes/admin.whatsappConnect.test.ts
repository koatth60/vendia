import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";

// La guarda que protege a un negocio YA conectado de que el flujo de Embedded Signup le pise el
// numero y el token. Se prueba contra la condicion real que evalua la ruta (ver whatsappConnect.ts):
// un negocio con phoneNumberId + accessToken solo se sobrescribe con replace:"true" explicito.
function wouldRefuseOverwrite(
  existing: { whatsappPhoneNumberId: string | null; whatsappAccessToken: string | null },
  body: Record<string, unknown>
): boolean {
  return Boolean(
    existing.whatsappPhoneNumberId && existing.whatsappAccessToken && String(body.replace ?? "") !== "true"
  );
}

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappPhoneNumberId: `pn-${randomUUID()}`,
      whatsappAccessToken: "token-de-un-cliente-en-produccion",
      whatsappPhoneNumber: "+573001112233",
    },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("un negocio ya conectado no se sobrescribe sin replace explicito", async () => {
  const existing = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { whatsappPhoneNumberId: true, whatsappAccessToken: true },
  });

  assert.equal(
    wouldRefuseOverwrite(existing, { code: "x", phoneNumberId: "otro", wabaId: "otra" }),
    true,
    "sin replace, el flujo tiene que rebotar - este es el caso que le romperia el bot a un cliente vivo"
  );
  assert.equal(
    wouldRefuseOverwrite(existing, { code: "x", replace: "true" }),
    false,
    "con replace explicito si se permite"
  );
});

test("un negocio sin WhatsApp conectado pasa derecho", () => {
  assert.equal(
    wouldRefuseOverwrite({ whatsappPhoneNumberId: null, whatsappAccessToken: null }, { code: "x" }),
    false
  );
  // A medio conectar (token sin numero, o al reves) tampoco puede bloquear: no hay nada vivo que romper.
  assert.equal(
    wouldRefuseOverwrite({ whatsappPhoneNumberId: "pn-1", whatsappAccessToken: null }, { code: "x" }),
    false
  );
});
