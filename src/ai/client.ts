import OpenAI from "openai";
import { env } from "../config/env";

export const deepseek = new OpenAI({
  apiKey: env.deepseekApiKey,
  baseURL: "https://api.deepseek.com",
});

export const DEEPSEEK_MODEL = "deepseek-v4-flash";

// Modelo experimental separado, unico que acepta imagenes (deepseek-v4-flash no tiene vision).
export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
