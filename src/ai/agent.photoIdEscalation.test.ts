import { test } from "node:test";
import assert from "node:assert/strict";
import { countUnresolvedPhotoIdStreak, PHOTO_ID_CLARIFY_PATTERN } from "./agent";

// Real production incident (2026-09-13/14): a customer sent 4 photos in a row trying to identify a
// product, and the bot asked "¿me confirmas cuál de estos dos es?" every single time without ever
// resolving it or escalating to the owner - the sale stalled and eventually needed a human to take over.
// countUnresolvedPhotoIdStreak is what forces ask_owner_about_photo once that loop has already happened
// twice (see shouldForcePhotoEscalation in generateReply).

function msg(role: "CUSTOMER" | "ASSISTANT", content: string, mediaType: string | null = null) {
  return { role, content, mediaType };
}

test("PHOTO_ID_CLARIFY_PATTERN matches real bot clarifying phrasings", () => {
  assert.equal(PHOTO_ID_CLARIFY_PATTERN.test("¿Me confirmas cuál de los dos es? Así te lo aparto"), true);
  assert.equal(
    PHOTO_ID_CLARIFY_PATTERN.test("Carlos, para no equivocarme con el modelo, ¿me confirmas cuál de estos dos es?"),
    true
  );
  assert.equal(
    PHOTO_ID_CLARIFY_PATTERN.test("el reloj negro cuadrado que me muestras podría ser uno de estos"),
    true
  );
  assert.equal(PHOTO_ID_CLARIFY_PATTERN.test("¡Perfecto! Tenemos el Smartwatch Serie 11 Mini a $145.000"), false);
});

test("countUnresolvedPhotoIdStreak counts consecutive unresolved photo-identify rounds", () => {
  const history = [
    msg("CUSTOMER", "Hola"),
    msg("ASSISTANT", "¡Hola! ¿En qué te ayudo?"),
    msg("CUSTOMER", "Quiero ese", "IMAGE"),
    msg("ASSISTANT", "¿Me confirmas cuál de los dos es? Por lo que veo, se parece a estos dos..."),
    msg("CUSTOMER", "", "IMAGE"),
    msg("ASSISTANT", "Para no equivocarme con el modelo, ¿me confirmas cuál de estos dos es?"),
  ];
  assert.equal(countUnresolvedPhotoIdStreak(history), 2);
});

test("countUnresolvedPhotoIdStreak stops counting once the bot actually resolves a match", () => {
  const history = [
    msg("CUSTOMER", "Quiero ese", "IMAGE"),
    msg("ASSISTANT", "¿Me confirmas cuál de los dos es?"),
    msg("CUSTOMER", "El primero"),
    msg("ASSISTANT", "¡Perfecto! Ese es el Smartwatch V20 Caballero, $140.000."),
    msg("CUSTOMER", "quiero esto", "IMAGE"),
    msg("ASSISTANT", "podría ser uno de estos: Smartwatch gen 9 o Combo k11 Mini"),
  ];
  // The resolved exchange in the middle breaks the streak - only the most recent unresolved round counts.
  assert.equal(countUnresolvedPhotoIdStreak(history), 1);
});

test("countUnresolvedPhotoIdStreak is 0 when the customer never sent media", () => {
  const history = [msg("CUSTOMER", "Hola"), msg("ASSISTANT", "¿Con quién tengo el gusto?")];
  assert.equal(countUnresolvedPhotoIdStreak(history), 0);
});
