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
        {
          name: "onix_owner_alert",
          status: "APPROVED",
          language: "es",
          components: [{ type: "BODY", text: "Onix: {{1}}\n\nEntra a zaqisolutions.com y anda a Conversaciones para atender." }],
        },
        { name: "seguimiento_post_venta", status: "PENDING", language: "es", components: [{ type: "BODY", text: "no deberia aparecer" }] },
        { name: "old_rejected_one", status: "REJECTED", language: "es", components: [{ type: "BODY", text: "no deberia aparecer" }] },
      ],
    }),
  })) as unknown as typeof fetch;

  const templates = await listApprovedTemplates("fake-token", "1400084061566358");
  assert.deepEqual(templates, [
    { name: "onix_owner_alert", language: "es", bodyText: "Onix: {{1}}\n\nEntra a zaqisolutions.com y anda a Conversaciones para atender." },
  ]);
});

test("listApprovedTemplates returns an empty bodyText (not a crash) when a template has no BODY component", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ data: [{ name: "weird_template", status: "APPROVED", language: "es", components: [] }] }),
  })) as unknown as typeof fetch;

  const templates = await listApprovedTemplates("fake-token", "1400084061566358");
  assert.deepEqual(templates, [{ name: "weird_template", language: "es", bodyText: "" }]);
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
