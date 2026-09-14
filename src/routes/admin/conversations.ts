import { Router } from "express";
import { prisma } from "../../db/client";
import {
  listConversationsForBusiness,
  getConversationForBusiness,
  setHumanControl,
  clearAgentRequestFlag,
  clearConversationIntent,
  clearPendingOwnerQuestionsForConversation,
  recordMessage,
  saveCustomerContactInfo,
  updateConversationStatus,
  getWindowState,
  queueOutboundMessage,
  listQueuedOutbound,
  cancelQueuedOutbound,
} from "../../conversation/service";
import {
  sendTextMessage,
  sendImageMessage,
  sendVideoMessage,
  sendTemplateMessage,
  listApprovedTemplates,
  formatForWhatsapp,
  type WhatsappCredentials,
} from "../../whatsapp/client";
import { generateClosingMessage } from "../../ai/agent";
import { extractSaleDetails } from "../../ai/extractSale";
import {
  resolveOrderItems,
  createOrder,
  askForCsat,
  getOrderByConversationId,
} from "../../orders/service";
import { uploadMedia } from "../../media/s3";
import { upload, businessIdOf, isUnsupportedImageType } from "./shared";

export const conversationsRouter = Router();

conversationsRouter.get("/api/conversations", async (req, res) => {
  const conversations = await listConversationsForBusiness(businessIdOf(req));
  res.json(conversations);
});

// Grouped-by-customer view of the Conversaciones list (see ONIX-CONVERSATIONS-GROUPING-PLAN.md) - one
// row per customer instead of one per Conversation, so a customer whose last sale already closed
// doesn't reappear as a second, unrelated-looking row the next time they write in. The underlying data
// model is untouched: /api/conversations/:id and everything under it still operate on a single
// Conversation id (the customer row's activeConversationId).

conversationsRouter.get("/api/conversations/:id", async (req, res) => {
  const conversation = await getConversationForBusiness(businessIdOf(req), String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  res.json(conversation);
});

conversationsRouter.put("/api/conversations/:id/handoff", async (req, res) => {
  const active = Boolean(req.body?.active);
  const businessId = businessIdOf(req);
  const conversation = await setHumanControl(businessId, String(req.params.id), active);
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  if (active) await clearAgentRequestFlag(businessId, String(req.params.id));
  res.json({ id: conversation.id, humanControl: conversation.humanControl });
});

// Lets the owner dismiss an intent badge (PQR/Devolución/No recibido/Pide asesor) from the panel once
// they've resolved it - flag_conversation_intent is the only thing that sets it, and previously nothing
// short of the whole conversation closing ever cleared it.
conversationsRouter.put("/api/conversations/:id/intent", async (req, res) => {
  const conversation = await clearConversationIntent(businessIdOf(req), String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  res.json({ id: conversation.id, intent: conversation.intent });
});

conversationsRouter.post("/api/conversations/:id/messages", upload.single("file"), async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  const file = req.file;
  if (!text && !file) {
    res.status(400).json({ error: "Falta el texto o el archivo" });
    return;
  }
  if (file && isUnsupportedImageType(file.mimetype)) {
    res.status(400).json({ error: "Formato GIF no soportado todavía - usa JPG, PNG o video." });
    return;
  }

  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.whatsappPhoneNumberId || !business.whatsappAccessToken) {
    res.status(400).json({ error: "Este negocio no tiene WhatsApp conectado" });
    return;
  }

  // Real incident (2026-09-14): a manual message sent 33h after the customer's last message got a real
  // wamid back from WhatsApp (looked sent) and only failed hours later via the async status webhook -
  // the owner had no way to know until she checked "Salud del bot". Checking the window BEFORE the send
  // catches this instead of letting it fail invisibly; see getWindowState for why a wamid is not proof.
  const windowState = await getWindowState(String(req.params.id));
  if (!windowState.windowOpen) {
    // Con `queue: true` el panel no pierde lo que el dueno ya escribio: queda guardado y el webhook lo
    // entrega solo en cuanto el cliente conteste (ver QueuedOutboundMessage). Sin eso, la unica salida
    // era mandar una plantilla generica y acordarse de reescribir el mensaje a mano mas tarde - que es
    // justo lo que no paso en el caso de David (2026-09-14).
    if (String(req.body?.queue ?? "") === "true" && text && !file) {
      const queued = await queueOutboundMessage(businessId, String(req.params.id), formatForWhatsapp(text), "PANEL");
      await setHumanControl(businessId, String(req.params.id), true);
      await clearAgentRequestFlag(businessId, String(req.params.id));
      res.status(202).json({ ok: true, queued: true, id: queued.id });
      return;
    }
    res.status(409).json({
      error: "Pasaron mas de 24h desde el ultimo mensaje del cliente - WhatsApp ya no entrega mensajes libres. Usa una plantilla aprobada para reabrir la conversacion.",
      windowClosed: true,
    });
    return;
  }

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };

  // Antes esto corria DESPUES del envio: durante esos segundos la conversacion seguia en automatico, y
  // un mensaje del cliente que entrara justo ahi recibia respuesta del bot encima de la del dueno.
  // Tomar el control primero cierra esa ventana; si el envio falla, la conversacion queda en manos del
  // humano, que es el lado seguro del error.
  await setHumanControl(businessId, String(req.params.id), true);
  await clearAgentRequestFlag(businessId, String(req.params.id));

  const formattedText = formatForWhatsapp(text);
  if (file) {
    const type = file.mimetype.startsWith("video") ? "VIDEO" : "IMAGE";
    const folder = type === "VIDEO" ? "videos" : "images";
    const { key, url } = await uploadMedia(file.buffer, file.mimetype, folder);
    const wamid =
      type === "IMAGE"
        ? await sendImageMessage(credentials, conversation.customer.phoneNumber, url, formattedText || undefined)
        : await sendVideoMessage(credentials, conversation.customer.phoneNumber, url, formattedText || undefined);
    await recordMessage(businessId, String(req.params.id), "ASSISTANT", formattedText || (type === "IMAGE" ? "[Foto]" : "[Video]"), wamid || undefined, {
      s3Key: key,
      type,
    });
  } else {
    const wamid = await sendTextMessage(credentials, conversation.customer.phoneNumber, formattedText);
    await recordMessage(businessId, String(req.params.id), "ASSISTANT", formattedText, wamid || undefined);
  }
  await clearPendingOwnerQuestionsForConversation(String(req.params.id));

  res.status(201).json({ ok: true });
});

// Deja al dueno sacar de la cola algo que ya no quiere mandar (se arrepintio, o el tema se resolvio por
// telefono) - si no, el mensaje se entregaria solo semanas despues, cuando el cliente vuelva a escribir
// por cualquier otra cosa.
conversationsRouter.delete("/api/conversations/:id/queued/:queuedId", async (req, res) => {
  const cancelled = await cancelQueuedOutbound(businessIdOf(req), String(req.params.queuedId));
  if (!cancelled) {
    res.status(404).json({ error: "Ese mensaje en cola ya no existe" });
    return;
  }
  res.json({ ok: true, queuedOutbound: await listQueuedOutbound(String(req.params.id)) });
});

// The only way to reach a customer once their 24h window has closed (see the check above) - an
// approved template, same mechanism sendOwnerAlert and runFollowUpJob already use. Re-validates the
// template against Meta's own approved list instead of trusting the name/language the client sent, so
// this can't be used to fire an arbitrary/unapproved template through the business's number.
conversationsRouter.post("/api/conversations/:id/send-template", async (req, res) => {
  const templateName = String(req.body?.templateName ?? "").trim();
  const language = String(req.body?.language ?? "").trim();
  if (!templateName || !language) {
    res.status(400).json({ error: "Falta el nombre o el idioma de la plantilla" });
    return;
  }

  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.whatsappPhoneNumberId || !business.whatsappAccessToken) {
    res.status(400).json({ error: "Este negocio no tiene WhatsApp conectado" });
    return;
  }
  if (!business.whatsappBusinessAccountId) {
    res.status(400).json({ error: "Falta configurar el WhatsApp Business Account ID de este negocio" });
    return;
  }

  const approved = await listApprovedTemplates(business.whatsappAccessToken, business.whatsappBusinessAccountId);
  const template = approved.find((t) => t.name === templateName && t.language === language);
  if (!template) {
    res.status(400).json({ error: "Esa plantilla no está aprobada para este negocio" });
    return;
  }

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };
  const wamid = await sendTemplateMessage(credentials, conversation.customer.phoneNumber, templateName, language);
  // Records the template's real wording, not just its name - the thread should read like a normal
  // message the customer actually saw, same as every other outbound bubble.
  await recordMessage(businessId, String(req.params.id), "ASSISTANT", template.bodyText || `[Plantilla: ${templateName}]`, wamid || undefined);
  await setHumanControl(businessId, String(req.params.id), true);
  await clearAgentRequestFlag(businessId, String(req.params.id));
  await clearPendingOwnerQuestionsForConversation(String(req.params.id));

  res.status(201).json({ ok: true });
});

// For sales the owner closes herself (chatting directly with the customer, bypassing the bot entirely) -
// close_conversation only ever runs as an AI tool call, so a manually-closed sale otherwise never creates
// an Order and never shows up in Pedidos. This is the deterministic equivalent for that path: no AI
// involved, so no risk of the model skipping or mishandling it.
// Prefills the close-sale form by reading the conversation with AI - read-only, no side effects. The
// owner still reviews/edits every field and clicks "Confirmar venta" herself before anything is created,
// so a bad extraction just means editing a field, not a wrong order silently going through.
conversationsRouter.get("/api/conversations/:id/extract-sale-details", async (req, res) => {
  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  try {
    const details = await extractSaleDetails(businessId, String(req.params.id));
    res.json(details);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "No se pudo leer la conversación" });
  }
});

conversationsRouter.post("/api/conversations/:id/close-sale", async (req, res) => {
  const businessId = businessIdOf(req);
  const itemLines: string[] = Array.isArray(req.body?.items) ? req.body.items : [];
  const shippingAddress = req.body?.shippingAddress ? String(req.body.shippingAddress).trim() : null;
  const paymentMethodLabel = req.body?.paymentMethodLabel ? String(req.body.paymentMethodLabel).trim() : null;
  const notes = String(req.body?.notes ?? "").trim();
  const shippingCost = req.body?.shippingCost !== undefined && req.body?.shippingCost !== "" ? Number(req.body.shippingCost) : null;
  const idNumber = req.body?.idNumber ? String(req.body.idNumber).trim() : undefined;
  const deliveryPhone = req.body?.deliveryPhone ? String(req.body.deliveryPhone).trim() : undefined;
  const customerMessage = String(req.body?.customerMessage ?? "").trim();

  const parsedItems = itemLines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s*x\s*(.+)$/i);
      return match ? { productName: match[2].trim(), quantity: Number(match[1]) } : { productName: line, quantity: 1 };
    });
  if (parsedItems.length === 0) {
    res.status(400).json({ error: "Agrega al menos un producto" });
    return;
  }

  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
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

  const { items, unresolved } = await resolveOrderItems(businessId, parsedItems);
  if (items.length === 0) {
    res.status(400).json({ error: "Ningún producto coincidió con el catálogo - revisa los nombres" });
    return;
  }
  if (unresolved.length > 0) {
    res.status(400).json({
      error: `No pude asociar estos productos con confianza al catálogo, revisa el nombre: ${unresolved.join(", ")}`,
    });
    return;
  }

  if (idNumber || deliveryPhone) {
    await saveCustomerContactInfo(businessId, conversation.customer.id, { idNumber, deliveryPhone });
  }

  if (await getOrderByConversationId(conversation.id)) {
    res.status(400).json({ error: "Esta conversación ya tiene un pedido registrado." });
    return;
  }

  const itemsSummary = items.map((i) => `${i.quantity}x ${i.productName}`).join(", ");
  const summary = notes ? `${itemsSummary} — Nota: ${notes}` : itemsSummary;
  const order = await createOrder({
    businessId,
    customerId: conversation.customer.id,
    conversationId: conversation.id,
    summary,
    items,
    shippingAddress,
    paymentMethodLabel,
    shippingCost,
  });
  await updateConversationStatus(businessId, conversation.id, "SOLD");

  const text =
    formatForWhatsapp(customerMessage) ||
    (await generateClosingMessage(businessId, conversation.id, business, {
      customerName: conversation.customer.name,
      summary: order.summary,
      shippingAddress: order.shippingAddress,
      paymentMethodLabel: order.paymentMethodLabel,
      shippingCost: order.shippingCost != null ? Number(order.shippingCost) : null,
      totalAmount: Number(order.totalAmount),
      currency: order.currency,
    }));
  const wamid = await sendTextMessage(credentials, conversation.customer.phoneNumber, text);
  await recordMessage(businessId, conversation.id, "ASSISTANT", text, wamid || undefined);
  await askForCsat(credentials, order.id, conversation.customer.phoneNumber);
  await clearPendingOwnerQuestionsForConversation(conversation.id);

  res.json({ ok: true, orderId: order.id });
});
