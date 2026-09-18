import test from "node:test";
import assert from "node:assert/strict";
import { quitarSintaxisDeHerramienta } from "./sintaxisDeHerramienta";

// El caso real, copiado tal cual de la conversacion que el dueño vio en el panel.
const FUGA_REAL = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="set_shipping_modality">',
  '<｜｜DSML｜｜ parameter name="modality" string="true">Contra entrega total (producto + envío)</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join(String.fromCharCode(10));

test("la llamada a herramienta escrita como texto no sobrevive", () => {
  const { limpio, habia } = quitarSintaxisDeHerramienta(FUGA_REAL);
  assert.equal(habia, true);
  assert.equal(limpio, "", "el turno entero era la llamada: no queda mensaje que enviar");
});

test("si la fuga viene pegada a un mensaje de verdad, el mensaje se conserva", () => {
  const texto = `¡Listo, Nubia! 😊${String.fromCharCode(10)}${FUGA_REAL}${String.fromCharCode(10)}En total serían $94.000.`;
  const { limpio, habia } = quitarSintaxisDeHerramienta(texto);
  assert.equal(habia, true);
  assert.match(limpio, /Listo, Nubia/);
  assert.match(limpio, /94\.000/);
  assert.doesNotMatch(limpio, /DSML/);
  assert.doesNotMatch(limpio, /invoke/);
});

test("otros envoltorios de llamada tampoco pasan", () => {
  const texto = `<｜tool▁calls▁begin｜>algo<｜tool▁call▁end｜>${String.fromCharCode(10)}Hola, ¿en que te ayudo?`;
  const { limpio } = quitarSintaxisDeHerramienta(texto);
  assert.doesNotMatch(limpio, /tool/);
  assert.match(limpio, /en que te ayudo/);
});

test("un mensaje normal no se toca", () => {
  const texto = `¡Hola, Carolina! 😊 El Smartwatch gen 9 vale $85.000.${String.fromCharCode(10)}¿Te lo separo?`;
  const { limpio, habia } = quitarSintaxisDeHerramienta(texto);
  assert.equal(habia, false);
  assert.equal(limpio, texto);
});

test("un mensaje que habla de herramientas en prosa no se rompe", () => {
  const texto = "Te cuento que el reloj trae herramientas de medicion y un parametro de brillo ajustable.";
  const { limpio, habia } = quitarSintaxisDeHerramienta(texto);
  assert.equal(habia, false);
  assert.equal(limpio, texto);
});
