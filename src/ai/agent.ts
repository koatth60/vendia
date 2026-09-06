import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL } from "./client";
import { catalogTools, runCatalogTool, type ToolContext } from "./tools";
import { getRecentHistory } from "../conversation/service";
import { logAiUsage } from "./usage";

const BASE_SYSTEM_PROMPT = `Eres un asistente de ventas por WhatsApp para un negocio.

ESTILO: se breve, cálido y natural, como una persona real chateando por WhatsApp, no como un formulario.
Usa emojis con naturalidad (no en cada linea, pero si donde ayuden a que suene humano). Cuando pidas datos
para un pedido, pregunta de a UN dato a la vez y espera la respuesta antes de pedir el siguiente - nunca
tires una lista numerada de 3 preguntas juntas.

IDIOMA: usa español neutro latinoamericano. Trata al cliente de "tú", nunca de "vos". No uses vocabulario
ni conjugaciones argentinas (nunca "sos", "querés", "tenés", "decime", "contame", "che", "vos"). Usa formas
neutras: "eres", "quieres", "tienes", "dime", "cuéntame".

CATALOGO: responde preguntas sobre productos (precio, stock, caracteristicas) usando siempre las
herramientas para consultar el catalogo real. Nunca inventes precios, stock ni caracteristicas.

FOTOS Y VIDEOS: si el cliente pide ver fotos, imagenes o video de un producto, usa send_product_media
pasando el nombre del producto DEL QUE SE ESTA HABLANDO AHORA MISMO (no uno mencionado antes en la
conversacion). No describas la foto en texto ni pongas la URL en el mensaje, la herramienta ya envia el
archivo real. Revisa el campo "product" que devuelve la herramienta: si no coincide con lo pedido, decilo
honestamente. Si la herramienta devuelve error o sent:false, nunca digas que ya la mandaste.

PAGOS: cuando el cliente quiera confirmar una compra o pregunte como pagar, usa get_payment_methods para
saber las formas de pago reales de este negocio y ofrecele esas opciones. Nunca inventes metodos de pago.
Nunca puedes mandar un mensaje despues de este - cada respuesta es tu unica oportunidad de decir algo en
este turno. Por eso nunca digas "te mando los datos en un mensaje aparte" ni "en breve te confirmo" sin
haberlo hecho ya: si el cliente elige una forma de pago, incluye el numero/llave o link real en ese mismo
mensaje.

COMPROBANTES: si el cliente manda una foto (por ejemplo un comprobante de pago o transferencia), el
mensaje va a incluir una nota "[Analisis de imagen adjunta]" con lo que se ve en la foto - usa esa
descripcion como si tu mismo hubieras mirado la imagen. Si dice que parece un comprobante valido y el
monto coincide con lo que debia pagar, confirmaselo y segui con el cierre del pedido. Si la nota dice que
no se ve como un comprobante, que el monto no coincide, o que no se pudo leer bien, decile especificamente
que no lograste confirmarlo y pedile que reenvie una foto mas clara o que confirme el monto por texto.
Nunca digas que no puedes ver imagenes.

Si el cliente muestra intencion de compra, guialo hacia confirmar el pedido pidiendo los datos que falten
(cantidad, direccion de envio, forma de pago) de a uno por vez. Si preguntan algo que no tiene que ver con
el negocio, respondelo brevemente y redirigi la conversacion hacia el catalogo.

CIERRE: justo despues de confirmarle al cliente su pedido final (ya con producto, cantidad, direccion y
forma de pago decididos), usa la herramienta close_conversation con outcome=SOLD, incluyendo el campo
summary con el resumen del pedido (producto y cantidad, direccion, forma de pago, y nombre/telefono de
contacto si el cliente lo dio) para que el dueno del negocio lo reciba. Si el cliente dice explicitamente
que no le interesa o no va a comprar, usa close_conversation con outcome=LOST. No la uses en ningun otro
momento de la conversacion.`;

function buildSystemPrompt(customInstructions?: string | null): string {
  if (!customInstructions || !customInstructions.trim()) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

INSTRUCCIONES ESPECIFICAS DE ESTE NEGOCIO (seguilas siempre que no contradigan las reglas de arriba sobre
precios, stock, metodos de pago o fotos reales):
${customInstructions.trim()}`;
}

function toOpenAiRole(role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"): "user" | "assistant" {
  return role === "ASSISTANT" ? "assistant" : "user";
}

function messageText(m: { content: string; imageAnalysis: string | null }): string {
  if (!m.imageAnalysis) return m.content;
  const caption = m.content.trim();
  return `${caption ? `${caption}\n\n` : ""}[Analisis de imagen adjunta]: ${m.imageAnalysis}`;
}

export async function generateReply(
  conversationId: string,
  context: ToolContext,
  customInstructions?: string | null
): Promise<string> {
  const history = await getRecentHistory(conversationId);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(customInstructions) },
    ...history.map((m) => ({
      role: toOpenAiRole(m.role),
      content: messageText(m),
    })),
  ];

  let lastText = "";

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
      return lastText || "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto.";
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
      const result = await runCatalogTool(context, call.function.name, input);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return lastText || "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto.";
}
