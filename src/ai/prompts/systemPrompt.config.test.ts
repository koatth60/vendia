import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, categoryLabel } from "./systemPrompt";
import { buildTools } from "../tools";
import { formatPaymentExamples } from "../../catalog/paymentMethods";

// Fase 11 del plan maestro (2026-09-15), causa raiz C5: nada de lo que el modelo lee puede venir escrito
// a mano para Colombia. Estas pruebas son puras (no tocan la base ni ningun servicio) y fijan lo que la
// fase promete: el segundo, el decimo y el mexicano no tocan codigo.

test("los ejemplos de forma de pago salen de los metodos reales del negocio", () => {
  assert.equal(formatPaymentExamples(["SPEI", "OXXO", "Mercado Pago"]), "SPEI, OXXO, Mercado Pago");
  // Solo tres: es un ejemplo, no el catalogo de pagos del negocio.
  assert.equal(formatPaymentExamples(["A", "B", "C", "D"]), "A, B, C");
  // Sin metodos cargados, ejemplos genericos de canal - nunca una marca de ningun pais.
  assert.equal(formatPaymentExamples([]), "transferencia, contraentrega");
  assert.equal(formatPaymentExamples(["  ", ""]), "transferencia, contraentrega");
});

test("las descripciones de las herramientas nombran los metodos reales, no Nequi", () => {
  const mexicano = JSON.stringify(buildTools({ saleStateEnabled: true, paymentExamples: "SPEI, OXXO" }));
  assert.ok(!mexicano.includes("Nequi"), "ninguna herramienta puede seguir diciendo Nequi para un negocio mexicano");
  assert.ok(mexicano.includes("SPEI, OXXO"));
  assert.ok(!mexicano.includes("{{METODOS_PAGO}}"), "no puede quedar la marca sin sustituir");

  const colombiano = JSON.stringify(buildTools({ saleStateEnabled: true, paymentExamples: "Nequi, Daviplata" }));
  assert.ok(colombiano.includes("Nequi, Daviplata"));
});

test("sin la bandera de SaleState no se mandan sus herramientas, igual que antes", () => {
  const conFlag = buildTools({ saleStateEnabled: true, paymentExamples: "SPEI" });
  const sinFlag = buildTools({ saleStateEnabled: false, paymentExamples: "SPEI" });
  assert.ok(conFlag.length > sinFlag.length);
  assert.ok(!JSON.stringify(sinFlag).includes("set_order_item"));
});

test("el prompt llama al documento como se llama en el pais del negocio", () => {
  assert.ok(buildSystemPrompt({ documentLabel: "número de cédula" }).includes("número de cédula"));
  const mx = buildSystemPrompt({ documentLabel: "identificación" });
  assert.ok(mx.includes("identificación"));
  assert.ok(!mx.includes("(cedula)"), "no puede quedar la palabra colombiana para un negocio mexicano");
  // Sin dato, una forma neutra - nunca "cedula".
  assert.ok(buildSystemPrompt({}).includes("un documento de identidad"));
});

test("el rubro del negocio ya no es un conjunto cerrado de cinco", () => {
  // Los cinco atajos del panel siguen expandiendose a su nombre completo.
  assert.equal(categoryLabel("joyeria"), "joyería y accesorios");
  // Y cualquier otro rubro llega al prompt tal cual, en vez de desaparecer.
  assert.equal(categoryLabel("ferretería"), "ferretería");
  assert.equal(categoryLabel(""), null);
  assert.equal(categoryLabel(null), null);
  assert.ok(buildSystemPrompt({ category: "farmacia" }).includes("este negocio es de farmacia"));
});

test("el horario de atencion solo entra al prompt si el negocio lo cargo", () => {
  assert.ok(!buildSystemPrompt({}).includes("HORARIO DE ATENCION"));
  const conHorario = buildSystemPrompt({
    businessHoursText: "lunes a viernes de 09:00 a 18:00",
    closedDaysText: "sábado, domingo",
  });
  assert.ok(conHorario.includes("lunes a viernes de 09:00 a 18:00"));
  assert.ok(conHorario.includes("No se atiende sábado, domingo."));
});

test("la modalidad de pago del envio ya no repite lo que dicen las herramientas", () => {
  // Ahorro de tokens (regla del repositorio): la frase "distinto del canal de pago ... son dos preguntas
  // separadas" la dicen ya, palabra por palabra, get_shipping_payment_modalities y set_shipping_modality,
  // que el modelo ve en cada llamada real. Estaba tres veces en el mismo payload.
  const prompt = buildSystemPrompt({ shippingPaymentModalities: ["PREPAID_ALL", "COD_ALL"] });
  assert.ok(prompt.includes("MODALIDAD DE PAGO DEL ENVIO"));
  assert.ok(!prompt.includes("son dos preguntas separadas"));
  assert.ok(JSON.stringify(buildTools({ saleStateEnabled: true, paymentExamples: "Nequi" })).includes("distinto del canal de pago"));
});
