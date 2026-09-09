import { prisma } from "../db/client";

const STATUSES = ["NEW", "INTERESTED", "QUOTED", "NEGOTIATING", "SOLD", "LOST"] as const;

export async function getAnalyticsSummary(businessId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const conversations = await prisma.conversation.findMany({
    where: { customer: { businessId }, createdAt: { gte: since } },
    select: { status: true },
  });

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const c of conversations) byStatus[c.status]++;

  const totalConversations = conversations.length;
  const closed = byStatus.SOLD + byStatus.LOST;
  const conversionRate = closed > 0 ? byStatus.SOLD / closed : 0;

  const messages = await prisma.message.findMany({
    where: { conversation: { customer: { businessId } }, createdAt: { gte: since } },
    select: { role: true, createdAt: true },
  });

  const byDayMap = new Map<string, { customer: number; assistant: number }>();
  for (const m of messages) {
    if (m.role !== "CUSTOMER" && m.role !== "ASSISTANT") continue;
    const day = m.createdAt.toISOString().slice(0, 10);
    const entry = byDayMap.get(day) ?? { customer: 0, assistant: 0 };
    if (m.role === "CUSTOMER") entry.customer++;
    else entry.assistant++;
    byDayMap.set(day, entry);
  }
  const messagesByDay = Array.from(byDayMap.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topProducts = await prisma.product.findMany({
    where: { businessId, inquiryCount: { gt: 0 } },
    orderBy: { inquiryCount: "desc" },
    take: 5,
    select: { id: true, name: true, inquiryCount: true },
  });

  const csatOrders = await prisma.order.findMany({
    where: { businessId, csatRating: { not: null }, createdAt: { gte: since } },
    select: { csatRating: true },
  });
  const csatCount = csatOrders.length;
  const avgCsat = csatCount > 0 ? csatOrders.reduce((sum, o) => sum + (o.csatRating ?? 0), 0) / csatCount : null;

  return { totalConversations, byStatus, conversionRate, messagesByDay, topProducts, avgCsat, csatCount };
}
