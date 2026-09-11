import { Router } from "express";
import multer from "multer";
import {
  createProduct,
  deleteProduct,
  deleteProductMedia,
  listAllProducts,
  updateProduct,
  addProductMedia,
} from "../catalog/products";
import { prisma } from "../db/client";
import { requireAuth } from "../auth/requireAuth";
import { requireOwner } from "../auth/requireOwner";
import { hashPassword } from "../auth/service";
import {
  listConversationsForBusiness,
  getConversationForBusiness,
  setHumanControl,
  clearAgentRequestFlag,
  recordMessage,
  setCustomerTags,
  saveCustomerName,
  saveCustomerContactInfo,
  updateConversationStatus,
} from "../conversation/service";
import {
  sendTextMessage,
  sendImageMessage,
  sendVideoMessage,
  setBusinessProfilePhoto,
  formatForWhatsapp,
  type WhatsappCredentials,
} from "../whatsapp/client";
import { getAiUsageSummary, getPlanUsage, logAiUsage } from "../ai/usage";
import { extractSaleDetails } from "../ai/extractSale";
import { deepseek, DEEPSEEK_MODEL } from "../ai/client";
import { getAnalyticsSummary } from "../analytics/service";
import { listFaqEntries, createFaqEntry, updateFaqEntry, deleteFaqEntry } from "../catalog/faq";
import { listPendingCandidates, approveCandidate, discardCandidate } from "../catalog/learnedFaq";
import { listUnresolvedDeliveryFailures, resolveDeliveryFailure } from "../delivery/failures";
import {
  listOrdersForBusiness,
  getOrderForBusiness,
  markOrderShipped,
  markOrderCanceled,
  resolveOrderItems,
  createOrder,
  askForCsat,
} from "../orders/service";
import { uploadMedia } from "../media/s3";
import {
  listPaymentMethods,
  createPaymentMethod,
  deletePaymentMethod,
  togglePaymentMethod,
  updatePaymentMethod,
} from "../catalog/paymentMethods";

export const adminRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

adminRouter.use("/api", requireAuth);

function businessIdOf(req: { session: { businessId?: string } }): string {
  return req.session.businessId as string;
}

// WhatsApp's Cloud API rejects image/gif outright ("Unsupported Image mime type image/gif") - and it
// does so asynchronously, after already accepting the send request, so the caller has no synchronous
// error to react to. Block it at upload time instead of letting it silently fail delivery later.
function isUnsupportedImageType(mimetype: string): boolean {
  return mimetype === "image/gif";
}

adminRouter.get("/api/business", async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: businessIdOf(req) } });
  if (!business) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }
  const { passwordHash: _hash, whatsappAccessToken: _token, ...safe } = business;
  res.json(safe);
});

adminRouter.put("/api/business", requireOwner, async (req, res) => {
  const {
    name,
    description,
    customInstructions,
    assistantName,
    botTone,
    botDialect,
    botGreeting,
    botNeverSay,
    autoSendPhotoOnQuote,
    requirePaymentProof,
    businessCategory,
    contactPhone,
    contactName,
    followUpTemplateName,
    followUpTemplateLanguage,
    followUpDelayHours,
  } = req.body;
  const business = await prisma.business.update({
    where: { id: businessIdOf(req) },
    data: {
      name,
      description,
      customInstructions,
      assistantName: assistantName || null,
      botTone: botTone || null,
      botDialect: botDialect || null,
      botGreeting: botGreeting || null,
      botNeverSay: botNeverSay || null,
      autoSendPhotoOnQuote: Boolean(autoSendPhotoOnQuote),
      requirePaymentProof: Boolean(requirePaymentProof),
      businessCategory: businessCategory || null,
      contactPhone,
      contactName,
      followUpTemplateName: followUpTemplateName || null,
      followUpTemplateLanguage: followUpTemplateLanguage || undefined,
      followUpDelayHours: followUpDelayHours !== undefined ? Number(followUpDelayHours) : undefined,
    },
  });
  const { passwordHash: _hash, whatsappAccessToken: _token, ...safe } = business;
  res.json(safe);
});

adminRouter.post("/api/business/profile-photo", requireOwner, upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No se subió ninguna imagen" });
    return;
  }

  const businessId = businessIdOf(req);
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.whatsappPhoneNumberId || !business.whatsappAccessToken) {
    res.status(400).json({ error: "Este negocio no tiene WhatsApp conectado" });
    return;
  }

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };

  try {
    await setBusinessProfilePhoto(credentials, file.buffer, file.mimetype);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "No se pudo actualizar la foto" });
    return;
  }

  res.json({ ok: true });
});

adminRouter.delete("/api/reset-test-data", requireOwner, async (req, res) => {
  const businessId = businessIdOf(req);

  await prisma.$transaction([
    prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } }),
    prisma.orderItem.deleteMany({ where: { order: { businessId } } }),
    prisma.order.deleteMany({ where: { businessId } }),
    prisma.conversation.deleteMany({ where: { customer: { businessId } } }),
    prisma.customer.deleteMany({ where: { businessId } }),
    prisma.product.updateMany({ where: { businessId }, data: { inquiryCount: 0 } }),
  ]);

  res.json({ ok: true });
});

adminRouter.post("/api/improve-instructions", requireOwner, async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "No hay texto para mejorar" });
    return;
  }

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    max_tokens: 600,
    messages: [
      {
        role: "system",
        content: `Reescribe instrucciones de un dueño de negocio para su asistente de ventas de WhatsApp.
Corrige ortografía y gramática, organiza en viñetas claras y cortas, en español neutro. NO inventes reglas
nuevas ni cambies el significado de lo que pidió - solo aclara la redacción. No agregues explicaciones,
devuelve unicamente las instrucciones reescritas.`,
      },
      { role: "user", content: text },
    ],
    // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning
    // tokens leave message.content empty for a short rewrite task like this one.
    thinking: { type: "disabled" },
  });

  await logAiUsage({
    businessId: businessIdOf(req),
    kind: "CHAT",
    model: DEEPSEEK_MODEL,
    usage: response.usage,
  });

  const improved = response.choices[0]?.message?.content?.trim();
  if (!improved) {
    res.status(502).json({ error: "No se pudo mejorar el texto, intenta de nuevo" });
    return;
  }
  res.json({ improved });
});

adminRouter.get("/api/products", async (req, res) => {
  const products = await listAllProducts(businessIdOf(req));
  res.json(products);
});

adminRouter.post("/api/products", async (req, res) => {
  const { name, description, price, currency, stock, category } = req.body;
  const product = await createProduct(businessIdOf(req), {
    name,
    description,
    price: Number(price),
    currency,
    stock: Number(stock ?? 0),
    category: category || undefined,
  });
  res.status(201).json(product);
});

adminRouter.put("/api/products/:id", async (req, res) => {
  const { name, description, price, currency, stock, category, active } = req.body;
  const product = await updateProduct(businessIdOf(req), String(req.params.id), {
    name,
    description,
    price: price !== undefined ? Number(price) : undefined,
    currency,
    stock: stock !== undefined ? Number(stock) : undefined,
    category: category === "" ? null : category,
    active,
  });
  res.json(product);
});

adminRouter.delete("/api/products/:id", async (req, res) => {
  await deleteProduct(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

adminRouter.post("/api/products/:id/media", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  if (isUnsupportedImageType(req.file.mimetype)) {
    res.status(400).json({ error: "Formato GIF no soportado todavía - usa JPG, PNG o video." });
    return;
  }

  const type = req.file.mimetype.startsWith("video") ? "VIDEO" : "IMAGE";
  const folder = type === "VIDEO" ? "videos" : "images";
  const { key, url } = await uploadMedia(req.file.buffer, req.file.mimetype, folder);
  const media = await addProductMedia(businessIdOf(req), String(req.params.id), { type, url, s3Key: key });
  res.status(201).json(media);
});

adminRouter.delete("/api/media/:id", async (req, res) => {
  await deleteProductMedia(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

adminRouter.get("/api/payment-methods", async (req, res) => {
  const methods = await listPaymentMethods(businessIdOf(req));
  res.json(methods);
});

adminRouter.post("/api/payment-methods", requireOwner, async (req, res) => {
  const { type, label, details } = req.body;
  if (!type || !label || !details) {
    res.status(400).json({ error: "Faltan campos obligatorios" });
    return;
  }
  const method = await createPaymentMethod(businessIdOf(req), { type, label, details });
  res.status(201).json(method);
});

adminRouter.put("/api/payment-methods/:id", requireOwner, async (req, res) => {
  const { type, label, details, active } = req.body;
  if (type === undefined && label === undefined && details === undefined) {
    const method = await togglePaymentMethod(businessIdOf(req), String(req.params.id), Boolean(active));
    res.json(method);
    return;
  }
  const method = await updatePaymentMethod(businessIdOf(req), String(req.params.id), { type, label, details, active });
  res.json(method);
});

adminRouter.delete("/api/payment-methods/:id", requireOwner, async (req, res) => {
  await deletePaymentMethod(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

adminRouter.get("/api/faq", async (req, res) => {
  const entries = await listFaqEntries(businessIdOf(req));
  res.json(entries);
});

adminRouter.post("/api/faq", requireOwner, async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    res.status(400).json({ error: "Faltan la pregunta o la respuesta" });
    return;
  }
  const entry = await createFaqEntry(businessIdOf(req), { question, answer });
  res.status(201).json(entry);
});

adminRouter.put("/api/faq/:id", requireOwner, async (req, res) => {
  const { question, answer, active } = req.body;
  const entry = await updateFaqEntry(businessIdOf(req), String(req.params.id), { question, answer, active });
  res.json(entry);
});

adminRouter.delete("/api/faq/:id", requireOwner, async (req, res) => {
  await deleteFaqEntry(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

adminRouter.get("/api/faq-candidates", async (req, res) => {
  const candidates = await listPendingCandidates(businessIdOf(req));
  res.json(candidates);
});

adminRouter.post("/api/faq-candidates/:id/approve", requireOwner, async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    res.status(400).json({ error: "Faltan la pregunta o la respuesta" });
    return;
  }
  try {
    const entry = await approveCandidate(businessIdOf(req), String(req.params.id), { question, answer });
    res.status(201).json(entry);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo aprobar la sugerencia" });
  }
});

adminRouter.post("/api/faq-candidates/:id/discard", requireOwner, async (req, res) => {
  try {
    await discardCandidate(businessIdOf(req), String(req.params.id));
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo descartar la sugerencia" });
  }
});

adminRouter.get("/api/delivery-failures", async (req, res) => {
  const failures = await listUnresolvedDeliveryFailures(businessIdOf(req));
  res.json(failures);
});

adminRouter.post("/api/delivery-failures/:id/resolve", requireOwner, async (req, res) => {
  try {
    await resolveDeliveryFailure(businessIdOf(req), String(req.params.id));
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo marcar como visto" });
  }
});

adminRouter.get("/api/team", requireOwner, async (req, res) => {
  const members = await prisma.teamMember.findMany({
    where: { businessId: businessIdOf(req) },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
  res.json(members);
});

adminRouter.post("/api/team", requireOwner, async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || !password) {
    res.status(400).json({ error: "Faltan email, nombre o contraseña" });
    return;
  }
  const existing = await prisma.teamMember.findUnique({ where: { email } });
  const existingBusiness = await prisma.business.findUnique({ where: { email } });
  if (existing || existingBusiness) {
    res.status(400).json({ error: "Ya existe una cuenta con ese email" });
    return;
  }
  const passwordHash = await hashPassword(password);
  const member = await prisma.teamMember.create({
    data: { businessId: businessIdOf(req), email, name, passwordHash },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
  res.status(201).json(member);
});

adminRouter.put("/api/team/:id", requireOwner, async (req, res) => {
  const member = await prisma.teamMember.findFirst({ where: { id: String(req.params.id), businessId: businessIdOf(req) } });
  if (!member) {
    res.status(404).json({ error: "Miembro no encontrado" });
    return;
  }
  const updated = await prisma.teamMember.update({
    where: { id: member.id },
    data: { active: Boolean(req.body?.active) },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
  res.json(updated);
});

adminRouter.delete("/api/team/:id", requireOwner, async (req, res) => {
  const member = await prisma.teamMember.findFirst({ where: { id: String(req.params.id), businessId: businessIdOf(req) } });
  if (!member) {
    res.status(404).json({ error: "Miembro no encontrado" });
    return;
  }
  await prisma.teamMember.delete({ where: { id: member.id } });
  res.status(204).send();
});

adminRouter.get("/api/ai-usage", async (req, res) => {
  const businessId = businessIdOf(req);
  const [summary, planUsage] = await Promise.all([getAiUsageSummary(businessId), getPlanUsage(businessId)]);
  res.json({ ...summary, planUsage });
});

adminRouter.put("/api/customers/:id/tags", async (req, res) => {
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [];
  const customer = await setCustomerTags(businessIdOf(req), String(req.params.id), tags);
  if (!customer) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json({ id: customer.id, tags: customer.tags });
});

adminRouter.put("/api/customers/:id/name", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const customer = await saveCustomerName(businessIdOf(req), String(req.params.id), name || null);
  if (!customer) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json({ id: customer.id, name: customer.name });
});

adminRouter.get("/api/orders", async (req, res) => {
  const orders = await listOrdersForBusiness(businessIdOf(req));
  res.json(orders);
});

adminRouter.put("/api/orders/:id/ship", upload.single("file"), async (req, res) => {
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

adminRouter.put("/api/orders/:id/cancel", async (req, res) => {
  const updated = await markOrderCanceled(businessIdOf(req), String(req.params.id));
  if (!updated) {
    res.status(404).json({ error: "Pedido no encontrado" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.get("/api/analytics", async (req, res) => {
  const summary = await getAnalyticsSummary(businessIdOf(req));
  res.json(summary);
});

adminRouter.get("/api/conversations", async (req, res) => {
  const conversations = await listConversationsForBusiness(businessIdOf(req));
  res.json(conversations);
});

adminRouter.get("/api/conversations/:id", async (req, res) => {
  const conversation = await getConversationForBusiness(businessIdOf(req), String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  res.json(conversation);
});

adminRouter.put("/api/conversations/:id/handoff", async (req, res) => {
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

adminRouter.post("/api/conversations/:id/messages", upload.single("file"), async (req, res) => {
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

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };

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
  await setHumanControl(businessId, String(req.params.id), true);
  await clearAgentRequestFlag(businessId, String(req.params.id));

  res.status(201).json({ ok: true });
});

// For sales the owner closes herself (chatting directly with the customer, bypassing the bot entirely) -
// close_conversation only ever runs as an AI tool call, so a manually-closed sale otherwise never creates
// an Order and never shows up in Pedidos. This is the deterministic equivalent for that path: no AI
// involved, so no risk of the model skipping or mishandling it.
// Prefills the close-sale form by reading the conversation with AI - read-only, no side effects. The
// owner still reviews/edits every field and clicks "Confirmar venta" herself before anything is created,
// so a bad extraction just means editing a field, not a wrong order silently going through.
adminRouter.get("/api/conversations/:id/extract-sale-details", async (req, res) => {
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

adminRouter.post("/api/conversations/:id/close-sale", async (req, res) => {
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

  const defaultMessage = "¡Listo! Tu pago quedó confirmado y tu pedido está cerrado. Gracias por tu compra 🎉";
  const text = formatForWhatsapp(customerMessage) || defaultMessage;
  const wamid = await sendTextMessage(credentials, conversation.customer.phoneNumber, text);
  await recordMessage(businessId, conversation.id, "ASSISTANT", text, wamid || undefined);
  await askForCsat(credentials, order.id, conversation.customer.phoneNumber);

  res.json({ ok: true, orderId: order.id });
});
