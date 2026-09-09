import { Router } from "express";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { sendTextMessage, downloadMedia, type WhatsappCredentials } from "../whatsapp/client";
import { uploadMedia } from "../media/s3";
import {
  getOrCreateCustomer,
  getOrCreateOpenConversation,
  recordMessage,
  findConversationByPendingConfirmation,
  clearPendingConfirmation,
  findConversationByPendingOwnerQuestion,
  clearPendingOwnerQuestion,
  setHumanControl,
  updateConversationStatus,
} from "../conversation/service";
import { generateReply } from "../ai/agent";
import { analyzeReceiptImage } from "../ai/vision";
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

async function handleOwnerReply(
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
  if (!quotedId) {
    await sendTextMessage(
      credentials,
      ownerPhone,
      'No identifique a que mensaje te refieres. Por favor responde citando (mantén presionado y "Responder") el mensaje especifico.'
    );
    return;
  }

  const pendingQuestion = await findConversationByPendingOwnerQuestion(quotedId);
  if (pendingQuestion) {
    const answerText = message.type === "text" ? (message.text?.body ?? "").trim() : "";
    if (!answerText) {
      await sendTextMessage(credentials, ownerPhone, "Respondeme con un mensaje de texto, citando esa misma pregunta, por favor.");
      return;
    }
    await sendTextMessage(credentials, pendingQuestion.customer.phoneNumber, answerText);
    await recordMessage(pendingQuestion.id, "ASSISTANT", answerText);
    await clearPendingOwnerQuestion(pendingQuestion.id);
    await setHumanControl(businessId, pendingQuestion.id, false);
    await sendTextMessage(credentials, ownerPhone, "Listo, le reenvie tu respuesta al cliente ✅");
    return;
  }

  const conversation = await findConversationByPendingConfirmation(quotedId);
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
    } | null;
    const order = await createOrder({
      businessId,
      customerId: conversation.customer.id,
      conversationId: conversation.id,
      summary: conversation.pendingOrderSummary ?? "",
      items: draft?.items ?? [],
      shippingAddress: draft?.shippingAddress ?? null,
      paymentMethodLabel: draft?.paymentMethodLabel ?? null,
    });
    await updateConversationStatus(conversation.id, "SOLD");
    await clearPendingConfirmation(conversation.id);
    const customerText = "¡Listo! Tu pago quedo confirmado y tu pedido esta cerrado. Gracias por tu compra 🎉";
    await sendTextMessage(credentials, customerPhone, customerText);
    await recordMessage(conversation.id, "ASSISTANT", customerText);
    await askForCsat(credentials, order.id, customerPhone);
    await sendTextMessage(credentials, ownerPhone, "Listo, le avise al cliente ✅");
  } else {
    await clearPendingConfirmation(conversation.id);
    const customerText =
      "No logramos confirmar tu pago todavia. ¿Puedes reenviar una foto mas clara del comprobante o confirmar el monto por texto?";
    await sendTextMessage(credentials, customerPhone, customerText);
    await recordMessage(conversation.id, "ASSISTANT", customerText);
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

    if (!message || !incomingPhoneNumberId) return;
    if (message.type !== "text" && message.type !== "image" && message.type !== "audio" && message.type !== "interactive") return;

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
    const conversation = await getOrCreateOpenConversation(customer.id);

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
        imageAnalysis = await analyzeReceiptImage(business.id, conversation.id, url, text);
      } catch (error) {
        console.error("No se pudo procesar la imagen entrante:", error);
        text = "[El cliente envio una imagen, pero hubo un problema tecnico y no se pudo procesar. Pedile que la reenvie.]";
      }
    } else {
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
    }

    try {
      await recordMessage(conversation.id, "CUSTOMER", text, whatsappMessageId, media, imageAnalysis);
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

    const capStatus = await checkPlanCap(business.id);
    if (capStatus.capped) {
      const capText =
        "Por ahora alcanzamos el límite de mensajes de este mes para este negocio. Un asesor te va a contactar en breve para ayudarte manualmente. ¡Gracias por tu paciencia! 🙏";
      await sendTextMessage(credentials, from, capText);
      await recordMessage(conversation.id, "ASSISTANT", capText);

      if (capStatus.justCrossed && business.contactPhone) {
        const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
        await sendTextMessage(
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
      }
    );
    await sendTextMessage(credentials, from, reply);
    await recordMessage(conversation.id, "ASSISTANT", reply);
  } catch (error) {
    console.error("Error handling WhatsApp webhook:", error);
  }
});
