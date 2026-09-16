import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  hashPassword,
  verifyPassword,
  requestPasswordReset,
  resetPasswordWithCode,
  verifyResetCode,
  generateResetCode,
  generateActivationCode,
} from "./service";

let businessId: string;
let businessEmail: string;
let originalFetch: typeof fetch;
let sentCode: string | null;

before(async () => {
  businessEmail = `test-${randomUUID()}@example.com`;
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: businessEmail,
      passwordHash: await hashPassword("old-password-123"),
      contactPhone: "573000000000",
      contactName: "Owner",
      whatsappPhoneNumberId: `test-phone-${randomUUID()}`,
      whatsappAccessToken: "test-token",
    },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentCode = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    // sendOwnerAlert tries a template first (params live in template.components[].parameters), so
    // search the whole payload rather than assuming a plain-text message shape.
    const match = /\b(\d{6})\b/.exec(String(init?.body ?? ""));
    if (match) sentCode = match[1];
    return {
      ok: true,
      json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }),
    } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("requestPasswordReset sends a code over WhatsApp and resetPasswordWithCode accepts it", async () => {
  stubWhatsappFetch();
  try {
    await requestPasswordReset(businessEmail);
    assert.ok(sentCode, "expected a 6-digit code to be sent over WhatsApp");

    const ok = await resetPasswordWithCode(businessEmail, sentCode!, "brand-new-password-456");
    assert.equal(ok, true);

    const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    assert.equal(business.passwordResetCode, null);
    assert.ok(await verifyPassword("brand-new-password-456", business.passwordHash));
  } finally {
    restoreFetch();
  }
});

test("resetPasswordWithCode rejects a wrong code", async () => {
  stubWhatsappFetch();
  try {
    await requestPasswordReset(businessEmail);
    const ok = await resetPasswordWithCode(businessEmail, "000000", "another-password-789");
    assert.equal(ok, false);
  } finally {
    restoreFetch();
  }
});

test("resetPasswordWithCode rejects an unknown email", async () => {
  const ok = await resetPasswordWithCode("does-not-exist@example.com", "123456", "whatever-password");
  assert.equal(ok, false);
});

// Fase 8, punto 6 del plan maestro (2026-09-15).

test("el codigo de restablecimiento no queda legible en la base ni en el registro del dueno", async () => {
  stubWhatsappFetch();
  try {
    await requestPasswordReset(businessEmail);
    assert.ok(sentCode, "esperaba un codigo de 6 digitos por WhatsApp");

    const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    assert.notEqual(business.passwordResetCode, sentCode, "el codigo no puede guardarse en texto plano");
    assert.equal(
      await verifyResetCode(sentCode!, business.passwordResetCode!),
      true,
      "lo guardado tiene que ser un hash del codigo, no otra cosa"
    );

    // OwnerMessageLog se lee desde /admin/api/owner-log y desde la consola de plataforma: un codigo
    // vivo escrito ahi es un codigo valido por dos caminos que no son el WhatsApp del dueno.
    const log = await prisma.ownerMessageLog.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
    for (const entry of log) {
      assert.equal(entry.body.includes(sentCode!), false, "el registro no puede contener el codigo");
    }
    assert.equal(log.length > 0, true, "el envio si tiene que dejar rastro, sin el secreto");
  } finally {
    restoreFetch();
  }
});

test("un codigo vencido no sirve aunque sea el correcto", async () => {
  stubWhatsappFetch();
  try {
    await requestPasswordReset(businessEmail);
    await prisma.business.update({
      where: { id: businessId },
      data: { passwordResetExpiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal(await resetPasswordWithCode(businessEmail, sentCode!, "password-vencida-000"), false);
  } finally {
    restoreFetch();
  }
});

test("generateResetCode da seis digitos y no se repite", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = generateResetCode();
    assert.equal(code.length, 6);
    const value = Number(code);
    assert.equal(Number.isInteger(value), true);
    assert.equal(value >= 100000 && value <= 999999, true);
    seen.add(code);
  }
  // 200 tiradas sobre 900.000 valores: repetir mas de un punado significa que la fuente no es
  // aleatoria de verdad.
  assert.equal(seen.size > 190, true, `demasiadas repeticiones: ${seen.size} distintos de 200`);
});

test("generateActivationCode tampoco sale de Math.random", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const code = generateActivationCode();
    assert.equal(code.length, 14, "cuatro bloques de 4 menos uno, con dos guiones: XXXX-XXXX-XXXX");
    seen.add(code);
  }
  assert.equal(seen.size, 100);
});
