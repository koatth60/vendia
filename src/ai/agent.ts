import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL } from "./client";
import { createChatCompletion } from "./modelFailover";
import { catalogTools, saleStateTools, runCatalogTool, type ToolContext } from "./tools";
import { getRecentHistory, findOpenPendingOwnerQuestionsForConversation } from "../conversation/service";
import { logAiUsage } from "./usage";
import { prisma } from "../db/client";
import { sendAlertToOwner } from "../whatsapp/outbound";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { recordAgentIncident } from "./incidents";
import { textMentionsConfiguredCategory } from "../catalog/products";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { buildCheckoutState } from "../orders/checkoutStateFromDb";
import {
  getSaleState,
  formatSaleStateForPrompt,
  getBlockedBy,
  getMediaSent,
  getPhotoIdStreak,
  bumpPhotoIdStreak,
  resetPhotoIdStreak,
} from "../orders/saleState";
import { canonicalColors } from "../catalog/attributeTaxonomy";
import { tokenize, normalizeForMatch } from "../search/text";
import { buildSystemPrompt, type BotPersonality } from "./prompts/systemPrompt";
import { CLOSING_MESSAGE_PROMPT } from "./prompts/closingMessage";
import {
  PAYMENT_BLOCK_MARKER,
  SHIPPING_BLOCK_MARKER,
  TOTAL_BLOCK_MARKER,
  ORDER_SUMMARY_BLOCK_MARKER,
  SALE_BLOCKED_BLOCK_MARKER,
} from "./fixedBlockMarkers";

export {
  PAYMENT_BLOCK_MARKER,
  SHIPPING_BLOCK_MARKER,
  TOTAL_BLOCK_MARKER,
  ORDER_SUMMARY_BLOCK_MARKER,
  SALE_BLOCKED_BLOCK_MARKER,
};

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

// Fase 5 del plan maestro (2026-09-15), causa raiz C2: los medios pasan a ser una decision de
// herramienta, nunca de texto - las nueve capas de regex que vivian aca (PHOTO_REQUEST_PATTERN,
// CUSTOMER_PHOTO_REQUEST_PATTERN, CUSTOMER_PHOTO_NEGATION_PATTERN, PHOTO_CLAIM_PATTERN,
// OPEN_CLARIFYING_QUESTION_PATTERN, NON_PRODUCT_PHOTO_PATTERN, FAKE_MEDIA_TAG_PATTERN,
// PHOTO_ID_CLARIFY_PATTERN, VARIANT_DENIAL_PATTERN), mas findMentionedProductsForMediaBackstop,
// honorOrRetractMediaPromise y OFFER_OR_PENDING_CONFIRMATION_PATTERN, se borraron enteras junto con
// el bloque de finalizeTurn que las usaba. send_product_media (tools.ts) es el unico camino real;
// cuando un producto no tiene foto, la herramienta devuelve sent:false y el modelo lo dice con sus
// propias palabras, sin ningun parche de texto encima. MEDIA_TAG_STRIP_PATTERN y MEDIA_CAPTION_PATTERN
// se conservan mas abajo, solo como saneamiento de la respuesta final (nunca para decidir si mandar
// algo).
export const MEDIA_TAG_STRIP_PATTERN = /\[[^\]]{0,60}\b(?:fotos?|videos?)\b[^\]]{0,60}\]/gi;

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

// Reintroducido de la Fase 4 del plan maestro (2026-09-15, commit e26d71e la borro junto con
// applyClaimBackstops) - mismo patron exacto, ahora solo como detector sin efecto para F1 del
// diagnostico: cuenta cuando el modelo promete consultar al dueno en prosa sin que exista ninguna
// PendingOwnerQuestion real que respalde esa promesa (ni de este turno ni de uno anterior). Nunca
// llama ask_owner, nunca toca el texto - ver el AgentIncident "escalacion_prometida_sin_herramienta"
// en finalizeTurn.
const ESCALATION_CLAIM_PATTERN =
  /\b(equipo|due[ñn][oa]s?)\b.{0,25}\b(consult|confirm|pregunt|revis)|\b(consult|confirm|pregunt|revis)\w*\b.{0,25}\b(equipo|due[ñn][oa]s?)\b/i;

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

// La direccion dentro de una respuesta combinada. Una direccion colombiana casi siempre trae una de
// estas palabras de via ("Cra 17 # 23-03", "Calle 57 sur 65 92", "Mz 4 casa 12"), y eso la distingue de
// una cedula o un celular sueltos sin necesidad de entender la frase entera. Se toma la linea completa
// donde aparece: el resto de la linea suele ser el barrio o el detalle de casa/apartamento, que el
// mensajero necesita igual. Real (2026-09-15): "Santa rosa de cabal risaralda | Cra 17 # 23-03 villa
// alegria | Linda Marin | 1093223487 | 3135794619" - todo en un mensaje, y la direccion no se guardaba.
const STREET_WORD_PATTERN =
  /\b(cra|carrera|cll|calle|kr|kra|av|avenida|diagonal|diag|transversal|trans|tv|manzana|mz|lote|lt|autopista|via|vereda|conjunto|torre|apto|apartamento|casa|piso|barrio|bloque|interior|urbanizaci[oó]n)\b/i;

export function extractAddressFromAnswer(text: string): string | null {
  const lines = text
    .split(/\n|\s{3,}|\s*\|\s*/)
    .map((l) => l.trim())
    .filter(Boolean);
  const candidate = lines.find((l) => STREET_WORD_PATTERN.test(l) && /\d/.test(l));
  if (!candidate) return null;
  // Una linea que es solo un numero largo con una palabra suelta no es una direccion.
  if (candidate.replace(/\D/g, "").length > 12) return null;
  return candidate.length > 120 ? candidate.slice(0, 120) : candidate;
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

function formatPesos(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export interface FixedBlockData {
  paymentMethods: { label: string; details: string }[] | null;
  shippingRate: { label: string; cost: string } | null;
  orderSummary: {
    items: { productName: string; variantLabel?: string | null; quantity: number; lineTotal: number }[];
    shippingCost: number;
    total: number;
  } | null;
  // Fase 6 del plan maestro (2026-09-15): lista de lo que falta configurar, solo si una de
  // show_order_summary/set_payment_method/close_conversation quedo bloqueada ESTE turno por la
  // compuerta de configHealth.getSaleGate. null cuando ninguna corrio bloqueada.
  saleBlocked: string[] | null;
}

// Fase 3 del plan maestro (2026-09-15), causa raiz C2: reemplaza los tres guards que LEIAN la prosa ya
// generada para detectar una cifra de pago/envio/total inventada (guardAgainstPaymentHallucination,
// guardAgainstShippingCostHallucination, guardAgainstOrderTotalMismatch - los tres borrados en este
// commit, junto con las tres backstop tras el hecho). El modelo ya no escribe estas cifras: pone la marca
// correspondiente donde quiere que aparezcan y redacta alrededor; esta funcion la sustituye por el dato
// real de ESTE turno antes de que el mensaje salga. Una marca sin dato real que la respalde (el modelo la
// puso sin haber llamado la herramienta que la llena) se borra en silencio en vez de dejarla pasar
// literal al cliente - finalizeTurn registra el incidente cuando eso pasa.
export function renderFixedBlocks(text: string, data: FixedBlockData): { text: string; missingBlocks: string[] } {
  const missingBlocks: string[] = [];

  if (text.includes(PAYMENT_BLOCK_MARKER)) {
    if (data.paymentMethods?.length) {
      const block = data.paymentMethods.map((m) => `*${m.label}*\n${m.details}`).join("\n\n");
      text = text.split(PAYMENT_BLOCK_MARKER).join(block);
    } else {
      missingBlocks.push("pago");
      text = text.split(PAYMENT_BLOCK_MARKER).join("");
    }
  }

  if (text.includes(SHIPPING_BLOCK_MARKER)) {
    if (data.shippingRate) {
      text = text.split(SHIPPING_BLOCK_MARKER).join(`$${formatPesos(parseFloat(data.shippingRate.cost))}`);
    } else {
      missingBlocks.push("envio");
      text = text.split(SHIPPING_BLOCK_MARKER).join("");
    }
  }

  if (text.includes(TOTAL_BLOCK_MARKER)) {
    if (data.orderSummary) {
      text = text.split(TOTAL_BLOCK_MARKER).join(`$${formatPesos(data.orderSummary.total)}`);
    } else {
      missingBlocks.push("total");
      text = text.split(TOTAL_BLOCK_MARKER).join("");
    }
  }

  if (text.includes(SALE_BLOCKED_BLOCK_MARKER)) {
    if (data.saleBlocked && data.saleBlocked.length > 0) {
      const block = `Por ahora no puedo confirmarte el pago ni el total (falta configurar ${data.saleBlocked.join(", ")}). Puedo dejar tu pedido anotado tal como esta para que el dueño te confirme esos datos directamente.`;
      text = text.split(SALE_BLOCKED_BLOCK_MARKER).join(block);
    } else {
      missingBlocks.push("venta_bloqueada");
      text = text.split(SALE_BLOCKED_BLOCK_MARKER).join("");
    }
  }

  if (text.includes(ORDER_SUMMARY_BLOCK_MARKER)) {
    if (data.orderSummary) {
      const lines = [
        ...data.orderSummary.items.map(
          (item) =>
            `${item.quantity}x ${item.productName}${item.variantLabel ? ` (${item.variantLabel})` : ""} — $${formatPesos(item.lineTotal)}`
        ),
        data.orderSummary.shippingCost > 0 ? `Envío: $${formatPesos(data.orderSummary.shippingCost)}` : "Envío: gratis",
        `Total: $${formatPesos(data.orderSummary.total)}`,
      ];
      text = text.split(ORDER_SUMMARY_BLOCK_MARKER).join(lines.join("\n"));
    } else {
      missingBlocks.push("resumen");
      text = text.split(ORDER_SUMMARY_BLOCK_MARKER).join("");
    }
  }

  return { text, missingBlocks };
}

function looksLikeIdOrPhone(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[\d\s-]{6,15}$/.test(trimmed)) return false;
  return /\d{6,}/.test(trimmed.replace(/\D/g, ""));
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

// Nombres de herramientas internas escritos dentro del mensaje al cliente. Real (2026-09-15): una
// clienta recibio "Aquí van las fotos del Combo Pareja 📸 [send_product_media: Combo Pareja]". El modelo
// imita el formato de los tool calls que ve en su propio contexto. MEDIA_TAG_STRIP_PATTERN no lo
// agarra porque ese patron exige la palabra foto/video adentro del corchete, y aca el corchete lleva
// el nombre tecnico de la herramienta.
const TOOL_CALL_LEAK_PATTERN = /\[\s*(?:send_product_media|get_product_details|search_products|find_products_by_attributes|ask_owner(?:_about_photo)?|save_customer_(?:name|contact_info)|get_faq|get_payment_methods|get_shipping_[a-z_]+|show_order_summary|close_sale|update_conversation_status|flag_conversation_intent|cancel_order|get_previous_conversation|list_all_products)\b[^\]]*\]/gi;

// El estado interno del sistema no es asunto del cliente. Real (2026-09-15): a una clienta que acababa
// de pagar y mandar el comprobante el bot le respondio "tu pedido aún no aparece registrado en el
// sistema porque el pago todavía está en verificación de nuestro lado". Es cierto y es pesimo: describe
// la mecanica interna en vez de decirle lo unico que le importa, que su pago esta siendo verificado.
const INTERNAL_STATE_PATTERN =
  /\bno (aparece|figura|esta|está) (registrad[oa]|cargad[oa]|cread[oa]) en (el|nuestro) sistema\b[^.]*\.?/gi;

export function stripInternalLeaks(text: string): string {
  return text
    .replace(TOOL_CALL_LEAK_PATTERN, "")
    .replace(INTERNAL_STATE_PATTERN, "tu pago todavía lo está verificando el equipo")
    // Fase 5 del plan maestro (2026-09-15): saneamiento puro, nunca una decision - si el modelo escribe
    // un corchete tipo "[Foto de X]"/"[3 fotos]" en su propia respuesta (nunca es un envio real, eso lo
    // decide send_product_media), se borra sin agregar ninguna retractacion ni reintentar nada.
    .replace(MEDIA_TAG_STRIP_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function lastAssistantText(history: { role: string; content: string }[]): string {
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].role === "ASSISTANT") return stripMarkdownEmphasis(history[i].content);
    if (history[i].role === "CUSTOMER") break;
  }
  return "";
}

// B4 (2026-09-13 audit): when finalizeTurn ends up sending the generic FALLBACK_TEXT apology, or the
// tool-calling loop exhausts all 5 iterations without a real answer, the customer gets a dead end and
// nobody - not even the owner - ever finds out unless they happen to read server logs. This surfaces it
// as a real WhatsApp alert instead, same channel as every other escalation.
async function alertOwner(context: ToolContext, text: string): Promise<void> {
  const business = await prisma.business.findUnique({ where: { id: context.businessId }, select: { contactPhone: true } });
  if (!business?.contactPhone) return;
  const result = await sendAlertToOwner(context.businessId, context.credentials, business.contactPhone, text);
  await recordOwnerMessage(context.businessId, {
    direction: "OUT",
    body: text,
    success: result.delivered,
    errorMessage: result.failure?.message ?? null,
  });
  if (!result.delivered) console.error("No se pudo avisar al dueno:", result.failure?.message);
}

async function alertOwnerOfDegradedReply(context: ToolContext, reason: string): Promise<void> {
  await alertOwner(
    context,
    `Aviso: el bot le mando una respuesta generica a un cliente en vez de resolverle la consulta. Motivo: ${reason}. Revisa esa conversacion en el panel.`
  );
  await recordAgentIncident(context.businessId, "DEGRADED_REPLY", reason, context.conversationId, "degraded_reply_fallback");
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
  const { history: mediaFreeHistory } = extractMediaHistory(history);
  const modelFacingHistory = mediaFreeHistory.slice(-20);

  // Fase 5 del plan maestro (2026-09-15), causa raiz C2: la lista de "ya enviado" viene de SaleState
  // (escrita por tools.ts en el momento real del envio), no de reconstruirla leyendo el historial con
  // MEDIA_CAPTION_PATTERN. Independiente de saleStateEnabled, igual que blockedBy.
  const mediaSent = await getMediaSent(conversationId);

  const lastHistoryEntry = history[history.length - 1];
  const customerSentMediaThisTurn =
    !!lastHistoryEntry && lastHistoryEntry.role === "CUSTOMER" && (lastHistoryEntry.mediaType === "IMAGE" || lastHistoryEntry.mediaType === "VIDEO");
  // Fase 5: racha de rondas de identificacion por foto sin resolver, leida como estado real (ver
  // shouldForcePhotoEscalation abajo) en vez de escanear el historial buscando una frase del modelo.
  const photoIdStreakAtTurnStart = customerSentMediaThisTurn ? await getPhotoIdStreak(conversationId) : 0;

  // Fase 2 del plan maestro (2026-09-15), causa raiz C1: el estado real del pedido en curso, calculado
  // de la base (nunca de lo que diga el modelo), inyectado como mensaje system - mismo canal que ya usa
  // FOTOS/VIDEOS YA ENVIADOS abajo. Solo para negocios con la bandera activa; el resto sigue exactamente
  // igual que hoy.
  const saleState = personality?.saleStateEnabled ? await getSaleState(conversationId) : null;
  const saleStateText = saleState ? formatSaleStateForPrompt(saleState) : "";
  // Herramientas nuevas solo visibles (y llamables) para un negocio con la bandera activa - el resto no
  // paga el costo de tokens de un tool que no puede usar.
  const tools = personality?.saleStateEnabled ? [...catalogTools, ...saleStateTools] : catalogTools;

  // Fase 4 del plan maestro (2026-09-15), correccion causa raiz C2: si esta conversacion ya tiene una
  // pregunta sin responder del dueno AL EMPEZAR este turno, se lo decimos al modelo como dato de estado
  // (mismo canal que FOTOS/VIDEOS YA ENVIADOS abajo) en vez de reemplazarle la respuesta entera despues -
  // eso descartaba cualquier respuesta real a otra cosa que el cliente preguntara. Independiente de
  // saleStateEnabled (ver getBlockedBy): la escalacion real es Core, no una funcion de seguimiento de
  // pedido. La pregunta pendiente en si (no solo el marcador) viene de PendingOwnerQuestion - ask_owner
  // en tools.ts ya se niega a abrir una segunda mientras esta siga abierta.
  const blockedByAtTurnStart = await getBlockedBy(conversationId);
  const pendingOwnerQuestionsAtTurnStart = blockedByAtTurnStart
    ? await findOpenPendingOwnerQuestionsForConversation(conversationId)
    : [];

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
    ...(saleStateText
      ? [{ role: "system" as const, content: saleStateText }]
      : []),
    ...(mediaSent.length > 0
      ? [
          {
            role: "system" as const,
            content: `FOTOS/VIDEOS YA ENVIADOS en esta conversacion (no los vuelvas a ofrecer ni a decir que los mandaste de nuevo, salvo que el cliente los pida explicitamente): ${mediaSent.join(", ")}`,
          },
        ]
      : []),
    ...(pendingOwnerQuestionsAtTurnStart.length > 0
      ? [
          {
            role: "system" as const,
            content: `PREGUNTA PENDIENTE CON EL DUEÑO: ya le preguntaste ${pendingOwnerQuestionsAtTurnStart.map((p) => `"${p.question}"`).join(", ")}, sigue sin responder. No vuelvas a prometer que vas a consultar eso; sí puedes seguir ayudando con todo lo demás.`,
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
  // Fase 5: junto con mediaSentThisTurn, decide si esta ronda de identificacion por foto quedo resuelta
  // (ver el bump/reset de SaleState.photoIdStreak al final de finalizeTurn).
  let photoEscalatedThisTurn = 0;
  let nameSavedThisTurn = 0;
  let contactSavedThisTurn = 0;
  let intentFlaggedThisTurn = 0;
  let paymentMethodsThisTurn: { type: string; label: string; details: string }[] | null = null;
  // Fase 3 del plan maestro (2026-09-15): dos fuentes posibles para {{BLOQUE_ENVIO}}. get_shipping_rate_for_city
  // ya devuelve una tarifa unica resuelta para la ciudad del cliente - siempre gana si corrio este turno.
  // get_shipping_rates devuelve TODAS las tarifas configuradas; solo sirve de fuente cuando el negocio
  // tiene una sola (ambiguo con 2+, nadie eligio categoria todavia).
  let shippingRatesListThisTurn: { label: string; cost: string }[] | null = null;
  let cityShippingRateThisTurn: { label: string; cost: string } | null = null;
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
  // Fase 3: resultado completo de show_order_summary de ESTE turno (no solo el total) - fuente de
  // {{BLOQUE_TOTAL}} y {{BLOQUE_RESUMEN}}. null si no corrio o si todavia no esta ready.
  let orderSummaryThisTurn: FixedBlockData["orderSummary"] = null;
  // Fase 6: lo que falta configurar, si show_order_summary/set_payment_method/close_conversation
  // quedaron bloqueadas por getSaleGate en algun llamado de este turno - fuente de
  // {{BLOQUE_VENTA_BLOQUEADA}}.
  let saleBlockedThisTurn: string[] | null = null;

  async function finalizeTurn(text: string): Promise<string> {
    text = stripInternalLeaks(text);

    // Etapa 1 del estado de pedido: se calcula y se registra, NO se usa. Sirve para comparar durante unos
    // dias lo que el estado dice que falta contra lo que el bot realmente pidio, y corregirlo antes de
    // que empiece a decidir respuestas. Nunca puede romper el turno: si falla, se loguea y sigue.
    void buildCheckoutState(conversationId)
      .then((estado) => {
        if (!estado) return;
        console.log(
          `[estado-pedido] conv=${conversationId} completo=${estado.completo} faltan=${JSON.stringify(estado.faltan)}`
        );
      })
      .catch((error) => console.error("No se pudo calcular el estado de pedido (no bloqueante):", error));

    const resolvedShippingRate =
      cityShippingRateThisTurn ?? (shippingRatesListThisTurn?.length === 1 ? shippingRatesListThisTurn[0] : null);
    const { text: renderedText, missingBlocks } = renderFixedBlocks(text, {
      paymentMethods: paymentMethodsThisTurn,
      shippingRate: resolvedShippingRate,
      orderSummary: orderSummaryThisTurn,
      saleBlocked: saleBlockedThisTurn,
    });
    text = renderedText;
    if (missingBlocks.length > 0) {
      await recordAgentIncident(
        context.businessId,
        "BACKSTOP_INTERVENTION",
        `El bot puso una marca de bloque fijo (${missingBlocks.join(", ")}) sin haber llamado la herramienta que la respalda este turno - se borro antes de enviar.`,
        conversationId,
        "fixed_block_missing_data"
      );
    }

    if (intentFlaggedThisTurn === 0 && customerText && customerRequestsHuman(customerText)) {
      await runCatalogTool(context, "flag_conversation_intent", { intent: "SOLICITA_AGENTE" });
    }

    // F1 del diagnostico: detector sin efecto. Si el texto promete consultar al dueno pero no hay
    // ninguna PendingOwnerQuestion real que la respalde (ni abierta antes de este turno, ni creada
    // recien por un ask_owner/ask_owner_about_photo que si corrio), solo se cuenta - nunca se llama
    // ask_owner, nunca se toca el texto.
    if (ESCALATION_CLAIM_PATTERN.test(text)) {
      const stillNoOpenQuestion = (await findOpenPendingOwnerQuestionsForConversation(conversationId)).length === 0;
      if (stillNoOpenQuestion) {
        await recordAgentIncident(
          context.businessId,
          "BACKSTOP_INTERVENTION",
          `El bot prometio consultar al dueno en prosa sin ninguna PendingOwnerQuestion real que respalde la promesa. Texto: "${text.slice(0, 200)}"`,
          conversationId,
          "escalacion_prometida_sin_herramienta"
        );
      }
    }

    // Fase 2 del plan maestro (2026-09-15), causa raiz C1: estos dos backstops INFIEREN el dato leyendo
    // la prosa del cliente porque hasta ahora no habia otro lugar que supiera que se le pregunto. Con
    // SaleState activo el modelo ve el estado real y llama save_customer_name/save_customer_contact_info
    // el mismo (ver PEDIDO_DATOS_DIRECTIVE_SALESTATE), asi que esta inferencia queda apagada para no
    // pisarle el guardado bien hecho con una lectura de prosa peor. Bandera apagada = cero cambio.
    if (nameSavedThisTurn === 0 && customerText && !personality?.saleStateEnabled) {
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

    if (contactSavedThisTurn === 0 && customerText && !personality?.saleStateEnabled) {
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
        const address = extractAddressFromAnswer(customerText) ?? undefined;
        if (found.idNumber || found.deliveryPhone || address) {
          await runCatalogTool(context, "save_customer_contact_info", { ...found, address });
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

    // Fase 5 del plan maestro (2026-09-15): racha real (no de regex) de rondas de identificacion por
    // foto sin resolver - se resuelve apenas se manda una foto de verdad o se escala al dueno, sino
    // sigue subiendo. Solo se toca cuando el cliente mando una foto/video este turno (ver
    // shouldForcePhotoEscalation).
    if (customerSentMediaThisTurn) {
      if (mediaSentThisTurn > 0 || photoEscalatedThisTurn > 0) {
        await resetPhotoIdStreak(conversationId);
      } else {
        await bumpPhotoIdStreak(conversationId);
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
  // real question text). photoIdStreakAtTurnStart is real state (SaleState.photoIdStreak), bumped/reset
  // below in finalizeTurn - Fase 5 replaced the old regex scan of the bot's own clarifying phrasing.
  const shouldForcePhotoEscalation = customerSentMediaThisTurn && photoIdStreakAtTurnStart >= 2;

  // Fase 2 seguimiento (2026-09-15): regrabar bf5c4k con SaleState activo mostro que el empujon de
  // prompt solo no alcanza - en una conversacion real el modelo jamas llamo save_customer_name ni
  // save_customer_contact_info por su cuenta (ver knownFailing de ese fixture), a pesar de que el
  // prompt se lo pide. Mismo mecanismo que shouldForceAttributeFilter/shouldForcePhotoEscalation de
  // arriba: se fuerza CUAL herramienta llamar, nunca los argumentos - el modelo sigue siendo quien lee
  // el mensaje del cliente y decide los valores reales. Los patrones reusados (ASK_NAME_PATTERN,
  // ASK_ID_PATTERN, etc, y extractSelfIntroducedName) son los MISMOS que ya existian para el camino
  // viejo de inferencia por regex - aca se usan solo como disparador ("le preguntaron esto"), nunca
  // para adivinar el valor, que es justamente la distincion que separa este guard del que la Fase 2
  // vino a apagar. Solo aplica con la bandera activa; sin ella, cero cambio de comportamiento.
  const priorAskForForcing = lastAssistantText(history);
  const shouldForceSaveName =
    !!personality?.saleStateEnabled &&
    !saleState?.customerName &&
    !!customerText &&
    (ASK_NAME_PATTERN.test(priorAskForForcing) || !!extractSelfIntroducedName(customerText));
  const shouldForceContactInfo =
    !!personality?.saleStateEnabled &&
    !!customerText &&
    (!saleState?.idNumber || !saleState?.deliveryPhone || !saleState?.address) &&
    (ASK_ID_PATTERN.test(priorAskForForcing) ||
      ASK_PHONE_PATTERN.test(priorAskForForcing) ||
      ASK_DELIVERY_DATA_PATTERN.test(priorAskForForcing));

  const forcedToolChoice = shouldForcePhotoEscalation
    ? "ask_owner_about_photo"
    : shouldForceAttributeFilter
      ? "find_products_by_attributes"
      : shouldForceSaveName
        ? "save_customer_name"
        : shouldForceContactInfo
          ? "save_customer_contact_info"
          : null;

  try {
    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await createChatCompletion({
        max_tokens: 1024,
        messages,
        tools,
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
          shippingCost?: number;
          items?: { productName: string; variantLabel?: string | null; quantity: number; lineTotal: number }[];
          blocked?: boolean;
          missing?: string[];
        };
        if (result?.blocked && Array.isArray(result.missing)) saleBlockedThisTurn = result.missing;
        if (result?.mediaJustSent || result?.sent) mediaSentThisTurn++;
        if (call.function.name === "ask_owner_about_photo" && result?.asked) photoEscalatedThisTurn++;
        if (call.function.name === "save_customer_name") nameSavedThisTurn++;
        if (call.function.name === "save_customer_contact_info") contactSavedThisTurn++;
        if (call.function.name === "flag_conversation_intent") intentFlaggedThisTurn++;
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
          shippingRatesListThisTurn = result.rates;
        }
        if (call.function.name === "get_shipping_rate_for_city" && result?.matched && result.label && result.cost) {
          cityShippingRateThisTurn = { label: result.label, cost: result.cost };
        }
        if (
          call.function.name === "find_products_by_attributes" &&
          !result?.ambiguousAcrossCategories &&
          Array.isArray(result?.matches) &&
          result.matches.length > 0
        ) {
          attributeMatchThisTurn = result.matches;
        }
        if (
          call.function.name === "show_order_summary" &&
          result?.ready &&
          typeof result.total === "number" &&
          Array.isArray(result.items)
        ) {
          orderSummaryThisTurn = { items: result.items, shippingCost: result.shippingCost ?? 0, total: result.total };
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
  // answer, so the customer got the raw dangling promise with nothing after it. One extra untooled
  // completion (this rare path only, never the normal turn) asks the model
  // to write the actual final answer using everything already gathered in `messages` instead of just
  // returning whatever text happened to come along with the last tool call.
  console.warn(`generateReply: loop de tool-calling agotado (5 iteraciones) sin respuesta final, conversation=${conversationId}`);
  await recordAgentIncident(context.businessId, "LOOP_EXHAUSTED", "Loop de tool-calling agotado (5 iteraciones) sin respuesta final", conversationId, "loop_exhaustion");
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
