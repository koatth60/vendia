import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHOTO_REQUEST_PATTERN,
  PHOTO_CLAIM_PATTERN,
  OPEN_CLARIFYING_QUESTION_PATTERN,
  OFFER_OR_PENDING_CONFIRMATION_PATTERN,
  ESCALATION_CLAIM_PATTERN,
  PAYMENT_OPTIONS_CLAIM_PATTERN,
  CATALOG_CHECK_CLAIM_PATTERN,
} from "./agent";

// Regression for a bug class found 2026-09-12 (see agent.photoBackstop.test.ts for the original photo
// case): several *_CLAIM_PATTERN backstops exist to catch the model claiming an action happened without
// actually calling the tool. But the same claim wording ("te paso fotos", "consulto con el equipo", "te
// comparto las opciones", "reviso el catalogo") also shows up inside a conditional OFFER still awaiting
// the customer's go-ahead ("Dime el numero y te paso fotos", "Quieres que consulte con el equipo?", "Si
// prefieres te comparto las opciones"). Without a guard, the backstop fires on the open offer instead of
// waiting for the customer to actually agree - worst case is escalation, which pings the real owner with
// no customer consent.
//
// Each case below is checked as the real call site checks it: CLAIM_PATTERN && !OFFER_OR_PENDING_PATTERN.

function fires(claimPattern: RegExp, text: string): boolean {
  return claimPattern.test(text) && !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(text);
}

test("photo: open clarifying question with a future-tense offer does not fire", () => {
  const text =
    "¡Perfecto! Para mostrarte el correcto, ¿cuál de estos relojes negros te interesa?\n\n" +
    "1. Serie 11 Mini\n2. Serie 12 Ultra 3\n\nDime el número o el nombre y te paso fotos y detalles";
  const modelClaimsSent =
    (PHOTO_CLAIM_PATTERN.test(text) && PHOTO_REQUEST_PATTERN.test(text) && !OPEN_CLARIFYING_QUESTION_PATTERN.test(text));
  assert.equal(modelClaimsSent, false);
});

test("photo: a genuine completed claim still fires", () => {
  const text = "Listo, ya te mande las fotos del reloj, avisame si tienes dudas";
  const modelClaimsSent =
    PHOTO_CLAIM_PATTERN.test(text) && PHOTO_REQUEST_PATTERN.test(text) && !OPEN_CLARIFYING_QUESTION_PATTERN.test(text);
  assert.equal(modelClaimsSent, true);
});

test("escalation: offering to ask the owner does not fire ask_owner", () => {
  assert.equal(fires(ESCALATION_CLAIM_PATTERN, "¿Quieres que consulte con el equipo sobre este descuento?"), false);
  assert.equal(
    fires(ESCALATION_CLAIM_PATTERN, "Puedo preguntarle al dueño si prefieres, dime si quieres que lo haga"),
    false
  );
});

test("escalation: a genuine dropped-promise claim still fires ask_owner", () => {
  assert.equal(fires(ESCALATION_CLAIM_PATTERN, "Dejame consultar con el equipo y ahora te confirmo"), true);
  assert.equal(fires(ESCALATION_CLAIM_PATTERN, "Ya consulte con el equipo, me confirman en un momento"), true);
});

test("payment: offering payment options before the customer agrees does not fire get_payment_methods", () => {
  assert.equal(
    fires(PAYMENT_OPTIONS_CLAIM_PATTERN, "¿Prefieres que te comparta las opciones de pago o seguimos con el pedido primero?"),
    false
  );
  assert.equal(
    fires(PAYMENT_OPTIONS_CLAIM_PATTERN, "Si prefieres te comparto las opciones de pago antes de seguir, ¿te parece?"),
    false
  );
  assert.equal(
    fires(PAYMENT_OPTIONS_CLAIM_PATTERN, "Te paso las opciones de pago en cuanto confirmes el pedido, ¿va bien?"),
    false
  );
});

test("payment: a genuine dropped-promise claim still fires get_payment_methods", () => {
  assert.equal(fires(PAYMENT_OPTIONS_CLAIM_PATTERN, "que medio prefieres usar? te comparto las opciones disponibles"), true);
});

test("catalog: offering to check the catalog does not fire search_products", () => {
  assert.equal(fires(CATALOG_CHECK_CLAIM_PATTERN, "¿Quieres que revise el catalogo completo o ya sabes que producto buscas?"), false);
});

test("catalog: a genuine dropped-promise claim still fires search_products", () => {
  assert.equal(fires(CATALOG_CHECK_CLAIM_PATTERN, "dejame revisar el catalogo para confirmarte bien"), true);
  assert.equal(fires(CATALOG_CHECK_CLAIM_PATTERN, "Perfecto, reviso el catalogo y te cuento"), true);
});
