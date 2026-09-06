import { prisma } from "../db/client";
import { getPresignedMediaUrl } from "../media/s3";

export async function getOrCreateCustomer(businessId: string, phoneNumber: string) {
  return prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId, phoneNumber } },
    update: {},
    create: { businessId, phoneNumber },
  });
}

export async function getOrCreateOpenConversation(customerId: string) {
  const existing = await prisma.conversation.findFirst({
    where: {
      customerId,
      status: { notIn: ["SOLD", "LOST"] },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) return existing;

  return prisma.conversation.create({
    data: { customerId, status: "NEW" },
  });
}

export async function recordMessage(
  conversationId: string,
  role: "CUSTOMER" | "ASSISTANT" | "SYSTEM",
  content: string,
  whatsappMessageId?: string,
  media?: { s3Key: string; type: "IMAGE" | "VIDEO" },
  imageAnalysis?: string
) {
  await prisma.message.create({
    data: {
      conversationId,
      role,
      content,
      whatsappMessageId,
      mediaS3Key: media?.s3Key,
      mediaType: media?.type,
      imageAnalysis,
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}

export async function updateConversationStatus(
  conversationId: string,
  status: "NEW" | "INTERESTED" | "QUOTED" | "NEGOTIATING" | "SOLD" | "LOST"
) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { status },
  });
}

export async function wasWhatsappMessageProcessed(whatsappMessageId: string): Promise<boolean> {
  const existing = await prisma.message.findUnique({ where: { whatsappMessageId } });
  return existing !== null;
}

export async function getRecentHistory(conversationId: string, limit = 20) {
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const ordered = messages.reverse();

  return Promise.all(
    ordered.map(async (m) => ({
      ...m,
      mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
    }))
  );
}

export async function listConversationsForBusiness(businessId: string) {
  const conversations = await prisma.conversation.findMany({
    where: { customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });

  return conversations.map((c) => ({
    id: c.id,
    status: c.status,
    updatedAt: c.updatedAt,
    customer: { phoneNumber: c.customer.phoneNumber, name: c.customer.name },
    lastMessage: c.messages[0]
      ? {
          role: c.messages[0].role,
          content: c.messages[0].mediaType === "IMAGE" ? c.messages[0].content || "📷 Imagen" : c.messages[0].content,
          createdAt: c.messages[0].createdAt,
        }
      : null,
  }));
}

export async function getConversationForBusiness(businessId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!conversation) return null;

  return {
    id: conversation.id,
    status: conversation.status,
    updatedAt: conversation.updatedAt,
    customer: { phoneNumber: conversation.customer.phoneNumber, name: conversation.customer.name },
    messages: await Promise.all(
      conversation.messages.map(async (m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
        mediaType: m.mediaType,
      }))
    ),
  };
}
