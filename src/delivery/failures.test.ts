import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { realtimeEvents } from "../realtime/events";
import { recordDeliveryFailure, listUnresolvedDeliveryFailures, resolveDeliveryFailure } from "./failures";

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.deliveryFailure.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("recordDeliveryFailure persists the failure and emits a realtime event", async () => {
  let emitted: unknown = null;
  const listener = (bid: string, payload: unknown) => {
    if (bid === businessId) emitted = payload;
  };
  realtimeEvents.on("delivery:failed", listener);

  try {
    const failure = await recordDeliveryFailure(businessId, {
      wamid: `wamid.${randomUUID()}`,
      recipientPhone: "573001112233",
      errorCode: 131047,
      errorMessage: "Re-engagement message: 24h window closed",
      critical: true,
    });

    assert.equal(failure.businessId, businessId);
    assert.equal(failure.resolved, false);

    const stored = await prisma.deliveryFailure.findUnique({ where: { id: failure.id } });
    assert.ok(stored);
    assert.equal(stored!.critical, true);

    assert.ok(emitted, "expected a realtime delivery:failed event for this business");
    assert.equal((emitted as { id: string }).id, failure.id);
  } finally {
    realtimeEvents.off("delivery:failed", listener);
  }
});

test("listUnresolvedDeliveryFailures returns only unresolved rows, newest first", async () => {
  const older = await recordDeliveryFailure(businessId, {
    wamid: `wamid.${randomUUID()}`,
    recipientPhone: "573002223344",
    errorCode: null,
    errorMessage: "older failure",
    critical: false,
  });
  await new Promise((r) => setTimeout(r, 5));
  const newer = await recordDeliveryFailure(businessId, {
    wamid: `wamid.${randomUUID()}`,
    recipientPhone: "573003334455",
    errorCode: null,
    errorMessage: "newer failure",
    critical: false,
  });
  await resolveDeliveryFailure(businessId, older.id);

  const list = await listUnresolvedDeliveryFailures(businessId);
  assert.equal(list.some((f) => f.id === older.id), false, "resolved failures must not appear");
  assert.equal(list[0]?.id, newer.id, "expected newest-first ordering");
});

test("resolveDeliveryFailure rejects an id from a different business (no cross-tenant resolve)", async () => {
  const otherBusiness = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    const failure = await recordDeliveryFailure(businessId, {
      wamid: `wamid.${randomUUID()}`,
      recipientPhone: "573004445566",
      errorCode: null,
      errorMessage: "cross tenant test",
      critical: false,
    });

    await assert.rejects(() => resolveDeliveryFailure(otherBusiness.id, failure.id));

    const stillUnresolved = await prisma.deliveryFailure.findUnique({ where: { id: failure.id } });
    assert.equal(stillUnresolved!.resolved, false);
  } finally {
    await prisma.business.deleteMany({ where: { id: otherBusiness.id } });
  }
});
