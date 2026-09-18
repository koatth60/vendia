import test from "node:test";
import assert from "node:assert/strict";
import { contradiceLaModalidad, metodosCompatibles, settlementQueExigeLaModalidad } from "./pagoSegunModalidad";

// E15b. Las tres filas de la tabla, y las dos cosas que la etapa exige: que no se ofrezca lo que ya se
// decidio, y que una contradiccion NO se resuelva en silencio.

const NEQUI = { id: "n", label: "Nequi", settlement: "PREPAID" as const };
const CONTRAENTREGA = { id: "c", label: "Contraentrega", settlement: "ON_DELIVERY" as const };

test("elegida la modalidad, el momento en que entra la plata queda determinado", () => {
  assert.equal(settlementQueExigeLaModalidad("COD_ALL"), "ON_DELIVERY");
  assert.equal(settlementQueExigeLaModalidad("PREPAID_ALL"), "PREPAID");
  // El producto va por adelantado aunque el envio se pague al recibir: lo que manda es el producto.
  assert.equal(settlementQueExigeLaModalidad("PREPAID_PRODUCT_COD_SHIPPING"), "PREPAID");
});

test("sin modalidad elegida no se filtra nada, que es lo contrario de esconder por las dudas", () => {
  assert.equal(settlementQueExigeLaModalidad(null), null);
  assert.deepEqual(metodosCompatibles([NEQUI, CONTRAENTREGA], null), [NEQUI, CONTRAENTREGA]);
});

test("con todo contraentrega no se le vuelve a ofrecer pagar por adelantado", () => {
  assert.deepEqual(metodosCompatibles([NEQUI, CONTRAENTREGA], "COD_ALL"), [CONTRAENTREGA]);
});

test("con pago por adelantado no se le ofrece contraentrega otra vez", () => {
  assert.deepEqual(metodosCompatibles([NEQUI, CONTRAENTREGA], "PREPAID_ALL"), [NEQUI]);
  assert.deepEqual(metodosCompatibles([NEQUI, CONTRAENTREGA], "PREPAID_PRODUCT_COD_SHIPPING"), [NEQUI]);
});

test("un metodo que contradice la modalidad se rechaza nombrando las dos cosas que chocan", () => {
  const choque = contradiceLaModalidad(NEQUI, "COD_ALL");
  assert.ok(choque, "pagar todo al recibir y elegir Nequi se contradicen");
  assert.match(choque, /al recibir/i);
  assert.match(choque, /Nequi/);
  assert.match(choque, /No se guardo nada/i, "y dice que no se quedo con ninguna en silencio");

  const alReves = contradiceLaModalidad(CONTRAENTREGA, "PREPAID_ALL");
  assert.ok(alReves);
  assert.match(alReves, /Contraentrega/);
});

test("el metodo que corresponde a la modalidad no contradice nada", () => {
  assert.equal(contradiceLaModalidad(CONTRAENTREGA, "COD_ALL"), null);
  assert.equal(contradiceLaModalidad(NEQUI, "PREPAID_ALL"), null);
  assert.equal(contradiceLaModalidad(NEQUI, null), null);
});
