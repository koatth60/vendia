import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runTokenExpiryJob } from "./tokenExpiry";

let originalFetch: typeof fetch;
let sentMessages: { to: string; body: string }[];

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentMessages = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text") sentMessages.push({ to, body: body.text?.body ?? "" });
    else if (body.type === "template") sentMessages.push({ to, body: body.template?.components?.[0]?.parameters?.[0]?.text ?? "" });
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const createdBusinessIds: string[] = [];
async function createBusiness(data: Partial<Parameters<typeof prisma.business.create>[0]["data"]>) {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: true,
      contactPhone: "573000000000",
      whatsappPhoneNumberId: `test-phone-${randomUUID()}`,
      whatsappAccessToken: "test-token",
      ...data,
    },
  });
  createdBusinessIds.push(business.id);
  return business;
}

after(async () => {
  await prisma.business.deleteMany({ where: { id: { in: createdBusinessIds } } });
});

test("runTokenExpiryJob warns the owner once when the token expires within 7 days, then never again", async () => {
  stubWhatsappFetch();
  try {
    const business = await createBusiness({ whatsappTokenExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });

    await runTokenExpiryJob();

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].body, /vence en 3/);

    const updated = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    assert.ok(updated.whatsappTokenExpiryNotifiedAt, "whatsappTokenExpiryNotifiedAt must be set so this expiry is never reminded again");

    sentMessages = [];
    await runTokenExpiryJob();
    assert.equal(sentMessages.length, 0, "must not send a second warning for the same expiry");
  } finally {
    restoreFetch();
  }
});

test("runTokenExpiryJob leaves a token that expires beyond the warning window alone", async () => {
  stubWhatsappFetch();
  try {
    await createBusiness({ whatsappTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });

    await runTokenExpiryJob();
    assert.equal(sentMessages.length, 0, "an expiry more than 7 days out must not warn yet");
  } finally {
    restoreFetch();
  }
});

test("runTokenExpiryJob does not warn a business without a stored expiry", async () => {
  stubWhatsappFetch();
  try {
    await createBusiness({ whatsappTokenExpiresAt: null });

    await runTokenExpiryJob();
    assert.equal(sentMessages.length, 0, "no expiry stored means nothing to warn about (manual token, never set)");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------------------------------
// E14 (2026-09-18). Un negocio que revienta no puede dejar sin atender a los que siguen.
//
// Estos cuatro jobs (este, escalationReminder, saleConfirmationChaser y conversationHealth) recorren
// negocios en un bucle. Sin try/catch por item, UN solo throw abortaba la pasada entera: los negocios
// que venian despues no recibian nada y nadie se enteraba, porque el job corre por temporizador y su
// excepcion no le llega a ningun usuario.
// ---------------------------------------------------------------------------------------------------

test("E14: un negocio que falla no impide que se procese el siguiente", async () => {
  stubWhatsappFetch();
  const enTresDias = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const rompe = await createBusiness({ whatsappTokenExpiresAt: enTresDias });
  const sano = await createBusiness({ whatsappTokenExpiresAt: enTresDias });

  // Se hace fallar la reserva de UNO de los dos. Mismo patron de monkeypatch que el resto del
  // repositorio usa para el cliente de DeepSeek: se pisa el metodo, se corre, se restaura.
  const originalUpdateMany = prisma.business.updateMany;
  prisma.business.updateMany = (async (args: Parameters<typeof originalUpdateMany>[0]) => {
    if ((args.where as { id?: string })?.id === rompe.id) {
      throw new Error("fallo simulado del negocio 1");
    }
    return (originalUpdateMany as (a: typeof args) => unknown)(args);
  }) as typeof prisma.business.updateMany;

  try {
    // Si el job no atrapa por item, esto TIRA y la prueba falla aca mismo.
    await runTokenExpiryJob();
  } finally {
    prisma.business.updateMany = originalUpdateMany;
    restoreFetch();
  }

  const despuesSano = await prisma.business.findUniqueOrThrow({ where: { id: sano.id } });
  assert.ok(
    despuesSano.whatsappTokenExpiryNotifiedAt,
    "el negocio sano tiene que quedar avisado aunque otro haya reventado"
  );

  const despuesRompe = await prisma.business.findUniqueOrThrow({ where: { id: rompe.id } });
  assert.equal(
    despuesRompe.whatsappTokenExpiryNotifiedAt,
    null,
    "el que fallo no puede quedar marcado como avisado"
  );
});

// ---------------------------------------------------------------------------------------------------
// E15 (2026-09-18). Reservar, enviar, confirmar.
//
// whatsappTokenExpiryNotifiedAt es la compuerta de "un aviso por token". Antes se ponia DESPUES de
// mandar pero sin mirar si el envio habia salido: un envio fallido dejaba la compuerta cerrada sobre un
// aviso que nunca ocurrio, y al dueno no se le avisaba nunca. El bot se apaga el dia 60 y nadie sabe
// por que.
// ---------------------------------------------------------------------------------------------------

function stubWhatsappFetchQueFalla() {
  originalFetch = globalThis.fetch;
  sentMessages = [];
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "fallo simulado de la Graph API" } }),
    }) as Response) as typeof fetch;
}

test("E15: si el aviso no sale, la marca no queda puesta y el ciclo siguiente reintenta", async () => {
  stubWhatsappFetchQueFalla();
  const enTresDias = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const negocio = await createBusiness({ whatsappTokenExpiresAt: enTresDias });

  try {
    await runTokenExpiryJob();
  } finally {
    restoreFetch();
  }

  const despues = await prisma.business.findUniqueOrThrow({ where: { id: negocio.id } });
  assert.equal(
    despues.whatsappTokenExpiryNotifiedAt,
    null,
    "un aviso que no salio no puede dejar la compuerta cerrada"
  );

  // Y el ciclo siguiente lo reintenta de verdad: con el envio andando, ahora si queda avisado.
  stubWhatsappFetch();
  try {
    await runTokenExpiryJob();
  } finally {
    restoreFetch();
  }
  const segunda = await prisma.business.findUniqueOrThrow({ where: { id: negocio.id } });
  assert.ok(segunda.whatsappTokenExpiryNotifiedAt, "la segunda pasada tiene que avisar");
  assert.ok(
    sentMessages.some((m) => m.to === negocio.contactPhone),
    "y el aviso tiene que salir de verdad al dueno"
  );
});
