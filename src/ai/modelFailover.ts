import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL, DEEPSEEK_FALLBACK_MODEL } from "./client";
import { recordAgentIncident } from "./incidents";

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
const RETRY_PREFERRED_AFTER_MS = 10 * 60 * 1000;

let preferredFailedAt: number | null = null;

function preferredIsInCooldown(): boolean {
  if (preferredFailedAt === null) return false;
  if (Date.now() - preferredFailedAt >= RETRY_PREFERRED_AFTER_MS) {
    preferredFailedAt = null;
    return false;
  }
  return true;
}

// Solo para los tests: el breaker es estado de proceso y se arrastraria entre casos.
export function resetModelFailoverState(): void {
  preferredFailedAt = null;
}

/**
 * E24 (2026-09-18): el estado del breaker, para que `/health` pueda decirlo. Sin esto, el bot puede
 * estar corriendo entero sobre el modelo de respaldo durante horas y el healthcheck responder "ok" --
 * que es justo la clase de mentira que esta etapa vino a sacar.
 *
 * VIVE EN MEMORIA, y eso importa: con dos procesos (`E23`) cada uno tiene su propio breaker y este
 * numero es el del proceso que atendio la peticion, no el del sistema. Sacarlo a una tabla es parte de
 * `E23`, no de aca.
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
  const startWithFallback = preferredIsInCooldown();
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

    preferredFailedAt = Date.now();
    const detail = `Modelo ${DEEPSEEK_MODEL} fallo, se pasa a ${DEEPSEEK_FALLBACK_MODEL} por ${RETRY_PREFERRED_AFTER_MS / 60000} min: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(detail);
    if (trace) {
      await recordAgentIncident(trace.businessId, "EXTERNAL_API_FAILURE", detail, trace.conversationId);
    }

    return (await deepseek.chat.completions.create({
      ...params,
      model: DEEPSEEK_FALLBACK_MODEL,
    })) as OpenAI.Chat.ChatCompletion;
  }
}
