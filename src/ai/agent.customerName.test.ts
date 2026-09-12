import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSelfIntroducedName } from "./agent";

// Regression: the code-level backstop for save_customer_name only fired when the bot's PRIOR turn
// asked for the name (see ASK_NAME_PATTERN). A customer who volunteers their name unprompted ("Hola
// soy David") fell through that gap - nothing forced the model to call save_customer_name, which
// matched the recurring complaint that the bot stopped saving names automatically.

test("extracts a name from an unprompted self-introduction", () => {
  assert.equal(extractSelfIntroducedName("Hola, soy David Gomez"), "David Gomez");
  assert.equal(extractSelfIntroducedName("Buenas, mi nombre es Maria Jose Rodriguez"), "Maria Jose Rodriguez");
  assert.equal(extractSelfIntroducedName("me llamo Andres"), "Andres");
});

test("returns null when there is no self-introduction", () => {
  assert.equal(extractSelfIntroducedName("Hola, cuanto cuesta el envio?"), null);
  assert.equal(extractSelfIntroducedName("1"), null);
});

test("does not match a non-name phrase after the trigger word", () => {
  assert.equal(extractSelfIntroducedName("soy de Bogota"), null);
  assert.equal(extractSelfIntroducedName("no soy yo quien pregunta"), null);
});
