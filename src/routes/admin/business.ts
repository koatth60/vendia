import { Router } from "express";
import { Prisma } from "@prisma/client";
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
} from "../../whatsapp/outbound";
import { deepseek, DEEPSEEK_MODEL } from "../../ai/client";
import { IMPROVE_INSTRUCTIONS_PROMPT } from "../../ai/prompts/improveInstructions";
import { logAiUsage } from "../../ai/usage";
import { upload, businessIdOf } from "./shared";
import { COUNTRIES, COUNTRY_CODES, isCountryCode } from "../../config/countries";
import { parseBusinessHours } from "../../config/businessHours";
import { adminCostlyLimiter } from "../../auth/rateLimits";

// Los tres valores validos de Business.catalogPhotoScope. Vive aca y no en el panel: el servidor no
// puede confiar en que el formulario mande uno de ellos.
const CATALOG_PHOTO_SCOPES = ["PRODUCT", "CATEGORY", "CATALOG"];

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
    interactiveListsEnabled,
    attributeCheckEnabled,
    catalogPhotoScope,
    businessCategory,
    contactPhone,
    contactName,
    ownerReminderMinutes,
    ownerQuestionTimeoutHours,
    intentEscalationTimeoutHours,
    followUpTemplateName,
    followUpTemplateLanguage,
    followUpDelayHours,
    abandonedAfterHours,
    cartRecoveryTemplateName,
    cartRecoveryTemplateLanguage,
    genderedAddressEnabled,
    femaleAddressTerm,
    maleAddressTerm,
    shippingPaymentModalities,
    countryCode,
    currency,
    timezone,
    businessHours,
    requiresIdDocument,
    idDocumentExemptZones,
  } = req.body;

  // Fase 11 del plan maestro (2026-09-15): un pais desconocido no se guarda - countryConfig() caeria en
  // Colombia en cada lectura y el panel mostraria un pais que el bot no esta usando. La moneda y la zona
  // horaria se dejan libres a proposito (un negocio colombiano que cobra en USD existe), pero si el dueno
  // cambia de pais y no toca las otras dos, arrancan de los valores de ese pais.
  const pais = isCountryCode(countryCode) ? COUNTRIES[countryCode] : null;
  const horario = businessHours === null ? null : parseBusinessHours(businessHours);
  // E46: un PUT con un solo campo no puede tocar los demas. Hasta el 2026-09-18, ocho campos usaban
  // `x || null` y tres `Boolean(x)`: omitirlos no los dejaba como estaban, los BORRABA (a null los
  // primeros, a false los otros tres). O sea que partir el guardado por seccion del panel - mandar solo
  // lo que esa seccion edita - habria apagado en silencio el envio automatico de fotos, el pedido de
  // comprobante y el nombre del asistente de cualquier negocio que guardara otra seccion.
  // El patron es el que el resto de este bloque ya usaba: `undefined` significa "no tocar" para Prisma;
  // presente-pero-vacio sigue significando "borrar", que es lo que hace el formulario al vaciar un campo.
  const business = await prisma.business.update({
    where: { id: businessIdOf(req) },
    data: {
      name,
      description,
      customInstructions,
      assistantName: assistantName !== undefined ? assistantName || null : undefined,
      botTone: botTone !== undefined ? botTone || null : undefined,
      botDialect: botDialect !== undefined ? botDialect || null : undefined,
      botGreeting: botGreeting !== undefined ? botGreeting || null : undefined,
      botNeverSay: botNeverSay !== undefined ? botNeverSay || null : undefined,
      autoSendPhotoOnQuote: autoSendPhotoOnQuote !== undefined ? Boolean(autoSendPhotoOnQuote) : undefined,
      offerPhotosBeforeSending: offerPhotosBeforeSending !== undefined ? Boolean(offerPhotosBeforeSending) : undefined,
      requirePaymentProof: requirePaymentProof !== undefined ? Boolean(requirePaymentProof) : undefined,
      // requiredEffectsEnabled NO se lee del body (2026-09-17). Que el bot verifique contra la base lo que
      // su propia respuesta dice haber hecho dejo de ser una opcion del panel, asi que tampoco puede
      // apagarse por esta ruta: un PUT con el campo en false no lo toca. Se cambia por SQL, a sabiendas.
      interactiveListsEnabled: interactiveListsEnabled !== undefined ? Boolean(interactiveListsEnabled) : undefined,
      attributeCheckEnabled: attributeCheckEnabled !== undefined ? Boolean(attributeCheckEnabled) : undefined,
      // Hasta donde llegan las fotos (2026-09-17). Un valor que no sea uno de los tres se ignora en vez
      // de guardarse: la columna es un enum, y un PUT viejo o un formulario a medias no puede dejar el
      // negocio con un alcance que el codigo no sabe leer.
      catalogPhotoScope: CATALOG_PHOTO_SCOPES.includes(catalogPhotoScope) ? catalogPhotoScope : undefined,
      businessCategory: businessCategory !== undefined ? businessCategory || null : undefined,
      contactPhone,
      contactName,
      ownerReminderMinutes: ownerReminderMinutes !== undefined ? Number(ownerReminderMinutes) : undefined,
      ownerQuestionTimeoutHours: ownerQuestionTimeoutHours !== undefined ? Number(ownerQuestionTimeoutHours) : undefined,
      intentEscalationTimeoutHours: intentEscalationTimeoutHours !== undefined ? Number(intentEscalationTimeoutHours) : undefined,
      followUpTemplateName: followUpTemplateName !== undefined ? followUpTemplateName || null : undefined,
      followUpTemplateLanguage: followUpTemplateLanguage || undefined,
      followUpDelayHours: followUpDelayHours !== undefined ? Number(followUpDelayHours) : undefined,
      abandonedAfterHours: abandonedAfterHours !== undefined ? Number(abandonedAfterHours) : undefined,
      cartRecoveryTemplateName: cartRecoveryTemplateName !== undefined ? cartRecoveryTemplateName || null : undefined,
      cartRecoveryTemplateLanguage: cartRecoveryTemplateLanguage || undefined,
      genderedAddressEnabled: genderedAddressEnabled !== undefined ? Boolean(genderedAddressEnabled) : undefined,
      femaleAddressTerm: femaleAddressTerm === "" ? null : femaleAddressTerm,
      maleAddressTerm: maleAddressTerm === "" ? null : maleAddressTerm,
      shippingPaymentModalities: Array.isArray(shippingPaymentModalities) ? shippingPaymentModalities : undefined,
      countryCode: pais?.code,
      currency: currency ? String(currency).trim().toUpperCase() : pais?.defaultCurrency,
      timezone: timezone ? String(timezone).trim() : pais?.defaultTimezone,
      // businessHours:null borra el horario; ausente lo deja como esta; un objeto mal formado tampoco se
      // guarda a medias (parseBusinessHours devuelve null y se trata como "sin horario").
      businessHours: businessHours === undefined ? undefined : (horario ?? Prisma.DbNull),
      requiresIdDocument: requiresIdDocument !== undefined ? Boolean(requiresIdDocument) : undefined,
      idDocumentExemptZones: Array.isArray(idDocumentExemptZones)
        ? idDocumentExemptZones.map((z: unknown) => String(z).trim()).filter(Boolean)
        : undefined,
    },
  });
  const { passwordHash: _hash, whatsappAccessToken: _token, ...safe } = business;
  res.json(safe);
});

// Los paises que el producto soporta hoy, para que el panel no mantenga su propia copia de la lista.
businessRouter.get("/api/countries", (_req, res) => {
  res.json({
    countries: COUNTRY_CODES.map((code) => ({
      code,
      label: COUNTRIES[code].label,
      defaultCurrency: COUNTRIES[code].defaultCurrency,
      defaultTimezone: COUNTRIES[code].defaultTimezone,
      documentLabel: COUNTRIES[code].documentLabel,
      requiresIdDocumentByDefault: COUNTRIES[code].requiresIdDocumentByDefault,
    })),
  });
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

businessRouter.post("/api/business/profile-photo", requireOwner, adminCostlyLimiter, upload.single("file"), async (req, res) => {
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

businessRouter.post("/api/improve-instructions", requireOwner, adminCostlyLimiter, async (req, res) => {
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
