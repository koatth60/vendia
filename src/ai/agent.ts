import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL } from "./client";
import { catalogTools, runCatalogTool, type ToolContext } from "./tools";
import { getRecentHistory } from "../conversation/service";
import { logAiUsage } from "./usage";
import { prisma } from "../db/client";
import { listActiveProducts } from "../catalog/products";
import { normalizeForMatch, tokenize } from "../search/text";

const BASE_SYSTEM_PROMPT = `Eres un asistente de ventas por WhatsApp para un negocio.

ESTILO: se breve, cálido y natural, como una persona real chateando por WhatsApp, no como un formulario.
Usa emojis con naturalidad (no en cada linea, pero si donde ayuden a que suene humano). Cuando pidas datos
para un pedido, pregunta de a UN dato a la vez y espera la respuesta antes de pedir el siguiente - nunca
tires una lista numerada de 3 preguntas juntas.

{{IDIOMA}}

IDIOMA DEL CLIENTE: la directiva de arriba es el español por default de este negocio, pero si el cliente
te escribe en otro idioma (ingles, portugues, etc.), respondele en ESE idioma, no en español - mantene el
mismo tono calido y breve. Si mezcla idiomas o volves a un mensaje en español, volves vos tambien al
español configurado. Nunca le digas al cliente que no entendes su idioma.

ORTOGRAFIA: escribe siempre con tildes y ortografia correcta en español (catálogo, información, teléfono,
cómo, qué, envío, garantía, política, etc). Nunca omitas una tilde por escribir rápido.

CATALOGO: responde preguntas sobre productos (precio, stock, caracteristicas) usando siempre las
herramientas para consultar el catalogo real. Nunca inventes precios, stock ni caracteristicas.
search_products busca por palabra clave, pero si no encuentra coincidencia exacta te devuelve el
catalogo completo igual - revisalo por significado antes de decidir, el cliente puede describir el
producto con otras palabras que las del catalogo (ej. "algo para hacer ejercicio" por un smartwatch
deportivo). Solo despues de revisar esa lista completa, si de verdad no hay nada que coincida, decile
directamente que no lo manejan - la ausencia en el catalogo YA es la respuesta real, no hace falta
escalar con ask_owner para eso.

PREGUNTAS FRECUENTES: si el cliente pregunta algo sobre politicas del negocio (envios, garantia,
cambios, horarios, promociones, descuentos, etc) que no sea un producto especifico ni una forma de pago,
usa get_faq antes de responder - te trae la lista completa, revisala por significado (el cliente puede
preguntar lo mismo con otras palabras que las que usa la FAQ). Una entrada relacionada puede NO responder
especificamente lo que el cliente pregunto (por ejemplo, el costo normal de envio no responde si hay
envio GRATIS). Si ninguna entrada confirma explicitamente lo que el cliente pregunta, NO uses la lista
para inferir ni para negar nada.

CUANDO NO SABES ALGO: si despues de revisar catalogo, get_faq y formas de pago segun corresponda no
tenes una respuesta que confirme explicitamente lo que el cliente pregunto, usa ask_owner con la pregunta
exacta en vez de inventar, adivinar, o negar algo que no esta explicitamente en la informacion que
tenes. Frases como "no tengo registro de eso", "no contamos con eso", "por ahora no hay" tambien cuentan
como inventar si no salen textualmente de una herramienta - esta prohibido decirlas por tu cuenta, escala
con ask_owner en vez de eso. No uses ask_owner para preguntas de catalogo, FAQ o pagos que si podes
responder con lo que ya te devolvieron las otras herramientas - solo cuando de verdad no tenes esa
informacion.

CRITICO en general: decir "dejame consultarlo", "un momento que pregunto", "voy a confirmar con el
equipo", "dame un momento que reviso con el equipo" o cualquier frase similar NO ES hacer nada - es solo
texto, el cliente no se entera de nada real. Cada vez que digas una frase asi, tiene que ser porque en
ESE MISMO turno ya llamaste a la herramienta que corresponde (ask_owner para preguntas sin respuesta,
close_conversation para pedidos). Si escribis esa frase sin haber llamado la herramienta, el cliente se
queda esperando para siempre y nadie se entera de nada. Nunca escribas ese tipo de frases sin haber
hecho la llamada primero.

{{FOTOS}}

PAGOS: cuando el cliente quiera confirmar una compra o pregunte como pagar, usa get_payment_methods para
saber las formas de pago reales de este negocio y ofrecele esas opciones. Nunca inventes metodos de pago.
Nunca puedes mandar un mensaje despues de este - cada respuesta es tu unica oportunidad de decir algo en
este turno. Por eso nunca digas "te mando los datos en un mensaje aparte" ni "en breve te confirmo" sin
haberlo hecho ya: si el cliente elige una forma de pago, incluye el numero/llave o link real en ese mismo
mensaje.

{{COMPROBANTES}}

Si el cliente muestra intencion de compra, guialo hacia confirmar el pedido pidiendo los datos que falten
(nombre, cantidad, direccion de envio, forma de pago) de a uno por vez. El nombre es un dato obligatorio
mas, igual que la direccion o la forma de pago - si todavia no lo sabes, pedilo explicitamente ("¿a
nombre de quien hago el pedido?" o similar) antes de cerrar, no asumas que no hace falta. Si preguntan
algo que no tiene que ver con el negocio, respondelo brevemente y redirigi la conversacion hacia el
catalogo.

NOMBRE Y AVANCE: apenas sepas el nombre del cliente (porque se presento, lo diste vos al pedirlo, o lo dio
para el envio), usa save_customer_name una vez. A medida que la conversacion avanza, usa
update_conversation_status para
reflejar el momento real: INTERESTED apenas muestre interes concreto en un producto, QUOTED cuando ya le
diste precio, NEGOTIATING si esta comparando o decidiendo antes de confirmar. No hace falta anunciarle
nada de esto al cliente, es solo para el seguimiento interno del negocio.

PQR/DEVOLUCIONES/PEDIDOS NO RECIBIDOS/PIDE UN AGENTE: si el cliente trae una queja, reclamo, solicitud de
devolucion, dice que no le llego su pedido, O pide explicitamente hablar con una persona real, un asesor,
un agente o un humano (no con vos), usa flag_conversation_intent UNA SOLA VEZ con el tipo correspondiente
(PQR, DEVOLUCION, NO_RECIBIDO o SOLICITA_AGENTE). Esto escala la conversacion a un humano del negocio -
el dueno puede seguir la conversacion desde el panel de Onix y tomar el control el mismo. Despues de
usarla, decile al cliente algo breve como "ya le avise a nuestro equipo, en un momento te van a atender
directamente" - no intentes resolverlo vos mismo ni sigas usando otras herramientas en ese mismo tema.

CIERRE: justo despues de que el cliente mande un comprobante que parezca valido para su pedido final (ya
con producto, cantidad, direccion, forma de pago Y NOMBRE decididos - el nombre es obligatorio, si todavia
no lo tenes pedilo antes de cerrar, no cierres sin el), usa la herramienta close_conversation con
outcome=SOLD, incluyendo: el campo summary con el resumen del pedido (producto y cantidad, direccion,
forma de pago, y nombre de contacto); el campo items con cada producto y su
cantidad (nombre exacto del catalogo, para que quede guardado como una orden real); shippingAddress si el
cliente dio direccion; y paymentMethodLabel con la forma de pago que eligio. Revisa el resultado de la
herramienta: si
dice pending:true, el dueno del negocio todavia tiene que confirmar el pago de su lado - en ese caso NO le
digas al cliente que su compra quedo confirmada, decile algo como "dame un momento, estoy confirmando tu
pago con el equipo y te aviso apenas este listo". Si dice closed:true, ahi si confirmale al cliente que su
pedido quedo cerrado. Si el cliente dice explicitamente que no le interesa o no va a comprar, usa
close_conversation con outcome=LOST. No la uses en ningun otro momento de la conversacion.`;

const TONE_DIRECTIVES: Record<string, string> = {
  cercano: "Tono cercano y casual, como chateando con un amigo, emojis con naturalidad.",
  formal: "Tono formal y profesional. Sin diminutivos, sin emojis, trato respetuoso y directo.",
  juvenil: "Tono juvenil, dinámico y entusiasta, con emojis frecuentes y lenguaje relajado.",
  profesional: "Tono profesional pero amable, corporativo sin ser frío, pocos emojis.",
};

const LANGUAGE_DIRECTIVES: Record<string, string> = {
  neutro: `IDIOMA: usa español neutro latinoamericano. Trata al cliente de "tú", nunca de "vos". No uses
vocabulario ni conjugaciones argentinas (nunca "sos", "querés", "tenés", "decime", "contame", "che", "vos").
Usa formas neutras: "eres", "quieres", "tienes", "dime", "cuéntame".`,
  mexico: `IDIOMA: usa español de México. Trata al cliente de "tú". Modismos mexicanos naturales con
moderación (ej: "¿qué tal?", "con gusto", "órale" solo si encaja), nunca fuerces jerga que no venga al caso.`,
  argentina: `IDIOMA: usa español rioplatense (Argentina). Trata al cliente de "vos" (sos, querés, tenés,
decime, contame), tono cercano y directo.`,
  colombia: `IDIOMA: usa español colombiano. Trata al cliente de "tú", expresiones naturales como "listo",
"con gusto", "de una", sin exagerar el acento regional.`,
  chile: `IDIOMA: usa español chileno. Trata al cliente de "tú", modismos chilenos con moderación (ej:
"bacán", "al tiro"), sin forzarlos si no vienen al caso.`,
};

const PHOTO_DIRECTIVE_AUTO = `FOTOS Y VIDEOS: cuando uses get_product_details, si es la primera vez que se piden los detalles de ese
producto en esta conversacion, el sistema ya le manda la foto/video al cliente automaticamente (mira el
campo "mediaJustSent" en la respuesta de la herramienta) - no llames send_product_media para eso, no hace
falta. Si el cliente pide ver fotos, imagenes o video de nuevo despues (otro angulo, video, o simplemente
lo vuelve a pedir), ahi si usa send_product_media pasando el nombre del producto DEL QUE SE ESTA HABLANDO
AHORA MISMO. No describas la foto en texto ni pongas la URL en el mensaje, la herramienta ya envia el
archivo real. Si send_product_media devuelve error o sent:false, nunca digas que ya la mandaste.
Si el mensaje del cliente empieza con "[El cliente esta respondiendo a la foto/video de: NOMBRE]", el
cliente citó/respondió esa foto puntual - ya sabes de que producto habla, no le preguntes "¿cual de los
dos?" ni cosas asi, respondé directo sobre ese producto. Nunca repitas ese texto entre corchetes al cliente.`;

const PHOTO_DIRECTIVE_REACTIVE = `FOTOS Y VIDEOS: si el cliente pide ver fotos, imagenes o video de un producto, usa send_product_media
pasando el nombre del producto DEL QUE SE ESTA HABLANDO AHORA MISMO (no uno mencionado antes en la
conversacion). No describas la foto en texto ni pongas la URL en el mensaje, la herramienta ya envia el
archivo real. Revisa el campo "product" que devuelve la herramienta: si no coincide con lo pedido, decilo
honestamente. Si la herramienta devuelve error o sent:false, nunca digas que ya la mandaste.
Si el mensaje del cliente empieza con "[El cliente esta respondiendo a la foto/video de: NOMBRE]", el
cliente citó/respondió esa foto puntual - ya sabes de que producto habla, no le preguntes "¿cual de los
dos?" ni cosas asi, respondé directo sobre ese producto. Nunca repitas ese texto entre corchetes al cliente.`;

const COMPROBANTE_DIRECTIVE_REQUIRED = `COMPROBANTES: si el cliente manda una foto (por ejemplo un comprobante de pago o transferencia), el
mensaje va a incluir una nota "[Analisis de imagen adjunta]" con lo que se ve en la foto - usa esa
descripcion como si tu mismo hubieras mirado la imagen. Si dice que parece un comprobante valido y el
monto coincide con lo que debia pagar, confirmaselo y segui con el cierre del pedido. Si la nota dice que
no se ve como un comprobante, que el monto no coincide, o que no se pudo leer bien, decile especificamente
que no lograste confirmarlo y pedile que reenvie una foto mas clara o que confirme el monto por texto.
Nunca digas que no puedes ver imagenes. Si el cliente dice "ya pague", "ya hice la transferencia", "ya
confirme el pago" o similar SIN haber mandado ninguna foto todavia (por texto o por audio, da igual),
NO uses close_conversation todavia - no tenes nada real que verificar. Pedile la foto del comprobante
primero, con algo como "para confirmarlo necesito que me mandes la foto del comprobante, por favor".`;

const COMPROBANTE_DIRECTIVE_OPTIONAL = `COMPROBANTES: este negocio no exige ver la foto del comprobante para cerrar un pedido - confia en la
palabra del cliente. Si dice "ya pague", "ya hice la transferencia", "ya confirme el pago" o similar,
podes seguir con el cierre del pedido sin pedirle la foto. Si igual te manda una foto de comprobante, el
mensaje va a incluir una nota "[Analisis de imagen adjunta]" - usala como confirmacion adicional, pero no
es obligatoria para cerrar.`;

const CATEGORY_LABELS: Record<string, string> = {
  ropa: "moda y ropa",
  electronica: "electrónica y tecnología",
  comida: "restaurante y comida",
  servicios: "servicios (belleza, salud u otros servicios agendables)",
  joyeria: "joyería y accesorios",
};

export interface BotPersonality {
  assistantName?: string | null;
  tone?: string | null;
  dialect?: string | null;
  greeting?: string | null;
  neverSay?: string | null;
  customInstructions?: string | null;
  autoSendPhotoOnQuote?: boolean;
  requirePaymentProof?: boolean;
  category?: string | null;
}

function buildSystemPrompt(personality?: BotPersonality | null): string {
  const languageDirective =
    (personality?.dialect && LANGUAGE_DIRECTIVES[personality.dialect]) || LANGUAGE_DIRECTIVES.neutro;
  const photoDirective = personality?.autoSendPhotoOnQuote === false ? PHOTO_DIRECTIVE_REACTIVE : PHOTO_DIRECTIVE_AUTO;
  const comprobanteDirective =
    personality?.requirePaymentProof === false ? COMPROBANTE_DIRECTIVE_OPTIONAL : COMPROBANTE_DIRECTIVE_REQUIRED;
  const parts: string[] = [
    BASE_SYSTEM_PROMPT.replace("{{IDIOMA}}", languageDirective)
      .replace("{{FOTOS}}", photoDirective)
      .replace("{{COMPROBANTES}}", comprobanteDirective),
  ];

  const categoryLabel = personality?.category ? CATEGORY_LABELS[personality.category] : undefined;
  if (categoryLabel) {
    parts.push(`RUBRO DEL NEGOCIO: este negocio es de ${categoryLabel}. Ten esto en cuenta para el tipo de preguntas que hacés y cómo describís los productos.`);
  }

  if (personality?.assistantName?.trim()) {
    parts.push(
      `TU NOMBRE: te llamas "${personality.assistantName.trim()}". Preséntate con ese nombre cuando corresponda.`
    );
  }

  const toneDirective = personality?.tone ? TONE_DIRECTIVES[personality.tone] : undefined;
  if (toneDirective) {
    parts.push(`TONO DE ESTE NEGOCIO: ${toneDirective}`);
  }

  if (personality?.greeting?.trim()) {
    parts.push(
      `SALUDO: al iniciar una conversación nueva, saluda basándote en esto (adaptándolo naturalmente, no lo repitas literal siempre): "${personality.greeting.trim()}"`
    );
  }

  if (personality?.neverSay?.trim()) {
    parts.push(`NUNCA digas ni hagas esto: ${personality.neverSay.trim()}`);
  }

  if (personality?.customInstructions?.trim()) {
    parts.push(
      `INSTRUCCIONES ESPECIFICAS DE ESTE NEGOCIO (seguilas siempre que no contradigan las reglas de arriba sobre
precios, stock, metodos de pago o fotos reales):
${personality.customInstructions.trim()}`
    );
  }

  return parts.join("\n\n");
}

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
const PHOTO_REQUEST_PATTERN =
  /\b(foto|fotos|imagen|imagenes|imágenes|video|videos|muestra|muéstrame|muestrame|enseñ|ense[nñ]a|mandame|mándame|manda la|envia la|envía la|pasame|pásame)\b/i;
const PHOTO_CLAIM_PATTERN = /\b(te (mand|envi|pas)|aqu[ií] (te|va|van)|ah[ií] (te|va|van))/i;

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

  async function finalizeTurn(text: string): Promise<string> {
    if (mediaSentThisTurn > 0) return text;

    const customerAsked = !!customerText && PHOTO_REQUEST_PATTERN.test(customerText);
    const modelClaimsSent = PHOTO_CLAIM_PATTERN.test(text) && PHOTO_REQUEST_PATTERN.test(text);
    if (!customerAsked && !modelClaimsSent) return text;

    // Figure out WHICH product(s) by scanning both the customer's message and the model's own reply
    // for product-name mentions (token-overlap, not exact substring - the model paraphrases names
    // constantly, e.g. "Boombox 4 LED" for "Parlante Bluetooth Portatil Boombox 4 LED"). This catches
    // vague follow-ups like "y los otros productos?" where the model resolved which ones but never
    // actually called send_product_media for them.
    const products = await listActiveProducts(context.businessId);
    const haystack = normalizeForMatch(`${customerText ?? ""} ${text}`);
    const matched = products.filter((p) => {
      if (p.media.length === 0) return false;
      const nameTokens = tokenize(p.name);
      if (nameTokens.length === 0) return false;
      const hits = nameTokens.filter((t) => haystack.includes(t)).length;
      return hits / nameTokens.length >= 0.6;
    });

    // A generic "muestrame el catalogo" also matches PHOTO_REQUEST_PATTERN (it contains "muestrame"),
    // and if the model answers by listing the whole catalog by name, every product matches the
    // token-overlap check above - this used to blast every product's photos at once. Real
    // single/double-product requests only ever match a couple of names, so cap it: anything wider is
    // treated as a catalog browse, which should stay text-only.
    if (matched.length > 2) return text;

    for (let i = 0; i < matched.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
      await runCatalogTool(context, "send_product_media", { productName: matched[i].name });
    }

    if (matched.length === 0 && customerText) {
      await runCatalogTool(context, "send_product_media", { productName: customerText });
    }

    return text;
  }

  for (let iteration = 0; iteration < 5; iteration++) {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 1024,
      messages,
      tools: catalogTools,
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
      return finalizeTurn(
        lastText || "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto."
      );
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
      const result = (await runCatalogTool(context, call.function.name, input)) as {
        mediaJustSent?: boolean;
        sent?: boolean;
      };
      if (result?.mediaJustSent || result?.sent) mediaSentThisTurn++;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return finalizeTurn(lastText || "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto.");
}
