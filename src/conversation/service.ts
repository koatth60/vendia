import { Prisma } from "@prisma/client";
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
  media?: { s3Key: string; type: "IMAGE" | "VIDEO" | "AUDIO" },
  imageAnalysis?: string,
  relatedProductId?: string
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
      relatedProductId,
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}

export async function getRelatedProductNameForMessage(whatsappMessageId: string): Promise<string | null> {
  const message = await prisma.message.findUnique({
    where: { whatsappMessageId },
    select: { relatedProductId: true },
  });
  if (!message?.relatedProductId) return null;
  const product = await prisma.product.findUnique({
    where: { id: message.relatedProductId },
    select: { name: true },
  });
  return product?.name ?? null;
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

export async function saveCustomerName(businessId: string, customerId: string, name: string | null) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  return prisma.customer.update({
    where: { id: customerId },
    data: { name },
  });
}

export async function saveCustomerContactInfo(
  businessId: string,
  customerId: string,
  data: { idNumber?: string; deliveryPhone?: string }
) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  return prisma.customer.update({
    where: { id: customerId },
    data: {
      ...(data.idNumber ? { idNumber: data.idNumber } : {}),
      ...(data.deliveryPhone ? { deliveryPhone: data.deliveryPhone } : {}),
    },
  });
}

export async function setCustomerTags(businessId: string, customerId: string, tags: string[]) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  return prisma.customer.update({
    where: { id: customerId },
    data: { tags },
  });
}

export async function setConversationIntent(
  conversationId: string,
  intent: "PQR" | "DEVOLUCION" | "NO_RECIBIDO" | "SOLICITA_AGENTE"
) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { intent },
  });
}

export async function setHumanControl(businessId: string, conversationId: string, active: boolean) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
  });
  if (!conversation) return null;
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { humanControl: active },
  });
}

// Called only when the OWNER manually takes control from the admin panel (not when the bot itself
// auto-escalates via flag_conversation_intent, which sets this same "pide agente" badge in the same
// breath - clearing it there would erase the flag the bot just set). The badge has done its job once a
// human is actually handling it; if the customer asks for an agent again later, the bot sets it right
// back via set_conversation_intent.
export async function clearAgentRequestFlag(businessId: string, conversationId: string) {
  await prisma.conversation.updateMany({
    where: { id: conversationId, customer: { businessId }, intent: "SOLICITA_AGENTE" },
    data: { intent: null },
  });
}

export async function findConversationByPendingConfirmation(pendingConfirmationMessageId: string) {
  return prisma.conversation.findUnique({
    where: { pendingConfirmationMessageId },
    include: { customer: true },
  });
}

export async function clearPendingConfirmation(conversationId: string) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingConfirmationMessageId: null, pendingOrderSummary: null, pendingOrderItems: Prisma.JsonNull },
  });
}

export async function createPendingOwnerQuestion(conversationId: string, wamid: string, question: string) {
  await prisma.pendingOwnerQuestion.create({
    data: { conversationId, wamid, question },
  });
}

export async function findConversationByPendingOwnerQuestion(wamid: string) {
  const pending = await prisma.pendingOwnerQuestion.findUnique({
    where: { wamid },
    include: { conversation: { include: { customer: true } } },
  });
  if (!pending) return null;
  return {
    questionId: pending.id,
    question: pending.question,
    conversationId: pending.conversationId,
    customer: pending.conversation.customer,
  };
}

export async function clearPendingOwnerQuestion(questionId: string) {
  await prisma.pendingOwnerQuestion.delete({ where: { id: questionId } });
}

// Used when the owner replies WITHOUT quoting a specific message (common on mobile, where long-pressing
// to reply is easy to skip) - lets the webhook auto-resolve the reply only when there's exactly one
// thing open for that business, instead of always demanding a quote even when there's nothing to
// disambiguate.
export async function findOpenPendingOwnerQuestionsForBusiness(businessId: string) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: { conversation: { customer: { businessId } } },
    include: { conversation: { include: { customer: true } } },
    orderBy: { createdAt: "desc" },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

export async function findOpenPendingConfirmationsForBusiness(businessId: string) {
  return prisma.conversation.findMany({
    where: { customer: { businessId }, pendingConfirmationMessageId: { not: null } },
    include: { customer: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function findConversationsDueForFollowUp(businessId: string, olderThan: Date) {
  return prisma.conversation.findMany({
    where: {
      customer: { businessId },
      status: "SOLD",
      followUpSentAt: null,
      updatedAt: { lte: olderThan },
    },
    include: { customer: true },
  });
}

export async function markFollowUpSent(conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { followUpSentAt: new Date() },
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
    intent: c.intent,
    humanControl: c.humanControl,
    updatedAt: c.updatedAt,
    customer: { id: c.customer.id, phoneNumber: c.customer.phoneNumber, name: c.customer.name, tags: c.customer.tags },
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
    intent: conversation.intent,
    humanControl: conversation.humanControl,
    updatedAt: conversation.updatedAt,
    customer: {
      id: conversation.customer.id,
      phoneNumber: conversation.customer.phoneNumber,
      name: conversation.customer.name,
      tags: conversation.customer.tags,
    },
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
