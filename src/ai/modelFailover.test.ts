import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deepseek, DEEPSEEK_MODEL, DEEPSEEK_FALLBACK_MODEL } from "./client";
import {
  createChatCompletion,
  currentChatModel,
  resetModelFailoverState,
  refreshModelFailoverState,
  modelFailoverState,
  olvidarLoQueSabeEsteProceso,
} from "./modelFailover";

// Incidente real (2026-09-14): DeepSeek retiro "deepseek-v4-flash" sin aviso. Pedir un modelo
// inexistente no da error - la peticion se cuelga - y el bot quedo mudo horas. Estas pruebas fijan el
// comportamiento que evita que un solo modelo vuelva a ser un punto unico de falla.

let originalCreate: typeof deepseek.chat.completions.create;
let modelsTried: string[];

function stubDeepSeek(behavior: (model: string) => unknown) {
  modelsTried = [];
  // @ts-expect-error stubbing for the test, real signature is wider than we need here
  deepseek.chat.completions.create = async (params: { model: string }) => {
    modelsTried.push(params.model);
    const result = behavior(params.model);
    if (result instanceof Error) throw result;
    return result;
  };
}

const okResponse = (model: string) => ({
  model,
  choices: [{ message: { content: "listo" } }],
  usage: { completion_tokens: 3 },
});

beforeEach(async () => {
  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  await resetModelFailoverState();
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  await resetModelFailoverState();
});

test("usa el modelo barato mientras responde, sin tocar el de respaldo", async () => {
  stubDeepSeek((model) => okResponse(model));

  const response = await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "hola" }] });

  assert.deepEqual(modelsTried, [DEEPSEEK_MODEL], "no debe gastar el respaldo si el preferido responde");
  assert.equal(response.model, DEEPSEEK_MODEL);
});

test("cae al modelo de respaldo cuando el preferido falla, y responde igual", async () => {
  stubDeepSeek((model) => (model === DEEPSEEK_MODEL ? new Error("model not found") : okResponse(model)));

  const response = await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "hola" }] });

  assert.deepEqual(modelsTried, [DEEPSEEK_MODEL, DEEPSEEK_FALLBACK_MODEL]);
  assert.equal(response.model, DEEPSEEK_FALLBACK_MODEL, "el cliente recibe respuesta pese al fallo");
});

// Sin esto, CADA mensaje del cliente pagaria el timeout completo del modelo caido (60s) antes de caer al
// respaldo - que es exactamente lo que hizo esperar 30 minutos a un cliente real.
test("tras un fallo va directo al respaldo, sin volver a pagar el timeout del modelo caido", async () => {
  stubDeepSeek((model) => (model === DEEPSEEK_MODEL ? new Error("model not found") : okResponse(model)));

  await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "uno" }] });
  modelsTried = [];
  await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "dos" }] });

  assert.deepEqual(modelsTried, [DEEPSEEK_FALLBACK_MODEL], "el segundo mensaje no debe reintentar el caido");
  assert.equal(currentChatModel(), DEEPSEEK_FALLBACK_MODEL);
});

test("si tambien falla el respaldo, propaga el error para que el agente degrade y avise al duena", async () => {
  stubDeepSeek(() => new Error("todo caido"));

  await assert.rejects(
    () => createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "hola" }] }),
    /todo caido/
  );
  assert.deepEqual(modelsTried, [DEEPSEEK_MODEL, DEEPSEEK_FALLBACK_MODEL], "intenta ambos antes de rendirse");
});

test("vuelve solo al modelo barato cuando el proveedor se recupera", async () => {
  stubDeepSeek((model) => (model === DEEPSEEK_MODEL ? new Error("model not found") : okResponse(model)));
  await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "hola" }] });
  assert.equal(currentChatModel(), DEEPSEEK_FALLBACK_MODEL);

  // El breaker es por tiempo: se simula que ya paso la ventana de reintento.
  await resetModelFailoverState();
  stubDeepSeek((model) => okResponse(model));

  const response = await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "hola" }] });
  assert.deepEqual(modelsTried, [DEEPSEEK_MODEL], "sin desplegar nada, vuelve al barato");
  assert.equal(response.model, DEEPSEEK_MODEL);
});

// E23, segunda parte (2026-09-18). El breaker es del SISTEMA, no del proceso.
test("un segundo proceso no vuelve a pagar el timeout del modelo caido", async () => {
  stubDeepSeek((model) => (model === DEEPSEEK_MODEL ? new Error("model not found") : okResponse(model)));
  await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "hola" }] });

  // Esto es lo que ve un proceso RECIEN ARRANCADO: la fila esta, su memoria no sabe nada. Antes de E23
  // ese proceso volvia a intentar el modelo caido y colgaba a un cliente el timeout entero.
  olvidarLoQueSabeEsteProceso();
  stubDeepSeek((model) => (model === DEEPSEEK_MODEL ? new Error("model not found") : okResponse(model)));

  const respuesta = await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "dos" }] });

  assert.deepEqual(modelsTried, [DEEPSEEK_FALLBACK_MODEL], "el proceso nuevo tiene que aprenderlo de la base");
  assert.equal(respuesta.model, DEEPSEEK_FALLBACK_MODEL);
});

test("/health lo ve aunque el modelo lo haya tumbado el otro proceso", async () => {
  stubDeepSeek((model) => (model === DEEPSEEK_MODEL ? new Error("model not found") : okResponse(model)));
  await createChatCompletion({ max_tokens: 10, messages: [{ role: "user", content: "hola" }] });

  olvidarLoQueSabeEsteProceso();
  assert.equal(modelFailoverState().enRespaldo, false, "sin refrescar, el espejo del proceso no sabe nada");

  await refreshModelFailoverState();
  assert.equal(modelFailoverState().enRespaldo, true);
  assert.equal(modelFailoverState().modelo, DEEPSEEK_FALLBACK_MODEL);
});
