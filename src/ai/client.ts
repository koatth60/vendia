import OpenAI from "openai";
import { env } from "../config/env";

// Incidente real (2026-09-14): el endpoint /chat/completions de DeepSeek se colgo - aceptaba la conexion
// y nunca devolvia nada (curl con --max-time 60 salia en http=000, mientras /models seguia respondiendo
// en 0.4s). Sin timeout explicito el SDK espera 10 MINUTOS por intento y reintenta 2 veces, asi que el
// cliente quedo 30 minutos en silencio antes de ver siquiera el mensaje de disculpa, y la duena tuvo que
// entrar a mano sin saber por que. Con 60s y un solo reintento el peor caso baja a ~2 minutos: el bot se
// rinde rapido, manda el fallback y le avisa al duena (ver alertOwnerOfDegradedReply en agent.ts).
const REQUEST_TIMEOUT_MS = 60_000;

export const deepseek = new OpenAI({
  apiKey: env.deepseekApiKey,
  baseURL: "https://api.deepseek.com",
  timeout: REQUEST_TIMEOUT_MS,
  maxRetries: 1,
});

// 2026-09-14: DeepSeek retiro "deepseek-v4-flash" el mismo dia que anuncio V4.1-Flash, y pedir un modelo
// inexistente deja la peticion colgada en vez de dar error - el bot quedo mudo horas. Por eso ahora hay
// un preferido y un respaldo, y quien decide cual se usa es src/ai/modelFailover.ts, no estas constantes.
//
// El preferido es el barato: medido sobre trafico real de produccion, flash sale ~4.4x mas barato que pro
// (USD 1.64 vs 7.28 al mes para el negocio piloto). Con el plan Emprendedor a ~USD 15/mes, eso es 11% del
// ingreso contra 48% - pro no se sostiene como default, solo como red de seguridad.
export const DEEPSEEK_MODEL = "deepseek-flash";
export const DEEPSEEK_FALLBACK_MODEL = "deepseek-v4-pro";

// Modelo experimental separado, unico que acepta imagenes (deepseek-v4-flash no tiene vision).
export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
