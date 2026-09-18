import { test } from "node:test";
import assert from "node:assert/strict";
import { sinSolape } from "./sinSolape";

// E23, primera parte (2026-09-18). Un job no se pisa a si mismo.
//
// setInterval no espera a que la pasada anterior termine. saleConfirmationChaser corre cada 60 segundos
// recorriendo negocios y mandando WhatsApps: una pasada lenta se solapa con la siguiente, las dos
// encuentran la misma conversacion vencida, y al cliente le llegan DOS mensajes identicos.

/** Una tarea que no termina hasta que se la suelta a mano. */
function tareaControlada() {
  let soltar!: () => void;
  const promesa = new Promise<void>((resolve) => {
    soltar = resolve;
  });
  let corridas = 0;
  return {
    corridas: () => corridas,
    soltar: () => soltar(),
    tarea: async () => {
      corridas += 1;
      await promesa;
    },
  };
}

test("la segunda pasada se saltea mientras la primera sigue corriendo", async () => {
  const t = tareaControlada();
  const errores: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void errores.push(args.join(" "));

  try {
    const guardia = sinSolape("prueba", t.tarea);
    const primera = guardia.correr();
    assert.equal(guardia.enCurso(), true);

    await guardia.correr(); // la segunda, mientras la primera sigue
    assert.equal(t.corridas(), 1, "la tarea no se puede haber ejecutado dos veces");
    assert.equal(guardia.salteadas(), 1);

    t.soltar();
    await primera;
    assert.equal(guardia.enCurso(), false);
  } finally {
    console.error = originalError;
  }
  assert.match(errores.join(" "), /todavia estaba corriendo/, "y tiene que quedar en el log");
});

test("terminada la primera, la siguiente pasada corre normal", async () => {
  const t = tareaControlada();
  const guardia = sinSolape("prueba", t.tarea);
  const primera = guardia.correr();
  t.soltar();
  await primera;

  const segunda = tareaControlada();
  const guardia2 = sinSolape("prueba", segunda.tarea);
  const corriendo = guardia2.correr();
  assert.equal(segunda.corridas(), 1);
  segunda.soltar();
  await corriendo;
});

test("si la tarea TIRA, la guardia se suelta igual", async () => {
  let corridas = 0;
  const guardia = sinSolape("prueba", async () => {
    corridas += 1;
    throw new Error("falla simulada");
  });

  await assert.rejects(() => guardia.correr());
  assert.equal(guardia.enCurso(), false, "un candado que no se suelta es peor que no tener candado");

  // Y la siguiente pasada tiene que poder correr.
  await assert.rejects(() => guardia.correr());
  assert.equal(corridas, 2, "el job no puede quedar trabado para siempre por un error");
});

test("varias pasadas seguidas durante una lenta se cuentan todas", async () => {
  const t = tareaControlada();
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const guardia = sinSolape("prueba", t.tarea);
    const primera = guardia.correr();
    await guardia.correr();
    await guardia.correr();
    await guardia.correr();
    assert.equal(guardia.salteadas(), 3, "el contador es la señal de que el intervalo quedo corto");
    assert.equal(t.corridas(), 1);
    t.soltar();
    await primera;
  } finally {
    console.error = originalError;
  }
});
