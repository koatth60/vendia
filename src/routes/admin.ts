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
import {
  listConversationsForBusiness,
  getConversationForBusiness,
  setHumanControl,
  recordMessage,
  setCustomerTags,
} from "../conversation/service";
import { sendTextMessage, type WhatsappCredentials } from "../whatsapp/client";
import { getAiUsageSummary } from "../ai/usage";
import { getAnalyticsSummary } from "../analytics/service";
import { listFaqEntries, createFaqEntry, updateFaqEntry, deleteFaqEntry } from "../catalog/faq";
import { listOrdersForBusiness } from "../orders/service";
import { uploadMedia } from "../media/s3";
import {
  listPaymentMethods,
  createPaymentMethod,
  deletePaymentMethod,
  togglePaymentMethod,
} from "../catalog/paymentMethods";

export const adminRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

adminRouter.use("/api", requireAuth);

function businessIdOf(req: { session: { businessId?: string } }): string {
  return req.session.businessId as string;
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

adminRouter.put("/api/business", async (req, res) => {
  const {
    name,
    description,
    customInstructions,
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

adminRouter.post("/api/payment-methods", async (req, res) => {
  const { type, label, details } = req.body;
  if (!type || !label || !details) {
    res.status(400).json({ error: "Faltan campos obligatorios" });
    return;
  }
  const method = await createPaymentMethod(businessIdOf(req), { type, label, details });
  res.status(201).json(method);
});

adminRouter.put("/api/payment-methods/:id", async (req, res) => {
  const { active } = req.body;
  const method = await togglePaymentMethod(businessIdOf(req), String(req.params.id), Boolean(active));
  res.json(method);
});

adminRouter.delete("/api/payment-methods/:id", async (req, res) => {
  await deletePaymentMethod(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

adminRouter.get("/api/faq", async (req, res) => {
  const entries = await listFaqEntries(businessIdOf(req));
  res.json(entries);
});

adminRouter.post("/api/faq", async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    res.status(400).json({ error: "Faltan la pregunta o la respuesta" });
    return;
  }
  const entry = await createFaqEntry(businessIdOf(req), { question, answer });
  res.status(201).json(entry);
});

adminRouter.put("/api/faq/:id", async (req, res) => {
  const { question, answer, active } = req.body;
  const entry = await updateFaqEntry(businessIdOf(req), String(req.params.id), { question, answer, active });
  res.json(entry);
});

adminRouter.delete("/api/faq/:id", async (req, res) => {
  await deleteFaqEntry(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

adminRouter.get("/api/ai-usage", async (req, res) => {
  const summary = await getAiUsageSummary(businessIdOf(req));
  res.json(summary);
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

adminRouter.get("/api/orders", async (req, res) => {
  const orders = await listOrdersForBusiness(businessIdOf(req));
  res.json(orders);
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
  const conversation = await setHumanControl(businessIdOf(req), String(req.params.id), active);
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  res.json({ id: conversation.id, humanControl: conversation.humanControl });
});

adminRouter.post("/api/conversations/:id/messages", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "Falta el texto del mensaje" });
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

  await sendTextMessage(credentials, conversation.customer.phoneNumber, text);
  await recordMessage(String(req.params.id), "ASSISTANT", text);
  await setHumanControl(businessId, String(req.params.id), true);

  res.status(201).json({ ok: true });
});
