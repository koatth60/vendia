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

// 2026-09-14: DeepSeek retiro "deepseek-v4-flash" el mismo dia que anuncio V4.1-Flash. El modelo
// desaparecio de GET /models (hoy solo quedan "deepseek-flash" y "deepseek-v4-pro") y las llamadas a
// /chat/completions con el id viejo se quedaban COLGADAS - sin error, sin respuesta - lo que dejo al bot
// mudo durante horas. "deepseek-flash" tampoco responde todavia (parece en despliegue del lado de ellos),
// asi que el unico id que funciona ahora mismo es v4-pro. Verificar si conviene volver a un flash cuando
// DeepSeek lo estabilice: v4-pro es mas caro.
export const DEEPSEEK_MODEL = "deepseek-v4-pro";

// Modelo experimental separado, unico que acepta imagenes (deepseek-v4-flash no tiene vision).
export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
