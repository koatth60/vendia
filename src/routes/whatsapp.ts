import { Router } from "express";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { sendTextMessage } from "../whatsapp/client";
import {
  getOrCreateCustomer,
  getOrCreateOpenConversation,
  recordMessage,
} from "../conversation/service";
import { generateReply } from "../ai/agent";
import { getQuickReply } from "../ai/quickReplies";

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

    if (!message || message.type !== "text" || !incomingPhoneNumberId) return;

    const business = await prisma.business.findUnique({
      where: { whatsappPhoneNumberId: incomingPhoneNumberId },
    });

    if (!business || !business.whatsappAccessToken || !business.active) {
      console.log("Mensaje recibido para un numero sin negocio asignado:", incomingPhoneNumberId);
      return;
    }

    const credentials = {
      phoneNumberId: business.whatsappPhoneNumberId!,
      accessToken: business.whatsappAccessToken,
    };

    const from: string = message.from;
    const text: string = message.text.body;
    const whatsappMessageId: string | undefined = message.id;

    const customer = await getOrCreateCustomer(business.id, from);
    const conversation = await getOrCreateOpenConversation(customer.id);

    try {
      await recordMessage(conversation.id, "CUSTOMER", text, whatsappMessageId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        console.log("Mensaje duplicado de WhatsApp ignorado:", whatsappMessageId);
        return;
      }
      throw error;
    }

    const reply =
      getQuickReply(text) ??
      (await generateReply(
        conversation.id,
        { businessId: business.id, conversationId: conversation.id, credentials, recipientPhone: from },
        business.customInstructions
      ));
    await sendTextMessage(credentials, from, reply);
    await recordMessage(conversation.id, "ASSISTANT", reply);
  } catch (error) {
    console.error("Error handling WhatsApp webhook:", error);
  }
});
