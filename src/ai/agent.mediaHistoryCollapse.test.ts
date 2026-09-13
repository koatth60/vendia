import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMediaHistory } from "./agent";

// Real production incident (2026-09-13, two occurrences same day):
// 1st occurrence: a backstop blast of 8-9 photos wrote that many literal "[Foto de X]" ASSISTANT rows
// into Conversation history - filling most of the model's 20-message window and teaching it to imitate
// the exact bracket format in its own replies.
// 2nd occurrence, found in a follow-up test conversation the SAME day: the first fix (collapsing runs
// into one ASSISTANT-role summary line, "[Se envio 1 foto/video: X]") got imitated too - it was still an
// ASSISTANT-role message shaped like something the model had just said. Real fix: remove media rows from
// the conversational history ENTIRELY (extractMediaHistory below), and tell the model about them via a
// `system` note instead (built by the caller in generateReply) - system content isn't something a model
// echoes back as its own reply.

type Row = { role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"; content: string; imageAnalysis: string | null };

function row(role: Row["role"], content: string): Row {
  return { role, content, imageAnalysis: null };
}

test("removes a consecutive run of photo captions from the history and reports them separately", () => {
  const history: Row[] = [
    row("CUSTOMER", "tienes reloj deportivo?"),
    row("ASSISTANT", "[Foto de Smartwatch V20 Caballero]"),
    row("ASSISTANT", "[Foto de Smartwatch gen 9]"),
    row("ASSISTANT", "[Foto de Combo k11 Mini]"),
    row("ASSISTANT", "Aqui tienes algunas opciones"),
  ];
  const { history: result, photosSent } = extractMediaHistory(history);
  assert.equal(result.length, 2, "the 3 caption rows must be removed, not collapsed into a new row");
  assert.equal(result[0].content, "tienes reloj deportivo?");
  assert.equal(result[1].content, "Aqui tienes algunas opciones");
  assert.deepEqual(photosSent, ["Smartwatch V20 Caballero", "Smartwatch gen 9", "Combo k11 Mini"]);
  // Nothing in the filtered history or the reported list should be a bracket the model could imitate as
  // its own turn - photosSent is plain text, never wrapped back into "[...]" by this function.
  assert.ok(result.every((r) => !r.content.includes("[")));
});

test("a single photo caption is removed and reported as a 1-item list", () => {
  const history: Row[] = [row("ASSISTANT", "[Video de Smartwatch gen 9]")];
  const { history: result, photosSent } = extractMediaHistory(history);
  assert.equal(result.length, 0);
  assert.deepEqual(photosSent, ["Smartwatch gen 9"]);
});

test("does not touch ordinary text messages or merge across a customer turn in between", () => {
  const history: Row[] = [
    row("ASSISTANT", "[Foto de Producto A]"),
    row("CUSTOMER", "y de otro color?"),
    row("ASSISTANT", "[Foto de Producto B]"),
  ];
  const { history: result, photosSent } = extractMediaHistory(history);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "y de otro color?");
  assert.deepEqual(photosSent, ["Producto A", "Producto B"]);
});

test("leaves history with no photo captions completely unchanged and reports an empty list", () => {
  const history: Row[] = [row("CUSTOMER", "hola"), row("ASSISTANT", "hola, en que te ayudo?")];
  const { history: result, photosSent } = extractMediaHistory(history);
  assert.deepEqual(result, history);
  assert.deepEqual(photosSent, []);
});

test("a bracket-shaped CUSTOMER message is never removed (only ASSISTANT rows are eligible)", () => {
  const history: Row[] = [row("CUSTOMER", "[Foto de un producto que vi en otra tienda]")];
  const { history: result, photosSent } = extractMediaHistory(history);
  assert.deepEqual(result, history);
  assert.deepEqual(photosSent, []);
});

test("does not duplicate the same product name if it was sent more than once", () => {
  const history: Row[] = [row("ASSISTANT", "[Foto de Producto A]"), row("CUSTOMER", "otra vez"), row("ASSISTANT", "[Foto de Producto A]")];
  const { photosSent } = extractMediaHistory(history);
  assert.deepEqual(photosSent, ["Producto A"]);
});
