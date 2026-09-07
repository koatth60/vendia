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
  updateConversationStatus,
} from "../conversation/service";
import { generateReply } from "../ai/agent";
import { analyzeReceiptImage } from "../ai/vision";

export const whatsappRouter = Router();

const CONFIRM_WORDS = ["si", "sí", "confirmado", "confirmo", "listo", "ok", "dale", "correcto", "confirm_yes"];
const DENY_WORDS = ["no", "confirm_no"];

interface OwnerReplyMessage {
  type: string;
  context?: { id?: string };
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
}

async function handleOwnerReply(credentials: WhatsappCredentials, ownerPhone: string, message: OwnerReplyMessage) {
  if (message.type !== "text" && message.type !== "interactive") {
    console.log("Mensaje del dueno ignorado (tipo no soportado para confirmaciones):", message.type);
    return;
  }

  const quotedId = message.context?.id;
  if (!quotedId) {
    await sendTextMessage(
      credentials,
      ownerPhone,
      'No identifique a que pedido te refieres. Por favor responde citando (mantén presionado y "Responder") el mensaje del pedido especifico.'
    );
    return;
  }

  const conversation = await findConversationByPendingConfirmation(quotedId);
  if (!conversation) {
    await sendTextMessage(
      credentials,
      ownerPhone,
      "Ese pedido ya no esta esperando confirmacion (puede que ya se haya resuelto o haya expirado)."
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
    await updateConversationStatus(conversation.id, "SOLD");
    await clearPendingConfirmation(conversation.id);
    const customerText = "¡Listo! Tu pago quedo confirmado y tu pedido esta cerrado. Gracias por tu compra 🎉";
    await sendTextMessage(credentials, customerPhone, customerText);
    await recordMessage(conversation.id, "ASSISTANT", customerText);
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
    if (message.type !== "text" && message.type !== "image" && message.type !== "interactive") return;

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

    const from: string = message.from;
    const whatsappMessageId: string | undefined = message.id;

    const onlyDigits = (phone: string) => phone.replace(/\D/g, "");
    if (business.contactPhone && onlyDigits(from) === onlyDigits(business.contactPhone)) {
      await handleOwnerReply(credentials, from, message);
      return;
    }

    if (message.type === "interactive") return;

    const customer = await getOrCreateCustomer(business.id, from);
    const conversation = await getOrCreateOpenConversation(customer.id);

    let text = "";
    let media: { s3Key: string; type: "IMAGE" } | undefined;
    let imageAnalysis: string | undefined;

    if (message.type === "text") {
      text = message.text.body;
    } else {
      try {
        const { buffer, mimeType } = await downloadMedia(credentials, message.image.id);
        const { key, url } = await uploadMedia(buffer, mimeType, "images");
        media = { s3Key: key, type: "IMAGE" };
        text = message.image.caption ?? "";
        imageAnalysis = await analyzeReceiptImage(business.id, conversation.id, url, text);
      } catch (error) {
        console.error("No se pudo procesar la imagen entrante:", error);
        text = "[El cliente envio una imagen, pero hubo un problema tecnico y no se pudo procesar. Pedile que la reenvie.]";
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

    const reply = await generateReply(
      conversation.id,
      {
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        credentials,
        recipientPhone: from,
      },
      business.customInstructions
    );
    await sendTextMessage(credentials, from, reply);
    await recordMessage(conversation.id, "ASSISTANT", reply);
  } catch (error) {
    console.error("Error handling WhatsApp webhook:", error);
  }
});
