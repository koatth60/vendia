import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { recordAgentIncident, getAgentIncidentSummary } from "./incidents";

// Fase F of the 2026-09-13 audit (F9): none of agent.ts's backend safety nets left any queryable trace
// before this. recordAgentIncident must never throw (best-effort logging), and the summary must count
// correctly per business and include a live count of currently-stalled conversations.

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("recordAgentIncident persists a row and getAgentIncidentSummary counts it by kind", async () => {
  await recordAgentIncident(businessId, "LOOP_EXHAUSTED", "test detail");
  await recordAgentIncident(businessId, "BACKSTOP_INTERVENTION", "test detail 1");
  await recordAgentIncident(businessId, "BACKSTOP_INTERVENTION", "test detail 2");

  const summary = await getAgentIncidentSummary(businessId);
  assert.equal(summary.loopExhausted, 1);
  assert.equal(summary.backstopInterventions, 2);
  assert.equal(summary.degradedReplies, 0);
});

test("getAgentIncidentSummary counts currently-stalled conversations live, not from the incidents table", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573011${Date.now()}` } });
  await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true, status: "NEW" } });
  await prisma.conversation.create({ data: { customerId: customer.id, humanControl: false, status: "NEW" } });
  await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true, status: "SOLD" } });

  const summary = await getAgentIncidentSummary(businessId);
  assert.equal(summary.stalledConversations, 1, "only the open, still-muted conversation counts");
});

test("recordAgentIncident does not throw for an unknown businessId (best-effort, never blocks the reply)", async () => {
  await assert.doesNotReject(recordAgentIncident("not-a-real-business-id", "LOOP_EXHAUSTED", "detail"));
});
