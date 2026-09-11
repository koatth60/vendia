import { Router } from "express";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { sendTextMessage, sendOwnerAlert, downloadMedia, formatForWhatsapp, type WhatsappCredentials } from "../whatsapp/client";
import { uploadMedia } from "../media/s3";
import {
  getOrCreateCustomer,
  getOrCreateOpenConversation,
  recordMessage,
  findConversationByPendingConfirmation,
  clearPendingConfirmation,
  findConversationByPendingOwnerQuestion,
  clearPendingOwnerQuestion,
  findOpenPendingOwnerQuestionsForBusiness,
  findOpenPendingConfirmationsForBusiness,
  setHumanControl,
  updateConversationStatus,
  getRelatedProductNameForMessage,
} from "../conversation/service";
import { generateReply } from "../ai/agent";
import { analyzeCustomerImage } from "../ai/vision";
import { transcribeAudio } from "../ai/transcription";
import { checkPlanCap } from "../ai/usage";
import { createOrder, askForCsat, recordCsatReply, type ResolvedOrderItem } from "../orders/service";

export const whatsappRouter = Router();

const CONFIRM_WORDS = ["si", "sí", "confirmado", "confirmo", "listo", "ok", "dale", "correcto", "confirm_yes"];
const DENY_WORDS = ["no", "confirm_no"];

interface OwnerReplyMessage {
  type: string;
  context?: { id?: string };
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
}

export async function handleOwnerReply(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string,
  message: OwnerReplyMessage
) {
  if (message.type !== "text" && message.type !== "interactive") {
    console.log("Mensaje del dueno ignorado (tipo no soportado para confirmaciones):", message.type);
    return;
  }

  const quotedId = message.context?.id;
  let pendingQuestion = quotedId ? await findConversationByPendingOwnerQuestion(quotedId) : null;
  let conversation = quotedId ? await findConversationByPendingConfirmation(quotedId) : null;

  // Owner replied without long-pressing to quote a specific message (common on mobile) - only
  // auto-resolve when there's exactly ONE thing open for this business. With two or more, we still
  // need the quote to know which one they mean, otherwise a reply meant for one customer could get
  // forwarded to a different one.
  if (!quotedId) {
    const [openQuestions, openConfirmations] = await Promise.all([
      findOpenPendingOwnerQuestionsForBusiness(businessId),
      findOpenPendingConfirmationsForBusiness(businessId),
    ]);
    const totalOpen = openQuestions.length + openConfirmations.length;
    if (totalOpen === 1) {
      if (openQuestions.length === 1) {
        pendingQuestion = openQuestions[0];
      } else {
        conversation = openConfirmations[0];
      }
    } else {
      const hint =
        totalOpen > 1
          ? ` Tenes ${totalOpen} cosas esperando respuesta ahora mismo, necesito saber a cual te referis.`
          : "";
      await sendTextMessage(
        credentials,
        ownerPhone,
        `No identifique a que mensaje te refieres.${hint} Por favor responde citando (mantén presionado y "Responder") el mensaje especifico.`
      );
      return;
    }
  }

  if (pendingQuestion) {
    const answerText = message.type === "text" ? (message.text?.body ?? "").trim() : "";
    if (!answerText) {
      await sendTextMessage(credentials, ownerPhone, "Respondeme con un mensaje de texto, citando esa misma pregunta, por favor.");
      return;
    }
    const formattedAnswer = formatForWhatsapp(answerText);
    await sendTextMessage(credentials, pendingQuestion.customer.phoneNumber, formattedAnswer);
    await recordMessage(businessId, pendingQuestion.conversationId, "ASSISTANT", formattedAnswer);
    await clearPendingOwnerQuestion(pendingQuestion.questionId);
    await setHumanControl(businessId, pendingQuestion.conversationId, false);
    await sendTextMessage(credentials, ownerPhone, "Listo, le reenvie tu respuesta al cliente ✅");
    return;
  }

  if (!conversation) {
    await sendTextMessage(
      credentials,
      ownerPhone,
      "Ese mensaje ya no esta esperando respuesta (puede que ya se haya resuelto o haya expirado)."
    );
    return;
  }

  const answer =
    message.type === "interactive"
      ? (message.interactive?.button_reply?.id ?? "")
      : (message.text?.body ?? "").trim().toLowerCase();
  const isConfirm = CONFIRM_WORDS.includes(answer);
  const isDeny = DENY_WORDS.includes(answer);

  if (!isConfirm && !isDeny) {
    await sendTextMessage(credentials, ownerPhone, 'Respondeme "si" o "no" citando ese mismo mensaje, por favor.');
    return;
  }

  const customerPhone = conversation.customer.phoneNumber;

  if (isConfirm) {
    const draft = conversation.pendingOrderItems as {
      items?: ResolvedOrderItem[];
      shippingAddress?: string | null;
      paymentMethodLabel?: string | null;
      shippingCost?: number | null;
    } | null;
    const order = await createOrder({
      businessId,
      customerId: conversation.customer.id,
      conversationId: conversation.id,
      summary: conversation.pendingOrderSummary ?? "",
      items: draft?.items ?? [],
      shippingAddress: draft?.shippingAddress ?? null,
      paymentMethodLabel: draft?.paymentMethodLabel ?? null,
      shippingCost: draft?.shippingCost ?? null,
    });
    await updateConversationStatus(businessId, conversation.id, "SOLD");
    await clearPendingConfirmation(conversation.id);
    const customerText = "¡Listo! Tu pago quedo confirmado y tu pedido esta cerrado. Gracias por tu compra 🎉";
    await sendTextMessage(credentials, customerPhone, customerText);
    await recordMessage(businessId, conversation.id, "ASSISTANT", customerText);
    await askForCsat(credentials, order.id, customerPhone);
    await sendTextMessage(credentials, ownerPhone, "Listo, le avise al cliente ✅");
  } else {
    await clearPendingConfirmation(conversation.id);
    const customerText =
      "No logramos confirmar tu pago todavia. ¿Puedes reenviar una foto mas clara del comprobante o confirmar el monto por texto?";
    await sendTextMessage(credentials, customerPhone, customerText);
    await recordMessage(businessId, conversation.id, "ASSISTANT", customerText);
    await sendTextMessage(credentials, ownerPhone, "Listo, le pedi al cliente que reenvie el comprobante.");
  }
}

whatsappRouter.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.whatsapp.verifyToken) {
    res.status(200).send(challenge);
    return;
  }

  res.sendStatus(403);
});

whatsappRouter.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const incomingPhoneNumberId: string | undefined = value?.metadata?.phone_number_id;

    // Meta sends delivery receipts (sent/delivered/read/failed) as `statuses`, not `messages` - these
    // were previously silently dropped, so a media message that Meta accepted but failed to actually
    // deliver (can't fetch the URL, unsupported format, etc.) left zero trace anywhere in our logs.
    const status = value?.statuses?.[0];
    if (status && !message) {
      if (status.status === "failed") {
        console.error("WhatsApp delivery FAILED:", JSON.stringify({ id: status.id, recipient: status.recipient_id, errors: status.errors }));
      } else {
        console.log("WhatsApp status:", status.status, status.id, status.recipient_id);
      }
      return;
    }

    if (!message || !incomingPhoneNumberId) return;
    // "reaction" (emoji reacting to a prior message) is intentionally excluded - replying to a 👍 with
    // bot chatter is noise, not a real customer turn. Every other content type below used to fall
    // through this same filter and get silently dropped with zero trace (no reply, nothing recorded) -
    // a customer sharing a location (delivery address), sticker, document (receipt as PDF), or contact
    // card just got no response at all.
    const SUPPORTED_MESSAGE_TYPES = new Set(["text", "image", "audio", "interactive", "location", "sticker", "document", "contacts"]);
    if (!SUPPORTED_MESSAGE_TYPES.has(message.type)) return;

    const business = await prisma.business.findUnique({
      where: { whatsappPhoneNumberId: incomingPhoneNumberId },
    });

    if (!business || !business.whatsappAccessToken || !business.active) {
      console.log("Mensaje recibido para un numero sin negocio asignado:", incomingPhoneNumberId);
      return;
    }

    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId!,
      accessToken: business.whatsappAccessToken,
    };

    const from: string | undefined = message.from ?? message.from_user_id;
    const whatsappMessageId: string | undefined = message.id;

    if (!from) {
      console.log("Mensaje sin remitente (from) valido, ignorado:", JSON.stringify(message));
      return;
    }

    const onlyDigits = (phone: string) => phone.replace(/\D/g, "");
    if (business.contactPhone && onlyDigits(from) === onlyDigits(business.contactPhone)) {
      await handleOwnerReply(business.id, credentials, from, message);
      return;
    }

    if (message.type === "interactive") {
      const buttonId: string | undefined = message.interactive?.button_reply?.id;
      if (buttonId?.startsWith("csat_")) {
        const result = await recordCsatReply(business.id, from, buttonId);
        if (result.recorded) {
          await sendTextMessage(credentials, from, "¡Gracias por tu opinión! 🙏");
        }
      }
      return;
    }

    const customer = await getOrCreateCustomer(business.id, from);
    const conversation = await getOrCreateOpenConversation(business.id, customer.id);

    let text = "";
    let media: { s3Key: string; type: "IMAGE" | "AUDIO" } | undefined;
    let imageAnalysis: string | undefined;

    if (message.type === "text") {
      text = message.text.body;
    } else if (message.type === "image") {
      try {
        const { buffer, mimeType } = await downloadMedia(credentials, message.image.id);
        const { key, url } = await uploadMedia(buffer, mimeType, "receipts");
        media = { s3Key: key, type: "IMAGE" };
        text = message.image.caption ?? "";
        imageAnalysis = await analyzeCustomerImage(business.id, conversation.id, url, text);
      } catch (error) {
        console.error("No se pudo procesar la imagen entrante:", error);
        text = "[El cliente envio una imagen, pero hubo un problema tecnico y no se pudo procesar. Pedile que la reenvie.]";
      }
    } else if (message.type === "audio") {
      try {
        const { buffer, mimeType } = await downloadMedia(credentials, message.audio.id);
        const { key } = await uploadMedia(buffer, mimeType, "audio");
        media = { s3Key: key, type: "AUDIO" };
        const transcript = await transcribeAudio(buffer, mimeType);
        text = transcript || "[El cliente envio una nota de voz, pero no se pudo transcribir. Pedile que la repita por texto.]";
      } catch (error) {
        console.error("No se pudo procesar el audio entrante:", error);
        text = "[El cliente envio una nota de voz, pero hubo un problema tecnico y no se pudo procesar. Pedile que la reenvie o escriba el mensaje.]";
      }
    } else if (message.type === "location") {
      const loc = message.location ?? {};
      const parts = [loc.name, loc.address].filter(Boolean).join(", ");
      const coords = loc.latitude != null && loc.longitude != null ? `lat ${loc.latitude}, lng ${loc.longitude}` : "";
      text = `[El cliente comparte su ubicacion por WhatsApp${parts ? `: ${parts}` : ""}${coords ? ` (${coords})` : ""}. Si es para la direccion de envio, confirmale la direccion exacta en texto (barrio/calle/numero) antes de cerrar el pedido - una ubicacion de mapa sola no siempre alcanza para el mensajero.]`;
    } else if (message.type === "sticker") {
      text = "[El cliente envio un sticker, sin texto.]";
    } else if (message.type === "document") {
      const filename = message.document?.filename ?? "sin nombre";
      text = `[El cliente envio un documento/archivo (${filename}), no una foto. Si esperabas un comprobante de pago, pedile que lo reenvie como foto/imagen para poder revisarlo.]`;
    } else if (message.type === "contacts") {
      text = "[El cliente compartio una tarjeta de contacto de WhatsApp.]";
    }

    // If the customer replied/quoted a specific WhatsApp message (long-press "Reply"), and that message
    // was a product photo/video we sent, tell the model directly which product it was - otherwise it has
    // to guess or ask "¿cual de los dos?" since WhatsApp doesn't show us the quoted image, only its id.
    // Keep the raw customer text separate from the marker-prefixed version: the marker itself contains
    // the words "foto"/"video" and the product's full name, which would otherwise false-trigger the
    // photo-resend safety net in generateReply (it would think the customer just asked for that photo).
    const rawText = text;
    const quotedMessageId: string | undefined = message.context?.id;
    if (quotedMessageId) {
      const relatedProductName = await getRelatedProductNameForMessage(quotedMessageId);
      if (relatedProductName) {
        text = `[El cliente esta respondiendo a la foto/video de: ${relatedProductName}] ${text}`;
      }
    }

    try {
      await recordMessage(business.id, conversation.id, "CUSTOMER", text, whatsappMessageId, media, imageAnalysis);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        console.log("Mensaje duplicado de WhatsApp ignorado:", whatsappMessageId);
        return;
      }
      throw error;
    }

    if (conversation.humanControl) {
      console.log("Conversacion en control humano, el bot no responde:", conversation.id);
      return;
    }

    // An image message is very likely a payment receipt for a purchase already in progress - cutting
    // the customer off here mid-close (right when they send proof of a payment already made) is worse
    // than letting one extra message through, so the cap only gates plain text/audio turns.
    const capStatus =
      message.type === "image"
        ? { capped: false as const, justCrossed: false, messageCap: null, planTier: business.planTier }
        : await checkPlanCap(business.id);
    if (capStatus.capped) {
      const capText =
        "Por ahora alcanzamos el límite de mensajes de este mes para este negocio. Un asesor te va a contactar en breve para ayudarte manualmente. ¡Gracias por tu paciencia! 🙏";
      await sendTextMessage(credentials, from, capText);
      await recordMessage(business.id, conversation.id, "ASSISTANT", capText);

      if (capStatus.justCrossed && business.contactPhone) {
        const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
        await sendOwnerAlert(
          credentials,
          business.contactPhone,
          `${greeting}, tu negocio alcanzó el límite de ${capStatus.messageCap} mensajes de tu plan ${capStatus.planTier} este mes. El bot dejó de responder automáticamente hasta el próximo mes - escribime si querés subir de plan.`
        );
      }
      return;
    }

    const reply = await generateReply(
      conversation.id,
      {
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        credentials,
        recipientPhone: from,
      },
      {
        assistantName: business.assistantName,
        tone: business.botTone,
        dialect: business.botDialect,
        greeting: business.botGreeting,
        neverSay: business.botNeverSay,
        customInstructions: business.customInstructions,
        autoSendPhotoOnQuote: business.autoSendPhotoOnQuote,
        requirePaymentProof: business.requirePaymentProof,
        category: business.businessCategory,
      },
      rawText
    );
    const formattedReply = formatForWhatsapp(reply);
    await sendTextMessage(credentials, from, formattedReply);
    await recordMessage(business.id, conversation.id, "ASSISTANT", formattedReply);
  } catch (error) {
    console.error("Error handling WhatsApp webhook:", error);
  }
});
