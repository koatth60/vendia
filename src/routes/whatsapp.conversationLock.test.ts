import { test } from "node:test";
import assert from "node:assert/strict";
import { withConversationLock } from "./whatsapp";

// Real production incident (2026-09-14/15): two webhooks for the SAME conversation arriving close
// together ran generateReply concurrently, both reading the same starting history and both writing a
// reply - the customer got two different, sometimes contradictory answers within seconds. This is the
// regression test for the fix: withConversationLock serializes calls sharing a conversationId, while
// leaving different conversations fully concurrent (a lock scoped too broadly would just move the bug
// from "duplicate replies" to "every customer waits on every other customer's turn").

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("withConversationLock serializes calls for the same conversationId", async () => {
  const order: string[] = [];
  const calls = [
    withConversationLock("conv-1", async () => {
      order.push("A-start");
      await delay(30);
      order.push("A-end");
    }),
    withConversationLock("conv-1", async () => {
      order.push("B-start");
      await delay(5);
      order.push("B-end");
    }),
  ];
  await Promise.all(calls);
  // B must not start until A fully finished - if the lock failed to serialize, B-start would land
  // between A-start and A-end (the exact shape of the real production bug: two turns overlapping).
  assert.deepEqual(order, ["A-start", "A-end", "B-start", "B-end"]);
});

test("withConversationLock lets different conversationIds run fully concurrently", async () => {
  const order: string[] = [];
  const calls = [
    withConversationLock("conv-a", async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
    }),
    withConversationLock("conv-b", async () => {
      order.push("b-start");
      await delay(5);
      order.push("b-end");
    }),
  ];
  await Promise.all(calls);
  // b (the shorter one) finishes before a even though a started first - proves they ran in parallel,
  // not serialized behind an accidentally-global lock.
  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
});

test("withConversationLock: a turn that throws does not wedge later turns for the same conversation", async () => {
  const order: string[] = [];
  await assert.rejects(
    withConversationLock("conv-err", async () => {
      order.push("first");
      throw new Error("simulated DeepSeek/send failure");
    })
  );
  // A second call for the SAME conversationId right after a throwing one must still run, not hang
  // forever behind a permanently-rejected promise.
  await withConversationLock("conv-err", async () => {
    order.push("second");
  });
  assert.deepEqual(order, ["first", "second"]);
});
