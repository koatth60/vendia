import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL, DEEPSEEK_FALLBACK_MODEL } from "./client";
import { recordAgentIncident } from "./incidents";
import { prisma } from "../db/client";

// Incidente real (2026-09-14): DeepSeek retiro "deepseek-v4-flash" sin aviso previo util. Pedir un
// modelo que ya no existe no devuelve error - la peticion se queda colgada hasta el timeout, asi que el
// bot dejo de responderle a los clientes durante horas y nadie se entero. Un solo modelo hardcodeado es
// un punto unico de falla.
//
// Esta capa intenta siempre el modelo barato primero y cae al de respaldo cuando falla. El respaldo es
// del MISMO proveedor a proposito: mismo formato de API, mismo tool-calling, cambiar de id es todo lo que
// hace falta. Cubre el caso real (un modelo puntual retirado o caido), que es el que ya nos paso; una
// caida total de DeepSeek necesitaria otro proveedor y traducir el loop de herramientas entero.
//
// El breaker existe por un motivo concreto: sin el, CADA mensaje del cliente pagaria el timeout completo
// del modelo caido antes de caer al respaldo. Tras el primer fallo se manda directo al respaldo y solo se
// reintenta el preferido cada RETRY_PREFERRED_AFTER_MS, para que el servicio vuelva solo cuando el
// proveedor se recupere sin que nadie tenga que desplegar nada.
//
// E23, segunda parte (2026-09-18): EL BREAKER VIVE EN LA BASE, no en memoria. Con `web` y `worker`
// separados, un breaker por proceso significa que el segundo proceso vuelve a colgar a un cliente el
// timeout entero para enterarse de algo que el primero ya sabia. La decision es una sola y es del
// sistema, asi que es una fila (tabla ModelBreaker).
//
// El espejo en memoria NO es la fuente: existe para que `/health` y `currentChatModel()` puedan seguir
// siendo sincronos. Se refresca en cada llamada al modelo y cada vez que `/health` pregunta.
const RETRY_PREFERRED_AFTER_MS = 10 * 60 * 1000;

let preferredFailedAt: number | null = null;

/** Lee la fila y actualiza el espejo. Es la unica funcion que decide si hay enfriamiento. */
async function leerEnfriamiento(): Promise<boolean> {
  const fila = await prisma.modelBreaker.findUnique({ where: { model: DEEPSEEK_MODEL } });
  if (!fila || fila.until.getTime() <= Date.now()) {
    // Vencido: se borra la fila en vez de dejarla, asi "no hay fila" y "no hay enfriamiento" son lo
    // mismo y no queda un estado intermedio que alguien tenga que interpretar.
    if (fila) await prisma.modelBreaker.deleteMany({ where: { model: DEEPSEEK_MODEL } }).catch(() => undefined);
    preferredFailedAt = null;
    return false;
  }
  preferredFailedAt = fila.failedAt.getTime();
  return true;
}

/** Marca el modelo preferido como caido para todos los procesos. */
async function marcarCaido(detalle: string): Promise<void> {
  const ahora = new Date();
  preferredFailedAt = ahora.getTime();
  await prisma.modelBreaker.upsert({
    where: { model: DEEPSEEK_MODEL },
    create: { model: DEEPSEEK_MODEL, failedAt: ahora, until: new Date(ahora.getTime() + RETRY_PREFERRED_AFTER_MS), detail: detalle },
    update: { failedAt: ahora, until: new Date(ahora.getTime() + RETRY_PREFERRED_AFTER_MS), detail: detalle },
  });
}

/** El espejo, sin tocar la base. Puede estar hasta una llamada al modelo desactualizado. */
function preferredIsInCooldown(): boolean {
  if (preferredFailedAt === null) return false;
  if (Date.now() - preferredFailedAt >= RETRY_PREFERRED_AFTER_MS) {
    preferredFailedAt = null;
    return false;
  }
  return true;
}

/**
 * Solo para las pruebas: olvida lo que sabe ESTE proceso sin tocar la fila. Es la unica forma de
 * reproducir un proceso recien arrancado contra un breaker que ya existe, que es el caso que E23 tiene
 * que cubrir.
 */
export function olvidarLoQueSabeEsteProceso(): void {
  preferredFailedAt = null;
}

/** Refresca el espejo desde la base. Lo usa `/health`, que tiene que decir el estado del SISTEMA. */
export async function refreshModelFailoverState(): Promise<void> {
  await leerEnfriamiento().catch((error) => console.error("No se pudo leer el breaker del modelo:", error));
}

// Solo para los tests: limpia el espejo Y la fila, que es el estado que se arrastraria entre casos.
export async function resetModelFailoverState(): Promise<void> {
  preferredFailedAt = null;
  await prisma.modelBreaker.deleteMany({ where: { model: DEEPSEEK_MODEL } });
}

/**
 * E24 (2026-09-18): el estado del breaker, para que `/health` pueda decirlo. Sin esto, el bot puede
 * estar corriendo entero sobre el modelo de respaldo durante horas y el healthcheck responder "ok" --
 * que es justo la clase de mentira que esta etapa vino a sacar.
 *
 * E23 (2026-09-18): el breaker ya NO vive en memoria. Esto lee el espejo del proceso, que se refresca
 * con `refreshModelFailoverState()` -- lo que hace `/health` antes de preguntar, asi que lo que reporta
 * es el estado del sistema y no el del proceso que atendio la peticion.
 */
export function modelFailoverState(): { enRespaldo: boolean; desde: Date | null; modelo: string } {
  return {
    enRespaldo: preferredIsInCooldown(),
    desde: preferredFailedAt === null ? null : new Date(preferredFailedAt),
    modelo: currentChatModel(),
  };
}

export function currentChatModel(): string {
  return preferredIsInCooldown() ? DEEPSEEK_FALLBACK_MODEL : DEEPSEEK_MODEL;
}

type ChatParams = Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "model">;

// businessId/conversationId solo se usan para dejar rastro del fallo en "Salud del bot" - sin ellos la
// llamada funciona igual, que es lo que necesitan los dos usos internos (resumen de contexto, etc).
export async function createChatCompletion(
  params: ChatParams,
  trace?: { businessId: string; conversationId?: string }
): Promise<OpenAI.Chat.ChatCompletion> {
  // La fuente es la base: si otro proceso ya encontro el modelo caido, este no vuelve a pagar el
  // timeout. Un fallo al leer no puede dejar al bot sin contestar, asi que cae al espejo en memoria.
  const startWithFallback = await leerEnfriamiento().catch(() => preferredIsInCooldown());
  const firstModel = startWithFallback ? DEEPSEEK_FALLBACK_MODEL : DEEPSEEK_MODEL;

  try {
    return (await deepseek.chat.completions.create({
      ...params,
      model: firstModel,
    })) as OpenAI.Chat.ChatCompletion;
  } catch (error) {
    // Ya estabamos en el respaldo: no hay a donde caer, que el caller lo maneje (agent.ts degrada a su
    // texto de disculpa y avisa al duena).
    if (startWithFallback) throw error;

    const detail = `Modelo ${DEEPSEEK_MODEL} fallo, se pasa a ${DEEPSEEK_FALLBACK_MODEL} por ${RETRY_PREFERRED_AFTER_MS / 60000} min: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(detail);
    // Marcar ANTES de reintentar: si el respaldo tarda, los otros procesos ya tienen que saberlo.
    await marcarCaido(detail).catch((e) => console.error("No se pudo guardar el breaker del modelo:", e));
    if (trace) {
      await recordAgentIncident(trace.businessId, "EXTERNAL_API_FAILURE", detail, trace.conversationId);
    }

    return (await deepseek.chat.completions.create({
      ...params,
      model: DEEPSEEK_FALLBACK_MODEL,
    })) as OpenAI.Chat.ChatCompletion;
  }
}
