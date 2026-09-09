import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { hashPassword, verifyPassword, requestPasswordReset, resetPasswordWithCode } from "./service";

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
      whatsappPhoneNumberId: "test-phone-id",
      whatsappAccessToken: "test-token",
    },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentCode = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const match = /\b(\d{6})\b/.exec(body.text?.body ?? "");
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
