import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseMediaCaptions } from "./agent";

// Real production incident (2026-09-13): a backstop blast of 8-9 photos wrote that many literal
// "[Foto de X]" ASSISTANT rows into Conversation history - filling most of the model's 20-message window
// and teaching it to imitate the exact bracket format in its own replies (FAKE_MEDIA_TAG_PATTERN then
// caught the fabrication and re-triggered the backstop, reinforcing the loop). collapseMediaCaptions
// folds each consecutive run into one compact line before the history reaches the model.

type Row = { role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"; content: string; imageAnalysis: string | null };

function row(role: Row["role"], content: string): Row {
  return { role, content, imageAnalysis: null };
}

test("collapses a consecutive run of photo captions into one summary line", () => {
  const history: Row[] = [
    row("CUSTOMER", "tienes reloj deportivo?"),
    row("ASSISTANT", "[Foto de Smartwatch V20 Caballero]"),
    row("ASSISTANT", "[Foto de Smartwatch gen 9]"),
    row("ASSISTANT", "[Foto de Combo k11 Mini]"),
    row("ASSISTANT", "Aqui tienes algunas opciones"),
  ];
  const result = collapseMediaCaptions(history);
  assert.equal(result.length, 3);
  assert.equal(result[0].content, "tienes reloj deportivo?");
  assert.match(result[1].content, /Se enviaron 3 fotos\/videos/);
  assert.match(result[1].content, /Smartwatch V20 Caballero/);
  assert.match(result[1].content, /Combo k11 Mini/);
  assert.equal(result[2].content, "Aqui tienes algunas opciones");
});

test("a single photo caption collapses to a singular summary", () => {
  const history: Row[] = [row("ASSISTANT", "[Video de Smartwatch gen 9]")];
  const result = collapseMediaCaptions(history);
  assert.equal(result.length, 1);
  assert.match(result[0].content, /Se envio 1 foto\/video/);
  assert.match(result[0].content, /Smartwatch gen 9/);
});

test("does not touch ordinary text messages or merge across a customer turn in between", () => {
  const history: Row[] = [
    row("ASSISTANT", "[Foto de Producto A]"),
    row("CUSTOMER", "y de otro color?"),
    row("ASSISTANT", "[Foto de Producto B]"),
  ];
  const result = collapseMediaCaptions(history);
  assert.equal(result.length, 3);
  assert.match(result[0].content, /Producto A/);
  assert.equal(result[1].content, "y de otro color?");
  assert.match(result[2].content, /Producto B/);
});

test("leaves history with no photo captions completely unchanged", () => {
  const history: Row[] = [row("CUSTOMER", "hola"), row("ASSISTANT", "hola, en que te ayudo?")];
  const result = collapseMediaCaptions(history);
  assert.deepEqual(result, history);
});

test("a bracket-shaped CUSTOMER message is never collapsed (only ASSISTANT rows are eligible)", () => {
  const history: Row[] = [row("CUSTOMER", "[Foto de un producto que vi en otra tienda]")];
  const result = collapseMediaCaptions(history);
  assert.deepEqual(result, history);
});
