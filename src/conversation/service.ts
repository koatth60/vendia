import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { getPresignedMediaUrl } from "../media/s3";
import { emitNewMessage, emitNewConversation, emitConversationUpdated, type ConversationRow } from "../realtime/events";

export async function getOrCreateCustomer(businessId: string, phoneNumber: string) {
  return prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId, phoneNumber } },
    update: {},
    create: { businessId, phoneNumber },
  });
}

export async function getOrCreateOpenConversation(businessId: string, customerId: string) {
  const existing = await prisma.conversation.findFirst({
    where: {
      customerId,
      status: { notIn: ["SOLD", "LOST"] },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) return existing;

  const conversation = await prisma.conversation.create({
    data: { customerId, status: "NEW" },
    include: { customer: true },
  });
  emitNewConversation(businessId, formatConversationRow(conversation));
  return conversation;
}

// "Previous conversation" for the continue-or-restart prompt some businesses' own scripts ask for (e.g.
// MAGByLizN's Etapa 1.3) = this customer's most recent CLOSED (SOLD/LOST) conversation, excluding
// whichever conversation is currently open. getOrCreateOpenConversation already guarantees the open one
// is never SOLD/LOST, so the status filter alone would already exclude it - the id exclusion is a
// harmless defensive belt-and-suspenders in case that invariant ever changes, not load-bearing today.
export async function getPreviousClosedConversation(businessId: string, customerId: string, excludeConversationId: string) {
  return prisma.conversation.findFirst({
    where: {
      customerId,
      customer: { businessId },
      id: { not: excludeConversationId },
      status: { in: ["SOLD", "LOST"] },
    },
    include: { order: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function recordMessage(
  businessId: string,
  conversationId: string,
  role: "CUSTOMER" | "ASSISTANT" | "SYSTEM",
  content: string,
  whatsappMessageId?: string,
  media?: { s3Key: string; type: "IMAGE" | "VIDEO" | "AUDIO" },
  imageAnalysis?: string,
  relatedProductId?: string
) {
  const message = await prisma.message.create({
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
  // A CUSTOMER message only counts as "unread" while the bot has stopped answering
  // (humanControl:true - escalated via flag_conversation_intent/ask_owner, or the owner took over
  // manually). While the bot is handling a conversation on its own, every customer message already
  // gets an automatic reply - counting those as needing the owner's attention would make the badge
  // climb on ordinary bot-handled traffic and drown out the conversations that actually need a human.
  const touched = await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
    select: { humanControl: true, unreadCount: true },
  });

  let unreadCount = touched.unreadCount;
  if (role === "CUSTOMER" && touched.humanControl) {
    const bumped = await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: { increment: 1 } },
      select: { unreadCount: true },
    });
    unreadCount = bumped.unreadCount;
  }

  emitNewMessage(
    businessId,
    conversationId,
    {
      id: message.id,
      role: message.role,
      content: message.content,
      mediaUrl: media ? await getPresignedMediaUrl(media.s3Key) : null,
      mediaType: message.mediaType,
      createdAt: message.createdAt,
    },
    unreadCount
  );
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
  businessId: string,
  conversationId: string,
  status: "NEW" | "INTERESTED" | "QUOTED" | "NEGOTIATING" | "SOLD" | "LOST"
) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
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
  businessId: string,
  conversationId: string,
  intent: "PQR" | "DEVOLUCION" | "NO_RECIBIDO" | "SOLICITA_AGENTE"
) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { intent },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

export async function setHumanControl(businessId: string, conversationId: string, active: boolean) {
  const existing = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
  });
  if (!existing) return null;
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    // Reset the one-time ack flag whenever a pause starts, so the next takeover gets its own single
    // heads-up instead of inheriting "already acked" from a previous pause period.
    data: { humanControl: active, humanControlAckSent: false },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
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

export async function createPendingOwnerQuestion(
  conversationId: string,
  wamid: string,
  question: string,
  kind: "TEXT" | "PHOTO_PRODUCT" = "TEXT"
) {
  await prisma.pendingOwnerQuestion.create({
    data: { conversationId, wamid, question, kind },
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
    kind: pending.kind,
    conversationId: pending.conversationId,
    customer: pending.conversation.customer,
  };
}

export async function clearPendingOwnerQuestion(questionId: string) {
  await prisma.pendingOwnerQuestion.delete({ where: { id: questionId } });
}

// Only the WhatsApp-reply path (quoting the alert, or the single-pending fallback) ever cleared a
// PendingOwnerQuestion - an owner who instead resolves it by typing directly into the admin panel's
// conversation view left the row open indefinitely, remindedAt still null. Harmless while the reminder
// job's own bug meant it almost never fired (see findPendingOwnerQuestionsDueForReminder) - once that got
// fixed (2026-09-12) this orphaned row was exactly what let a real, already-resolved conversation get a
// confusing "seguimos revisando" follow-up hours later. Called wherever the owner addresses a conversation
// through the admin panel instead of WhatsApp.
export async function clearPendingOwnerQuestionsForConversation(conversationId: string) {
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId } });
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
    kind: p.kind,
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

// Escalations the owner never answered - one reminder per question (remindedAt gates it so the
// reminder job doesn't re-send every tick), independent of the sale follow-up job above.
export async function findPendingOwnerQuestionsDueForReminder(businessId: string, olderThan: Date) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: {
      // Must still be an open conversation - a real orphaned row from a 2026-09-11 migration backfill
      // (see that migration's SQL) triggered a false reminder in production for a conversation that had
      // already closed a sale hours earlier, reminding about a question that isn't actually blocking
      // anything anymore. This used to be gated on humanControl:true instead, but that's wrong for the
      // majority of pending questions: plain ask_owner deliberately leaves humanControl false (the bot
      // keeps chatting about everything else while that one question is escalated, see tools.ts), so the
      // humanControl gate silently excluded almost every ask_owner reminder and only ever fired for
      // ask_owner_about_photo (the one case that does set humanControl). status is the real "still open"
      // signal regardless of which escalation path set it.
      conversation: { customer: { businessId }, status: { notIn: ["SOLD", "LOST"] } },
      remindedAt: null,
      createdAt: { lte: olderThan },
    },
    include: { conversation: { include: { customer: true } } },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    kind: p.kind,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

export async function markPendingOwnerQuestionReminded(questionId: string) {
  await prisma.pendingOwnerQuestion.update({
    where: { id: questionId },
    data: { remindedAt: new Date() },
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

// Shared row shape for the conversations sidebar - used both by the REST list endpoint and by the
// realtime conversation:new/conversation:updated emits, so the two never drift apart.
function formatConversationRow(c: {
  id: string;
  status: string;
  intent: string | null;
  humanControl: boolean;
  updatedAt: Date;
  unreadCount: number;
  customer: { id: string; phoneNumber: string; name: string | null; tags: string[] };
  messages?: { role: string; content: string; mediaType: string | null; createdAt: Date }[];
}): ConversationRow {
  const last = c.messages?.[0];
  return {
    id: c.id,
    status: c.status,
    intent: c.intent,
    humanControl: c.humanControl,
    updatedAt: c.updatedAt,
    unreadCount: c.unreadCount,
    customer: { id: c.customer.id, phoneNumber: c.customer.phoneNumber, name: c.customer.name, tags: c.customer.tags },
    lastMessage: last
      ? {
          role: last.role,
          content:
            last.mediaType === "IMAGE"
              ? last.content || "📷 Imagen"
              : last.mediaType === "VIDEO"
                ? last.content || "🎥 Video"
                : last.content,
          createdAt: last.createdAt,
        }
      : null,
  };
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

  return conversations.map(formatConversationRow);
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

  // Opening a conversation in the admin panel IS reading it - reset the unread badge here as a side
  // effect of the fetch, instead of a separate "mark as read" round trip the frontend would have to
  // remember to call. Emit so other open admin tabs/devices for this business see the badge clear too.
  if (conversation.unreadCount > 0) {
    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
      include: { customer: true },
    });
    emitConversationUpdated(businessId, formatConversationRow(updated));
    conversation.unreadCount = 0;
  }

  return {
    id: conversation.id,
    status: conversation.status,
    intent: conversation.intent,
    humanControl: conversation.humanControl,
    updatedAt: conversation.updatedAt,
    unreadCount: conversation.unreadCount,
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
