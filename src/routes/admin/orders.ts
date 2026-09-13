import { Router } from "express";
import { prisma } from "../../db/client";
import {
  listOrdersForBusiness,
  countOrdersByStatus,
  getOrderForBusiness,
  markOrderShipped,
  markOrderCanceled,
} from "../../orders/service";
import { recordMessage } from "../../conversation/service";
import {
  sendTextMessage,
  sendImageMessage,
  sendVideoMessage,
  formatForWhatsapp,
  type WhatsappCredentials,
} from "../../whatsapp/client";
import { uploadMedia } from "../../media/s3";
import { upload, businessIdOf, isUnsupportedImageType } from "./shared";

export const ordersRouter = Router();

const ORDER_STATUSES = ["PENDING", "SHIPPED", "CANCELED"] as const;

ordersRouter.get("/api/orders", async (req, res) => {
  const status = ORDER_STATUSES.includes(req.query.status as (typeof ORDER_STATUSES)[number])
    ? (req.query.status as (typeof ORDER_STATUSES)[number])
    : "PENDING";
  const skip = Math.max(Number(req.query.skip) || 0, 0);
  const take = Math.min(Math.max(Number(req.query.take) || 20, 1), 100);
  const result = await listOrdersForBusiness(businessIdOf(req), status, skip, take);
  res.json(result);
});

ordersRouter.get("/api/orders/counts", async (req, res) => {
  const counts = await countOrdersByStatus(businessIdOf(req));
  res.json(counts);
});

ordersRouter.put("/api/orders/:id/ship", upload.single("file"), async (req, res) => {
  const businessId = businessIdOf(req);
  const note = String(req.body?.note ?? "").trim();
  const file = req.file;

  if (file && isUnsupportedImageType(file.mimetype)) {
    res.status(400).json({ error: "Formato GIF no soportado todavía - usa JPG, PNG o video." });
    return;
  }

  const order = await getOrderForBusiness(businessId, String(req.params.id));
  if (!order) {
    res.status(404).json({ error: "Pedido no encontrado" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.whatsappPhoneNumberId || !business.whatsappAccessToken) {
    res.status(400).json({ error: "Este negocio no tiene WhatsApp conectado" });
    return;
  }
  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };

  const formattedNote = note ? formatForWhatsapp(note) : "";
  const defaultMessage = "¡Tu pedido fue enviado! 📦 Cualquier duda me escribes.";

  // The text notification is the real guarantee here, sent as its own message instead of bundled as a
  // media caption - WhatsApp accepts a media send request synchronously (giving a wamid) and only fails
  // it later, asynchronously, if the file itself is rejected (wrong format, download timeout, etc). With
  // a caption baked into that message, a media failure used to take the whole notification down with it
  // and the order still got marked "Enviado" as if the customer had heard nothing.
  const messageText = formattedNote || defaultMessage;
  const textWamid = await sendTextMessage(credentials, order.customer.phoneNumber, messageText);
  await recordMessage(businessId, order.conversationId, "ASSISTANT", messageText, textWamid || undefined);

  let mediaS3Key: string | null = null;
  let mediaType: string | null = null;
  let mediaError: string | null = null;

  if (file) {
    try {
      const type = file.mimetype.startsWith("video") ? "VIDEO" : "IMAGE";
      const folder = type === "VIDEO" ? "videos" : "images";
      const { key, url } = await uploadMedia(file.buffer, file.mimetype, folder);
      const wamid =
        type === "IMAGE"
          ? await sendImageMessage(credentials, order.customer.phoneNumber, url)
          : await sendVideoMessage(credentials, order.customer.phoneNumber, url);
      mediaS3Key = key;
      mediaType = type;
      await recordMessage(businessId, order.conversationId, "ASSISTANT", type === "IMAGE" ? "[Foto]" : "[Video]", wamid || undefined, {
        s3Key: key,
        type,
      });
    } catch (error) {
      mediaError = error instanceof Error ? error.message : "No se pudo enviar el archivo adjunto";
      console.error("Error enviando adjunto de envio de pedido:", error);
    }
  }

  await markOrderShipped(businessId, String(req.params.id), {
    note: formattedNote || null,
    mediaS3Key,
    mediaType,
  });
  res.json({ ok: true, mediaError });
});

ordersRouter.put("/api/orders/:id/cancel", async (req, res) => {
  const businessId = businessIdOf(req);
  const order = await getOrderForBusiness(businessId, String(req.params.id));
  if (!order) {
    res.status(404).json({ error: "Pedido no encontrado" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (business?.whatsappPhoneNumberId && business.whatsappAccessToken) {
    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId,
      accessToken: business.whatsappAccessToken,
    };
    const messageText = "Tu pedido fue cancelado. Cualquier duda me escribes.";
    try {
      const wamid = await sendTextMessage(credentials, order.customer.phoneNumber, messageText);
      await recordMessage(businessId, order.conversationId, "ASSISTANT", messageText, wamid || undefined);
    } catch (error) {
      console.error("No se pudo avisar al cliente de la cancelacion del pedido:", error);
    }
  }

  await markOrderCanceled(businessId, String(req.params.id));
  res.json({ ok: true });
});

