import { Router } from "express";
import { prisma } from "../../db/client";
import { requireOwner } from "../../auth/requireOwner";
import {
  setBusinessProfilePhoto,
  listApprovedTemplates,
  listAllTemplates,
  createTemplate,
  deleteTemplate,
  normalizeTemplateName,
  type WhatsappCredentials,
} from "../../whatsapp/client";
import { deepseek, DEEPSEEK_MODEL } from "../../ai/client";
import { IMPROVE_INSTRUCTIONS_PROMPT } from "../../ai/prompts/improveInstructions";
import { logAiUsage } from "../../ai/usage";
import { upload, businessIdOf } from "./shared";

export const businessRouter = Router();

businessRouter.get("/api/business", async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: businessIdOf(req) } });
  if (!business) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }
  const { passwordHash: _hash, whatsappAccessToken: _token, ...safe } = business;
  res.json(safe);
});

businessRouter.put("/api/business", requireOwner, async (req, res) => {
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
    offerPhotosBeforeSending,
    requirePaymentProof,
    businessCategory,
    contactPhone,
    contactName,
    followUpTemplateName,
    followUpTemplateLanguage,
    followUpDelayHours,
    genderedAddressEnabled,
    femaleAddressTerm,
    maleAddressTerm,
    shippingPaymentModalities,
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
      offerPhotosBeforeSending: Boolean(offerPhotosBeforeSending),
      requirePaymentProof: Boolean(requirePaymentProof),
      businessCategory: businessCategory || null,
      contactPhone,
      contactName,
      followUpTemplateName: followUpTemplateName || null,
      followUpTemplateLanguage: followUpTemplateLanguage || undefined,
      followUpDelayHours: followUpDelayHours !== undefined ? Number(followUpDelayHours) : undefined,
      genderedAddressEnabled: genderedAddressEnabled !== undefined ? Boolean(genderedAddressEnabled) : undefined,
      femaleAddressTerm: femaleAddressTerm === "" ? null : femaleAddressTerm,
      maleAddressTerm: maleAddressTerm === "" ? null : maleAddressTerm,
      shippingPaymentModalities: Array.isArray(shippingPaymentModalities) ? shippingPaymentModalities : undefined,
    },
  });
  const { passwordHash: _hash, whatsappAccessToken: _token, ...safe } = business;
  res.json(safe);
});

businessRouter.get("/api/whatsapp-templates", async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: businessIdOf(req) } });
  if (!business?.whatsappAccessToken || !business.whatsappBusinessAccountId) {
    res.json({ templates: [], note: "Falta configurar el WhatsApp Business Account ID de este negocio (lo hace Zaqi desde el panel interno)." });
    return;
  }
  try {
    const templates = await listApprovedTemplates(business.whatsappAccessToken, business.whatsappBusinessAccountId);
    res.json({ templates });
  } catch (error) {
    res.status(502).json({ templates: [], error: error instanceof Error ? error.message : "No se pudo consultar las plantillas" });
  }
});

businessRouter.get("/api/whatsapp-templates/all", async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: businessIdOf(req) } });
  if (!business?.whatsappAccessToken || !business.whatsappBusinessAccountId) {
    res.json({ templates: [], note: "Falta configurar el WhatsApp Business Account ID de este negocio (lo hace Zaqi desde el panel interno)." });
    return;
  }
  try {
    const templates = await listAllTemplates(business.whatsappAccessToken, business.whatsappBusinessAccountId);
    res.json({ templates });
  } catch (error) {
    res.status(502).json({ templates: [], error: error instanceof Error ? error.message : "No se pudo consultar las plantillas" });
  }
});

businessRouter.post("/api/whatsapp-templates", requireOwner, async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: businessIdOf(req) } });
  if (!business?.whatsappAccessToken || !business.whatsappBusinessAccountId) {
    res.status(400).json({ error: "Falta configurar el WhatsApp Business Account ID de este negocio (lo hace Zaqi desde el panel interno)." });
    return;
  }

  const { name, category, bodyText } = req.body;
  const normalizedName = normalizeTemplateName(String(name ?? ""));
  const text = String(bodyText ?? "").trim();
  if (!normalizedName) {
    res.status(400).json({ error: "Falta el nombre de la plantilla" });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "Falta el texto del mensaje" });
    return;
  }
  if (text.includes("{{")) {
    res.status(400).json({ error: "Por ahora no se admiten variables ({{1}}, etc) desde el panel - usa texto fijo." });
    return;
  }
  const safeCategory = category === "MARKETING" ? "MARKETING" : "UTILITY";

  try {
    const result = await createTemplate(business.whatsappAccessToken, business.whatsappBusinessAccountId, {
      name: normalizedName,
      category: safeCategory,
      language: "es",
      bodyText: text,
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "No se pudo crear la plantilla" });
  }
});

businessRouter.delete("/api/whatsapp-templates/:name", requireOwner, async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: businessIdOf(req) } });
  if (!business?.whatsappAccessToken || !business.whatsappBusinessAccountId) {
    res.status(400).json({ error: "Falta configurar el WhatsApp Business Account ID de este negocio." });
    return;
  }
  try {
    await deleteTemplate(business.whatsappAccessToken, business.whatsappBusinessAccountId, String(req.params.name));
    res.status(204).send();
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "No se pudo eliminar la plantilla" });
  }
});

businessRouter.post("/api/business/profile-photo", requireOwner, upload.single("file"), async (req, res) => {
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

businessRouter.delete("/api/reset-test-data", requireOwner, async (req, res) => {
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

businessRouter.post("/api/improve-instructions", requireOwner, async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "No hay texto para mejorar" });
    return;
  }

  // Scale the completion ceiling with input size - a fixed 600 truncates a business's longer real
  // customInstructions (seen up to ~8.3k chars / ~2.7k tokens in production) mid-rewrite.
  const maxTokens = Math.min(4000, Math.max(600, Math.ceil(text.length / 3)));

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: IMPROVE_INSTRUCTIONS_PROMPT },
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
