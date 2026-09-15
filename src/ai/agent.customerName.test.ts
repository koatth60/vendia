import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSelfIntroducedName, extractNameFromAnswer, ASK_NAME_PATTERN, stripMarkdownEmphasis } from "./agent";

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

// Real production bug (2026-09-13): the bot's own bold formatting broke the "bot asked, customer
// answered" name-save backstop - "¿Me confirmas tu *nombre*, por favor?" never matched ASK_NAME_PATTERN
// because the asterisks sit between "tu" and "nombre", breaking the literal phrase. A real customer stayed
// stuck as their old panel name ("Mano") after giving their real name ("Carlos") because of this exact gap.
test("ASK_NAME_PATTERN matches even when the bot bolded the key word with WhatsApp markdown", () => {
  const boldAsk = "¿Me confirmas tu *nombre*, por favor?";
  assert.equal(ASK_NAME_PATTERN.test(boldAsk), false, "the raw bolded text does not match on its own");
  assert.equal(ASK_NAME_PATTERN.test(stripMarkdownEmphasis(boldAsk)), true, "stripping markdown first must restore the match");
});

// Real production incident (2026-09-13, MAGByLizN): a business's own opening script asks "¿Con quién
// tengo el gusto de hablar?" - a real, common greeting phrasing that the original ASK_NAME_PATTERN never
// covered at all.
test("ASK_NAME_PATTERN matches this business's real greeting phrasing", () => {
  assert.equal(ASK_NAME_PATTERN.test("¡Hola, buena tarde! ¿Con quién tengo el gusto de hablar?"), true);
  assert.equal(ASK_NAME_PATTERN.test("¿Con quién tengo el placer?"), true);
  assert.equal(ASK_NAME_PATTERN.test("¿Con quién hablo?"), true);
  assert.equal(ASK_NAME_PATTERN.test("¿Me regalas tu nombre?"), true);
});

// Same real incident: the customer answered "Hola con einer mucho gusto" - the bot's own prior turn
// asked for the name (matches the pattern above), but the raw 5-word answer was over
// looksLikePersonName's 4-word cap, so the name was never saved even though the bot itself understood
// and used it ("¡Mucho gusto, Einer!") in its own reply.
test("extractNameFromAnswer strips greeting/politeness filler to find the real name", () => {
  assert.equal(extractNameFromAnswer("Hola con einer mucho gusto"), "Einer");
  assert.equal(extractNameFromAnswer("hola, soy Carlos"), "Carlos");
  assert.equal(extractNameFromAnswer("buenas tardes, mucho gusto, Maria Fernanda"), "Maria Fernanda");
  assert.equal(extractNameFromAnswer("David"), "David", "a bare name with nothing to strip still works");
});

test("extractNameFromAnswer still returns null for a real sentence with no name in it", () => {
  assert.equal(extractNameFromAnswer("Hola, cuanto cuesta el envio?"), null);
  assert.equal(extractNameFromAnswer("no se, dime tu vos"), null);
});

// Real, repeated production incident (2026-09-14/15): three separate customers ended up with their
// saved name overwritten by "Plateado", "Negro", and "Pero Negro Sale Todo" - all real answers to a
// DIFFERENT part of a compound bot message that also happened to ask for the name ("Cuál color
// prefieres? Y ya que estamos, me confirmas tu nombre...", or a numbered list ending in "...nombre
// completo, cedula..."). ASK_NAME_PATTERN matches that whole message, so whatever the customer replied
// got tried as a name candidate, and these short, all-alphabetic answers had nothing to disqualify them.
test("extractNameFromAnswer rejects a color answered to a compound color+name question", () => {
  assert.equal(extractNameFromAnswer("Plateado"), null);
  assert.equal(extractNameFromAnswer("Negro"), null);
  assert.equal(extractNameFromAnswer("Rosado"), null);
  assert.equal(extractNameFromAnswer("negro"), null, "case-insensitive");
});

test("extractNameFromAnswer rejects a short sentence that merely happens to fit the word-count/shape check", () => {
  assert.equal(extractNameFromAnswer("Pero negro sale con todo"), null);
});

test("extractSelfIntroducedName also rejects a color/non-name candidate after the trigger word", () => {
  assert.equal(extractSelfIntroducedName("soy negro"), null);
  assert.equal(extractSelfIntroducedName("me llamo plateado"), null);
});

test("extractNameFromAnswer still accepts a real name that is not a color/reserved word", () => {
  assert.equal(extractNameFromAnswer("Angie"), "Angie");
  assert.equal(extractNameFromAnswer("Maria Camila"), "Maria Camila");
});
