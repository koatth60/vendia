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
} from "../conversation/service";
import { generateReply } from "../ai/agent";
import { analyzeReceiptImage } from "../ai/vision";

export const whatsappRouter = Router();

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
    if (message.type !== "text" && message.type !== "image") return;

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

    const reply = await generateReply(
      conversation.id,
      { businessId: business.id, conversationId: conversation.id, credentials, recipientPhone: from },
      business.customInstructions
    );
    await sendTextMessage(credentials, from, reply);
    await recordMessage(conversation.id, "ASSISTANT", reply);
  } catch (error) {
    console.error("Error handling WhatsApp webhook:", error);
  }
});
