import { Router } from "express";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { sendTextMessage, sendImageMessage, sendOwnerAlert, downloadMedia, formatForWhatsapp, type WhatsappCredentials } from "../whatsapp/client";
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
import { generateReply, buildOrderClosedMessage } from "../ai/agent";
import { analyzeCustomerImage } from "../ai/vision";
import { transcribeAudio } from "../ai/transcription";
import { checkPlanCap } from "../ai/usage";
import { createOrder, askForCsat, recordCsatReply, type ResolvedOrderItem } from "../orders/service";
import { recordAskOwnerResolution } from "../catalog/learnedFaq";
import { getCatalogHintText, findConfidentProductMatch } from "../catalog/products";
import { recordDeliveryFailure } from "../delivery/failures";
import { recordOwnerMessage, trackOwnerSend } from "../delivery/ownerLog";
import { extractFrame } from "../media/videoFrame";

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
      const noQuoteText = `No identifique a que mensaje te refieres.${hint} Por favor responde citando (mantén presionado y "Responder") el mensaje especifico.`;
      await trackOwnerSend(businessId, noQuoteText, () => sendTextMessage(credentials, ownerPhone, noQuoteText));
      return;
    }
  }

  if (pendingQuestion) {
    const answerText = message.type === "text" ? (message.text?.body ?? "").trim() : "";
    if (!answerText) {
      const askTextText = "Respondeme con un mensaje de texto, citando esa misma pregunta, por favor.";
      await trackOwnerSend(businessId, askTextText, () => sendTextMessage(credentials, ownerPhone, askTextText));
      return;
    }

    // PHOTO_PRODUCT (from ask_owner_about_photo, src/ai/tools.ts): the owner is naming a product from a
    // photo we couldn't identify, not answering a free-text question - try to resolve it to a real
    // catalog product so the customer gets the actual name/price/photo back, instead of just the owner's
    // raw words. Falls back to forwarding the raw text (still prefixed) when it doesn't match anything.
    if (pendingQuestion.kind === "PHOTO_PRODUCT") {
      const match = await findConfidentProductMatch(businessId, answerText);
      if (match.product) {
        const price = `$${match.product.price.toString()} ${match.product.currency}`;
        const productText = formatForWhatsapp(`Según nuestro equipo, el producto que buscas es: *${match.product.name}* - ${price}`);
        await sendTextMessage(credentials, pendingQuestion.customer.phoneNumber, productText);
        await recordMessage(businessId, pendingQuestion.conversationId, "ASSISTANT", productText);
        if (match.product.media.length > 0) {
          try {
            await sendImageMessage(credentials, pendingQuestion.customer.phoneNumber, match.product.media[0].url);
          } catch (error) {
            console.error("No se pudo enviar la foto del producto identificado al cliente:", error);
          }
        }
      } else {
        const fallbackText = formatForWhatsapp(`Según nuestro equipo: ${answerText}`);
        await sendTextMessage(credentials, pendingQuestion.customer.phoneNumber, fallbackText);
        await recordMessage(businessId, pendingQuestion.conversationId, "ASSISTANT", fallbackText);
      }
      await clearPendingOwnerQuestion(pendingQuestion.questionId);
      await setHumanControl(businessId, pendingQuestion.conversationId, false);
      const confirmedProductText = "Listo, le confirme el producto al cliente ✅";
      await trackOwnerSend(businessId, confirmedProductText, () => sendTextMessage(credentials, ownerPhone, confirmedProductText));
      return;
    }

    const formattedAnswer = formatForWhatsapp(answerText);
    await sendTextMessage(credentials, pendingQuestion.customer.phoneNumber, formattedAnswer);
    await recordMessage(businessId, pendingQuestion.conversationId, "ASSISTANT", formattedAnswer);
    await clearPendingOwnerQuestion(pendingQuestion.questionId);
    await setHumanControl(businessId, pendingQuestion.conversationId, false);
    // The owner just answered a real customer question for the first time - surface it as a suggested
    // FAQ entry instead of discarding it after this one use (never auto-published, just queued for
    // review in the admin panel).
    await recordAskOwnerResolution(businessId, pendingQuestion.question, answerText, pendingQuestion.conversationId);
    const forwardedText = "Listo, le reenvie tu respuesta al cliente ✅";
    await trackOwnerSend(businessId, forwardedText, () => sendTextMessage(credentials, ownerPhone, forwardedText));
    return;
  }

  if (!conversation) {
    const expiredText = "Ese mensaje ya no esta esperando respuesta (puede que ya se haya resuelto o haya expirado).";
    await trackOwnerSend(businessId, expiredText, () => sendTextMessage(credentials, ownerPhone, expiredText));
    return;
  }

  const answer =
    message.type === "interactive"
      ? (message.interactive?.button_reply?.id ?? "")
      : (message.text?.body ?? "").trim().toLowerCase();
  const isConfirm = CONFIRM_WORDS.includes(answer);
  const isDeny = DENY_WORDS.includes(answer);

  if (!isConfirm && !isDeny) {
    const clarifyText = 'Respondeme "si" o "no" citando ese mismo mensaje, por favor.';
    await trackOwnerSend(businessId, clarifyText, () => sendTextMessage(credentials, ownerPhone, clarifyText));
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
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { botTone: true, assistantName: true },
    });
    const customerText = buildOrderClosedMessage(business ?? {});
    await sendTextMessage(credentials, customerPhone, customerText);
    await recordMessage(businessId, conversation.id, "ASSISTANT", customerText);
    await askForCsat(credentials, order.id, customerPhone);
    const confirmedSaleText = "Listo, le avise al cliente ✅";
    await trackOwnerSend(businessId, confirmedSaleText, () => sendTextMessage(credentials, ownerPhone, confirmedSaleText));
  } else {
    await clearPendingConfirmation(conversation.id);
    const customerText =
      "No logramos confirmar tu pago todavia. ¿Puedes reenviar una foto mas clara del comprobante o confirmar el monto por texto?";
    await sendTextMessage(credentials, customerPhone, customerText);
    await recordMessage(businessId, conversation.id, "ASSISTANT", customerText);
    const deniedSaleText = "Listo, le pedi al cliente que reenvie el comprobante.";
    await trackOwnerSend(businessId, deniedSaleText, () => sendTextMessage(credentials, ownerPhone, deniedSaleText));
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
        // Meta reports this asynchronously, after the original send call already returned a wamid that
        // looked successful - previously this only reached a pm2 log nobody watches. Persist it so the
        // admin panel can surface it live instead (see src/delivery/failures.ts).
        const failedForBusiness = incomingPhoneNumberId
          ? await prisma.business.findUnique({ where: { whatsappPhoneNumberId: incomingPhoneNumberId } })
          : null;
        if (failedForBusiness) {
          const recipient: string = status.recipient_id ?? "";
          const onlyDigits = (phone: string) => phone.replace(/\D/g, "");
          const critical = Boolean(failedForBusiness.contactPhone) && onlyDigits(recipient) === onlyDigits(failedForBusiness.contactPhone!);
          const firstError = status.errors?.[0];
          await recordDeliveryFailure(failedForBusiness.id, {
            wamid: status.id ?? "",
            recipientPhone: recipient,
            errorCode: firstError?.code ?? null,
            errorMessage: firstError?.title ? `${firstError.title}: ${firstError?.error_data?.details ?? firstError.message ?? ""}` : "Error desconocido",
            critical,
          });
        }
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
    const SUPPORTED_MESSAGE_TYPES = new Set(["text", "image", "video", "audio", "interactive", "location", "sticker", "document", "contacts"]);
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
      const ownerIncomingBody =
        message.type === "interactive"
          ? (message.interactive?.button_reply?.title ?? message.interactive?.button_reply?.id ?? `[${message.type}]`)
          : message.type === "text"
            ? (message.text?.body ?? "")
            : `[${message.type}]`;
      await recordOwnerMessage(business.id, { direction: "IN", body: ownerIncomingBody });
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
    let media: { s3Key: string; type: "IMAGE" | "VIDEO" | "AUDIO" } | undefined;
    let imageAnalysis: string | undefined;

    if (message.type === "text") {
      text = message.text.body;
    } else if (message.type === "image") {
      try {
        const { buffer, mimeType } = await downloadMedia(credentials, message.image.id);
        const { key, url } = await uploadMedia(buffer, mimeType, "receipts");
        media = { s3Key: key, type: "IMAGE" };
        text = message.image.caption ?? "";
        const catalogHint = await getCatalogHintText(business.id);
        imageAnalysis = await analyzeCustomerImage(business.id, conversation.id, url, text, catalogHint);
      } catch (error) {
        console.error("No se pudo procesar la imagen entrante:", error);
        text = "[El cliente envio una imagen, pero hubo un problema tecnico y no se pudo procesar. Pedile que la reenvie.]";
      }
    } else if (message.type === "video") {
      try {
        const { buffer, mimeType } = await downloadMedia(credentials, message.video.id);
        const { key } = await uploadMedia(buffer, mimeType, "videos");
        media = { s3Key: key, type: "VIDEO" };
        text = message.video.caption ?? "";
        const frame = await extractFrame(buffer);
        const { url: frameUrl } = await uploadMedia(frame, "image/jpeg", "receipts");
        const catalogHint = await getCatalogHintText(business.id);
        imageAnalysis = await analyzeCustomerImage(business.id, conversation.id, frameUrl, text, catalogHint);
      } catch (error) {
        console.error("No se pudo procesar el video entrante:", error);
        text = "[El cliente envio un video, pero hubo un problema tecnico y no se pudo analizar. Pedile que mande una foto del producto en vez de video.]";
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
      // Silence with zero acknowledgment reads as the bot being broken to the customer, and the owner
      // ends up having to jump in just to say "we got your message". Send one heads-up per pause period
      // (checked against the last ASSISTANT message so it doesn't repeat on every follow-up message from
      // the same customer while still paused), then stay quiet until the owner/admin actually resumes it.
      const HUMAN_CONTROL_ACK = "Ya te leimos, en un momento te contesta el equipo directamente 🙏";
      const lastAssistantMessage = await prisma.message.findFirst({
        where: { conversationId: conversation.id, role: "ASSISTANT" },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      });
      if (lastAssistantMessage?.content !== HUMAN_CONTROL_ACK) {
        try {
          const wamid = await sendTextMessage(credentials, from, HUMAN_CONTROL_ACK);
          await recordMessage(business.id, conversation.id, "ASSISTANT", HUMAN_CONTROL_ACK, wamid || undefined);
        } catch (error) {
          console.error("No se pudo mandar el acuse de recibo durante control humano:", error);
        }
      }
      return;
    }

    // An image/video message is very likely a payment receipt (or product photo mid-close) for a
    // purchase already in progress - cutting the customer off here mid-close is worse than letting
    // one extra message through, so the cap only gates plain text/audio turns.
    const capStatus =
      message.type === "image" || message.type === "video"
        ? { capped: false as const, justCrossed: false, messageCap: null, planTier: business.planTier }
        : await checkPlanCap(business.id);
    if (capStatus.capped) {
      const capText =
        "Por ahora alcanzamos el límite de mensajes de este mes para este negocio. Un asesor te va a contactar en breve para ayudarte manualmente. ¡Gracias por tu paciencia! 🙏";
      await sendTextMessage(credentials, from, capText);
      await recordMessage(business.id, conversation.id, "ASSISTANT", capText);

      if (capStatus.justCrossed && business.contactPhone) {
        const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
        const capAlertText = `${greeting}, tu negocio alcanzó el límite de ${capStatus.messageCap} mensajes de tu plan ${capStatus.planTier} este mes. El bot dejó de responder automáticamente hasta el próximo mes - escribime si querés subir de plan.`;
        await trackOwnerSend(business.id, capAlertText, () => sendOwnerAlert(credentials, business.contactPhone!, capAlertText));
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
