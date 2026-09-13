import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOMER_PHOTO_REQUEST_PATTERN,
  CUSTOMER_PHOTO_NEGATION_PATTERN,
  PHOTO_CLAIM_PATTERN,
  PHOTO_REQUEST_PATTERN,
  OPEN_CLARIFYING_QUESTION_PATTERN,
  OFFER_OR_PENDING_CONFIRMATION_PATTERN,
  FAKE_MEDIA_TAG_PATTERN,
  MEDIA_TAG_STRIP_PATTERN,
  stripMarkdownEmphasis,
} from "./agent";

// Real production incident (2026-09-13, MAGByLizN, customer 573148426124): the same photo set went out
// THREE times in one conversation. Two of the three root causes were in the media backstop's trigger
// (agent.ts finalizeTurn) - this test file locks in the fix for both, using the exact real phrasings from
// the transcript.

function fakeMediaTagFires(text: string): boolean {
  return FAKE_MEDIA_TAG_PATTERN.test(stripMarkdownEmphasis(text));
}

function customerAsked(text: string): boolean {
  return CUSTOMER_PHOTO_REQUEST_PATTERN.test(text) && !CUSTOMER_PHOTO_NEGATION_PATTERN.test(text);
}

function modelClaimsSent(text: string): boolean {
  const stripped = stripMarkdownEmphasis(text);
  return (
    PHOTO_CLAIM_PATTERN.test(text) &&
    PHOTO_REQUEST_PATTERN.test(text) &&
    !OPEN_CLARIFYING_QUESTION_PATTERN.test(text) &&
    !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(stripped)
  );
}

test("blast 3: 'no me muestra la distancia' (screen complaint) does not trigger a photo send", () => {
  const text =
    "Bueno te comento es q ya tengo el S-Mart Watch serie 12 ultra 3 pero ese no me muestra la distancia recorrida en la aplicación de deportes de ciclismo solo me muestra tiempo por eso quiero uno q si me muéstre ese dato";
  assert.equal(customerAsked(text), false);
});

test("blast 1: the bot's own conditional offer ('si quieres te mando fotos') does not count as already sent", () => {
  const text =
    "¡Sí, Einer! Tenemos varios relojes deportivos. ¿Alguno te llama la atención? Si quieres te mando fotos de los que te gusten 📸";
  assert.equal(modelClaimsSent(text), false);
});

test("blast 2: a genuine request ('me gustaria q me la enseñaras') still triggers", () => {
  const text = "Si la verdad es muy clave la parte de ciclismo pero si tienes algun otro q me pueda medir esa parte en deportes me gustaria q me la enseñaras";
  assert.equal(customerAsked(text), true);
});

test("a plain repeat request still works ('mándamela otra vez')", () => {
  assert.equal(customerAsked("mándamela otra vez porfa"), true);
  assert.equal(customerAsked("me la mandas de nuevo?"), true);
});

test("a bare noun request still works ('mándame fotos')", () => {
  assert.equal(customerAsked("mándame fotos de ese porfa"), true);
  assert.equal(customerAsked("tienes video del producto?"), true);
});

test("a genuine completed claim still fires (regression, agent.claimBackstopGuards.test.ts case)", () => {
  const text = "Listo, ya te mande las fotos del reloj, avisame si tienes dudas";
  assert.equal(modelClaimsSent(text), true);
});

test("bare verbs with no media noun and no clitic object do not trigger on their own", () => {
  assert.equal(customerAsked("muestra que tan resistente es al agua"), false);
  assert.equal(customerAsked("enseña el manual antes de comprar"), false);
});

// Second occurrence of the same incident class, found the SAME DAY in a follow-up test conversation
// (business MAG.IMP, customer 573150496302 "Einer") right after the first fix deployed. Two independent
// gaps, both closed here (H9, H10).

// H10: "Déjame mandarte la foto 👇... ¿Te lo llevas?" - PHOTO_CLAIM_PATTERN's "te (mand|envi|pas)"
// alternative only matches when "te" comes BEFORE the verb, not attached after it as a suffix
// ("mandarte"). This exact real reply fell through every existing alternative, so the promise was never
// backed by a real send_product_media call - the customer had to type "fotos" by hand to get anything.
test("H10: 'Déjame mandarte la foto' (enclitic pronoun) now counts as a claim", () => {
  const text = "¡Buen ojo, Einer! 😎\n\n*Smartwatch V20 Caballero* — Negro — *$140.000*\n\nDéjame mandarte la foto 👇\n\n¿Te lo llevas? Cuéntame y seguimos con el pedido 😊";
  assert.equal(modelClaimsSent(text), true);
});

// H9: the FIRST fix for this incident (extractMediaHistory, see agent.mediaHistoryCollapse.test.ts)
// replaced the imitable "[Foto de X]" history format with "[Se envio 1 foto/video: X]" - the model just
// imitated THAT bracket shape instead in its own reply, and the old FAKE_MEDIA_TAG_PATTERN (which only
// matched the literal "[foto de "/"[video de " prefix) never caught it.
test("H9: a fabricated '[Se envio N foto/video: X]' tag (the new imitation shape) is now caught", () => {
  const text = "¡Claro, Einer! Mientras te confirmo lo del ciclismo, te muestro la opción 3 😊\n\n*COMBO SMARTWATCH T2000 ULTRA* — *$80.000*\n\nDéjame mandarte las fotos 👇\n\n¿Te gusta? 🤩\n\n[Se envio 1 foto/video: COMBO SMARTWATCH T2000 ULTRA]";
  assert.equal(fakeMediaTagFires(text), true, "must detect the fabricated tag");
  const stripped = text.replace(MEDIA_TAG_STRIP_PATTERN, "").trim();
  assert.doesNotMatch(stripped, /Se envio/i, "the fabricated tag must be strippable from the reply text");
});

test("H9: the broadened pattern still doesn't false-positive on ordinary text mentioning foto/video with no brackets", () => {
  assert.equal(fakeMediaTagFires("¿Prefieres ver la foto o un video del producto?"), false);
});
