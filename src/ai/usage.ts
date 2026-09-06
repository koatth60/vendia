import { prisma } from "../db/client";

// Precios oficiales DeepSeek por 1M tokens (USD), vigentes desde el repricing del 2026-08-16.
// Fuente: https://api-docs.deepseek.com/quick_start/pricing
// Peak: 01:00-04:00 y 06:00-10:00 UTC, lunes a viernes (precio x2 sobre off-peak).
const PRICING = {
  "deepseek-v4-flash": { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
  "deepseek-v4-flash-vision-exp": { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
  "deepseek-v4-pro": { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
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

export async function logAiUsage(params: {
  businessId: string;
  conversationId?: string;
  kind: "CHAT" | "VISION";
  model: keyof typeof PRICING;
  usage: DeepSeekUsage | undefined;
}): Promise<void> {
  const { businessId, conversationId, kind, model, usage } = params;
  if (!usage) return;

  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens = usage.prompt_cache_miss_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  const now = new Date();
  const multiplier = isPeakHour(now) ? 2 : 1;
  const prices = PRICING[model];

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
  const visionCalls = logs.filter((l) => l.kind === "VISION").length;
  const totalInputTokens = logs.reduce((sum, l) => sum + l.cacheHitTokens + l.cacheMissTokens, 0);
  const totalOutputTokens = logs.reduce((sum, l) => sum + l.outputTokens, 0);

  const byDayMap = new Map<string, number>();
  for (const log of logs) {
    const day = log.createdAt.toISOString().slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + log.costUsd);
  }
  const byDay = Array.from(byDayMap.entries()).map(([date, costUsd]) => ({ date, costUsd }));

  return { totalCostUsd, totalCalls, chatCalls, visionCalls, totalInputTokens, totalOutputTokens, byDay };
}
