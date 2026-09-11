import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { listApprovedTemplates } from "./client";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("listApprovedTemplates returns only APPROVED templates, dropping pending/rejected ones", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      data: [
        { name: "onix_owner_alert", status: "APPROVED", language: "es" },
        { name: "seguimiento_post_venta", status: "PENDING", language: "es" },
        { name: "old_rejected_one", status: "REJECTED", language: "es" },
      ],
    }),
  })) as unknown as typeof fetch;

  const templates = await listApprovedTemplates("fake-token", "1400084061566358");
  assert.deepEqual(templates, [{ name: "onix_owner_alert", language: "es" }]);
});

test("listApprovedTemplates throws with a readable error when the WhatsApp API call fails", async () => {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"Invalid OAuth access token"}}',
  })) as unknown as typeof fetch;

  await assert.rejects(() => listApprovedTemplates("bad-token", "1400084061566358"), /401/);
});

test("listApprovedTemplates returns an empty list (not a crash) when the WABA has no templates at all", async () => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;

  const templates = await listApprovedTemplates("fake-token", "1400084061566358");
  assert.deepEqual(templates, []);
});
