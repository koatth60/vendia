import { prisma } from "../db/client";

// Message caps per plan tier — enforced by checkPlanCap below (gates the bot's auto-reply once
// exceeded), and also shown to the owner as a usage percentage in the admin panel. NEGOCIO is
// deliberately null (unlimited), not Infinity — Infinity doesn't survive JSON.stringify (becomes null
// on the wire anyway), so we make that explicit and treat null as "no cap" everywhere it's read.
const PLAN_MESSAGE_CAPS: Record<string, number | null> = {
  BASICO: 2000,
  EMPRENDEDOR: 5000,
  NEGOCIO: null,
};

function getMessageCap(planTier: string): number | null {
  return planTier in PLAN_MESSAGE_CAPS ? PLAN_MESSAGE_CAPS[planTier] : PLAN_MESSAGE_CAPS.BASICO;
}

export async function getPlanUsage(businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { planTier: true } });
  const planTier = business?.planTier ?? "BASICO";
  const messageCap = getMessageCap(planTier);

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const messagesUsed = await prisma.message.count({
    where: {
      conversation: { customer: { businessId } },
      createdAt: { gte: periodStart },
    },
  });

  return {
    planTier,
    messageCap,
    messagesUsed,
    usagePercent: messageCap === null ? 0 : Math.round((messagesUsed / messageCap) * 1000) / 10,
    periodStart,
  };
}

// Precios oficiales DeepSeek por 1M tokens (USD), vigentes desde el repricing del 2026-09-10.
// Fuente: https://api-docs.deepseek.com/quick_start/pricing
// Peak: 01:00-04:00 y 06:00-10:00 UTC, lunes a viernes (precio x2 sobre off-peak).
// "deepseek-v4-flash" y "deepseek-v4-flash-vision-exp" son nombres legacy que DeepSeek sigue aceptando -
// las llamadas se enrutan a su modelo V4.1-Flash pero se cobran al precio Flash (mas barato que antes).
// claude-haiku-4-5: $1/$5 por 1M tokens input/output (sin cache hit distinto, se usa el mismo
// precio de cacheMiss para el input - Anthropic no tiene peak pricing como DeepSeek).
const PRICING = {
  "deepseek-v4-flash": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  "deepseek-v4-flash-vision-exp": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  "deepseek-v4-pro": { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  "claude-haiku-4-5-20251001": { cacheHit: 1.0, cacheMiss: 1.0, output: 5.0 },
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
  kind: "CHAT" | "VISION" | "VISION_ESCALATION";
  model: keyof typeof PRICING;
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

// Gates the bot's auto-reply, not the DB write of the incoming message itself - the customer message
// is always recorded, only the AI call (and the cost/message-volume it represents) is what gets capped.
export async function checkPlanCap(
  businessId: string
): Promise<{ capped: boolean; justCrossed: boolean; messageCap: number | null; planTier: string }> {
  const usage = await getPlanUsage(businessId);
  if (usage.messageCap === null || usage.messagesUsed <= usage.messageCap) {
    return { capped: false, justCrossed: false, messageCap: usage.messageCap, planTier: usage.planTier };
  }

  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { capNotifiedAt: true } });
  const justCrossed = !business?.capNotifiedAt || business.capNotifiedAt < usage.periodStart;
  if (justCrossed) {
    await prisma.business.update({ where: { id: businessId }, data: { capNotifiedAt: new Date() } });
  }

  return { capped: true, justCrossed, messageCap: usage.messageCap, planTier: usage.planTier };
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
