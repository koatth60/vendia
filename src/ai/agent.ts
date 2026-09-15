import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL } from "./client";
import { createChatCompletion } from "./modelFailover";
import { catalogTools, runCatalogTool, type ToolContext } from "./tools";
import { getRecentHistory } from "../conversation/service";
import { logAiUsage } from "./usage";
import { prisma } from "../db/client";
import { sendOwnerAlert } from "../whatsapp/client";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { recordAgentIncident } from "./incidents";
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

// recordMessage writes one ASSISTANT row PER media item sent (sendMediaWithSpacing, tools.ts), each with
// content exactly "[Foto de X]"/"[Video de X]" - a real backstop blast of 8-9 photos filled 8-9 of the 20
// history slots with that literal string. Real production incident (2026-09-13, first occurrence): the
// model, seeing its own recent turns dominated by that exact bracket format, started FABRICATING it in its
// own reply text without ever calling send_product_media.
//
// First fix attempt (same day) collapsed consecutive runs into one ASSISTANT-role summary line
// ("[Se envio 1 foto/video: X]") - REGRESSION found the same day in a follow-up test conversation: the
// model just imitated THAT new bracket format instead, since it was still an ASSISTANT-role message shaped
// like something it had just said. Real fix: stop putting ANY bracket-shaped media confirmation into a
// turn the model could mistake for its own prior utterance. Media rows are removed from the conversational
// history entirely; the fact that photos already went out is told to the model as a `system` note instead
// (same channel as RESUMEN DE LO HABLADO ANTES below) - system content isn't something a model echoes back
// as its own reply. Exported as a pure function for a cheap test - no DB/LLM needed. Deliberately NOT
// applied to `history` itself (used elsewhere for lastAssistantText, which needs the real prior text, e.g.
// to detect the bot's own name-asking phrasing).
const MEDIA_CAPTION_PATTERN = /^\[(?:Foto|Video) de (.+)\]$/;

export function extractMediaHistory<T extends { role: string; content: string; imageAnalysis: string | null }>(
  history: T[]
): { history: T[]; photosSent: string[] } {
  const filtered: T[] = [];
  const photosSent: string[] = [];

  for (const m of history) {
    const match = m.role === "ASSISTANT" ? m.content.match(MEDIA_CAPTION_PATTERN) : null;
    if (match) {
      if (!photosSent.includes(match[1])) photosSent.push(match[1]);
      continue;
    }
    filtered.push(m);
  }
  return { history: filtered, photosSent };
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
    const response = await createChatCompletion({
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
    }, { businessId, conversationId });

    await logAiUsage({
      businessId,
      conversationId,
      kind: "CHAT",
      // El modelo REAL que respondio, no el preferido - si el failover cayo al de respaldo, el precio por
      // token es otro y registrar el preferido subestimaria el costo.
      model: response.model || DEEPSEEK_MODEL,
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
// Real production bug (2026-09-13): PHOTO_REQUEST_PATTERN's bare verbs (muestra/enseña/manda) match
// ordinary Spanish that has nothing to do with photos - "ese reloj no me MUESTRA la distancia" (a screen
// complaint) fired the media backstop and blasted 8 unrequested photos. Used ONLY for the customer's own
// message (never for the bot's text, which stays on PHOTO_REQUEST_PATTERN below) - requires either a media
// noun, or a send-verb bound to a clitic object ("muéstramela", "me la mandes"). A bare verb alone no
// longer qualifies, so callers must ALSO check CUSTOMER_PHOTO_NEGATION_PATTERN to reject "no me
// muestra/enseña..." before treating this as a real request.
export const CUSTOMER_PHOTO_REQUEST_PATTERN =
  /\b(foto|fotos|imagen|imagenes|imágenes|video|videos)\b|\b(mu[eé]stra(me)?la|mu[eé]stramelas?|ens[eé][ñn]a(me)?la|ens[eé][ñn]amelas?|m[aá]ndamela|m[aá]ndamelas|p[aá]samela|p[aá]samelas|me la (muestras|muestres|ense[ñn]as|ense[ñn]es|enseñaras|enseñara|mandas|mandes|pasas|pases)|me las (muestras|muestres|ense[ñn]as|ense[ñn]es|mandas|mandes|pasas|pases))\b/i;
export const CUSTOMER_PHOTO_NEGATION_PATTERN = /\bno me (muestra|ense[nñ]a)\b/i;
// Broadened beyond "te mand.." to also catch phrasings without "te" ("ya la mande", "ahi la envio") and
// "aca"/"aqui esta(n)" - a real conversation slipped through the narrower pattern with "ya se la mande".
// H10 (2026-09-13 incident): "(mand|envi|pas|mostr)ar(te|le)" catches the enclitic-pronoun phrasing
// ("Déjame mandarte la foto", "voy a enviarte las fotos") that none of the other alternatives cover -
// "te (mand|envi|pas)" only matches when "te" comes BEFORE the verb, not attached after it as a suffix.
// A real production case ("Déjame mandarte la foto 👇... ¿Te lo llevas?") fell through every existing
// alternative, so the promise was never backed by a real send_product_media call.
export const PHOTO_CLAIM_PATTERN =
  /\b(te (mand|envi|pas)|ya (te |se la |la |lo )?(mand|envi|pas)\w*|aqu[ií] (te|va|van|est[aá])|ac[aá] (te|va|van|est[aá])|ah[ií] (te|va|van)|(mand|envi|pas|mostr)ar(te|le)\b)/i;
// "te (mand|envi|pas)" above also matches a conditional offer inside a still-open clarifying question
// ("Dime el número o el nombre y te paso fotos y detalles, ¿cuál prefieres?") - that's a promise
// contingent on the customer's answer, not a claim that photos already went out. Real production bug
// (2026-09-12): bot listed 4 options with that exact phrasing on the FIRST turn (nothing asked yet by
// the customer), the claim pattern fired anyway, and the media backstop below matched all 4 option
// names present in the bot's own reply text - sending 4 unrequested photos, several not even matching
// what the customer asked for, before the customer had picked one.
export const OPEN_CLARIFYING_QUESTION_PATTERN =
  /\bcu[aá]l\b.{0,30}\b(prefer|interes|te (gust|llam))|\bdime\b.{0,20}\b(n[uú]mero|nombre)\b/i;
// The model sometimes fabricates a bracket-shaped media-confirmation caption without ever calling
// send_product_media - a copy-the-pattern hallucination, not a natural-language claim, so it doesn't
// match PHOTO_CLAIM_PATTERN above. Catch it directly. Broadened 2026-09-13 (second occurrence of the same
// incident class): the original pattern only caught the exact "[Foto de X]" shape recordMessage writes -
// a same-day fix that summarized several sends as "[Se envio 1 foto/video: X]" got imitated by the model
// in its OWN reply text, and that different bracket shape slipped past this pattern uncaught. Broadened to
// match ANY bracketed text mentioning foto(s)/video(s), regardless of the exact wording around it - the
// model has no real caption format worth preserving here, only real sends do, and those never appear
// inside the model's own generated `text`.
// Not every "foto" in a reply is a CATALOG photo. A courier tracking slip ("te paso la foto de la guía
// apenas se realice el envío") and a payment receipt ("mandame la foto del comprobante") both match the
// claim patterns above word for word, but neither is something send_product_media could ever deliver -
// the first is a future promise about a document that does not exist yet, the second is a photo the
// CUSTOMER sends US. Real regression (2026-09-15): the guía phrasing dragged the whole media backstop in
// mid-purchase and appended a "no logré cargar las fotos" retraction to a perfectly correct shipping
// answer. Checked before the backstop engages at all.
export const NON_PRODUCT_PHOTO_PATTERN =
  /\b(gu[ií]a|comprobante|recibo|soporte|transferencia|pago)\b/i;

export const FAKE_MEDIA_TAG_PATTERN = /\[[^\]]{0,60}\b(?:fotos?|videos?)\b[^\]]{0,60}\]/i;
export const MEDIA_TAG_STRIP_PATTERN = /\[[^\]]{0,60}\b(?:fotos?|videos?)\b[^\]]{0,60}\]/gi;

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

// Real production bug (2026-09-15): the model told a customer "Ese modelo... no tiene variantes de
// color cargadas" for a product that had 3 real active color variants with stock, seconds after
// get_product_details itself returned that data. Not a dropped-promise pattern like the ones above (no
// tool call is missing here), so this is checked separately in finalizeTurn against hasVariantsThisTurn
// - the real, just-fetched answer - not repaired through applyClaimBackstops's registry.
export const VARIANT_DENIAL_PATTERN =
  /no tiene variantes|no maneja(mos)? variantes|no hay variantes|una sola presentaci[oó]n|no viene en (otros? )?colores?|no tenemos (otros? )?colores?/i;

// The model's own "I can't tell which product this photo is" clarifying question - used to detect a
// repeated identify-by-photo loop (see shouldForcePhotoEscalation in generateReply) so it escalates to
// ask_owner_about_photo instead of asking the same question a third/fourth time.
export const PHOTO_ID_CLARIFY_PATTERN =
  /no logro identificar|no pude identificar|no logr[eé] identificar|cu[aá]l de (estos|los|las)\b.{0,20}\bes\b|me confirmas cu[aá]l|podr[ií]a ser uno de estos|para no equivocarme con el modelo/i;

// Same failure mode again, this time for save_customer_name: the bot asks "a nombre de quien hago el
// pedido?", the customer answers with just their name, and the bot's next reply acknowledges it
// ("Perfecto, David!") without ever having called save_customer_name - confirmed against a real
// conversation where the owner had to add the name by hand afterward. Only fires when the bot's PRIOR
// turn actually asked for the name (so a random two-word customer message elsewhere never gets
// mistaken for one) and the customer's answer is shaped like a name, not a sentence.
export const ASK_NAME_PATTERN =
  /\b(a nombre de qui[eé]n|tu nombre completo|nombre completo|c[oó]mo te llamas|cu[aá]l es tu nombre|tu nombre,? por favor|con qui[eé]n tengo el (gusto|placer)|con qui[eé]n hablo|me (regalas|compartes|confirmas) tu nombre)\b/i;

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
    const response = await createChatCompletion({
      max_tokens: 400,
      messages: [
        { role: "system", content: CLOSING_MESSAGE_PROMPT },
        { role: "user", content: orderFacts },
      ],
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning tokens
      // leave message.content empty for a short generation task like this one.
      thinking: { type: "disabled" },
    }, { businessId, conversationId });
    await logAiUsage({ businessId, conversationId, kind: "CHAT", model: response.model || DEEPSEEK_MODEL, usage: response.usage });
    const text = response.choices[0]?.message?.content?.trim();
    return text || buildOrderClosedMessage(business);
  } catch (error) {
    console.error("No se pudo generar el mensaje de cierre personalizado, usando el generico:", error);
    return buildOrderClosedMessage(business);
  }
}

// Real, repeated production bug (2026-09-14/15): a customer's saved name kept flipping to "Plateado",
// "Negro", or "Pero Negro Sale Todo" - not typos, actual answers to a DIFFERENT question. Root cause:
// the bot often asks for the name compounded with something else in one message ("Cuál color prefieres?
// Y ya que estamos, me confirmas tu nombre...", or a 3-item numbered list ending in "...datos de
// entrega: nombre completo, cedula..."). ASK_NAME_PATTERN below matches that whole message (it DOES
// contain "nombre"), so whatever the customer replies gets tried as a name - and a short, all-alphabetic,
// <=4-word answer like "Plateado" or "Pero negro sale todo" passes looksLikePersonName's shape check
// with nothing to tell it apart from a real name. NOT_A_NAME only ever caught a handful of exact
// single-word replies (si/no/listo/...), never a color or a short sentence. canonicalColors is the same
// closed, language-level vocabulary find_products_by_attributes already uses - reusing it here rejects
// any candidate that mentions a color, in any of its synonyms, business-agnostically.
// Primer intento (2026-09-15, temprano): una lista de palabras prohibidas armada con los casos vistos
// ese dia (colores y conectores). Fallo a los minutos de desplegarse - "Me envías el catalogo" se guardo
// como nombre porque "envías" y "catalogo" no estaban en la lista. Perseguir palabras sueltas no puede
// funcionar: el conjunto de frases que no son nombres es infinito.
//
// Este es el criterio al reves, y si generaliza: las palabras de CLASE CERRADA del español (pronombres,
// preposiciones, articulos, conjunciones, adverbios basicos) son un conjunto finito y completo. Una
// oracion real casi siempre contiene al menos una; un nombre propio no contiene ninguna. "Me envías el
// catalogo" cae por "me" y "el"; "Pero negro sale todo" cae por "pero" y "todo"; "Diana" y "Maria Jose
// Rodriguez" pasan limpios. Se suman los colores (canonicalColors, el mismo vocabulario cerrado que usa
// find_products_by_attributes) porque responder el color cuando el bot pregunto color Y nombre en el
// mismo mensaje es el caso que mas se repitio.
const NAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "y"]);

const CLOSED_CLASS_WORDS = new Set([
  // pronombres
  "yo", "tu", "tú", "vos", "usted", "ustedes", "el", "él", "ella", "ello", "nosotros", "nosotras",
  "vosotros", "ellos", "ellas", "me", "te", "se", "lo", "le", "nos", "os", "les", "mi", "mí", "ti",
  "conmigo", "contigo", "consigo", "este", "esta", "esto", "estos", "estas", "ese", "esa", "eso",
  "esos", "esas", "aquel", "aquella", "aquello", "mio", "mío", "mia", "tuyo", "tuya", "suyo", "suya",
  "nuestro", "nuestra", "que", "qué", "quien", "quién", "cual", "cuál", "cuyo", "cuanto", "cuánto",
  "algo", "alguien", "nadie", "nada", "alguno", "alguna", "ninguno", "ninguna", "todo", "toda",
  "todos", "todas", "otro", "otra", "mucho", "mucha", "poco", "poca", "varios", "varias", "cada",
  "mismo", "misma",
  // preposiciones
  "ante", "bajo", "con", "contra", "desde", "durante", "en", "entre", "hacia", "hasta", "mediante",
  "para", "por", "segun", "según", "sin", "sobre", "tras", "via", "vía", "al",
  // articulos
  "un", "una", "unos", "unas",
  // conjunciones
  "e", "ni", "o", "u", "pero", "mas", "sino", "aunque", "porque", "pues", "si", "sí", "como", "cuando",
  "mientras", "donde", "dónde", "entonces",
  // adverbios de uso corriente
  "no", "tambien", "también", "tampoco", "muy", "más", "menos", "ya", "aun", "aún", "todavia",
  "todavía", "siempre", "nunca", "aqui", "aquí", "ahi", "ahí", "alli", "allí", "aca", "acá", "alla",
  "allá", "ahora", "luego", "despues", "después", "antes", "bien", "mal", "asi", "así", "solo", "sólo",
  "quiza", "quizá", "casi", "entonces",
]);

function looksLikeNonNameAnswer(candidate: string): boolean {
  if (canonicalColors(candidate).length > 0) return true;
  if (CHAT_NOISE_PATTERN.test(candidate.trim())) return true;
  const words = candidate.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.some((w) => DOMAIN_NOUNS.has(w) || CHAT_NOISE_PATTERN.test(w))) return true;
  // Las particulas de apellido compuesto ("De la Hoz", "Del Río") son palabras de clase cerrada que si
  // aparecen en nombres reales colombianos - se toleran solo cuando ademas hay al menos dos palabras
  // que no lo son, que es la forma que tiene un apellido compuesto de verdad.
  const realWords = words.filter((w) => !NAME_PARTICLES.has(w));
  const particlesAreLegit = realWords.length >= 2;
  return words.some((w) => {
    if (NAME_PARTICLES.has(w) && particlesAreLegit) return false;
    return CLOSED_CLASS_WORDS.has(w) || NAME_PARTICLES.has(w);
  });
}

function looksLikePersonName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  if (!words.every((w) => /^[A-Za-zÀ-ÿ'-]+$/.test(w))) return false;
  if (NOT_A_NAME.has(trimmed.toLowerCase())) return false;
  return !looksLikeNonNameAnswer(trimmed);
}

function toTitleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

// Real production bug (2026-09-13): looksLikePersonName alone rejects the customer's answer whenever it
// arrives wrapped in ordinary greeting/politeness words - "Hola con einer mucho gusto" is 5 words, over
// looksLikePersonName's 4-word cap, so a real, correctly-answered name-ask never got saved. Strips known
// filler words (greetings, "con", "mucho gusto", the self-intro verbs) before checking, so only the
// actual name candidate is tested against looksLikePersonName's shape/length rules - a genuinely long or
// sentence-shaped answer still correctly returns null once the filler is removed. Exported for a cheap
// pure-function test - no DB/LLM needed.
const NAME_ANSWER_FILLER_WORDS = new Set([
  "hola", "buenas", "buenos", "bueno", "buena", "dia", "día", "dias", "días", "tarde", "tardes",
  "noche", "noches", "que", "qué", "tal", "con", "mucho", "mucha", "gusto", "el", "la", "es", "soy", "yo",
]);

// Se quitan en cualquier posicion, no solo en los extremos - ver extractNameFromAnswer.
const ANSWER_FRAME_WORDS = new Set(["con", "hablas", "habla", "soy", "es", "llamo", "llaman", "dicen", "mi", "nombre"]);

// Encima de la regla de clase cerrada: un puñado de respuestas de chat y de palabras del propio dominio
// que el replay mostro colandose como nombres ("Sii", "Fotos", "Reloj", "Sii estan correctos"). Esto si
// es una lista, y como tal nunca va a estar completa - por eso el replay contra conversaciones reales
// (scripts/replay-name-and-delivery.ts) es la verificacion que manda antes de desplegar, no la lista.
const CHAT_NOISE_PATTERN = /^(s[ií]+|n[oó]+|ok+|okey|oki|dale|listo|sip|nop|ajá|aja|mmm+|jaj+a*)$/i;
const DOMAIN_NOUNS = new Set([
  "foto", "fotos", "video", "videos", "imagen", "imagenes", "imágenes", "catalogo", "catálogo",
  "precio", "precios", "envio", "envío", "domicilio", "producto", "productos", "combo", "combos",
  "reloj", "relojes", "audifonos", "audífonos", "parlante", "parlantes", "color", "colores", "talla",
  "tallas", "unidad", "unidades", "correcto", "correctos", "correcta", "correctas", "estan", "están",
  "esta", "está", "pedido", "pedidos", "garantia", "garantía",
]);

export function extractNameFromAnswer(customerText: string): string | null {
  // A real name answer is essentially never phrased as a question - guards against a customer replying
  // with an unrelated question right after being asked for their name (e.g. "Hola, cuanto cuesta el
  // envio?"), which would otherwise strip down to a short all-alphabetic phrase that superficially fits
  // looksLikePersonName's shape check just like a real name would.
  if (/[?¿]/.test(customerText)) return null;
  let words = customerText
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[¡¿]+|[.,!¡¿?]+$/g, ""))
    .filter((w) => w.length > 0);
  // El saludo y la cortesia SIEMPRE van a los costados del nombre ("Hola con einer mucho gusto",
  // "buenas tardes, mucho gusto, Maria Fernanda"), nunca en el medio. Recortar solo por los extremos y
  // no en cualquier posicion: "la" es muletilla al inicio pero es parte del apellido en "Juan De la
  // Hoz", y filtrarla en todas partes devolvia "Juan De Hoz".
  const isFiller = (w: string) => NAME_ANSWER_FILLER_WORDS.has(w.toLowerCase());
  while (words.length > 0 && isFiller(words[0])) words = words.slice(1);
  while (words.length > 0 && isFiller(words[words.length - 1])) words = words.slice(0, -1);
  // El armazon con el que la gente presenta su nombre ("Hablas con María", "te habla Andres") sí puede
  // quedar en el medio, y es un conjunto chico y fijo - distinto de los articulos, que en el medio son
  // parte del apellido. Encontrado por el replay: al recortar solo por los extremos, "Hablas con María"
  // pasaba a rechazarse porque el "con" del medio caia en la regla de clase cerrada.
  words = words.filter((w) => !ANSWER_FRAME_WORDS.has(w.toLowerCase()));
  if (words.length === 0) return null;
  const candidate = words.join(" ");
  return looksLikePersonName(candidate) ? toTitleCase(candidate) : null;
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

// Se cumple cuando el turno anterior del bot pidio datos de entrega, en cualquier forma - incluida la
// lista de varios datos de una sola vez ("Nombre y apellido, cedula, celular, ciudad, barrio..."), que es
// como este negocio (y el default del producto desde 2026-09-13) los pide.
const ASK_DELIVERY_DATA_PATTERN =
  /\b(datos de (entrega|env[ií]o)|nombre y apellido|nombre completo)\b|\bc[eé]dula\b|\bcelular\b|\bidentificaci[oó]n\b/i;

// Real production incident (2026-09-15, el mas caro del dia): desde que el bot pide TODOS los datos de
// entrega en un solo mensaje, los clientes contestan mezclando texto y numeros -
// "Sebastián montealegre sotelo        CC: 1004074880" o "Celular 3208935318   Mosquera Cundinamarca".
// Los dos guardadores viejos eran ciegos a eso: looksLikeIdOrPhone exigia que el mensaje entero fuera
// digitos (^[\d\s-]{6,15}$) y extractNameFromAnswer exigia palabras puramente alfabeticas, asi que ni la
// cedula ni el celular ni el nombre llegaban a la ficha - el bot respondia "ya tengo el nombre y la
// cedula" y en la base los tres campos seguian en null. Encima, cuando el bot pedia cedula Y celular en
// el mismo mensaje, el codigo viejo ni siquiera intentaba (no sabia cual de los dos contestaba el
// cliente). Esta funcion identifica cada dato por su PROPIA forma y etiqueta, no por cual fue la
// pregunta, asi que la ambiguedad desaparece.
//
// Reglas, pensadas para Colombia: el celular son 10 digitos que arrancan en 3; la cedula, 6 a 10 digitos
// que no arrancan en 3. Una etiqueta explicita al lado del numero ("CC", "cedula", "celular", "cel")
// gana siempre sobre la forma. Un numero con $ o COP cerca es plata, nunca un documento.
const MONEY_NEAR_PATTERN = /(\$|\bcop\b|\bpesos\b|\bmil\b)/i;
const ID_LABEL_PATTERN = /\b(c\.?c\.?|c[eé]dula|documento|identificaci[oó]n|nit|ti)\b/i;
const PHONE_LABEL_PATTERN = /\b(celular|cel|tel[eé]fono|tel|whatsapp|wpp|movil|m[oó]vil|contacto)\b/i;

export function extractDeliveryDataFromAnswer(text: string): { idNumber?: string; deliveryPhone?: string } {
  const out: { idNumber?: string; deliveryPhone?: string } = {};
  // Cada corrida de digitos junto con las ~18 letras que la preceden, para poder leer su etiqueta.
  const runs = [...text.matchAll(/([^\d]{0,18})(\d[\d.\s-]{4,18}\d)/g)];
  for (const run of runs) {
    const before = run[1] ?? "";
    const digits = (run[2] ?? "").replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 11) continue;
    // La plata puede llevar su marca ANTES ("$145.000") o DESPUES ("145.000 pesos", "145000 COP") - hay
    // que mirar los dos lados o un precio termina guardado como numero de cedula.
    const after = text.slice((run.index ?? 0) + run[0].length, (run.index ?? 0) + run[0].length + 12);
    if (MONEY_NEAR_PATTERN.test(before) || MONEY_NEAR_PATTERN.test(after)) continue;

    const labeledId = ID_LABEL_PATTERN.test(before);
    const labeledPhone = PHONE_LABEL_PATTERN.test(before);
    const looksPhone = digits.length === 10 && digits.startsWith("3");

    if (labeledPhone && !labeledId) {
      out.deliveryPhone ??= digits;
    } else if (labeledId && !labeledPhone) {
      out.idNumber ??= digits;
    } else if (looksPhone) {
      out.deliveryPhone ??= digits;
    } else if (digits.length >= 6 && digits.length <= 10) {
      out.idNumber ??= digits;
    }
  }
  return out;
}

// El nombre dentro de una respuesta combinada: se queda solo con el tramo alfabetico antes del primer
// numero o etiqueta ("Sebastián montealegre sotelo        CC: 1004074880" -> "Sebastián montealegre
// sotelo") y lo pasa por el mismo filtro estricto que el resto de los nombres.
export function extractNameFromDeliveryAnswer(text: string): string | null {
  const head = text.split(/\d/)[0] ?? "";
  const cleaned = head
    .replace(ID_LABEL_PATTERN, " ")
    .replace(PHONE_LABEL_PATTERN, " ")
    .replace(/[^A-Za-zÀ-ÿ'\-\s]/g, " ")
    .trim();
  if (!cleaned) return null;
  return extractNameFromAnswer(cleaned);
}

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

// Mostly detection-only, unlike guardAgainstPaymentHallucination above: a shipping cost is usually one
// clause inside a longer message (order summary, product price alongside it), so blindly discarding the
// whole reply the way the payment guard does would also nuke unrelated real content. With several
// configured tiers (see ShippingRate/get_shipping_rates) there's no single "the real number" to
// auto-substitute - stays detection-only there. Revisited 2026-09-13 (audit F6): with exactly ONE
// configured tier there IS a single unambiguous real number, so that one case now gets corrected in place
// instead of only logged - same reasoning as guardAgainstOrderTotalMismatch below reaching a different
// conclusion for a genuinely ambiguous multi-tier case.
export function guardAgainstShippingCostHallucination(
  text: string,
  shippingRates: { label: string; cost: string }[] | null
): string {
  if (!shippingRates?.length || !SHIPPING_MENTION_PATTERN.test(text)) return text;
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
  const chunkPattern = /env[ií]o[^.\n]{0,40}?\$?[ \t]?[\d.,]{4,6}\b/gi;
  const nearbyChunks = text.match(chunkPattern) ?? [];
  let sawMismatch = false;
  for (const chunk of nearbyChunks) {
    const digits = (chunk.match(/[\d.,]{4,6}/) ?? [""])[0].replace(/\D/g, "");
    if (digits.length >= 4 && digits.length <= 6 && !knownCosts.has(digits)) {
      sawMismatch = true;
      break;
    }
  }
  if (!sawMismatch) return text;

  console.error("Costo de envio mencionado no coincide con ninguna tarifa real configurada - revisar:", {
    modelText: text,
    realRates: shippingRates,
  });

  // Only safe to auto-correct with exactly one configured tier - the real number is unambiguous. With 2+
  // tiers there's no way to know which one applies without the customer's city/category context this
  // guard doesn't have, so it stays detection-only there, same as before.
  if (shippingRates.length !== 1) return text;
  const realCostDigits = String(Math.round(parseFloat(shippingRates[0].cost)));
  const formattedCost = realCostDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return text.replace(chunkPattern, (chunk) => chunk.replace(/[\d.,]{4,6}\b/, formattedCost));
}

const ORDER_TOTAL_MENTION_PATTERN = /total/i;

// B5 (2026-09-13 audit): a guard exists for a hallucinated payment number (guardAgainstPaymentHallucination,
// hard-replaces the whole reply) and for shipping cost (guardAgainstShippingCostHallucination,
// detection-only - several tiers, no single "the" real number). Nothing existed for the order TOTAL the
// bot tells the customer, even though show_order_summary already computes exactly one real, unambiguous
// total per call - a wrong number here is a customer confirming payment for the wrong amount, same money
// risk class as the payment guard. Detection + owner alert (not an in-place rewrite like the payment
// guard): the figure appears in varied formatting ("$145.000", "145000"), and blindly substring-replacing
// it risks corrupting unrelated text worse than the shipping guard's already-accepted "detect, don't
// rewrite" tradeoff for the exact same reason.
export async function guardAgainstOrderTotalMismatch(context: ToolContext, text: string, realTotal: number | null): Promise<void> {
  if (realTotal === null || !ORDER_TOTAL_MENTION_PATTERN.test(text)) return;
  const realTotalDigits = String(Math.round(realTotal));
  const nearbyChunks = text.match(/total[^.\n]{0,30}?\$?[ \t]?[\d.,]{4,9}\b/gi) ?? [];
  const mentionedTotals = nearbyChunks
    .map((chunk) => (chunk.match(/[\d.,]{4,9}\b/) ?? [""])[0].replace(/\D/g, ""))
    .filter(Boolean);
  const hasMismatch = mentionedTotals.some((digits) => digits !== realTotalDigits);
  if (!hasMismatch) return;

  console.error("Total del pedido mencionado no coincide con el real de show_order_summary - posible cifra inventada:", {
    modelText: text,
    realTotal,
    mentionedTotals,
  });
  await alertOwner(
    context,
    `Aviso: el bot le menciono al cliente un total de pedido distinto al real ($${realTotalDigits}). Revisa esa conversacion antes de que se confirme un pago con la cifra equivocada.`
  );
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

// A numbered list written with keycap emoji ("1️⃣ Producto A... 4️⃣ Producto D") isn't caught by
// LIST_MARKER_PATTERN above (no literal "."/")"/":" character - it's a digit followed by the Unicode
// variation-selector + combining-keycap marks). tokenize's generic non-alphanumeric strip removes those
// marks but KEEPS the bare digit as its own token. Real production incident (2026-09-13): a numbered list
// "1️⃣...4️⃣" left a bare "4" in the haystack, which matched the literal "4" in an unrelated real
// product's name ("AIRPODS SERIE 4") - same bug class as the plain-marker case, different Unicode shape.
const KEYCAP_DIGIT_PATTERN = /[0-9]️?⃣/g;

// A business's own marketing subtitle in parentheses ("Reloj... Serie 12 Ultra 3 (Edición Deportiva /
// Robusta)") is never repeated when the bot or customer refers to the product in shorthand - counting
// those extra words in the ratio's denominator systematically under-scores exactly the long, real,
// wordy names this business uses (verified against production data: a 10-token full name where the bot's
// own shorthand mention only ever repeats the 5-6 words BEFORE the parenthetical scored 0.5, just under
// the 0.6 threshold, so the real watches the customer was shown never matched while the bug above sent
// unrelated earbuds instead). Stripped only for THIS scoring calculation, never from the name actually
// shown to the customer.
const NAME_PARENTHETICAL_SUFFIX_PATTERN = /\s*\([^)]*\)\s*$/;

// Token-overlap match (not exact substring - the model paraphrases names constantly, e.g. "Boombox 4
// LED" for "Parlante Bluetooth Portatil Boombox 4 LED") against a haystack that should already include
// the customer's message, the bot's current reply, AND the bot's prior turn (see the photo-claim
// backstop in finalizeTurn for why the prior turn matters). Exported as a pure function for a cheap
// regression test - no DB/LLM needed to verify the matching decision itself.
export function findMentionedProductsForMediaBackstop<
  T extends { name: string; media: unknown[]; category?: string | null; variants?: { media: unknown[] }[] }
>(products: T[], haystack: string): T[] {
  const haystackTokens = new Set(tokenize(haystack.replace(KEYCAP_DIGIT_PATTERN, " ").replace(LIST_MARKER_PATTERN, " ")));
  const scored = products
    .map((p) => {
      // Real production bug (2026-09-15): checking only p.media (general/unassigned photos) made this
      // backstop blind to any product whose photos are all assigned to color variants (a real case had
      // all 3 on variants, zero general) - the bot's own claim "aqui van las fotos" never got backed by
      // a real send, and the customer got nothing. Same combined-media rule send_product_media and
      // get_product_details already use.
      const totalMedia = p.media.length + (p.variants?.reduce((sum, v) => sum + v.media.length, 0) ?? 0);
      if (totalMedia === 0) return null;
      const nameTokens = tokenize(p.name.replace(NAME_PARENTHETICAL_SUFFIX_PATTERN, ""));
      if (nameTokens.length === 0) return null;
      const hits = nameTokens.filter((t) => haystackTokens.has(t)).length;
      // A short name (1-2 tokens) crossing 0.6 on a single shared word is too weak on its own - real
      // production bug (2026-09-13): "serie" alone (1/3 tokens of a 3-token name, well under 0.6 anyway,
      // but a shorter 2-token name sharing just its generic first word would cross threshold with only 1
      // hit). Require at least 2 matched tokens, or a full match for a genuinely 1-token name.
      if (hits < Math.min(2, nameTokens.length)) return null;
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

// Counts how many times, back-to-back at the END of `history`, the customer sent a photo/video and the
// bot immediately replied with an "I can't tell which product this is" clarifying question - see
// shouldForcePhotoEscalation in generateReply. Exported as a pure function for a cheap regression test.
// `history` here should NOT include the current turn's own trailing customer message - that message is
// what the caller is deciding whether to escalate, not part of the PRIOR streak being measured.
export function countUnresolvedPhotoIdStreak(
  history: { role: string; content: string; mediaType: string | null }[]
): number {
  let streak = 0;
  let j = history.length - 1;
  while (j >= 1) {
    const assistantMsg = history[j];
    const priorCustomerMsg = history[j - 1];
    if (
      assistantMsg.role === "ASSISTANT" &&
      priorCustomerMsg.role === "CUSTOMER" &&
      (priorCustomerMsg.mediaType === "IMAGE" || priorCustomerMsg.mediaType === "VIDEO") &&
      PHOTO_ID_CLARIFY_PATTERN.test(stripMarkdownEmphasis(assistantMsg.content))
    ) {
      streak++;
      j -= 2;
    } else break;
  }
  return streak;
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

async function applyClaimBackstops(
  text: string,
  guards: ClaimBackstopGuard[],
  businessId: string,
  conversationId: string
): Promise<string> {
  for (const guard of guards) {
    if (guard.alreadyHandled || !guard.extraCondition) continue;
    const testText = guard.matchAgainstStrippedText ? stripMarkdownEmphasis(text) : text;
    if (guard.pattern.test(testText) && !guard.suppressor.test(testText)) {
      text = await guard.repair(text);
      await recordAgentIncident(businessId, "BACKSTOP_INTERVENTION", `Guard "${guard.name}" reparo una promesa incumplida`, conversationId);
    }
  }
  return text;
}

// B4 (2026-09-13 audit): when finalizeTurn ends up sending the generic FALLBACK_TEXT apology, or the
// tool-calling loop exhausts all 5 iterations without a real answer, the customer gets a dead end and
// nobody - not even the owner - ever finds out unless they happen to read server logs. This surfaces it
// as a real WhatsApp alert instead, same channel as every other escalation.
async function alertOwner(context: ToolContext, text: string): Promise<void> {
  const business = await prisma.business.findUnique({ where: { id: context.businessId }, select: { contactPhone: true } });
  if (!business?.contactPhone) return;
  try {
    const wamid = await sendOwnerAlert(context.credentials, business.contactPhone, text);
    await recordOwnerMessage(context.businessId, { direction: "OUT", body: text, success: Boolean(wamid) });
  } catch (error) {
    console.error("No se pudo avisar al dueno:", error);
  }
}

async function alertOwnerOfDegradedReply(context: ToolContext, reason: string): Promise<void> {
  await alertOwner(
    context,
    `Aviso: el bot le mando una respuesta generica a un cliente en vez de resolverle la consulta. Motivo: ${reason}. Revisa esa conversacion en el panel.`
  );
  await recordAgentIncident(context.businessId, "DEGRADED_REPLY", reason, context.conversationId);
}

// Invariant added 2026-09-15 (real incident: the bot promised photos twice in the same conversation,
// mediaSentThisTurn stayed 0 both times, and NOTHING recorded it anywhere - no AgentIncident, no owner
// alert, no trace except the customer eventually asking a human to send them by hand). Both media
// backstop branches above call this whenever they tried to send (or had a real candidate to send) and
// still ended the turn with zero actual sends - the model's own text already claims photos went out, so
// leaving it as-is would ship a dropped promise with no record and no honest correction. Unlike the
// claim backstops in applyClaimBackstops (which repair a claim by actually doing the thing), there is no
// "just call the tool again" fix here - the tool already ran and failed/found nothing - so this alerts
// the owner for real (the text below only says "avise al equipo" because it's about to be true) and
// appends an honest, non-promising line instead of leaving the false claim standing alone.
async function honorOrRetractMediaPromise(context: ToolContext, conversationId: string, text: string): Promise<string> {
  const reason = `El bot prometio fotos/video pero no logro enviar ninguno. Texto: "${text.slice(0, 200)}"`;
  await recordAgentIncident(context.businessId, "BACKSTOP_INTERVENTION", reason, conversationId);
  await alertOwner(
    context,
    "Aviso: el bot le prometio fotos/video a un cliente pero no logro mandar ninguna (revisa si el producto tiene fotos cargadas, incluidas las de sus variantes). Revisa esa conversacion en el panel."
  );
  return `${text}\n\nUy, no logré cargar las fotos en este momento - ya le avisé al equipo para que te las mande. 🙏`;
}

export async function generateReply(
  conversationId: string,
  context: ToolContext,
  personality?: BotPersonality | null,
  customerText?: string
): Promise<string> {
  // Fetch a bigger window than the model actually sees: extractMediaHistory removes several rows (one
  // per photo/video sent) entirely, so 30 raw rows reliably leaves ~20 meaningful entries after that.
  // `history` itself (raw, unfiltered) is still used below for lastAssistantText, which needs the real
  // prior text - growing its window from 20 to 30 doesn't change that function's result (it scans
  // backward and stops at the first CUSTOMER row either way).
  const history = await getRecentHistory(conversationId, 30);
  const contextSummary = await getOrRefreshContextSummary(conversationId, context.businessId);
  const { history: mediaFreeHistory, photosSent } = extractMediaHistory(history);
  const modelFacingHistory = mediaFreeHistory.slice(-20);

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
    ...(photosSent.length > 0
      ? [
          {
            role: "system" as const,
            content: `FOTOS/VIDEOS YA ENVIADOS en esta conversacion (no los vuelvas a ofrecer ni a decir que los mandaste de nuevo, salvo que el cliente los pida explicitamente): ${photosSent.join(", ")}`,
          },
        ]
      : []),
    ...modelFacingHistory.map((m) => ({
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
  // Set whenever get_product_details resolves this turn - lets finalizeTurn correct a false "no tiene
  // variantes" claim against the product it JUST looked up (with the real colors, not a generic stall),
  // instead of trusting the model to have read its own tool result correctly.
  let hasVariantsThisTurn: boolean | null = null;
  let variantColorsThisTurn: string[] = [];
  let shippingModalitiesThisTurn: { code: string; label: string }[] | null = null;
  // Set when show_order_summary ran this turn and returned ready:true - the one real, unambiguous total
  // for this order, used by guardAgainstOrderTotalMismatch below (B5, 2026-09-13 audit).
  let orderSummaryTotalThisTurn: number | null = null;

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
    text = guardAgainstShippingCostHallucination(text, shippingRatesThisTurn);
    await guardAgainstOrderTotalMismatch(context, text, orderSummaryTotalThisTurn);

    // hasVariantsThisTurn === true means get_product_details JUST returned real variants for the
    // product being discussed - if the model denies that anyway, its own tool result already proves it
    // wrong, so correct it deterministically instead of leaving a false statement with the customer.
    if (hasVariantsThisTurn === true && VARIANT_DENIAL_PATTERN.test(text)) {
      await recordAgentIncident(
        context.businessId,
        "BACKSTOP_INTERVENTION",
        `El bot nego variantes de color que si existen. Texto: "${text.slice(0, 200)}"`,
        conversationId
      );
      const colorList = variantColorsThisTurn.length > 0 ? variantColorsThisTurn.join(", ") : "varios colores";
      text = text.replace(VARIANT_DENIAL_PATTERN, `sí viene en estos colores: ${colorList}`);
    }

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
    ], context.businessId, conversationId);

    if (intentFlaggedThisTurn === 0 && customerText && customerRequestsHuman(customerText)) {
      await runCatalogTool(context, "flag_conversation_intent", { intent: "SOLICITA_AGENTE" });
    }

    if (nameSavedThisTurn === 0 && customerText) {
      if (ASK_NAME_PATTERN.test(lastAssistantText(history))) {
        // extractNameFromAnswer handles both a bare "David" AND a greeting-wrapped answer like "Hola con
        // einer mucho gusto" - a strict superset of the old bare looksLikePersonName(customerText) check
        // (no fillers to strip just means the candidate is the original text, unchanged).
        const answeredName = extractNameFromAnswer(customerText);
        if (answeredName) {
          await runCatalogTool(context, "save_customer_name", { name: answeredName });
        }
      } else {
        const selfIntroName = extractSelfIntroducedName(customerText);
        if (selfIntroName) {
          await runCatalogTool(context, "save_customer_name", { name: selfIntroName });
        }
      }
    }

    if (contactSavedThisTurn === 0 && customerText) {
      const priorAsk = lastAssistantText(history);
      const askedId = ASK_ID_PATTERN.test(priorAsk);
      const askedPhone = ASK_PHONE_PATTERN.test(priorAsk);

      if (looksLikeIdOrPhone(customerText)) {
        // Respuesta de un solo dato, puro numero: sigue resolviendose por cual fue la pregunta, que es
        // mas confiable que la forma cuando el mensaje no trae ninguna etiqueta.
        if (askedId && !askedPhone) {
          await runCatalogTool(context, "save_customer_contact_info", { idNumber: customerText.trim() });
        } else if (askedPhone && !askedId) {
          await runCatalogTool(context, "save_customer_contact_info", { deliveryPhone: customerText.trim() });
        }
      } else if (ASK_DELIVERY_DATA_PATTERN.test(priorAsk)) {
        // Respuesta combinada (texto + numeros). Cada dato se identifica por su propia etiqueta/forma,
        // asi que ya no importa que el bot haya pedido varios a la vez - ver
        // extractDeliveryDataFromAnswer.
        const found = extractDeliveryDataFromAnswer(customerText);
        if (found.idNumber || found.deliveryPhone) {
          await runCatalogTool(context, "save_customer_contact_info", found);
        }
        if (nameSavedThisTurn === 0) {
          const combinedName = extractNameFromDeliveryAnswer(customerText);
          // save_customer_name ya protege por su cuenta el nombre viejo cuando el nuevo es el del
          // destinatario y no una correccion del cliente (ver ese case en tools.ts).
          if (combinedName) {
            await runCatalogTool(context, "save_customer_name", { name: combinedName });
          }
        }
      }
    }

    if (mediaSentThisTurn > 0) return text;

    // 2026-09-13 audit incident: PHOTO_REQUEST_PATTERN's bare verbs matched "ese reloj no me MUESTRA la
    // distancia" (a screen complaint, not a photo request) and blasted 8 unrequested photos - use the
    // stricter CUSTOMER_PHOTO_REQUEST_PATTERN here, plus an explicit negation guard.
    const customerAsked =
      !!customerText &&
      CUSTOMER_PHOTO_REQUEST_PATTERN.test(customerText) &&
      !CUSTOMER_PHOTO_NEGATION_PATTERN.test(customerText);
    const fakeMediaTag = FAKE_MEDIA_TAG_PATTERN.test(stripMarkdownEmphasis(text));
    // Same incident, blast 1: the bot's own reply was a CONDITIONAL OFFER ("Si quieres te mando fotos de
    // los que te gusten") - PHOTO_CLAIM_PATTERN's "te mand.." matched it as if the send already happened.
    // OFFER_OR_PENDING_CONFIRMATION_PATTERN already exists for exactly this bug class and already guards
    // the payment/catalog/escalation backstops - it was never applied here. Deliberately NOT applied to
    // fakeMediaTag: a literal fabricated "[Foto de X]" tag is unambiguous regardless of nearby offer
    // language, unlike a natural-language claim.
    const modelClaimsSent =
      (PHOTO_CLAIM_PATTERN.test(text) &&
        PHOTO_REQUEST_PATTERN.test(text) &&
        !OPEN_CLARIFYING_QUESTION_PATTERN.test(text) &&
        !NON_PRODUCT_PHOTO_PATTERN.test(text) &&
        !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(stripMarkdownEmphasis(text))) ||
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
    if (attributeMatchThisTurn && attributeMatchThisTurn.length <= 3) {
      let sentAny = false;
      for (let i = 0; i < attributeMatchThisTurn.length; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
        const m = attributeMatchThisTurn[i];
        // A real WhatsApp send failure here (expired token, transient 5xx) used to throw uncaught all
        // the way out of generateReply - the text reply already generated for this turn never reached
        // the customer at all, not even the fallback apology, since this runs in the return path outside
        // generateReply's own try/catch. Degrade instead: log and keep going, so one failed photo never
        // silences the whole turn or blocks the rest of the batch.
        try {
          const result = (await runCatalogTool(context, "send_product_media", {
            productId: m.productId,
            variantId: m.variantId ?? undefined,
            skipIfAlreadySent: true,
          })) as { sent?: boolean; skipped?: boolean };
          // `skipped` significa que esas fotos YA se le mandaron antes en esta conversacion - el cliente
          // las tiene, no se cayo nada. Contarlo como fallo hacia que el bot se disculpara por fotos que
          // el cliente ya habia recibido (mismo texto de disculpa que ya causo tres mensajes raros en
          // produccion el 2026-09-15, esta vez por la rama de atributos).
          if (result?.sent || result?.skipped) sentAny = true;
        } catch (error) {
          console.error("Fallo el envio de una foto en el backstop de atributos:", error);
        }
      }
      return sentAny ? text : await honorOrRetractMediaPromise(context, conversationId, text);
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

    // Zero candidates does NOT mean a dropped product-photo promise - far more often it means the
    // "claim" was never about a catalog photo at all. Real regression this caused within minutes of
    // shipping (2026-09-15): "te paso la foto de la guía apenas se realice el envío" (a courier tracking
    // slip, promised for the FUTURE) matched PHOTO_CLAIM_PATTERN + PHOTO_REQUEST_PATTERN, matched no
    // product (correctly - there is none), and got the retraction line glued onto an otherwise perfect
    // shipping answer, in front of a customer mid-purchase. The retraction only makes sense when we had
    // a real product to send and the send itself failed; with nothing to send, stay quiet and just leave
    // the incident for the panel.
    if (matched.length === 0) {
      await recordAgentIncident(
        context.businessId,
        "BACKSTOP_INTERVENTION",
        `Texto parecia prometer fotos pero no se identifico ningun producto para mandar: "${text.slice(0, 160)}"`,
        conversationId
      );
      return text;
    }

    let sentAny = false;
    for (let i = 0; i < matched.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
      // Same reasoning as the attribute-match loop above: never let one failed send take the whole
      // turn's reply down with it.
      try {
        const result = (await runCatalogTool(context, "send_product_media", {
          productName: matched[i].name,
          skipIfAlreadySent: true,
        })) as { sent?: boolean; skipped?: boolean };
        // Mismo criterio que la rama de atributos: ya enviadas antes = el cliente las tiene.
        if (result?.sent || result?.skipped) sentAny = true;
      } catch (error) {
        console.error("Fallo el envio de una foto en el backstop de nombres:", error);
      }
    }

    return sentAny ? text : await honorOrRetractMediaPromise(context, conversationId, text);
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
  //
  // 2026-09-13 audit (F7): originally required BOTH a color word AND a configured category word in the
  // same message, so a color-only reply ("el negro", "quiero el rosadito") or a category-only question
  // ("¿que relojes tienen?") never forced the tool at all - only the narrow "reloj negro" case did.
  // find_products_by_attributes's own schema (Phase 5) already accepts category/color/freeText
  // independently, so there's no reason to require both here either - loosened to OR.
  const shouldForceAttributeFilter =
    !!customerText &&
    (canonicalColors(customerText).length > 0 || (await textMentionsConfiguredCategory(context.businessId, customerText)));

  // Real production bug (2026-09-14/15): a customer sends a photo of a product they want, the model
  // can't confidently match it and asks "¿me confirmas cuál de estos dos es?", the customer sends ANOTHER
  // photo (reasonable read: "here, does this help identify it"), and the model just asks the same
  // clarifying question again - a real conversation did this 4 times in a row and never resolved,
  // wasting the customer's patience and the sale. ask_owner_about_photo exists exactly for this ("last
  // resort when image analysis can't confidently identify the product") but nothing forced the model to
  // actually reach for it instead of asking the customer to try again. Force it once the customer has
  // already sent a photo/video at least twice in a row without the bot ever resolving which product it
  // is - mirrors the shouldForceAttributeFilter pattern above (force tool_choice, model still owns the
  // real question text).
  const lastHistoryEntry = history[history.length - 1];
  const shouldForcePhotoEscalation =
    !!lastHistoryEntry &&
    lastHistoryEntry.role === "CUSTOMER" &&
    (lastHistoryEntry.mediaType === "IMAGE" || lastHistoryEntry.mediaType === "VIDEO") &&
    countUnresolvedPhotoIdStreak(history.slice(0, -1)) >= 2;

  const forcedToolChoice = shouldForcePhotoEscalation
    ? "ask_owner_about_photo"
    : shouldForceAttributeFilter
      ? "find_products_by_attributes"
      : null;

  try {
    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await createChatCompletion({
        max_tokens: 1024,
        messages,
        tools: catalogTools,
        ...(iteration === 0 && forcedToolChoice
          ? { tool_choice: { type: "function" as const, function: { name: forcedToolChoice } } }
          : {}),
        // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning
        // tokens add latency/cost we don't need for a WhatsApp sales reply.
        thinking: { type: "disabled" },
      }, { businessId: context.businessId, conversationId });

      await logAiUsage({
        businessId: context.businessId,
        conversationId,
        kind: "CHAT",
        model: response.model || DEEPSEEK_MODEL,
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
          ready?: boolean;
          total?: number;
          id?: string;
          variants?: { id: string; color: string | null; size: string | null }[];
        };
        if (result?.mediaJustSent || result?.sent) mediaSentThisTurn++;
        // Tracks whether THIS product genuinely has variants, straight from formatProduct's own output -
        // used below to correct a "no tiene variantes" claim the model makes right after actually seeing
        // real variant data (2026-09-15 incident: get_product_details returned 3 real active color
        // variants and the model still told the customer "no tiene variantes de color cargadas").
        if (call.function.name === "get_product_details" && typeof result?.id === "string") {
          hasVariantsThisTurn = Array.isArray(result.variants) && result.variants.length > 0;
          variantColorsThisTurn = (result.variants ?? []).map((v) => v.color).filter((c): c is string => !!c);
        }
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
        if (call.function.name === "show_order_summary" && result?.ready && typeof result.total === "number") {
          orderSummaryTotalThisTurn = result.total;
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
    if (!lastText) await alertOwnerOfDegradedReply(context, "Fallo la llamada a DeepSeek y no habia texto previo que mostrar");
    return finalizeTurn(lastText || FALLBACK_TEXT);
  }

  // Reached only when the model kept requesting tools through all 5 iterations without ever returning
  // plain text - F2 from the 2026-09-13 audit. Returning `lastText` here used to often be literally the
  // intermediate "dame un momento, reviso el catalogo" the model wrote ALONGSIDE a tool call, not a real
  // answer - and none of the applyClaimBackstops guards above catch it, because the tools DID run this
  // turn (their `alreadyHandled` is true), so the customer got the raw dangling promise with nothing
  // after it. One extra untooled completion (this rare path only, never the normal turn) asks the model
  // to write the actual final answer using everything already gathered in `messages` instead of just
  // returning whatever text happened to come along with the last tool call.
  console.warn(`generateReply: loop de tool-calling agotado (5 iteraciones) sin respuesta final, conversation=${conversationId}`);
  await recordAgentIncident(context.businessId, "LOOP_EXHAUSTED", "Loop de tool-calling agotado (5 iteraciones) sin respuesta final", conversationId);
  let finalText = lastText;
  try {
    const finalCompletion = await createChatCompletion({
      max_tokens: 1024,
      messages,
      // No `tools` here on purpose - forces a plain-text answer instead of yet another tool request.
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types.
      thinking: { type: "disabled" },
    }, { businessId: context.businessId, conversationId });
    await logAiUsage({ businessId: context.businessId, conversationId, kind: "CHAT", model: finalCompletion.model || DEEPSEEK_MODEL, usage: finalCompletion.usage });
    finalText = finalCompletion.choices[0]?.message?.content?.trim() || lastText;
  } catch (error) {
    console.error("Fallo la llamada final (sin herramientas) tras agotar el loop de tool-calling:", error);
  }
  if (!finalText) await alertOwnerOfDegradedReply(context, "Se agoto el loop de herramientas y no se logro generar ninguna respuesta final");
  return finalizeTurn(finalText || FALLBACK_TEXT);
}
