import { prisma } from "../db/client";

// EL CONSUMO DEL PLAN YA NO VIVE ACA (2026-09-17). Este archivo mide lo que nos cuesta la IA en tokens;
// lo que se le VENDE al negocio se mide en chats y vive en src/billing/chats.ts. Aca estaban
// PLAN_MESSAGE_CAPS, getPlanUsage y checkPlanCap, que contaban filas de Message - una unidad que ya no
// es la que se factura.

// Precios oficiales DeepSeek por 1M tokens (USD), vigentes desde el repricing del 2026-09-10.
// Fuente: https://api-docs.deepseek.com/quick_start/pricing
// Peak: 01:00-04:00 y 06:00-10:00 UTC, lunes a viernes (precio x2 sobre off-peak).
// "deepseek-v4-flash" y "deepseek-v4-flash-vision-exp" son nombres legacy que DeepSeek sigue aceptando -
// las llamadas se enrutan a su modelo V4.1-Flash pero se cobran al precio Flash (mas barato que antes).
// claude-sonnet-5: $2/$10 por 1M tokens input/output (sin cache hit distinto, se usa el mismo precio
// de cacheMiss para el input - Anthropic no tiene peak pricing como DeepSeek).
const PRICING = {
  // "deepseek-flash" es el id vigente desde que DeepSeek retiro "deepseek-v4-flash" el 2026-09-14; el
  // viejo se deja en la tabla para que los registros historicos sigan costeandose bien.
  "deepseek-flash": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  "deepseek-v4-flash": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  "deepseek-v4-flash-vision-exp": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  "deepseek-v4-pro": { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  "claude-sonnet-5": { cacheHit: 2.0, cacheMiss: 2.0, output: 10.0 },
} as const;

function isPeakHour(date: Date): boolean {
  const day = date.getUTCDay(); // 0 = domingo, 6 = sabado
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

interface DeepSeekUsage {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens?: number;
}

// El modelo que se registra es el que REALMENTE respondio (response.model), no el que pedimos: con el
// failover puede ser el de respaldo, y los proveedores tambien renombran ids sin avisar (DeepSeek retiro
// "deepseek-v4-flash" el 2026-09-14). Por eso el tipo es string y no la union de PRICING - un id que no
// conocemos debe quedar registrado igual, con el precio mas caro que conocemos, en vez de romper la
// llamada o subestimar el gasto en silencio.
const UNKNOWN_MODEL_PRICING = { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 };

export async function logAiUsage(params: {
  businessId: string;
  conversationId?: string;
  kind: "CHAT" | "VISION" | "VISION_ESCALATION";
  model: string;
  usage: DeepSeekUsage | undefined;
}): Promise<void> {
  const { businessId, conversationId, kind, model, usage } = params;
  if (!usage) return;

  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens = usage.prompt_cache_miss_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  // Anthropic no tiene peak pricing (eso es exclusivo de DeepSeek) - el multiplicador solo aplica a
  // modelos deepseek-*, nunca a claude-*.
  const now = new Date();
  const multiplier = model.startsWith("deepseek-") && isPeakHour(now) ? 2 : 1;
  const prices = PRICING[model as keyof typeof PRICING] ?? UNKNOWN_MODEL_PRICING;

  const costUsd =
    multiplier *
    ((cacheHitTokens / 1_000_000) * prices.cacheHit +
      (cacheMissTokens / 1_000_000) * prices.cacheMiss +
      (outputTokens / 1_000_000) * prices.output);

  try {
    await prisma.aiUsageLog.create({
      data: { businessId, conversationId, kind, model, cacheHitTokens, cacheMissTokens, outputTokens, costUsd },
    });
  } catch (error) {
    console.error("No se pudo registrar el uso de IA:", error);
  }
}

export async function getAiUsageSummary(businessId: string, days = 14) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const logs = await prisma.aiUsageLog.findMany({
    where: { businessId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { kind: true, costUsd: true, cacheHitTokens: true, cacheMissTokens: true, outputTokens: true, createdAt: true },
  });

  const totalCostUsd = logs.reduce((sum, l) => sum + l.costUsd, 0);
  const totalCalls = logs.length;
  const chatCalls = logs.filter((l) => l.kind === "CHAT").length;
  const visionCalls = logs.filter((l) => l.kind === "VISION" || l.kind === "VISION_ESCALATION").length;
  const totalCacheHitTokens = logs.reduce((sum, l) => sum + l.cacheHitTokens, 0);
  const totalCacheMissTokens = logs.reduce((sum, l) => sum + l.cacheMissTokens, 0);
  const totalInputTokens = totalCacheHitTokens + totalCacheMissTokens;
  const totalOutputTokens = logs.reduce((sum, l) => sum + l.outputTokens, 0);
  // See ONIX-RELIABILITY-PLAN.md Track C item 5 / Fase 6.0 - cache-miss tokens cost ~50x more than
  // cache-hit for the DeepSeek flash model, so a low ratio here (not raw token count) is what actually
  // signals a business worth investigating (e.g. a heavy catalog generating a lot of never-cached
  // tool-result content). Surfaces the same number the manual query in Fase 6.0 needed, per business.
  const cacheHitRatio = totalInputTokens === 0 ? 0 : Math.round((totalCacheHitTokens / totalInputTokens) * 1000) / 10;

  const byDayMap = new Map<string, number>();
  for (const log of logs) {
    const day = log.createdAt.toISOString().slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + log.costUsd);
  }
  const byDay = Array.from(byDayMap.entries()).map(([date, costUsd]) => ({ date, costUsd }));

  return {
    totalCostUsd,
    totalCalls,
    chatCalls,
    visionCalls,
    totalInputTokens,
    totalOutputTokens,
    totalCacheHitTokens,
    totalCacheMissTokens,
    cacheHitRatio,
    byDay,
  };
}
