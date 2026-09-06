import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, CLAUDE_MODEL } from "./client";
import { catalogTools, runCatalogTool, type ToolContext } from "./tools";
import { getRecentHistory } from "../conversation/service";

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

Si el cliente muestra intencion de compra, guialo hacia confirmar el pedido pidiendo los datos que falten
(cantidad, direccion de envio, forma de pago) de a uno por vez. Si preguntan algo que no tiene que ver con
el negocio, respondelo brevemente y redirigi la conversacion hacia el catalogo.

CIERRE: justo despues de confirmarle al cliente su pedido final (ya con producto, cantidad, direccion y
forma de pago decididos), usa la herramienta close_conversation con outcome=SOLD. Si el cliente dice
explicitamente que no le interesa o no va a comprar, usa close_conversation con outcome=LOST. No la uses
en ningun otro momento de la conversacion.`;

function buildSystemPrompt(customInstructions?: string | null): string {
  if (!customInstructions || !customInstructions.trim()) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

INSTRUCCIONES ESPECIFICAS DE ESTE NEGOCIO (seguilas siempre que no contradigan las reglas de arriba sobre
precios, stock, metodos de pago o fotos reales):
${customInstructions.trim()}`;
}

function toAnthropicRole(role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"): "user" | "assistant" {
  return role === "ASSISTANT" ? "assistant" : "user";
}

export async function generateReply(
  conversationId: string,
  context: ToolContext,
  customInstructions?: string | null
): Promise<string> {
  const history = await getRecentHistory(conversationId);

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: toAnthropicRole(m.role),
    content: m.content,
  }));

  const systemPrompt = buildSystemPrompt(customInstructions);

  for (let iteration = 0; iteration < 5; iteration++) {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools: catalogTools,
      messages,
    });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find((block) => block.type === "text");
      return textBlock?.type === "text" ? textBlock.text : "";
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await runCatalogTool(context, block.name, block.input as Record<string, unknown>);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto.";
}
