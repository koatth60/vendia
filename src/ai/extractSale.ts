import { deepseek, DEEPSEEK_MODEL } from "./client";
import { getRecentHistory } from "../conversation/service";
import { listActiveProducts } from "../catalog/products";
import { logAiUsage } from "./usage";
import { getPaymentExamples } from "../catalog/paymentMethods";
import { getBusinessLocale } from "../config/businessConfig";

// Fase 11 del plan maestro (2026-09-15): los ejemplos de forma de pago y la palabra "cedula" salian
// escritos a mano aca. Ahora los pone el caller con los metodos reales del negocio y la etiqueta de
// documento de su pais - ver catalog/paymentMethods.ts y config/countries.ts.
const EXTRACT_PROMPT = `Sos un asistente que lee una conversacion de ventas por WhatsApp entre un negocio y un
cliente, y extrae los datos de un pedido que se cerro (o esta por cerrarse) para que el dueno del negocio
lo revise y confirme antes de registrarlo - vos solo prellenas un formulario, no cerras nada por tu cuenta.

Devolve SOLO un JSON con esta forma exacta, sin texto adicional:
{
  "items": [{"productName": "string", "quantity": number}],
  "shippingAddress": "string o null",
  "paymentMethodLabel": "string o null",
  "shippingCost": number o null,
  "idNumber": "string o null",
  "deliveryPhone": "string o null",
  "notes": "string o null"
}

- "items": cada producto que el cliente decidio comprar, con la cantidad. Te paso la lista de nombres
  reales del catalogo de este negocio - usa el nombre EXACTO de esa lista que corresponda al producto del
  que se hablo en la conversacion, no una descripcion propia (ej: usa "Smartwatch Serie 11 Mini", no
  "reloj plateado"). Si el producto del que hablaron no esta en la lista, usa el nombre tal como lo
  escribio o menciono el negocio en la conversacion.
- "shippingAddress": la direccion de entrega si se menciono (ciudad, barrio, direccion exacta). null si
  no se menciono.
- "paymentMethodLabel": la forma de pago acordada (ej: {{METODOS_PAGO}}). null si
  no quedo claro.
- "shippingCost": el costo de envio en numero (sin simbolos ni puntos, ej 9000) si se menciono o cobro
  explicitamente. null si no se menciono ningun costo de envio o si es gratis (en ese caso usa 0, no
  null, si el negocio dijo explicitamente "envio gratis").
- "idNumber": {{DOCUMENTO}} del cliente si lo dio. null si no se menciono.
- "deliveryPhone": el celular de contacto para la entrega si lo dio (puede ser distinto al numero de
  WhatsApp). null si no se menciono.
- "notes": cualquier pedido especial del cliente que no encaje en los campos anteriores (ej: horario o
  dia de entrega especifico, color/version elegida, instrucciones para el mensajero). null si no hay
  nada especial.

Si la conversacion no tiene suficiente informacion para algun campo, usa null (o array vacio para items) -
NUNCA inventes datos que no esten explicitamente en la conversacion.`;

export interface ExtractedSaleDetails {
  items: { productName: string; quantity: number }[];
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shippingCost: number | null;
  idNumber: string | null;
  deliveryPhone: string | null;
  notes: string | null;
}

const EMPTY_RESULT: ExtractedSaleDetails = {
  items: [],
  shippingAddress: null,
  paymentMethodLabel: null,
  shippingCost: null,
  idNumber: null,
  deliveryPhone: null,
  notes: null,
};

// getRecentHistory defaults to a 20-message window, tuned for the live chat loop's per-turn context
// cost - too narrow here. A long conversation easily buries the address/payment method (given once,
// early on) well before the last 20 messages, while a repeated detail (like a delivery-day request)
// stays in view - confirmed against a real conversation where exactly that happened, address and
// payment came back empty while notes didn't. Extraction is a one-off synchronous call, not per-turn, so
// it can afford to read the whole thing.
const EXTRACT_HISTORY_LIMIT = 300;

export async function extractSaleDetails(businessId: string, conversationId: string): Promise<ExtractedSaleDetails> {
  const history = await getRecentHistory(conversationId, EXTRACT_HISTORY_LIMIT);
  if (history.length === 0) return EMPTY_RESULT;

  const transcript = history.map((m) => `${m.role}: ${m.content}`).join("\n");
  const [products, paymentExamples, negocio] = await Promise.all([
    listActiveProducts(businessId),
    getPaymentExamples(businessId),
    getBusinessLocale(businessId),
  ]);
  const catalogNames = products.map((p) => p.name).join(", ") || "(catalogo vacio)";

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: EXTRACT_PROMPT.split("{{METODOS_PAGO}}")
          .join(paymentExamples)
          .split("{{DOCUMENTO}}")
          .join(`el ${negocio.country.documentLabel}`),
      },
      { role: "user", content: `Nombres reales del catalogo de este negocio: ${catalogNames}\n\nConversacion:\n${transcript}` },
    ],
    response_format: { type: "json_object" },
    // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning tokens
    // leave message.content empty for a short extraction task like this one.
    thinking: { type: "disabled" },
  });

  await logAiUsage({ businessId, conversationId, kind: "CHAT", model: DEEPSEEK_MODEL, usage: response.usage });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return EMPTY_RESULT;

  try {
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items)
        ? parsed.items
            .filter((i: unknown): i is { productName: unknown; quantity: unknown } => typeof i === "object" && i !== null)
            .map((i: { productName: unknown; quantity: unknown }) => ({
              productName: String(i.productName ?? "").trim(),
              quantity: Math.max(1, Math.floor(Number(i.quantity) || 1)),
            }))
            .filter((i: { productName: string }) => i.productName)
        : [],
      shippingAddress: typeof parsed.shippingAddress === "string" ? parsed.shippingAddress.trim() || null : null,
      paymentMethodLabel: typeof parsed.paymentMethodLabel === "string" ? parsed.paymentMethodLabel.trim() || null : null,
      shippingCost: typeof parsed.shippingCost === "number" && !Number.isNaN(parsed.shippingCost) ? parsed.shippingCost : null,
      idNumber: typeof parsed.idNumber === "string" ? parsed.idNumber.trim() || null : null,
      deliveryPhone: typeof parsed.deliveryPhone === "string" ? parsed.deliveryPhone.trim() || null : null,
      notes: typeof parsed.notes === "string" ? parsed.notes.trim() || null : null,
    };
  } catch (error) {
    console.error("No se pudo parsear la extraccion de datos de venta:", error, raw);
    return EMPTY_RESULT;
  }
}
