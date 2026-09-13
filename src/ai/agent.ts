import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL } from "./client";
import { catalogTools, runCatalogTool, type ToolContext } from "./tools";
import { getRecentHistory } from "../conversation/service";
import { logAiUsage } from "./usage";
import { prisma } from "../db/client";
import { listActiveProducts, textMentionsConfiguredCategory } from "../catalog/products";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { canonicalColors } from "../catalog/attributeTaxonomy";
import { tokenize, normalizeForMatch } from "../search/text";
import { buildSystemPrompt, type BotPersonality } from "./prompts/systemPrompt";
import { CLOSING_MESSAGE_PROMPT } from "./prompts/closingMessage";

// Track C item 1 (ONIX-RELIABILITY-PLAN.md): prompt template literals (BASE_SYSTEM_PROMPT and its
// directives, buildSystemPrompt, CLOSING_MESSAGE_PROMPT) live in ./prompts/ now, separate from the
// tool-calling orchestration/guards below - pure refactor, no behavior change. Re-exported here so
// existing `from "./agent"` / `from "../ai/agent"` imports across the codebase are unaffected.
export { buildSystemPrompt, type BotPersonality };

function toOpenAiRole(role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"): "user" | "assistant" {
  return role === "ASSISTANT" ? "assistant" : "user";
}

function messageText(m: { content: string; imageAnalysis: string | null }): string {
  if (!m.imageAnalysis) return m.content;
  const caption = m.content.trim();
  return `${caption ? `${caption}\n\n` : ""}[Analisis de imagen adjunta]: ${m.imageAnalysis}`;
}

// getRecentHistory only sends the last RECENT_WINDOW messages to the model - a long conversation would
// otherwise lose everything said before that. Instead of re-summarizing the whole older-messages history
// from scratch each time (which grows unbounded), this only feeds the newly-aged-out slice through the
// model to fold into the existing summary, so each refresh stays cheap regardless of how long the
// conversation eventually gets.
const CONTEXT_SUMMARY_WINDOW = 20;
const CONTEXT_SUMMARY_REFRESH_EVERY = 10;

export async function getOrRefreshContextSummary(conversationId: string, businessId: string): Promise<string | null> {
  const total = await prisma.message.count({ where: { conversationId } });
  if (total <= CONTEXT_SUMMARY_WINDOW) return null;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contextSummary: true, contextSummarizedUpTo: true },
  });

  const olderCount = total - CONTEXT_SUMMARY_WINDOW;
  const lastUpTo = conversation?.contextSummarizedUpTo ?? 0;

  if (conversation?.contextSummary && olderCount - lastUpTo < CONTEXT_SUMMARY_REFRESH_EVERY) {
    return conversation.contextSummary;
  }

  const newlyAgedMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    skip: lastUpTo,
    take: olderCount - lastUpTo,
  });
  if (newlyAgedMessages.length === 0) return conversation?.contextSummary ?? null;

  const roleLabel = { CUSTOMER: "Cliente", ASSISTANT: "Bot", SYSTEM: "Sistema" } as const;
  const transcript = newlyAgedMessages.map((m) => `${roleLabel[m.role]}: ${m.content}`).join("\n");

  try {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content:
            "Actualiza el resumen de esta conversacion de ventas por WhatsApp combinando el resumen " +
            "anterior con los mensajes nuevos. 3-4 frases cortas en español: que producto(s) le " +
            "interesaron al cliente, que datos ya dio (nombre, direccion, forma de pago), en que quedo " +
            "la conversacion. Sin relleno, sin saludos.",
        },
        {
          role: "user",
          content: `Resumen anterior: ${conversation?.contextSummary || "(ninguno todavia)"}\n\nMensajes nuevos:\n${transcript}`,
        },
      ],
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types.
      thinking: { type: "disabled" },
    });

    await logAiUsage({
      businessId,
      conversationId,
      kind: "CHAT",
      model: DEEPSEEK_MODEL,
      usage: response.usage,
    });

    const summary = response.choices[0]?.message?.content?.trim();
    if (!summary) return conversation?.contextSummary ?? null;

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { contextSummary: summary, contextSummarizedUpTo: olderCount },
    });
    return summary;
  } catch (error) {
    console.error("No se pudo actualizar el resumen de contexto de la conversacion:", error);
    return conversation?.contextSummary ?? null;
  }
}

// Safety net for when the model claims "ya te la mande" without actually calling the tool - fires
// only if nothing was sent this turn AND either the customer explicitly asked for media, or the
// model's own reply text claims to have sent some, so it never overrides or duplicates what the model
// already did on its own.
export const PHOTO_REQUEST_PATTERN =
  /\b(foto|fotos|imagen|imagenes|imágenes|video|videos|muestra|muéstrame|muestrame|enseñ|ense[nñ]a|mandame|mándame|manda la|envia la|envía la|pasame|pásame|regal[aá]me|regala la)\b/i;
// Broadened beyond "te mand.." to also catch phrasings without "te" ("ya la mande", "ahi la envio") and
// "aca"/"aqui esta(n)" - a real conversation slipped through the narrower pattern with "ya se la mande".
export const PHOTO_CLAIM_PATTERN =
  /\b(te (mand|envi|pas)|ya (te |se la |la |lo )?(mand|envi|pas)\w*|aqu[ií] (te|va|van|est[aá])|ac[aá] (te|va|van|est[aá])|ah[ií] (te|va|van))/i;
// "te (mand|envi|pas)" above also matches a conditional offer inside a still-open clarifying question
// ("Dime el número o el nombre y te paso fotos y detalles, ¿cuál prefieres?") - that's a promise
// contingent on the customer's answer, not a claim that photos already went out. Real production bug
// (2026-09-12): bot listed 4 options with that exact phrasing on the FIRST turn (nothing asked yet by
// the customer), the claim pattern fired anyway, and the media backstop below matched all 4 option
// names present in the bot's own reply text - sending 4 unrequested photos, several not even matching
// what the customer asked for, before the customer had picked one.
export const OPEN_CLARIFYING_QUESTION_PATTERN =
  /\bcu[aá]l\b.{0,30}\b(prefer|interes|te (gust|llam))|\bdime\b.{0,20}\b(n[uú]mero|nombre)\b/i;
// The model sometimes fabricates the exact "[Foto de X]"/"[Video de X]" caption that recordMessage
// writes for a REAL send, without ever calling send_product_media - a copy-the-pattern hallucination,
// not a natural-language claim, so it doesn't match PHOTO_CLAIM_PATTERN above. Catch it directly.
const FAKE_MEDIA_TAG_PATTERN = /\[(?:foto|video)s? de /i;
const MEDIA_TAG_STRIP_PATTERN = /\[(?:foto|video)s? de [^\]]*\]/gi;

// Shared guard for the three claim-patterns below: each was built to catch a dropped-promise bug (model
// says it'll do something, never calls the real tool), but the same claim wording also shows up inside a
// conditional OFFER still awaiting the customer's go-ahead ("¿Quieres que consulte con el equipo?", "Si
// prefieres te comparto las opciones de pago", "...en cuanto confirmes el pedido") - not a claim that the
// action already happened. Confirmed same bug class as PHOTO_CLAIM_PATTERN/OPEN_CLARIFYING_QUESTION_PATTERN
// above (2026-09-12 photo regression): without this, ask_owner/get_payment_methods/search_products fire on
// an unresolved offer, before the customer agreed to it - worst case is ESCALATION, which pings the real
// owner with no customer consent. Verified against both the offer phrasings above and the original
// dropped-promise phrasings each pattern was built for (see agent.claimBackstopGuards.test.ts) - the guard
// doesn't suppress the real cases, only the conditional-offer ones.
export const OFFER_OR_PENDING_CONFIRMATION_PATTERN =
  /\b(si (quieres|prefieres|gustas|deseas)|(quieres|prefieres|gustar[ií]as?|gustas|deseas)\b.{0,15}\bque\b|en cuanto (confirmes|me digas|decidas|me cuentes))/i;

// Same failure mode as the photo claim above, for escalation: the model says "ya consulto con el
// equipo" / "dejame confirmar con el equipo" without actually calling ask_owner - confirmed against a
// real conversation where a customer's shipping-cost question got this exact non-answer and the owner
// never received anything, because no tool call ever fired. The system prompt already tells it not to
// do this (see PROMETER NO ES HACER) - this is the code-level backstop for when that's not enough.
export const ESCALATION_CLAIM_PATTERN =
  /\b(equipo|due[ñn][oa]s?)\b.{0,25}\b(consult|confirm|pregunt|revis)|\b(consult|confirm|pregunt|revis)\w*\b.{0,25}\b(equipo|due[ñn][oa]s?)\b/i;

// Same failure mode once more, this time for get_payment_methods: the bot asks "que medio prefieres
// usar? te comparto las opciones disponibles" and ends the turn right there without ever calling the
// tool or listing anything - confirmed against a real conversation where the customer had to ask
// "opciones de pago" again before getting an actual answer. No digit run at all in the text is the tell
// that nothing real was attached (a message that actually lists payment methods always has numbers in
// it).
export const PAYMENT_OPTIONS_CLAIM_PATTERN = /\b(te comparto|te paso|aqu[ií] (est[aá]n|tenes)|estas son)\b.{0,20}\bopciones\b/i;

// Same dropped-promise family, for shipping-PAYMENT-MODALITY (who pays shipping and when - see
// Business.shippingPaymentModalities in schema.prisma) - a different axis from PAYMENT_OPTIONS_CLAIM_PATTERN
// above (which channel: Nequi/tarjeta/etc). Only relevant for businesses that configured this concept at
// all - gated separately in finalizeTurn, not by this pattern alone.
export const SHIPPING_MODALITY_CLAIM_PATTERN =
  /\b(anticipado|contraentrega|contra entrega)\b.{0,25}\b(opciones|modalidad(es)?|prefer[ií]s?|prefier(es|e)?|elegir)\b|\b(opciones|modalidad(es)?)\b.{0,25}\b(anticipado|contraentrega|contra entrega)\b/i;

// Same failure mode once more, this time for the catalog: the bot says "dejame revisar el catalogo para
// confirmarte bien" (or similar) and stops there without ever calling search_products/list_all_products -
// confirmed against a real conversation where the customer had no idea the bot was waiting on anything and
// the owner had to take over manually just to get the bot to continue. Fires only when no catalog tool ran
// this turn - re-runs search_products with the customer's own message as the query (search_products
// already falls back to the full catalog on no keyword match, see CATALOGO above) and appends a plain list
// so the customer gets something real instead of a dropped promise.
export const CATALOG_CHECK_CLAIM_PATTERN =
  /\bcat[aá]logo\b.{0,25}\b(revis|confirm|consult|chequ|mir[ao])|\b(revis|confirm|consult|chequ|mir[ao])\w*\b.{0,25}\bcat[aá]logo\b/i;

// Same failure mode again, this time for save_customer_name: the bot asks "a nombre de quien hago el
// pedido?", the customer answers with just their name, and the bot's next reply acknowledges it
// ("Perfecto, David!") without ever having called save_customer_name - confirmed against a real
// conversation where the owner had to add the name by hand afterward. Only fires when the bot's PRIOR
// turn actually asked for the name (so a random two-word customer message elsewhere never gets
// mistaken for one) and the customer's answer is shaped like a name, not a sentence.
export const ASK_NAME_PATTERN =
  /\b(a nombre de qui[eé]n|tu nombre completo|nombre completo|c[oó]mo te llamas|cu[aá]l es tu nombre|tu nombre,? por favor)\b/i;

// Same failure mode once more, for the case the prior fix didn't cover: the customer volunteers their
// name unprompted ("Hola soy David", "mi nombre es Maria Jose") instead of answering a question that
// asked for it - ASK_NAME_PATTERN never matches because the bot never asked, so the tool call depended
// entirely on the model remembering to do it on its own. That's the gap behind the recurring "the bot
// isn't saving the name automatically anymore, we've had to add it by hand" complaint.
const SELF_INTRO_NAME_PATTERN = /\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,3})/i;
const NOT_A_NAME = new Set([
  "si", "sí", "no", "ok", "listo", "gracias", "hola", "buenas", "dale", "vale", "hey", "chao", "claro",
  "ala", "parce", "parcero", "oiga", "uy", "bacano", "hermano", "ey",
]);

// Explicit request for a human agent - the most unambiguous of the PQR/queja signals, kept narrow on
// purpose (general complaint/sentiment detection stays with the model, too fuzzy for a regex to avoid
// false positives like "necesito ayuda con la talla"). Code-level backstop for when the model reads a
// clear "quiero hablar con una persona" and just keeps chatting instead of calling
// flag_conversation_intent.
const HUMAN_REQUEST_PATTERN =
  /hablar con (una persona|alguien real|un humano|un asesor|un agente)|(pas|comunic)\w* con (un asesor|un agente|una persona|un humano)|quiero (un humano|hablar con alguien)|no quiero (hablar con )?(un )?bot/i;

export function customerRequestsHuman(text: string): boolean {
  return HUMAN_REQUEST_PATTERN.test(text);
}

// Fallback for the order-closed confirmation when there's no customInstructions to follow, or the
// one-shot closing generation below fails/returns nothing - dialect doesn't change this particular
// sentence (no "tenés"/"tienes" style conjugation in it), only tone (formality/emoji) and sign-off vary.
export function buildOrderClosedMessage(business: { botTone?: string | null; assistantName?: string | null }): string {
  const formal = business.botTone === "formal" || business.botTone === "profesional";
  const signOff = business.assistantName?.trim() ? ` - ${business.assistantName.trim()}` : "";
  return formal
    ? `Tu pago quedo confirmado y tu pedido esta cerrado. Gracias por tu compra.${signOff}`
    : `¡Listo! Tu pago quedo confirmado y tu pedido esta cerrado. Gracias por tu compra 🎉${signOff}`;
}

export interface ClosingOrderFacts {
  customerName: string | null;
  summary: string;
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shippingCost: number | null;
  totalAmount: number;
  currency: string;
}

// One-shot completion (no tools, no agent loop) - deliberately NOT routed through generateReply/the
// tool-calling agent, since this fires from the deterministic owner-confirms-payment code path where
// re-running the full agent could re-trigger close_conversation or other tools and double up the order.
export async function generateClosingMessage(
  businessId: string,
  conversationId: string,
  business: { customInstructions?: string | null; botTone?: string | null; assistantName?: string | null },
  order: ClosingOrderFacts
): Promise<string> {
  if (!business.customInstructions?.trim()) return buildOrderClosedMessage(business);

  const orderFacts = `Instrucciones especificas de este negocio:
${business.customInstructions.trim()}

Datos reales de este pedido:
- Cliente: ${order.customerName ?? "(sin nombre registrado)"}
- Resumen: ${order.summary}
- Direccion de envio: ${order.shippingAddress ?? "(no registrada)"}
- Forma de pago: ${order.paymentMethodLabel ?? "(no registrada)"}
- Costo de envio: ${order.shippingCost != null ? order.shippingCost : "(no registrado)"}
- Total: ${order.totalAmount} ${order.currency}`;

  try {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 400,
      messages: [
        { role: "system", content: CLOSING_MESSAGE_PROMPT },
        { role: "user", content: orderFacts },
      ],
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning tokens
      // leave message.content empty for a short generation task like this one.
      thinking: { type: "disabled" },
    });
    await logAiUsage({ businessId, conversationId, kind: "CHAT", model: DEEPSEEK_MODEL, usage: response.usage });
    const text = response.choices[0]?.message?.content?.trim();
    return text || buildOrderClosedMessage(business);
  } catch (error) {
    console.error("No se pudo generar el mensaje de cierre personalizado, usando el generico:", error);
    return buildOrderClosedMessage(business);
  }
}

function looksLikePersonName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  if (!words.every((w) => /^[A-Za-zÀ-ÿ'-]+$/.test(w))) return false;
  return !NOT_A_NAME.has(trimmed.toLowerCase());
}

// "soy"/"mi nombre es"/"me llamo" also introduce non-name words in ordinary Spanish ("soy de Bogota",
// "soy yo", "soy nuevo por aca") - looksLikePersonName alone doesn't catch these since they're still
// 1-4 alphabetic words. Reject when the word right after the trigger is one of these common cases
// instead of a name.
const SELF_INTRO_STOPWORDS = new Set([
  "de", "yo", "nuevo", "nueva", "quien", "quién", "asi", "así", "cliente", "el", "la", "los", "las",
  "un", "una", "aqui", "aquí", "aca", "acá", "alli", "allí", "ahi", "ahí", "bien", "mal", "nadie", "alguien",
]);

// Pulls a name out of an unprompted self-introduction ("Hola soy David Gomez"), independent of whatever
// the bot last said. Exported for a cheap pure-function regression test - no need to hit the real LLM
// just to check this extraction.
export function extractSelfIntroducedName(customerText: string): string | null {
  const match = customerText.match(SELF_INTRO_NAME_PATTERN);
  if (!match) return null;
  const candidate = match[1].trim();
  const firstWord = candidate.split(/\s+/)[0].toLowerCase();
  if (SELF_INTRO_STOPWORDS.has(firstWord)) return null;
  return looksLikePersonName(candidate) ? candidate : null;
}

// Same pattern once more, for cedula/celular de contacto - split into two separate patterns since a
// business can ask for both in the same message ("cedula y celular"), and a single numeric reply in
// that case is ambiguous about which one it answers, so the net only fires when the prior turn asked
// for exactly one of the two (safer to miss it than to save a phone number as a cedula or vice versa).
const ASK_ID_PATTERN = /\b(numero de (identificaci[oó]n|c[eé]dula)|tu c[eé]dula|c[eé]dula,? por favor)\b/i;
const ASK_PHONE_PATTERN = /\b(numero de celular|tu celular|celular de contacto|celular,? por favor)\b/i;

const PAYMENT_MENTION_PATTERN = /nequi|bancolombia|daviplata|titular|transferencia|llave/i;

// Prompt instructions alone weren't enough to stop the model from occasionally fabricating an entire
// fake account number + titular for a real payment method (seen in production: a completely invented
// Nequi number and name, not even close to the real configured one - real money risk). This is the hard
// backstop: if the reply mentions payment details but contains a 7+ digit run that isn't in ANY of the
// real configured methods, don't trust the model's text at all - replace it with the real data verbatim.
export function guardAgainstPaymentHallucination(
  text: string,
  paymentMethods: { label: string; details: string }[] | null
): string {
  if (!paymentMethods?.length || !PAYMENT_MENTION_PATTERN.test(text)) return text;
  const knownDigits = paymentMethods.map((m) => m.details.replace(/\D/g, "")).join("|");
  const digitRuns = text.match(/\d{7,}/g) ?? [];
  const hasUnverifiedNumber = digitRuns.some((run) => !knownDigits.includes(run));
  if (!hasUnverifiedNumber) return text;

  console.error("Dato de pago inventado por el modelo, reemplazado por los datos reales configurados:", {
    modelText: text,
    realMethods: paymentMethods,
  });
  return [
    "¡Perfecto! Estos son los datos reales para el pago:",
    ...paymentMethods.map((m) => `*${m.label}*\n${m.details}`),
  ].join("\n\n");
}

// Un metodo real puede combinar varios canales en una sola etiqueta (ej. "Nequi, Llave o Daviplata") -
// el modelo confirma con el cliente solo el canal puntual que uso ("Nequi"), no la etiqueta completa.
// Encontrado por npm run regression 2026-09-13: el match exacto original bloqueaba close_conversation en
// 6/37 conversaciones reales de MAGByLizN, siempre por este mismo motivo (su unico metodo configurado
// combina 3 canales). Acepta el match si todas las palabras del label del modelo aparecen entre las del
// label real, ademas del match exacto original.
export function matchesConfiguredPaymentMethod(label: string, realMethods: { label: string }[]): boolean {
  const inputLabelNorm = normalizeForMatch(label.trim());
  const inputTokens = tokenize(label.trim());
  return realMethods.some((m) => {
    if (normalizeForMatch(m.label) === inputLabelNorm) return true;
    if (inputTokens.length === 0) return false;
    const realTokens = new Set(tokenize(m.label));
    return inputTokens.every((t) => realTokens.has(t));
  });
}

const SHIPPING_MENTION_PATTERN = /env[ií]o/i;

// Detection-only, unlike guardAgainstPaymentHallucination above: a shipping cost is usually one clause
// inside a longer message (order summary, product price alongside it), so blindly discarding the whole
// reply the way the payment guard does would also nuke unrelated real content. And with several
// configured tiers (see ShippingRate/get_shipping_rates), there's no single "the real number" to
// auto-substitute the way the full payment-methods list works as a fallback - so this only logs for
// visibility instead of rewriting the customer-facing text, closing half the gap (a real number source
// now exists via the tool) without risking a worse mutation on the other half.
export function guardAgainstShippingCostHallucination(
  text: string,
  shippingRates: { label: string; cost: string }[] | null
): void {
  if (!shippingRates?.length || !SHIPPING_MENTION_PATTERN.test(text)) return;
  // Parse-and-round rather than stripping non-digits like the reply-text side does below: a Decimal's
  // toString() can carry a real fractional part ("9000.00", or worse with no @db.Decimal scale set,
  // "9000.000000000000000000000000") - stripping the "." there concatenates the fraction's zeros onto the
  // integer part instead of discarding them, corrupting every comparison. Colombian peso amounts in the
  // reply text, by contrast, only ever use "." as a thousands separator with no real fraction, so stripping
  // non-digits there is correct.
  const knownCosts = new Set(shippingRates.map((r) => String(Math.round(parseFloat(r.cost)))));
  // [ \t]? (not \s?) between the number and "envio" - \s also matches newline, which let an unrelated
  // number on the PREVIOUS bullet line (e.g. the product price, "$145.000\n- Envio: ...") get treated as
  // "near" the word envio just because a line break and a bullet character separated them. Found by the
  // regression suite: every real, correctly-quoted shipping cost was flagged as a false positive because
  // the chunk it grabbed was actually the product price line above it, not the real shipping line.
  //
  // Forward direction only (envio, THEN the number) - a reverse "number, then envio within 15 chars"
  // branch used to also fire on "producto ($46.000) + el envio" and "$145.000) y el envio", grabbing the
  // PRODUCT price sitting right before the word envio instead of an actual shipping figure. The real
  // phrasing this bot uses always states envio's own cost after the word, never before it.
  //
  // Digit run capped at 4-6 (not 4-9): every real configured tier tops out at 6 digits (88.900), while a
  // cedula or celular runs 7-10 - capping here also stops the fake anonymized placeholder digits
  // ("00000000"/"3000000000") from a nearby "datos de entrega" block being mistaken for a cost.
  const nearbyChunks = text.match(/env[ií]o[^.\n]{0,40}?\$?[ \t]?[\d.,]{4,6}\b/gi) ?? [];
  for (const chunk of nearbyChunks) {
    const digits = (chunk.match(/[\d.,]{4,6}/) ?? [""])[0].replace(/\D/g, "");
    if (digits.length >= 4 && digits.length <= 6 && !knownCosts.has(digits)) {
      console.error("Costo de envio mencionado no coincide con ninguna tarifa real configurada - revisar:", {
        modelText: text,
        realRates: shippingRates,
      });
      return;
    }
  }
}

function looksLikeIdOrPhone(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[\d\s-]{6,15}$/.test(trimmed)) return false;
  return /\d{6,}/.test(trimmed.replace(/\D/g, ""));
}

// Strips numbered-list markers ("1. ", "2) ", "3- ") at the start of a line before tokenizing - a real
// production bug (2026-09-12): the bot's own numbered option list ("1. Serie 11 Mini... 4. Smartwatch
// V20 Caballero") left a bare "4" token in the haystack, which then coincidentally matched the literal
// "4" in an unrelated product's actual name ("AIRPODS SERIE 4") - combined with "Serie" being a shared
// brand word across both categories in this catalog, that unrelated product crossed the 0.6 overlap
// threshold and got its photo sent alongside the real watches. List numbering was never meant to carry
// matching evidence; the product's real name text (what follows the marker) still does.
const LIST_MARKER_PATTERN = /^\s*\d+[.):]\s*/gm;

// Token-overlap match (not exact substring - the model paraphrases names constantly, e.g. "Boombox 4
// LED" for "Parlante Bluetooth Portatil Boombox 4 LED") against a haystack that should already include
// the customer's message, the bot's current reply, AND the bot's prior turn (see the photo-claim
// backstop in finalizeTurn for why the prior turn matters). Exported as a pure function for a cheap
// regression test - no DB/LLM needed to verify the matching decision itself.
export function findMentionedProductsForMediaBackstop<T extends { name: string; media: unknown[]; category?: string | null }>(
  products: T[],
  haystack: string
): T[] {
  const haystackTokens = new Set(tokenize(haystack.replace(LIST_MARKER_PATTERN, " ")));
  const scored = products
    .map((p) => {
      if (p.media.length === 0) return null;
      const nameTokens = tokenize(p.name);
      if (nameTokens.length === 0) return null;
      const hits = nameTokens.filter((t) => haystackTokens.has(t)).length;
      const ratio = hits / nameTokens.length;
      return ratio >= 0.6 ? { product: p, ratio } : null;
    })
    .filter((x): x is { product: T; ratio: number } => x !== null);
  const matched = scored.map((s) => s.product);

  // Defense in depth beyond the list-marker fix above: once the matches clearly settle on ONE dominant
  // category, drop any WEAK minority-category outlier - a shared generic word or any other future token
  // collision can drag in a product from a totally different category, and the real intent behind "show
  // me photos of the ones you just listed" is usually "more of the same kind of thing", never a silent
  // category switch. Only acts on a clear majority (strictly more matches in one category than any
  // other) - on a tie, stay silent rather than guess which category the customer actually meant.
  //
  // Never drops a NEAR-EXACT name match (ratio >= 0.9) regardless of category - a real production case
  // (2026-09-13): a business's own "combo" lineup spans categories on purpose (a watch combo and an
  // earbuds combo both fully named in the same list), and the customer/bot naming one by its complete
  // real name is far stronger evidence of real intent than a same-category headcount. The original bug
  // this guard fixed matched its outlier through a stray shared token (a brand word plus a coincidental
  // list-number digit), never the product's full name - that distinction is exactly what ratio captures.
  const categoryCounts = new Map<string, number>();
  for (const p of matched) {
    if (p.category) categoryCounts.set(p.category, (categoryCounts.get(p.category) ?? 0) + 1);
  }
  const sortedCategories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedCategories.length < 2 || sortedCategories[0][1] > sortedCategories[1][1]) {
    const dominantCategory = sortedCategories[0]?.[0];
    if (dominantCategory) {
      return scored.filter((s) => !s.product.category || s.product.category === dominantCategory || s.ratio >= 0.9).map((s) => s.product);
    }
  }
  return matched;
}

// Strips WhatsApp markdown emphasis (*bold*, _italic_) - real production bug (2026-09-13): the bot wrote
// "¿Me confirmas tu *nombre*, por favor?" (bold per its own ESTILO), and ASK_NAME_PATTERN/ASK_ID_PATTERN/
// ASK_PHONE_PATTERN below look for the literal phrase as contiguous text ("tu nombre, por favor") - the
// asterisks around the key word broke every one of these regexes silently, so save_customer_name/
// save_customer_contact_info never fired even though the bot's own reply proves it DID ask and the
// customer DID answer. Confirmed via a real customer stuck as "Mano" in the panel after giving "Carlos".
export function stripMarkdownEmphasis(text: string): string {
  return text.replace(/[*_]/g, "");
}

function lastAssistantText(history: { role: string; content: string }[]): string {
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].role === "ASSISTANT") return stripMarkdownEmphasis(history[i].content);
    if (history[i].role === "CUSTOMER") break;
  }
  return "";
}

// The "model claimed X happened but never called the real tool" backstops (payment options, shipping
// modality, catalog check, escalation) all repeat the exact same shape: skip if the real tool already ran
// this turn, skip unless some extra per-guard condition holds, then check CLAIM_PATTERN vs the shared
// OFFER_OR_PENDING_CONFIRMATION_PATTERN suppressor. This registry replaces four copy-pasted if-blocks with
// one loop (reliability plan Phase 1, 2026-09-13) - pure refactor, no behavior change. Verified against
// agent.claimBackstopGuards.test.ts and agent.corePersonality.test.ts.
type ClaimBackstopGuard = {
  name: string;
  pattern: RegExp;
  suppressor: RegExp;
  alreadyHandled: boolean;
  extraCondition: boolean;
  // Match against a markdown-stripped copy of the CURRENT turn's text, not the real text - closes the
  // same gap stripMarkdownEmphasis already closed for lastAssistantText/history (see that function's
  // comment): the model's own bolded "*te comparto* las opciones" would otherwise silently disarm this
  // backstop, since the pattern expects the key phrase as contiguous plain text.
  matchAgainstStrippedText?: boolean;
  repair: (text: string) => Promise<string>;
};

async function applyClaimBackstops(text: string, guards: ClaimBackstopGuard[]): Promise<string> {
  for (const guard of guards) {
    if (guard.alreadyHandled || !guard.extraCondition) continue;
    const testText = guard.matchAgainstStrippedText ? stripMarkdownEmphasis(text) : text;
    if (guard.pattern.test(testText) && !guard.suppressor.test(testText)) {
      text = await guard.repair(text);
    }
  }
  return text;
}

export async function generateReply(
  conversationId: string,
  context: ToolContext,
  personality?: BotPersonality | null,
  customerText?: string
): Promise<string> {
  const history = await getRecentHistory(conversationId);
  const contextSummary = await getOrRefreshContextSummary(conversationId, context.businessId);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(personality) },
    ...(contextSummary
      ? [
          {
            role: "system" as const,
            content: `RESUMEN DE LO HABLADO ANTES (mensajes mas viejos que ya no ves completos): ${contextSummary}`,
          },
        ]
      : []),
    ...history.map((m) => ({
      role: toOpenAiRole(m.role),
      content: messageText(m),
    })),
  ];

  let lastText = "";
  let mediaSentThisTurn = 0;
  let ownerAskedThisTurn = 0;
  let nameSavedThisTurn = 0;
  let contactSavedThisTurn = 0;
  let intentFlaggedThisTurn = 0;
  let catalogCheckedThisTurn = 0;
  let paymentMethodsThisTurn: { type: string; label: string; details: string }[] | null = null;
  let shippingRatesThisTurn: { label: string; cost: string }[] | null = null;
  // Set only when find_products_by_attributes ran this turn AND resolved unambiguously (not spanning
  // several categories with no category given - see "el rosadito" handling in tools.ts). This is the
  // real fix for "reloj negro sends airpods/wrong colors" (2026-09-12): the media backstop below prefers
  // this already-scoped result set over guessing from prose whenever it's available, instead of
  // re-deriving "which products" by scanning text for any name overlap (blind to color/category).
  let attributeMatchThisTurn: { productId: string; productName: string; variantId: string | null }[] | null = null;
  // Same idea as attributeMatchThisTurn, for search_products instead of find_products_by_attributes: set
  // only when this turn's keyword search resolved to exactly ONE product (no color/variant scoping
  // possible from a plain keyword search, so variantId is always null here). Lets the send_product_media
  // guard below also catch a stale productId when THIS tool, not find_products_by_attributes, is what
  // actually scoped the product this turn (reliability plan Phase 2, item 3, 2026-09-13).
  let searchScopedThisTurn: { productId: string; productName: string; variantId: string | null }[] | null = null;
  let shippingModalitiesThisTurn: { code: string; label: string }[] | null = null;

  async function finalizeTurn(text: string): Promise<string> {
    text = guardAgainstPaymentHallucination(text, paymentMethodsThisTurn);

    // Verify shipping-cost mentions even if the model never called get_shipping_rates this turn (it may
    // have paraphrased a business's own free-text tier table instead) - fetch the real rates ourselves
    // just for this check whenever shipping is mentioned. Read-only, no side effect on the order/reply.
    if (!shippingRatesThisTurn && SHIPPING_MENTION_PATTERN.test(text)) {
      const shippingResult = (await runCatalogTool(context, "get_shipping_rates", {})) as {
        rates?: { label: string; cost: string }[];
      };
      if (shippingResult?.rates?.length) shippingRatesThisTurn = shippingResult.rates;
    }
    guardAgainstShippingCostHallucination(text, shippingRatesThisTurn);

    text = await applyClaimBackstops(text, [
      {
        name: "payment_options",
        pattern: PAYMENT_OPTIONS_CLAIM_PATTERN,
        suppressor: OFFER_OR_PENDING_CONFIRMATION_PATTERN,
        alreadyHandled: !!paymentMethodsThisTurn,
        extraCondition: !/\d{6,}/.test(text),
        matchAgainstStrippedText: true,
        repair: async (t) => {
          const result = (await runCatalogTool(context, "get_payment_methods", {})) as {
            methods?: { label: string; details: string }[];
          };
          if (!result?.methods?.length) return t;
          return `${t}\n\n${result.methods.map((m) => `*${m.label}*\n${m.details}`).join("\n\n")}`;
        },
      },
      {
        // Same dropped-promise family, for shipping-payment-modality - only fires for a business that
        // actually configured this concept (empty for most businesses, see
        // Business.shippingPaymentModalities).
        name: "shipping_modality",
        pattern: SHIPPING_MODALITY_CLAIM_PATTERN,
        suppressor: OFFER_OR_PENDING_CONFIRMATION_PATTERN,
        alreadyHandled: !!shippingModalitiesThisTurn,
        extraCondition: !!(personality?.shippingPaymentModalities && personality.shippingPaymentModalities.length > 0),
        repair: async (t) => {
          const result = (await runCatalogTool(context, "get_shipping_payment_modalities", {})) as {
            modalities?: { code: string; label: string }[];
          };
          if (!result?.modalities?.length) return t;
          return `${t}\n\n${result.modalities.map((m, i) => `${i + 1}. ${m.label}`).join("\n")}`;
        },
      },
      {
        name: "catalog_check",
        pattern: CATALOG_CHECK_CLAIM_PATTERN,
        suppressor: OFFER_OR_PENDING_CONFIRMATION_PATTERN,
        alreadyHandled: catalogCheckedThisTurn !== 0,
        extraCondition: !!customerText,
        matchAgainstStrippedText: true,
        repair: async (t) => {
          const result = (await runCatalogTool(context, "search_products", { query: customerText })) as
            | { id: string; name: string; price: string; currency: string }[]
            | { results?: { id: string; name: string; price: string; currency: string }[] };
          const products = Array.isArray(result) ? result : result?.results ?? [];
          if (products.length === 0) return t;
          return `${t}\n\n${products
            .slice(0, 8)
            .map((p) => `*${p.name}* — $${p.price} ${p.currency}`)
            .join("\n")}`;
        },
      },
      {
        name: "escalation",
        pattern: ESCALATION_CLAIM_PATTERN,
        suppressor: OFFER_OR_PENDING_CONFIRMATION_PATTERN,
        alreadyHandled: ownerAskedThisTurn !== 0,
        extraCondition: !!customerText,
        matchAgainstStrippedText: true,
        repair: async (t) => {
          await runCatalogTool(context, "ask_owner", { question: customerText });
          return t;
        },
      },
    ]);

    if (intentFlaggedThisTurn === 0 && customerText && customerRequestsHuman(customerText)) {
      await runCatalogTool(context, "flag_conversation_intent", { intent: "SOLICITA_AGENTE" });
    }

    if (nameSavedThisTurn === 0 && customerText) {
      if (looksLikePersonName(customerText) && ASK_NAME_PATTERN.test(lastAssistantText(history))) {
        await runCatalogTool(context, "save_customer_name", { name: customerText.trim() });
      } else {
        const selfIntroName = extractSelfIntroducedName(customerText);
        if (selfIntroName) {
          await runCatalogTool(context, "save_customer_name", { name: selfIntroName });
        }
      }
    }

    if (contactSavedThisTurn === 0 && customerText && looksLikeIdOrPhone(customerText)) {
      const priorAsk = lastAssistantText(history);
      const askedId = ASK_ID_PATTERN.test(priorAsk);
      const askedPhone = ASK_PHONE_PATTERN.test(priorAsk);
      if (askedId && !askedPhone) {
        await runCatalogTool(context, "save_customer_contact_info", { idNumber: customerText.trim() });
      } else if (askedPhone && !askedId) {
        await runCatalogTool(context, "save_customer_contact_info", { deliveryPhone: customerText.trim() });
      }
    }

    if (mediaSentThisTurn > 0) return text;

    const customerAsked = !!customerText && PHOTO_REQUEST_PATTERN.test(customerText);
    const fakeMediaTag = FAKE_MEDIA_TAG_PATTERN.test(stripMarkdownEmphasis(text));
    const modelClaimsSent =
      (PHOTO_CLAIM_PATTERN.test(text) &&
        PHOTO_REQUEST_PATTERN.test(text) &&
        !OPEN_CLARIFYING_QUESTION_PATTERN.test(text)) ||
      fakeMediaTag;
    if (!customerAsked && !modelClaimsSent) return text;

    // The model can only have fabricated this tag, never really sent it (mediaSentThisTurn === 0 here) -
    // strip it so the customer doesn't see a broken "[Foto de X]" label alongside the real photos we're
    // about to send below.
    if (fakeMediaTag) {
      text = text.replace(MEDIA_TAG_STRIP_PATTERN, "").trim();
    }

    // Prefer this turn's ALREADY-SCOPED find_products_by_attributes result over re-deriving "which
    // products" by scanning prose - that scan is blind to category/color (any product NAME mention
    // counts), which is exactly how "reloj negro" used to also send airpods and non-black watches (real
    // production bug, 2026-09-12): the bot's own clarifying reply lists every candidate by name, so the
    // prose scan matched all of them regardless of color. When the model called the real filter this
    // turn, trust its result instead of re-guessing from text.
    if (attributeMatchThisTurn && attributeMatchThisTurn.length <= 5) {
      for (let i = 0; i < attributeMatchThisTurn.length; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
        const m = attributeMatchThisTurn[i];
        // A real WhatsApp send failure here (expired token, transient 5xx) used to throw uncaught all
        // the way out of generateReply - the text reply already generated for this turn never reached
        // the customer at all, not even the fallback apology, since this runs in the return path outside
        // generateReply's own try/catch. Degrade instead: log and keep going, so one failed photo never
        // silences the whole turn or blocks the rest of the batch.
        try {
          await runCatalogTool(context, "send_product_media", { productId: m.productId, variantId: m.variantId ?? undefined });
        } catch (error) {
          console.error("Fallo el envio de una foto en el backstop de atributos:", error);
        }
      }
      return text;
    }

    // Fallback for everything else (direct product-name requests, vague follow-ups like "y los otros
    // productos?") - scanning the customer's message, the model's own reply, AND the bot's own PRIOR turn
    // (token-overlap, not exact substring - the model paraphrases names constantly, e.g. "Boombox 4 LED"
    // for "Parlante Bluetooth Portatil Boombox 4 LED"). Blind to color/category by design (it only knows
    // product NAMES), which is exactly why the branch above takes priority whenever it's available.
    //
    // The prior-turn scan matters for a real, reported failure: bot lists 4 numbered smartwatch options
    // ("1. Serie 11 Mini... 2. Serie 12 Ultra 3...") and asks which one; customer replies "Muestrame
    // fotos" with no name at all, since they haven't seen any yet and can't name one sight-unseen - the
    // reasonable read of that is "show me all 4 you just listed", not "pick one for me" or a clarifying
    // question that would just repeat the same dead end. The specific names only live in the bot's PRIOR
    // message, never in this turn's customerText/text, so without this the code below found zero matches
    // and fell back to calling send_product_media with the raw customer text ("Muestrame fotos") as if it
    // were a product name - never matches anything, so the bot's false "aqui van las fotos" claim went
    // out with nothing actually sent.
    //
    // Must compare whole tokens, not substrings: haystack.includes(t) on the raw normalized string used
    // to match "pro" (from "AirPods Pro 2") against the "pro" inside "producto", and single-digit tokens
    // like "2"/"3" against any stray digit in a price - false-positiving completely unrelated products
    // into a customer message that never mentioned them.
    const products = await listActiveProducts(context.businessId);
    // Strip bare media-tag captions ("[Foto de X]") from the PRIOR turn before folding it into the
    // haystack - a real production bug (2026-09-12): the bot's prior reply was just such a tag (a
    // hallucinated empty answer to an unrelated question), and its product name kept matching turn
    // after turn even though the customer had moved on to asking about a completely different product
    // ("Tienen airpods blancos?" got the earlier watch photo resent). This scan was only ever meant to
    // catch a numbered PROSE list of options ("1. Serie 11 Mini... 2. ..."), never a photo caption -
    // a caption carries no "here's what I just offered you" intent worth re-matching.
    const priorAssistantText = lastAssistantText(history).replace(MEDIA_TAG_STRIP_PATTERN, "");
    const haystack = `${customerText ?? ""} ${text} ${priorAssistantText}`;
    const matched = findMentionedProductsForMediaBackstop(products, haystack);

    // A generic "muestrame el catalogo" also matches PHOTO_REQUEST_PATTERN (it contains "muestrame"),
    // and if the model answers by listing the whole catalog by name, every product matches the
    // token-overlap check above - this used to blast every product's photos at once. Distinguish that
    // from a real request for several specific products (e.g. "mandame fotos de estos 3") by comparing
    // against how many active products exist at all: matching (almost) the entire catalog means "show
    // me everything", not an itemized request, so only that case stays text-only. A flat cap of 2 used
    // to silently drop legitimate 3+ product requests.
    const wholeCatalogMatch = products.length > 1 && matched.length === products.length;
    if (matched.length > 5 || wholeCatalogMatch) return text;

    for (let i = 0; i < matched.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
      // Same reasoning as the attribute-match loop above: never let one failed send take the whole
      // turn's reply down with it.
      try {
        await runCatalogTool(context, "send_product_media", { productName: matched[i].name });
      } catch (error) {
        console.error("Fallo el envio de una foto en el backstop de nombres:", error);
      }
    }

    return text;
  }

  const FALLBACK_TEXT = "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto.";

  // Reliability plan Phase 4 (2026-09-13): stop depending on the model to voluntarily call
  // find_products_by_attributes for a "color negro" / "reloj negro" style message - a real production bug
  // ("reloj negro sends airpods/wrong colors", 2026-09-12) traced back to the model sometimes skipping
  // that tool entirely despite the prompt instruction. Forces tool_choice (not the arguments - the model
  // still picks those) on the FIRST completion of the turn only, and only when the customer's own text has
  // BOTH a real color word and a category word this business actually has configured - never a hardcoded
  // vertical vocabulary (see textMentionsConfiguredCategory). Picked option (b) from the plan (force
  // tool_choice) over option (a) (pre-execute the filter in code) - smaller diff, model still controls the
  // real arguments, matches the plan's own recommendation to start there.
  const shouldForceAttributeFilter =
    !!customerText &&
    canonicalColors(customerText).length > 0 &&
    (await textMentionsConfiguredCategory(context.businessId, customerText));

  try {
    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await deepseek.chat.completions.create({
        model: DEEPSEEK_MODEL,
        max_tokens: 1024,
        messages,
        tools: catalogTools,
        ...(iteration === 0 && shouldForceAttributeFilter
          ? { tool_choice: { type: "function" as const, function: { name: "find_products_by_attributes" } } }
          : {}),
        // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning
        // tokens add latency/cost we don't need for a WhatsApp sales reply.
        thinking: { type: "disabled" },
      });

      await logAiUsage({
        businessId: context.businessId,
        conversationId,
        kind: "CHAT",
        model: DEEPSEEK_MODEL,
        usage: response.usage,
      });

      const choice = response.choices[0];
      const message = choice.message;

      if (message.content?.trim()) {
        lastText = message.content;
      }

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return finalizeTurn(lastText || FALLBACK_TEXT);
      }

      messages.push(message);

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        
        // Real production bug (2026-09-13): once find_products_by_attributes scopes a color/category
        // query this turn, the model keeps calling send_product_media with a productId it picked up
        // earlier in the CONVERSATION HISTORY (e.g. a product it wrongly listed as "negro" several turns
        // ago) instead of one of THIS turn's real matches - a prompt instruction alone didn't stop it
        // (confirmed with a controlled repro), so this blocks the send at the code level instead of
        // trusting the model to pick the right ID. Only engages once a real attribute filter has run this
        // turn; every other send_product_media call (a directly-named product, no color/category filter
        // involved) is unaffected.
        // A hallucinated paymentMethodLabel used to reach a real Order record with no check at all
        // (createOrder persists whatever close_conversation was called with) - validate it against this
        // business's REAL active payment methods before the tool ever runs, same shape as the
        // send_product_media guard above (reliability plan Phase 2, item 1, 2026-09-13).
        if (
          call.function.name === "close_conversation" &&
          input.outcome !== "LOST" &&
          typeof input.paymentMethodLabel === "string" &&
          input.paymentMethodLabel.trim()
        ) {
          const realMethods = await listActivePaymentMethods(context.businessId);
          const isRealLabel = matchesConfiguredPaymentMethod(input.paymentMethodLabel, realMethods);
          if (realMethods.length > 0 && !isRealLabel) {
            console.error(
              "close_conversation bloqueado: paymentMethodLabel no coincide con ninguna forma de pago real configurada:",
              input.paymentMethodLabel
            );
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                closed: false,
                error: `"${input.paymentMethodLabel}" no es una forma de pago real configurada para este negocio - no se cerro nada. Formas de pago reales: ${realMethods
                  .map((m) => m.label)
                  .join(", ")}. Usa exactamente uno de esos labels, tal como lo devolvio get_payment_methods.`,
              }),
            });
            continue;
          }
        }

        const scopedProductsThisTurn =
          attributeMatchThisTurn && attributeMatchThisTurn.length > 0
            ? attributeMatchThisTurn
            : searchScopedThisTurn && searchScopedThisTurn.length > 0
              ? searchScopedThisTurn
              : null;
        if (call.function.name === "send_product_media" && scopedProductsThisTurn) {
          const inputProductId = input.productId ? String(input.productId) : null;
          const inputProductName = input.productName ? normalizeForMatch(String(input.productName)) : null;
          const inputVariantId = input.variantId ? String(input.variantId) : null;
          const isRealMatch = scopedProductsThisTurn.some((m) => {
            const productMatches = inputProductId
              ? m.productId === inputProductId
              : inputProductName !== null && normalizeForMatch(m.productName).includes(inputProductName);
            if (!productMatches) return false;
            return m.variantId ? inputVariantId === m.variantId : true;
          });
          if (!isRealMatch) {
            console.error(
              "send_product_media bloqueado: productId/variantId no esta entre los resultados reales de la busqueda de este turno:",
              input
            );
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                sent: false,
                error:
                  "Ese producto/variante no esta entre los resultados reales de tu busqueda de este turno - no se envio nada. Usa unicamente el productId/variantId que te devolvio find_products_by_attributes o search_products en ESTE turno.",
              }),
            });
            continue;
          }
        }

        const result = (await runCatalogTool(context, call.function.name, input)) as {
          mediaJustSent?: boolean;
          sent?: boolean;
          asked?: boolean;
          methods?: { type: string; label: string; details: string }[];
          rates?: { label: string; cost: string }[];
          matched?: boolean;
          label?: string;
          cost?: string;
          matches?: { productId: string; productName: string; variantId: string | null }[];
          ambiguousAcrossCategories?: boolean;
          modalities?: { code: string; label: string }[];
        };
        if (result?.mediaJustSent || result?.sent) mediaSentThisTurn++;
        if (call.function.name === "ask_owner") ownerAskedThisTurn++;
        if (call.function.name === "save_customer_name") nameSavedThisTurn++;
        if (call.function.name === "save_customer_contact_info") contactSavedThisTurn++;
        if (call.function.name === "flag_conversation_intent") intentFlaggedThisTurn++;
        if (["search_products", "get_product_details", "list_all_products"].includes(call.function.name)) {
          catalogCheckedThisTurn++;
        }
        if (call.function.name === "search_products" && Array.isArray(result) && result.length === 1) {
          const onlyMatch = result[0] as { id?: unknown; name?: unknown };
          if (typeof onlyMatch.id === "string" && typeof onlyMatch.name === "string") {
            searchScopedThisTurn = [{ productId: onlyMatch.id, productName: onlyMatch.name, variantId: null }];
          }
        }
        if (call.function.name === "get_payment_methods" && Array.isArray(result?.methods)) {
          paymentMethodsThisTurn = result.methods;
        }
        if (call.function.name === "get_shipping_rates" && Array.isArray(result?.rates) && result.rates.length > 0) {
          shippingRatesThisTurn = result.rates;
        }
        if (call.function.name === "get_shipping_rate_for_city" && result?.matched && result.label && result.cost) {
          shippingRatesThisTurn = [...(shippingRatesThisTurn ?? []), { label: result.label, cost: result.cost }];
        }
        if (
          call.function.name === "find_products_by_attributes" &&
          !result?.ambiguousAcrossCategories &&
          Array.isArray(result?.matches) &&
          result.matches.length > 0
        ) {
          attributeMatchThisTurn = result.matches;
        }
        if (call.function.name === "get_shipping_payment_modalities" && Array.isArray(result?.modalities) && result.modalities.length > 0) {
          shippingModalitiesThisTurn = result.modalities;
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
  } catch (error) {
    // A DeepSeek network/API failure used to propagate uncaught out of generateReply - the webhook's
    // outer try/catch swallowed it with just a console.error, so the customer got NO reply at all for
    // that turn. Degrade instead: log it and fall through to the same apology text used when the model
    // itself has nothing to say, still running finalizeTurn's own safety nets (name/contact/photo
    // backstops) against whatever the customer said this turn.
    console.error("Fallo la llamada a DeepSeek en generateReply:", error);
    return finalizeTurn(lastText || FALLBACK_TEXT);
  }

  return finalizeTurn(lastText || FALLBACK_TEXT);
}
