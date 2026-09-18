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
import { sendToCustomer, formatForWhatsapp, type WhatsappCredentials } from "../../whatsapp/outbound";
import { uploadMedia } from "../../media/s3";
import { uploadOnceToWhatsapp } from "../../whatsapp/mediaUpload";
import { requireOwner } from "../../auth/requireOwner";
import { upload, businessIdOf, isUnsupportedImageType, rolDe, emailDe } from "./shared";
import { TransicionNoPermitida } from "../../orders/stateMachine";
import { adminCostlyLimiter } from "../../auth/rateLimits";

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

ordersRouter.put("/api/orders/:id/ship", adminCostlyLimiter, upload.single("file"), async (req, res) => {
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
  const shipNotice = await sendToCustomer({
    businessId,
    conversationId: order.conversationId,
    credentials,
    to: order.customer.phoneNumber,
    content: { kind: "text", text: messageText },
    recordAs: { text: messageText },
  });
  // Se propaga como antes (la ruta responde 500 y el pedido NO queda marcado como enviado): el aviso de
  // texto es la garantia real de esta accion, marcarlo despachado sin que el cliente se entere es
  // exactamente el error que este bloque existe para evitar.
  if (!shipNotice.delivered) {
    throw new Error(shipNotice.failure?.message ?? "No se pudo avisar al cliente del envio");
  }

  let mediaS3Key: string | null = null;
  let mediaType: string | null = null;
  let mediaError: string | null = null;

  if (file) {
    try {
      const type = file.mimetype.startsWith("video") ? "VIDEO" : "IMAGE";
      const folder = type === "VIDEO" ? "videos" : "images";
      const { key, url } = await uploadMedia(file.buffer, file.mimetype, folder);
      // Igual que en el chat del panel: el archivo viaja hacia Meta y la URL de S3 queda de respaldo,
      // para que Meta no tenga que descargarla (E17b).
      const nombre = String(file.originalname || "adjunto").slice(0, 120);
      const enviable = await uploadOnceToWhatsapp(credentials, file.buffer, file.mimetype, nombre, url);
      const media = await sendToCustomer({
        businessId,
        conversationId: order.conversationId,
        credentials,
        to: order.customer.phoneNumber,
        content: type === "IMAGE" ? { kind: "image", url: enviable } : { kind: "video", url: enviable },
      });
      if (!media.delivered) throw new Error(media.failure?.message ?? "No se pudo enviar el archivo adjunto");
      const wamid = media.wamid;
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

  try {
    await markOrderShipped(
      businessId,
      String(req.params.id),
      { note: formattedNote || null, mediaS3Key, mediaType },
      { tipo: rolDe(req) === "EMPLOYEE" ? "EMPLOYEE" : "OWNER", etiqueta: emailDe(req) },
    );
  } catch (error) {
    if (error instanceof TransicionNoPermitida) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  res.json({ ok: true, mediaError });
});

// E35 (2026-09-18). DONDE ESTA EL PEDIDO Y SI ESTA PAGADO.
//
// Medido en produccion el mismo dia: 55 mensajes de esa base mencionan guia, rastreo o una
// transportadora, y 6 clientas preguntan "cuando llega". Todo eso lo escribia la duena a mano en el
// chat, uno por uno, porque no existia donde guardarlo -- y el bot no podia contestar ni el mas simple.
//
// Lo carga quien despacha, asi que lo puede hacer un EMPLOYEE igual que marcar enviado. Cancelar sigue
// siendo del dueno.
//
// CADA CAMPO SE VALIDA APARTE Y `undefined` DEJA LA COLUMNA COMO ESTA. Es el mismo criterio que
// `PUT /api/business` (E46) y que las tarifas de envio: un formulario que manda solo la guia no puede
// borrar la transportadora que ya estaba.
const ESTADOS_DE_PAGO = ["UNPAID", "PARTIAL", "PAID", "REFUNDED"];

function textoOpcional(valor: unknown, largo: number): string | null | undefined {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  const texto = String(valor).trim();
  return texto ? texto.slice(0, largo) : null;
}

ordersRouter.put("/api/orders/:id/tracking", async (req, res) => {
  const businessId = businessIdOf(req);
  const orderId = String(req.params.id);
  const order = await getOrderForBusiness(businessId, orderId);
  if (!order) {
    res.status(404).json({ error: "Pedido no encontrado" });
    return;
  }

  const datos: Record<string, unknown> = {};

  const carrier = textoOpcional(req.body?.carrier, 80);
  if (carrier !== undefined) datos.carrier = carrier;

  const trackingNumber = textoOpcional(req.body?.trackingNumber, 120);
  if (trackingNumber !== undefined) datos.trackingNumber = trackingNumber;

  const paymentReference = textoOpcional(req.body?.paymentReference, 120);
  if (paymentReference !== undefined) datos.paymentReference = paymentReference;

  if (req.body?.estimatedDelivery !== undefined) {
    const crudo = req.body.estimatedDelivery;
    if (crudo === null || String(crudo).trim() === "") {
      datos.estimatedDelivery = null;
    } else {
      const fecha = new Date(String(crudo));
      if (Number.isNaN(fecha.getTime())) {
        res.status(400).json({ error: "La fecha de entrega estimada no es válida" });
        return;
      }
      datos.estimatedDelivery = fecha;
    }
  }

  if (req.body?.paymentStatus !== undefined) {
    const estado = String(req.body.paymentStatus);
    if (!ESTADOS_DE_PAGO.includes(estado)) {
      res.status(400).json({ error: "Ese estado de pago no existe" });
      return;
    }
    datos.paymentStatus = estado;
  }

  if (Object.keys(datos).length === 0) {
    res.status(400).json({ error: "No mandaste ningún dato para guardar" });
    return;
  }

  const actualizado = await prisma.order.update({ where: { id: orderId }, data: datos });
  res.json({
    ok: true,
    order: {
      id: actualizado.id,
      carrier: actualizado.carrier,
      trackingNumber: actualizado.trackingNumber,
      estimatedDelivery: actualizado.estimatedDelivery,
      paymentStatus: actualizado.paymentStatus,
      paymentReference: actualizado.paymentReference,
    },
  });
});

// Fase 8, punto 4 (decision D5): marcar un pedido como enviado es trabajo de bandeja y lo puede hacer
// un EMPLOYEE. Cancelarlo no: le avisa al cliente por WhatsApp que su pedido se cayo y deja el pedido
// en CANCELED sin vuelta atras desde el panel. Esa es una decision del dueno.
ordersRouter.put("/api/orders/:id/cancel", requireOwner, async (req, res) => {
  const businessId = businessIdOf(req);
  const order = await getOrderForBusiness(businessId, String(req.params.id));
  if (!order) {
    res.status(404).json({ error: "Pedido no encontrado" });
    return;
  }

  // E31: se CANCELA primero y se avisa despues. Antes era al reves, y con la maquina de estados eso
  // seria peor que un orden arbitrario: si la transicion se rechaza (por ejemplo, el pedido ya salio),
  // al cliente ya le habriamos dicho "tu pedido fue cancelado" y recien despues fallaria. Un aviso que
  // no se puede desdecir no puede salir antes del hecho que anuncia.
  try {
    await markOrderCanceled(
      businessId,
      String(req.params.id),
      { tipo: "OWNER", etiqueta: emailDe(req) },
      typeof req.body?.motivo === "string" ? req.body.motivo.slice(0, 300) : null,
    );
  } catch (error) {
    if (error instanceof TransicionNoPermitida) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (business?.whatsappPhoneNumberId && business.whatsappAccessToken) {
    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId,
      accessToken: business.whatsappAccessToken,
    };
    const messageText = "Tu pedido fue cancelado. Cualquier duda me escribes.";
    const notice = await sendToCustomer({
      businessId,
      conversationId: order.conversationId,
      credentials,
      to: order.customer.phoneNumber,
      content: { kind: "text", text: messageText },
      recordAs: { text: messageText },
    });
    if (!notice.delivered) {
      console.error("No se pudo avisar al cliente de la cancelacion del pedido:", notice.failure?.message);
    }
  }

  res.json({ ok: true });
});

