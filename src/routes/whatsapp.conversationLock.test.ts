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

// NO DELAYS HERE, ON PURPOSE (2026-09-18). This test used to prove concurrency by making `a` sleep
// 30ms and `b` sleep 5ms and asserting b finished first. That is a race, not a proof: the lock now
// goes through a Postgres advisory lock (E07), so under a loaded test run acquiring b's lock can take
// longer than a's 30ms sleep and the order flips - a green/red that depends on the machine, not on the
// code. It failed exactly that way in a full `npm test` run.
//
// The rewrite proves the same property by CONSTRUCTION: `a` cannot finish until `b` has started. If
// the lock were global (the bug this guards against), `b` could never start while `a` holds it, so the
// two would deadlock - which the timeout below reports as such instead of hanging the suite.
test("withConversationLock lets different conversationIds run fully concurrently", async () => {
  const order: string[] = [];
  let avisarQueBArranco: () => void;
  const bArranco = new Promise<void>((resolve) => {
    avisarQueBArranco = resolve;
  });

  const calls = [
    withConversationLock("conv-a", async () => {
      order.push("a-start");
      await bArranco;
      order.push("a-end");
    }),
    withConversationLock("conv-b", async () => {
      order.push("b-start");
      avisarQueBArranco();
      order.push("b-end");
    }),
  ];

  const seTrabo = delay(5000).then(() => {
    throw new Error("conv-a quedo esperando a conv-b: el lock esta serializando conversaciones distintas");
  });
  await Promise.race([Promise.all(calls), seTrabo]);

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
