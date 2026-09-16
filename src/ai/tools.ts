import type OpenAI from "openai";
import { z } from "zod";
import {
  getProductById,
  listActiveProducts,
  searchProducts,
  findConfidentProductMatch,
  findProductsByAttributes,
} from "../catalog/products";
import {
  PAYMENT_BLOCK_MARKER,
  SHIPPING_BLOCK_MARKER,
  TOTAL_BLOCK_MARKER,
  ORDER_SUMMARY_BLOCK_MARKER,
  SALE_BLOCKED_BLOCK_MARKER,
  CATALOG_BLOCK_MARKER,
} from "./fixedBlockMarkers";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { listShippingRates, resolveShippingRateForCity } from "../catalog/shippingRates";
import { recordAgentIncident } from "./incidents";
import { getSaleGate } from "./configHealth";
import { normalizeForMatch } from "../search/text";
import { formatPrice } from "../config/money";
import { getBusinessLocale } from "../config/businessConfig";

// Shared with agent.ts (both the tool result here and the system-prompt directive there need the same
// Spanish wording for each modality) - defined once here since agent.ts already imports from this file,
// not the other way around.
export const SHIPPING_MODALITY_LABELS: Record<string, string> = {
  PREPAID_ALL: "pagar producto + envio, todo por adelantado",
  PREPAID_PRODUCT_COD_SHIPPING: "pagar el producto por adelantado, el envio se paga contraentrega",
  COD_ALL: "pagar todo (producto + envio) contraentrega",
};
import { listActiveFaqEntries } from "../catalog/faq";
import {
  updateConversationStatus,
  setConversationIntent,
  setHumanControl,
  saveCustomerName,
  saveCustomerContactInfo,
  recordMessage,
  createPendingOwnerQuestion,
  getPreviousClosedConversation,
  findOpenPendingOwnerQuestionsForConversation,
} from "../conversation/service";
import {
  resolveOrderItems,
  createOrder,
  askForCsat,
  getLatestOrderForCustomer,
  getOrderByConversationId,
  markOrderCanceled,
  type ResolvedOrderItem,
} from "../orders/service";
import {
  getSaleState,
  setOrderItem as setSaleStateOrderItem,
  removeOrderItem as removeSaleStateOrderItem,
  setShippingModality as setSaleStateShippingModality,
  setPaymentMethod as setSaleStatePaymentMethod,
  saveDeliveryDataToSaleState,
  recordOrderItemsShown,
  recordShippingCity,
  isSaleStateEnabled,
  setBlockedBy,
  recordMediaSent,
} from "../orders/saleState";
import {
  sendAlertToOwner,
  sendToCustomer,
  sendToOwner,
  isBsuid,
  type WhatsappCredentials,
} from "../whatsapp/outbound";
import { prisma } from "../db/client";
import { getPresignedMediaUrl } from "../media/s3";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { askOwnerToConfirmSale, describeCustomerForOwner } from "../whatsapp/ownerConfirmation";

// WhatsApp sometimes fails to deliver/render an image if it's sent immediately after another one -
// a short gap between consecutive media sends avoids that collision.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Records each sent image/video as its own Message row (whatsappMessageId + relatedProductId), so that
// when the customer later replies/quotes that specific WhatsApp message, the webhook can look up which
// product it was and tell the model directly instead of the model having to guess ("¿cual de los dos?").
async function sendMediaWithSpacing(
  businessId: string,
  credentials: WhatsappCredentials,
  recipientPhone: string,
  conversationId: string,
  productId: string,
  productName: string,
  media: { type: string; url: string; s3Key: string }[]
): Promise<void> {
  for (let i = 0; i < media.length; i++) {
    if (i > 0) await sleep(1200);
    const item = media[i];
    const mediaType = item.type === "IMAGE" ? "IMAGE" : "VIDEO";
    const result = await sendToCustomer({
      businessId,
      conversationId,
      credentials,
      to: recipientPhone,
      content: mediaType === "IMAGE" ? { kind: "image", url: item.url } : { kind: "video", url: item.url },
    });
    // Se propaga como antes: quien llama a esto necesita saber que la foto NO salio, porque si no el
    // modelo sigue la conversacion como si el cliente ya la estuviera viendo.
    if (!result.delivered) throw new Error(result.failure?.message ?? "No se pudo enviar el medio del producto");
    const wamid = result.wamid;
    await recordMessage(
      businessId,
      conversationId,
      "ASSISTANT",
      `[${mediaType === "IMAGE" ? "Foto" : "Video"} de ${productName}]`,
      wamid || undefined,
      { s3Key: item.s3Key, type: mediaType },
      undefined,
      productId
    );
  }
}

async function describeCustomer(customerId: string, recipientPhone: string): Promise<string> {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  return describeCustomerForOwner({ name: customer?.name ?? null, phoneNumber: recipientPhone });
}

export const catalogTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Busca productos en el catalogo por nombre, descripcion o categoria. Usar cuando el cliente pregunta por un tipo de producto o palabra clave.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Palabra o frase para buscar. Si el cliente respondio solo con un numero eligiendo una opcion de una lista que VOS mostraste antes, no busques ese numero - usa el nombre real del producto en esa posicion de tu propia lista.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_products_by_attributes",
      description:
        "Busca productos por categoria y/o color reales del catalogo (no por texto libre) - usala SIEMPRE que el cliente pida un tipo de producto con un color o categoria especifica (ej: 'reloj negro', 'el rosadito', 'audifonos rojos') en vez de search_products, para no mezclar categorias o colores que no pidio.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Categoria que pidio el cliente (ej: 'reloj', 'audifonos'), si la dijo o se infiere claramente. Opcional.",
          },
          color: {
            type: "string",
            description: "Color que pidio el cliente (ej: 'negro', 'rosado'), tal como lo dijo. Opcional.",
          },
          freeText: {
            type: "string",
            description: "El resto del mensaje del cliente relacionado al pedido, por si el color esta mencionado ahi y no en el campo color (ej: diminutivos como 'rosadito').",
          },
        },
        // At least one of category/color/freeText, or this call carries no real evidence to filter by -
        // same invariant runtime already enforces (an empty call returns matches:[]), now visible in the
        // schema itself instead of only discoverable by calling it (reliability plan Phase 5, item 1,
        // 2026-09-13).
        anyOf: [{ required: ["category"] }, { required: ["color"] }, { required: ["freeText"] }],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product_details",
      description:
        "Obtiene el detalle completo de un producto especifico por su ID, incluyendo precio, stock y URLs de fotos/videos. La respuesta trae 'variants' (color, stock, hasMedia) solo si el producto tiene - si no viene ese campo, no tiene variantes. Nunca digas que no tiene variantes sin haber llamado esto primero.",
      parameters: {
        type: "object",
        properties: {
          productId: {
            type: "string",
            description:
              "El campo 'id' exacto del producto (ej: cmtp5r1c00005jr2ky86q5l6d), tal como aparece en los resultados de search_products o list_all_products. NUNCA el numero de orden (1, 2, 3...) que se le muestra al cliente en una lista.",
          },
        },
        required: ["productId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_all_products",
      description: "Lista todos los productos activos del catalogo. Usar cuando el cliente pregunta que productos hay disponibles en general.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_product_media",
      description:
        "Envia por WhatsApp las fotos/videos reales de un producto. Usar SIEMPRE que el cliente pida verlas. Preferi productId (mas confiable) si lo obtuviste este turno con search_products o get_product_details; si no, usa productName. Si el cliente pidio puntualmente video o foto, pasa mediaType: la herramienta te avisa si ese tipo no existe en vez de mandar el otro.",
      parameters: {
        type: "object",
        properties: {
          productId: {
            type: "string",
            description:
              "El 'id' exacto del producto, si ya lo tenes de search_products o get_product_details en este turno. Preferilo sobre productName.",
          },
          productName: {
            type: "string",
            description:
              "El nombre del producto que el cliente menciono en ESTE mensaje (el que se esta hablando ahora, no uno anterior). Solo si no tenes productId. Si el cliente respondio con un numero de una lista tuya, resolvelo al nombre real antes de pasarlo aca (ver SELECCION POR NUMERO).",
          },
          variantId: {
            type: "string",
            description:
              "SOLO si ese producto tiene variantes (varios colores/tallas) y find_products_by_attributes ya te dio el 'variantId' del color/talla exacto que el cliente quiere - manda solo las fotos de ESE color, no las de todos. No inventes un variantId, solo usa el que te devolvio la herramienta.",
          },
          mediaType: {
            type: "string",
            enum: ["imagen", "video"],
            description:
              "Solo si el cliente pidio un tipo puntual ('mandame el video', 'una foto'). Sin esto se manda todo lo que el producto tenga.",
          },
        },
        // Exactly one of productId/productName identifies the product - the runtime already treats them
        // this way (productId wins if both are given, an error if neither is), now visible in the schema
        // itself (reliability plan Phase 5, item 2, 2026-09-13).
        oneOf: [{ required: ["productId"] }, { required: ["productName"] }],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_faq",
      description:
        "Trae las preguntas frecuentes configuradas por el negocio (envios, garantia, horarios, cambios, etc). Usar cuando el cliente pregunte algo asi que no sea de un producto especifico ni forma de pago, antes de responder de memoria o decir que no sabes.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_payment_methods",
      description:
        "Obtiene las formas de pago reales que acepta este negocio (transferencia, tarjeta, efectivo/contraentrega, etc). Usar cuando el cliente pregunte como pagar o este por confirmar una compra.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shipping_rates",
      description:
        "Obtiene las tarifas de envio reales configuradas por este negocio. Usar SIEMPRE antes de decirle un costo de envio al cliente cuando las instrucciones del negocio describen tarifas por ciudad/categoria.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shipping_rate_for_city",
      description:
        "Busca si esta ciudad especifica tiene una tarifa de envio EXACTA configurada por el negocio (coincidencia literal de nombre, ej. 'Bogota'). Usala apenas el cliente te de una ciudad puntual, antes de clasificarla vos de memoria en una categoria. Si no hay coincidencia exacta, no es un error - segui las instrucciones del negocio para su categoria/tarifa general.",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "La ciudad tal como la escribio el cliente (con o sin tildes), sin el barrio ni otros datos.",
          },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shipping_payment_modalities",
      description:
        "Obtiene las modalidades reales de pago del ENVIO que ofrece este negocio (ej: todo anticipado, producto anticipado + envio contraentrega, todo contraentrega) - distinto del canal de pago ({{METODOS_PAGO}}/etc, ver get_payment_methods). Usar cuando el cliente este por confirmar una compra y el negocio tiene esto configurado.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_customer_name",
      description:
        "Guarda el nombre del cliente cuando lo menciona en la conversacion (por ejemplo al presentarse o al darlo para el envio). Usar UNA VEZ apenas lo sepas, no hace falta volver a preguntarlo despues.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "El nombre del cliente tal como lo dijo" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_customer_contact_info",
      description:
        "Guarda la cedula, el celular de contacto y/o la direccion de entrega del cliente cuando los da para el envio. Llamala apenas tengas cualquiera de los datos, no hace falta esperar a tenerlos todos.",
      parameters: {
        type: "object",
        properties: {
          idNumber: { type: "string", description: "Numero de cedula tal como lo dio el cliente" },
          deliveryPhone: { type: "string", description: "Celular de contacto para la entrega, tal como lo dio el cliente" },
          address: { type: "string", description: "Direccion de entrega completa (ciudad, barrio, calle y numero), tal como la dio el cliente" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_conversation_status",
      description:
        "Actualiza el avance de esta conversacion en el embudo de ventas: INTERESTED (el cliente mostro interes concreto en un producto), QUOTED (ya le diste precio/cotizacion), NEGOTIATING (esta decidiendo, comparando o negociando detalles antes de confirmar). No la uses para SOLD ni LOST, para eso usa close_conversation.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["INTERESTED", "QUOTED", "NEGOTIATING"] },
        },
        required: ["status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_conversation_intent",
      description:
        "Usa UNA SOLA VEZ cuando el cliente trae PQR (queja/reclamo), DEVOLUCION, NO_RECIBIDO (no le llego el pedido), o SOLICITA_AGENTE (pide hablar con una persona/asesor/humano). Ver PQR/DEVOLUCIONES en tus instrucciones para el flujo completo. Esto SILENCIA el bot para esta conversacion, asi que solo se justifica cuando hay una razon real - no la uses por una frase ambigua.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["PQR", "DEVOLUCION", "NO_RECIBIDO", "SOLICITA_AGENTE"] },
          explicit: {
            type: "boolean",
            description:
              "true SOLO si el cliente lo pidio o lo dijo con sus propias palabras (ej: 'quiero hablar con un asesor', 'quiero devolver el producto'). false si vos lo dedujiste del contexto o del tono sin que el cliente lo haya dicho asi. El dueno ve esta diferencia en la alerta que recibe.",
          },
        },
        required: ["intent", "explicit"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_owner",
      description:
        "Usa SOLO cuando el cliente hace una pregunta real que necesita un dato concreto del negocio y no la podes responder con catalogo/get_faq/pagos. Manda la pregunta EXACTA al dueno por WhatsApp; mientras tanto el bot deja de responderle. No la uses para PQR/devolucion/no_recibido/pedido de hablar con un humano, para eso usa flag_conversation_intent.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "La pregunta del cliente tal como la escribio, sin resumir ni traducir.",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_owner_about_photo",
      description:
        "Ultimo recurso cuando el analisis de imagen no identifica el producto con confianza y el cliente tampoco pudo aclararlo con una foto mas clara o el nombre (ver IMAGEN DE PRODUCTO en tus instrucciones). Reenvia la foto/video real al dueno; el bot deja de responderle mientras tanto. NO la uses de entrada, es cara en tiempo del dueno.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_order_summary",
      description:
        "Usala ANTES de pedir el comprobante de pago, apenas tengas producto(s)+cantidad, direccion, forma de pago y nombre - calcula el precio y total REALES del catalogo (nunca los calcules de memoria) para que se los muestres al cliente y le pidas que confirme, antes de seguir. Mismo formato de items que close_conversation. No cierra ni guarda nada, solo calcula.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Un item por cada producto distinto, con el nombre tal como aparece en el catalogo y la cantidad.",
            items: {
              type: "object",
              properties: {
                productName: { type: "string", description: "Nombre del producto, tal como aparece en el catalogo" },
                quantity: { type: "number", description: "Cantidad comprada de ese producto" },
                variantLabel: {
                  type: "string",
                  description: "SOLO si ese producto tiene varios colores/tallas: el color y/o talla que el cliente eligio.",
                },
              },
              required: ["productName", "quantity"],
            },
          },
          shippingCost: {
            type: "number",
            description: "Costo de envio ya confirmado al cliente (0 si gratis/no aplica).",
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_conversation",
      description:
        "Usa outcome=SOLD cuando el cliente ya confirmo su pedido final y mando comprobante de pago valido (ver CIERRE en tus instrucciones para el flujo completo, incluido el caso pending). Usa outcome=LOST si el cliente dice explicitamente que no le interesa o no va a comprar. No la uses para nada mas.",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["SOLD", "LOST"] },
          summary: {
            type: "string",
            description:
              "SOLO para outcome=SOLD: un resumen corto del pedido para el dueno del negocio, con producto(s) y cantidad, direccion de envio, forma de pago elegida, y el nombre/telefono de contacto que dio el cliente (si lo dio). No hace falta para outcome=LOST.",
          },
          items: {
            type: "array",
            description:
              "SOLO para outcome=SOLD: la lista estructurada de productos del pedido, para guardarlos como una orden real (no solo texto). Un item por cada producto distinto, con el nombre tal como aparece en el catalogo y la cantidad.",
            items: {
              type: "object",
              properties: {
                productName: { type: "string", description: "Nombre del producto, tal como aparece en el catalogo" },
                quantity: { type: "number", description: "Cantidad comprada de ese producto" },
                variantLabel: {
                  type: "string",
                  description:
                    "SOLO si ese producto tiene varios colores/tallas (variantes): el color y/o talla que el cliente eligio, tal como lo dijo (ej: 'rojo', 'M', 'rojo talla M'). Si el producto tiene variantes y todavia no sabes cual, NO llames esta herramienta - preguntale primero.",
                },
              },
              required: ["productName", "quantity"],
            },
          },
          shippingAddress: {
            type: "string",
            description: "SOLO para outcome=SOLD: la direccion de envio que dio el cliente, si aplica.",
          },
          paymentMethodLabel: {
            type: "string",
            description: "SOLO para outcome=SOLD: el nombre de la forma de pago elegida (ej: {{METODOS_PAGO}}), tal como la devolvio get_payment_methods.",
          },
          shippingCost: {
            type: "number",
            description:
              "SOLO para outcome=SOLD: costo de envio confirmado al cliente (0 si gratis/no aplica). El total del pedido = precio(s) + este valor, asi que si cobraste o mencionaste envio, incluilo para que el total registrado sea el real.",
          },
        },
        required: ["outcome"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_status",
      description:
        "Consulta el estado real del pedido mas reciente del cliente (pendiente, enviado o cancelado), con resumen, nota de envio y total. Usa SIEMPRE que pregunte como va su pedido, si se lo enviaron, pida factura/guia, o algo que compro antes.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description:
        "Cancela el pedido mas reciente de este cliente. USA ESTA HERRAMIENTA SOLO despues de que el cliente ya confirmo explicitamente que si quiere cancelar (ver CONSULTAR O CANCELAR UN PEDIDO en tus instrucciones) - nunca en el mismo turno en que recien lo pide. Si el pedido ya fue enviado, esta herramienta lo va a rechazar.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_previous_conversation",
      description:
        "Busca si este cliente tiene una conversacion anterior con este negocio que ya haya sido cerrada (vendida o perdida). Usa esto SOLO si las instrucciones de este negocio piden preguntar si el cliente quiere continuar una conversacion anterior o empezar una nueva - no la llames si el negocio no lo pide.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

// Fase 2 del plan maestro (2026-09-15): solo se agregan al array de herramientas que ve el modelo para
// un negocio con Business.saleStateEnabled=true (ver agent.ts) - un negocio sin la bandera no paga el
// costo de tokens de estas 4 herramientas ni puede llamarlas.
// Fase 11 del plan maestro (2026-09-15): las cuatro descripciones de arriba traian "Nequi" escrito a
// mano como ejemplo de canal de pago. Nequi no existe en Mexico, y un negocio que solo cobra
// contraentrega tampoco gana nada con ese ejemplo. buildTools lo sustituye por los metodos reales del
// negocio antes de mandar las herramientas al modelo.
const PAYMENT_EXAMPLES_MARKER = "{{METODOS_PAGO}}";

function withPaymentExamples(tool: OpenAI.Chat.ChatCompletionTool, examples: string): OpenAI.Chat.ChatCompletionTool {
  const raw = JSON.stringify(tool);
  if (!raw.includes(PAYMENT_EXAMPLES_MARKER)) return tool;
  return JSON.parse(raw.split(PAYMENT_EXAMPLES_MARKER).join(examples)) as OpenAI.Chat.ChatCompletionTool;
}

/** Las herramientas que ve el modelo este turno, con los ejemplos de pago reales de este negocio. */
export function buildTools(opts: { saleStateEnabled: boolean; paymentExamples: string }): OpenAI.Chat.ChatCompletionTool[] {
  const base = opts.saleStateEnabled ? [...catalogTools, ...saleStateTools] : catalogTools;
  return base.map((tool) => withPaymentExamples(tool, opts.paymentExamples));
}

export const saleStateTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "set_order_item",
      description:
        "Fija (no suma) la cantidad de un producto/variante en el pedido en curso. Llamala apenas el cliente elija producto y cantidad, y de nuevo si cambia de cantidad o de variante - siempre reemplaza el valor anterior de esa misma linea, no lo acumula. productId/variantId tienen que ser los reales que te devolvio search_products/get_product_details/find_products_by_attributes EN ESTA conversacion, nunca inventados.",
      parameters: {
        type: "object",
        properties: {
          productId: { type: "string", description: "Id real del producto, tal como lo devolvio una herramienta de catalogo." },
          variantId: { type: "string", description: "Id real de la variante (color/talla), SOLO si el producto tiene variantes." },
          quantity: { type: "number", description: "Cantidad total deseada de esa linea (reemplaza, no suma)." },
        },
        required: ["productId", "quantity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_order_item",
      description: "Quita un producto del pedido en curso porque el cliente se arrepintio o lo cambio por otro. Si no das variantId, quita todas las lineas de ese producto.",
      parameters: {
        type: "object",
        properties: {
          productId: { type: "string", description: "Id real del producto a quitar." },
          variantId: { type: "string", description: "Id real de la variante a quitar, si el pedido tiene mas de una de este producto." },
        },
        required: ["productId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_shipping_modality",
      description: "Guarda la modalidad de pago del ENVIO que eligio el cliente (ver get_shipping_payment_modalities para las opciones reales de este negocio). Distinto del metodo de pago ({{METODOS_PAGO}}/etc, ver set_payment_method).",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", enum: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"], description: "El code exacto que devolvio get_shipping_payment_modalities." },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_payment_method",
      description: "Guarda el metodo de pago ({{METODOS_PAGO}}/etc) que eligio el cliente para este pedido. El id tiene que ser el real que te devolvio get_payment_methods EN ESTA conversacion.",
      parameters: {
        type: "object",
        properties: {
          paymentMethodId: { type: "string", description: "Id real del metodo de pago, tal como lo devolvio get_payment_methods." },
        },
        required: ["paymentMethodId"],
      },
    },
  },
];

interface PendingOrderDraft {
  items: ResolvedOrderItem[];
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shippingCost: number | null;
}

// Returns true whenever this business requires owner confirmation before closing a sale (i.e. has a
// contactPhone configured) - the caller must NOT auto-close the order in that case, regardless of
// whether the alert actually reached the owner. Una falla total en alcanzar al dueno sigue bloqueando el
// cierre automatico; lo que cambio (2026-09-16) es que ya no termina ahi: la confirmacion queda viva en
// la conversacion y el perseguidor de jobs/escalationReminder.ts la reintenta hasta que el dueno
// responda o venza Business.ownerQuestionTimeoutHours.
//
// Toda la garantia de entrega (escalera botones -> texto -> plantilla, idempotencia, registro del wamid
// para el acuse de Meta) vive en src/whatsapp/ownerConfirmation.ts, que es el mismo modulo que usa el
// perseguidor - asi el primer pedido y cada reintento dejan exactamente el mismo estado.
async function requestSaleConfirmation(context: ToolContext, summary: string, draft: PendingOrderDraft): Promise<boolean> {
  const result = await askOwnerToConfirmSale({
    businessId: context.businessId,
    conversationId: context.conversationId,
    customerId: context.customerId,
    credentials: context.credentials,
    summary,
    draft,
  });
  return result.pending;
}

// For a product sold in several colors/sizes (see ProductVariant in schema.prisma), each sale
// decrements only the specific variant's own stock (see orders/service.ts) - product.stock itself is
// never touched and stays stale forever once variants exist. Report the real total (sum of active
// variants) here instead, so a generic "cuantos tienen en total" question isn't answered with a frozen
// number that never reflects what's actually sold.
function totalStock(product: { stock: number; variants: { stock: number; active: boolean }[] }): number {
  if (product.variants.length === 0) return product.stock;
  return product.variants.filter((v) => v.active).reduce((sum, v) => sum + v.stock, 0);
}

// LIST_DESCRIPTION_MAX_CHARS: solo para vistas de LISTA (varios productos en un mismo tool result) - el
// modelo ahi solo necesita reconocer de cual producto se trata para decidir relevancia o pedir el detalle
// completo con get_product_details, no la ficha entera. Medido en catalogo real de produccion (16
// productos, ~1000 chars de descripcion promedio): el fallback de search_products sin truncar pesaba
// ~18.8k chars (~4.7k tokens) en un solo tool result, mas grande que BASE_SYSTEM_PROMPT completo, y
// siempre a precio cache-miss (contenido nuevo cada vez que se genera). Ver ONIX-RELIABILITY-PLAN.md Fase
// 6.0b.
const LIST_DESCRIPTION_MAX_CHARS = 150;

// Defecto real de produccion (2026-09-15): send_product_media no distinguia foto de video. Un cliente
// que pedia el video de un producto que solo tiene fotos recibia las fotos igual, y el modelo las
// anunciaba como "aqui te va el video". Medido contra la base de MAGByLizN: 5 productos tienen video y
// 15 solo fotos, o sea el 75% del catalogo podia producirlo.
//
// El tipo pedido se valida contra la base, no con una regex sobre el mensaje ni con una instruccion de
// prompt: el modelo declara que pidio el cliente y la herramienta responde con lo que el producto
// REALMENTE tiene. Las variantes de escritura se resuelven con una tabla cerrada sobre el texto ya
// normalizado (normalizeForMatch saca acentos y mayusculas: "Vídeo" y "video" son la misma clave). Un
// valor que no este en la tabla se trata como "sin tipo pedido", que es el comportamiento de siempre.
const REQUESTED_MEDIA_TYPES = new Map<string, "IMAGE" | "VIDEO">([
  ["imagen", "IMAGE"],
  ["imagenes", "IMAGE"],
  ["foto", "IMAGE"],
  ["fotos", "IMAGE"],
  ["image", "IMAGE"],
  ["photo", "IMAGE"],
  ["video", "VIDEO"],
  ["videos", "VIDEO"],
]);

// Bloqueador de produccion (2026-09-15): el modelo escribia la lista de productos de memoria - le
// invento 11 de 18 nombres a un cliente real, inflo dos precios reales y omitio cinco productos con
// stock. Mismo patron que los otros bloques fijos: la lista la renderiza agent.ts desde estos mismos
// datos, el modelo solo redacta alrededor. `products` de aca es lo que agent.ts lee para llenar la
// marca (ver catalogListThisTurn).
const CATALOG_LIST_NOTE = `No escribas vos los nombres, los precios ni el stock de estos productos: pone la marca ${CATALOG_BLOCK_MARKER} donde quieras que aparezca la lista y el sistema la reemplaza por el catalogo real (numerado) antes de enviar. Redacta solo alrededor. Los datos de esta lista igual te sirven para decidir y para responder sobre un producto puntual.`;

function truncateForList(description: string): string {
  return description.length > LIST_DESCRIPTION_MAX_CHARS
    ? `${description.slice(0, LIST_DESCRIPTION_MAX_CHARS)}…`
    : description;
}

function formatProduct(product: Awaited<ReturnType<typeof getProductById>>, locale: string, opts?: { forList?: boolean }) {
  if (!product) return null;
  // hasMedia and hasVariantMedia both need to fold in variant-level photos, not just product.media
  // (variantId: null only - see PRODUCT_INCLUDE) - a real product can have EVERY photo assigned to a
  // color variant and zero general ones (2026-09-15 incident: hasMedia read false, the model never
  // called send_product_media, and the customer got a "no tiene variantes"/no-photos reply for a
  // product that had both).
  const hasAnyMedia = product.media.length > 0 || product.variants.some((v) => v.media.length > 0);
  return {
    id: product.id,
    name: product.name,
    description: opts?.forList ? truncateForList(product.description) : product.description,
    price: formatPrice(product.price, product.currency, locale),
    currency: product.currency,
    stock: totalStock(product),
    category: product.category,
    // No mandamos la URL de media aca - el modelo nunca la usa (send_product_media la resuelve
    // internamente y las reglas del prompt prohiben escribir la URL en el mensaje), mismo patron que ya
    // usa find_products_by_attributes con "hasMedia".
    hasMedia: hasAnyMedia,
    // Real production bug (2026-09-15): formatProduct never told the model whether a product HAS
    // variants at all, so a get_product_details call on a product with 3 real active color variants
    // (stock and all) got the model answering "no tiene variantes de color cargadas" - flatly false,
    // straight to the customer. Only present when the product actually has variants, same "omit when
    // empty" pattern hasMedia already follows via find_products_by_attributes.
    ...(product.variants.length > 0
      ? {
          variants: product.variants
            .filter((v) => v.active)
            .map((v) => ({
              id: v.id,
              color: v.color,
              size: v.size,
              stock: v.stock,
              hasMedia: v.media.length > 0 || product.media.length > 0,
            })),
        }
      : {}),
  };
}

export interface ToolContext {
  businessId: string;
  /** Locale de formateo del negocio (ver src/config/businessConfig.ts). Opcional: se resuelve si falta. */
  locale?: string;
  conversationId: string;
  customerId: string;
  credentials: WhatsappCredentials;
  recipientPhone: string;
}

// Track C item 3 (ONIX-RELIABILITY-PLAN.md): a validation gate ahead of the switch below, catching a
// malformed shape (an object/array where a scalar was expected, a badly-shaped items entry) with a clear
// rejection instead of runCatalogTool's per-case `String(input.x)` silently turning garbage into
// "[object Object]" or an unresolvable order item. Deliberately does NOT touch every field: enum fields
// with their own existing fallback logic (outcome, status, intent) already degrade gracefully on purpose
// and are left out here so this doesn't change that established tolerant behavior. Only tools with at
// least one field worth validating get an entry - a tool with no schema here skips this gate entirely,
// same as before this change.
const SCALAR_INPUT = z.union([z.string(), z.number()]);
const ORDER_ITEM_INPUT = z.object({
  productName: SCALAR_INPUT,
  quantity: SCALAR_INPUT,
  variantLabel: SCALAR_INPUT.optional(),
});

const TOOL_INPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  find_products_by_attributes: z.object({
    category: SCALAR_INPUT.optional(),
    color: SCALAR_INPUT.optional(),
    freeText: SCALAR_INPUT.optional(),
  }),
  search_products: z.object({ query: SCALAR_INPUT.optional() }),
  get_product_details: z.object({ productId: SCALAR_INPUT.optional() }),
  send_product_media: z.object({
    productId: SCALAR_INPUT.optional(),
    productName: SCALAR_INPUT.optional(),
    variantId: SCALAR_INPUT.optional(),
    mediaType: SCALAR_INPUT.optional(),
  }),
  get_shipping_rate_for_city: z.object({ city: SCALAR_INPUT.optional() }),
  save_customer_name: z.object({ name: SCALAR_INPUT.optional() }),
  save_customer_contact_info: z.object({
    idNumber: SCALAR_INPUT.optional(),
    deliveryPhone: SCALAR_INPUT.optional(),
    address: SCALAR_INPUT.optional(),
  }),
  ask_owner: z.object({ question: SCALAR_INPUT.optional() }),
  show_order_summary: z.object({
    shippingCost: SCALAR_INPUT.optional(),
    items: z.array(ORDER_ITEM_INPUT).optional(),
  }),
  close_conversation: z.object({
    summary: SCALAR_INPUT.optional(),
    shippingAddress: SCALAR_INPUT.optional(),
    paymentMethodLabel: SCALAR_INPUT.optional(),
    shippingCost: SCALAR_INPUT.optional(),
    items: z.array(ORDER_ITEM_INPUT).optional(),
  }),
  set_order_item: z.object({
    productId: SCALAR_INPUT,
    variantId: SCALAR_INPUT.optional(),
    quantity: SCALAR_INPUT,
  }),
  remove_order_item: z.object({
    productId: SCALAR_INPUT,
    variantId: SCALAR_INPUT.optional(),
  }),
  set_shipping_modality: z.object({ code: SCALAR_INPUT }),
  set_payment_method: z.object({ paymentMethodId: SCALAR_INPUT }),
};

function describeZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(raiz)"}: ${i.message}`).join("; ");
}

export async function runCatalogTool(context: ToolContext, name: string, input: Record<string, unknown>) {
  const { businessId } = context;
  // Fase 11: como se escribe un precio depende del negocio (moneda + locale del pais), no de es-CO. El
  // caller real ya lo trae en el contexto; si no vino (un test que arma el ToolContext a mano) se resuelve
  // de la base una sola vez para toda la llamada.
  const locale = context.locale ?? (await getBusinessLocale(businessId)).locale;

  const schema = TOOL_INPUT_SCHEMAS[name];
  if (schema) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { error: `Input invalido para ${name}: ${describeZodIssues(parsed.error)}. Corrige el formato y volve a intentar.` };
    }
  }

  // Fase 6 del plan maestro (2026-09-15), causa raiz C5: sin metodos de pago, tarifa de envio o telefono
  // de contacto reales, estas tres herramientas no tienen con que cerrar una venta real - dejarlas correr
  // igual es lo que hoy termina en el bot prometiendo datos bancarios o un total que nadie configuro.
  // close_conversation con outcome LOST no vende nada, asi que queda afuera de la compuerta.
  const isClosingSale = name === "close_conversation" && input.outcome !== "LOST";
  if (name === "show_order_summary" || name === "set_payment_method" || isClosingSale) {
    const gate = await getSaleGate(businessId);
    if (!gate.canSell) {
      // El booleano de "no paso" varia por herramienta (ready/ok/closed) - cada caller de runCatalogTool
      // en agent.ts y en los tests ya lee ese campo especifico, asi que la respuesta bloqueada lo respeta
      // en vez de dejarlo undefined.
      const outcomeField =
        name === "show_order_summary" ? { ready: false } : name === "set_payment_method" ? { ok: false } : { closed: false };
      return {
        ...outcomeField,
        error: `Este negocio todavia no puede procesar la venta: falta configurar ${gate.missing.join(", ")}. No se ejecuto nada.`,
        blocked: true,
        missing: gate.missing,
        note: `No inventes datos de pago ni un total - pone la marca ${SALE_BLOCKED_BLOCK_MARKER} donde quieras ofrecerle al cliente dejar el pedido anotado para que el dueno lo confirme directamente, y redacta alrededor.`,
      };
    }
  }

  switch (name) {
    case "find_products_by_attributes": {
      const category = input.category ? String(input.category).trim() : undefined;
      const color = input.color ? String(input.color).trim() : undefined;
      const freeText = input.freeText ? String(input.freeText).trim() : undefined;
      const { matches, categoriesFound } = await findProductsByAttributes(businessId, { category, color, freeText }, locale);

      if (matches.length === 0) {
        return {
          matches: [],
          note: "No hay ningun producto activo que cumpla ese color/categoria en el catalogo real. No inventes que si hay - decile al cliente honestamente que no tenes esa combinacion, o usa search_products si crees que puede estar descrito distinto.",
        };
      }

      // Ambiguous on purpose: matches span more than one category and the model didn't give a category
      // to narrow by - this is the "el rosadito" case (pink exists in headphones, headbands AND a
      // smartwatch). Group by category so the model asks which one instead of guessing or blasting every
      // match's photos.
      const ambiguousAcrossCategories = !category && categoriesFound.length > 1;

      // Mismo bloqueador de produccion que list_all_products/search_products (2026-09-15): una lista
      // filtrada tambien es una lista, y hasta ahora este camino la dejaba como prosa libre del modelo -
      // es ademas el camino MAS transitado ("que relojes tienen" es mucho mas comun que "muestrame todo
      // el catalogo"). Mismo criterio: desde 2 resultados se renderiza desde la base, uno solo se sigue
      // redactando en prosa. Se reusa CATALOG_LIST_NOTE tal cual, sin prosa nueva en el payload.
      const listNote = matches.length > 1 ? ` ${CATALOG_LIST_NOTE}` : "";

      return {
        matches: matches.map((m) => ({
          productId: m.productId,
          productName: m.productName,
          category: m.category,
          variantId: m.variantId,
          variantLabel: m.variantLabel,
          price: m.price,
          currency: m.currency,
          stock: m.stock,
          hasMedia: m.mediaCount > 0,
        })),
        ambiguousAcrossCategories,
        note: ambiguousAcrossCategories
          ? `Estos resultados son de VARIAS categorias distintas - no asumas cual quiere el cliente ni mandes fotos todavia. Preguntale cual categoria es (usa 'category' de cada uno para nombrarlas) antes de llamar send_product_media.${listNote}`
          : `Estos son los productos/variantes reales que cumplen lo que pidio el cliente - no menciones ni mandes fotos de ningun otro color/categoria que no este en esta lista.${listNote}`,
      };
    }
    case "search_products": {
      const results = await searchProducts(businessId, String(input.query ?? ""));
      // Un solo resultado no es una lista: se sigue redactando en prosa, igual que get_product_details.
      if (results.length === 1) return results.map((p) => formatProduct(p, locale, { forList: true }));
      if (results.length > 1) {
        return { products: results.map((p) => formatProduct(p, locale, { forList: true })), note: CATALOG_LIST_NOTE };
      }

      // No hubo coincidencia por palabra clave - el catalogo suele ser chico por negocio, asi que en
      // vez de decir "no existe" le mostramos todo lo activo para que lo revise por significado (el
      // cliente puede estar describiendo el producto con otras palabras que las del catalogo).
      const all = await listActiveProducts(businessId);
      return {
        products: all.map((p) => formatProduct(p, locale, { forList: true })),
        note:
          all.length > 1
            ? `No hubo coincidencia exacta por palabra clave. Revisa este catalogo completo por significado antes de decir que no tenes el producto. ${CATALOG_LIST_NOTE}`
            : all.length === 1
              ? "No hubo coincidencia exacta por palabra clave. Revisa este catalogo completo por significado antes de decir que no tenes el producto."
              : "Este negocio todavia no tiene productos activos en el catalogo.",
      };
    }
    case "get_product_details": {
      const product = await getProductById(businessId, String(input.productId ?? ""));
      if (!product) return formatProduct(product, locale);

      await prisma.product.update({ where: { id: product.id }, data: { inquiryCount: { increment: 1 } } });

      // Deterministic auto-send: don't rely on the model remembering to separately call
      // send_product_media on first detail - it sometimes skips it despite the prompt instruction.
      // Send here in code instead, once per product per conversation (tracked via
      // Conversation.mediaSentProductIds), gated by the business's autoSendPhotoOnQuote setting.
      //
      // Real production incident (2026-09-15): `product.media` alone (variantId: null only, see
      // PRODUCT_INCLUDE) is EMPTY for a product whose photos are all assigned to color variants - a
      // real case had all 3 photos on variants (rosa/plateado/negro), zero general ones. This gate used
      // to read `product.media.length > 0`, saw 0, and silently skipped auto-send entirely - the model
      // then also saw `hasMedia: false` (see formatProduct) and never called send_product_media either,
      // so the bot promised photos twice in the same conversation and sent nothing both times, with the
      // owner having to step in and send them by hand. No color was named yet at this point in the flow
      // (get_product_details, not a color-scoped call), so - same rule send_product_media itself already
      // follows for an unscoped request - the combined send is every variant's media plus the general
      // ones, not just the first variant's.
      const allProductMedia = [...product.media, ...product.variants.flatMap((v) => v.media)];
      let mediaJustSent = false;
      if (allProductMedia.length > 0) {
        const [business, conversation] = await Promise.all([
          prisma.business.findUnique({ where: { id: businessId }, select: { autoSendPhotoOnQuote: true } }),
          prisma.conversation.findUnique({ where: { id: context.conversationId }, select: { mediaSentProductIds: true } }),
        ]);
        const alreadySent = conversation?.mediaSentProductIds.includes(product.id) ?? false;
        if (business?.autoSendPhotoOnQuote && !alreadySent) {
          await sendMediaWithSpacing(
            businessId,
            context.credentials,
            context.recipientPhone,
            context.conversationId,
            product.id,
            product.name,
            allProductMedia
          );
          await prisma.conversation.update({
            where: { id: context.conversationId },
            data: { mediaSentProductIds: { push: product.id } },
          });
          await recordMediaSent(context.conversationId, product.name);
          mediaJustSent = true;
        }
      }

      return { ...formatProduct(product, locale), mediaJustSent };
    }
    case "list_all_products": {
      const results = await listActiveProducts(businessId);
      if (results.length < 2) return results.map((p) => formatProduct(p, locale, { forList: true }));
      return { products: results.map((p) => formatProduct(p, locale, { forList: true })), note: CATALOG_LIST_NOTE };
    }
    case "send_product_media": {
      // Internal-only, never in the JSON schema the model sees (zero prompt-token cost) - set ONLY by
      // agent.ts's own media backstop loops (finalizeTurn), never by the model's own tool calls. 2026-09-13
      // production incident: the backstop resent the exact same photo set 3 times in one conversation
      // because this case never read/wrote Conversation.mediaSentProductIds at all (only
      // get_product_details's auto-send path did) - the model's OWN explicit requests (e.g. "mándamela
      // otra vez") must still always go through, so the skip only applies to the backstop's own re-checks.
      const skipIfAlreadySent = input.skipIfAlreadySent === true;
      const productId = input.productId ? String(input.productId).trim() : "";
      const query = String(input.productName ?? "");

      let product: Awaited<ReturnType<typeof getProductById>> | null = null;
      if (productId) {
        product = await getProductById(businessId, productId);
        if (!product) return { error: `No se encontro ningun producto con id "${productId}".` };
      } else {
        if (!query) return { error: "Falta productId o productName" };
        const match = await findConfidentProductMatch(businessId, query);
        if (match.ambiguous) {
          return {
            error: `"${query}" coincide con varios productos por igual: ${match.candidates?.join(", ")}. Pedile al cliente que aclare cual, o usa get_product_details con el ID exacto de uno de search_products.`,
          };
        }
        if (!match.product) {
          return { error: `No se encontro ningun producto que coincida con confianza con "${query}".` };
        }
        product = match.product;
      }

      await prisma.product.update({ where: { id: product.id }, data: { inquiryCount: { increment: 1 } } });

      // A variantId (from find_products_by_attributes) scopes the send to just that color/size's own
      // photos - falls back to the product's general media only if that variant has none of its own,
      // never to a DIFFERENT variant's photos (would send the wrong color). With NO variantId (the
      // customer never named a color), send everything the product has - general photos AND every
      // variant's own - instead of only the general ones: "muestrame fotos" with no color mentioned
      // means "show me what you've got", which for a multi-color product includes each color's photo,
      // not just whatever happened to be uploaded as unassigned/general.
      const variantId = input.variantId ? String(input.variantId).trim() : "";
      let media = product.media;
      let variantLabel: string | null = null;
      if (variantId) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (!variant) return { error: `No se encontro la variante "${variantId}" de este producto.` };
        variantLabel = [variant.color, variant.size].filter(Boolean).join(" / ") || null;
        media = variant.media.length > 0 ? variant.media : product.media;
      } else if (product.variants.length > 0) {
        media = [...product.media, ...product.variants.flatMap((v) => v.media)];
      }

      if (media.length === 0) {
        return { sent: false, product: product.name, reason: "Este producto no tiene fotos ni videos cargados" };
      }

      // Ver REQUESTED_MEDIA_TYPES. El motivo que se devuelve cuando el tipo pedido no existe es
      // DISTINTO del "no tiene fotos ni videos" de arriba a proposito: el modelo tiene que poder decirle
      // al cliente, con sus palabras, que del producto hay fotos pero no video (o al reves), que no es lo
      // mismo que no haber nada. No se toca el dedup ni se marca nada como enviado: no se mando nada.
      const requestedMediaType = input.mediaType
        ? REQUESTED_MEDIA_TYPES.get(normalizeForMatch(String(input.mediaType).trim())) ?? null
        : null;
      if (requestedMediaType) {
        const ofRequestedType = media.filter((m) => m.type === requestedMediaType);
        if (ofRequestedType.length === 0) {
          const hasImage = media.some((m) => m.type === "IMAGE");
          const hasVideo = media.some((m) => m.type === "VIDEO");
          const reason =
            requestedMediaType === "VIDEO"
              ? hasImage
                ? "Este producto tiene fotos pero no video"
                : "Este producto no tiene video cargado"
              : hasVideo
                ? "Este producto tiene video pero no fotos"
                : "Este producto no tiene fotos cargadas";
          return { sent: false, product: product.name, variant: variantLabel, reason };
        }
        media = ofRequestedType;
      }

      // Dedup key: the compound "productId#variantId" for a scoped color/size so a DIFFERENT variant is
      // never suppressed, the plain productId otherwise (matches what get_product_details already checks).
      const dedupKey = variantId ? `${product.id}#${variantId}` : product.id;
      const conversation = await prisma.conversation.findUnique({
        where: { id: context.conversationId },
        select: { mediaSentProductIds: true },
      });
      const alreadySent = conversation?.mediaSentProductIds.includes(dedupKey) ?? false;
      if (skipIfAlreadySent && alreadySent) {
        await recordAgentIncident(
          businessId,
          "BACKSTOP_INTERVENTION",
          `send_product_media backstop se salto un reenvio duplicado de "${product.name}"${variantLabel ? ` (${variantLabel})` : ""}`,
          context.conversationId
        );
        return { sent: false, skipped: true, product: product.name, variant: variantLabel, reason: "Ya se le mandaron estas fotos antes en esta conversacion" };
      }

      await sendMediaWithSpacing(
        businessId,
        context.credentials,
        context.recipientPhone,
        context.conversationId,
        product.id,
        variantLabel ? `${product.name} (${variantLabel})` : product.name,
        media
      );

      if (!alreadySent) {
        const updated = new Set(conversation?.mediaSentProductIds ?? []);
        updated.add(product.id);
        updated.add(dedupKey);
        await prisma.conversation.update({
          where: { id: context.conversationId },
          data: { mediaSentProductIds: { set: [...updated] } },
        });
      }
      await recordMediaSent(context.conversationId, variantLabel ? `${product.name} (${variantLabel})` : product.name);

      return { sent: true, product: product.name, variant: variantLabel, count: media.length };
    }
    case "get_faq": {
      const results = await listActiveFaqEntries(businessId);
      if (results.length === 0) {
        return { results: [], note: "Este negocio no tiene preguntas frecuentes configuradas. No inventes ni niegues nada, usa ask_owner." };
      }
      return {
        results: results.map((r) => ({ question: r.question, answer: r.answer })),
        note: "Revisa si alguna de estas responde por significado lo que pregunto el cliente, aunque este redactado distinto. Si ninguna lo confirma explicitamente, no inventes ni niegues nada - usa ask_owner.",
      };
    }
    case "get_payment_methods": {
      const methods = await listActivePaymentMethods(businessId);
      if (methods.length === 0) {
        return { methods: [], note: "Este negocio todavia no configuro formas de pago. Decile al cliente que un asesor le va a confirmar como pagar." };
      }
      return {
        // `id` agregado en Fase 2 (2026-09-15): lo necesita set_payment_method para guardar cual eligio
        // el cliente sin ambiguedad de label (dos metodos podrian compartir el mismo label).
        methods: methods.map((m) => ({ id: m.id, type: m.type, label: m.label, details: m.details })),
        note: `No escribas vos el numero/llave/titular: pone la marca ${PAYMENT_BLOCK_MARKER} donde quieras mostrarlos y el sistema la reemplaza por estos datos reales antes de enviar.`,
      };
    }
    case "get_shipping_rates": {
      const rates = await listShippingRates(businessId);
      if (rates.length === 0) {
        return {
          rates: [],
          note: "Este negocio no tiene tarifas de envio estructuradas todavia. Segui las instrucciones especificas del negocio tal como estan escritas para esto.",
        };
      }
      return {
        rates: rates.map((r) => ({ label: r.label, cost: r.cost.toString() })),
        note:
          rates.length === 1
            ? `Hay una sola tarifa configurada: no escribas vos el numero, pone la marca ${SHIPPING_BLOCK_MARKER} donde quieras mostrarlo.`
            : "Hay varias tarifas configuradas - decidi cual categoria/ciudad le corresponde al cliente con las instrucciones del negocio y confirmala con get_shipping_rate_for_city antes de poner la marca de costo.",
      };
    }
    case "get_shipping_rate_for_city": {
      const city = String(input.city ?? "").trim();
      if (!city) return { matched: false, note: "Falta la ciudad." };

      const resolved = await resolveShippingRateForCity(businessId, city);
      // Matcheo contra ShippingCityRule: la ciudad existe de verdad en la configuracion del negocio, asi
      // que queda registrada como evidencia del servidor (no como dato de entrega - ver schema.prisma).
      if (resolved) await recordShippingCity(context.conversationId, city);
      if (!resolved) {
        return {
          matched: false,
          note: "Esta ciudad no tiene una regla exacta configurada. No inventes su categoria: segui las instrucciones propias del negocio para clasificarla, y usa get_shipping_rates para confirmar el monto de la categoria que corresponda.",
        };
      }
      return {
        matched: true,
        label: resolved.label,
        cost: resolved.cost.toString(),
        note: `No escribas vos el numero: pone la marca ${SHIPPING_BLOCK_MARKER} donde quieras mostrarlo y el sistema la reemplaza por este costo real.`,
      };
    }
    case "get_shipping_payment_modalities": {
      const business = await prisma.business.findUnique({ where: { id: businessId }, select: { shippingPaymentModalities: true } });
      const modalities = business?.shippingPaymentModalities ?? [];
      if (modalities.length === 0) {
        return { modalities: [], note: "Este negocio no configuro modalidades de pago de envio. Segui el flujo generico de pago." };
      }
      return { modalities: modalities.map((m) => ({ code: m, label: SHIPPING_MODALITY_LABELS[m] })) };
    }
    case "save_customer_name": {
      const name = String(input.name ?? "").trim();
      if (!name) return { error: "Falta el nombre" };

      // Real production incident (2026-09-15): una clienta se presento como "Diana" al saludar, y al
      // final del pedido dio "Sebastián Montealegre Sotelo" como nombre del DESTINATARIO del regalo. Esto
      // sobrescribia sin condicion, asi que la ficha de la clienta quedo con el nombre de otra persona -
      // el bot le siguio diciendo Diana en el chat (lo leia del historial) mientras el CRM decia Sebastián.
      // Un nombre ya guardado solo se reemplaza si el nuevo lo COMPLETA ("Diana" -> "Diana Perez"): eso es
      // el mismo ser humano dando su nombre completo. Cualquier otro nombre distinto es, casi siempre,
      // quien recibe el pedido, y ese dato pertenece al pedido, no a la ficha del cliente.
      // El panel sigue pudiendo corregirlo a mano: admin/customers.ts llama saveCustomerName directo, sin
      // pasar por esta herramienta.
      const existing = await prisma.customer.findFirst({
        where: { id: context.customerId, businessId },
        select: { name: true },
      });
      const previous = existing?.name?.trim();
      if (previous) {
        const a = normalizeForMatch(previous);
        const b = normalizeForMatch(name);
        const isCompletion = b.startsWith(a) || a.startsWith(b);
        if (!isCompletion) {
          return {
            saved: false,
            keptName: previous,
            note: `Este cliente ya esta guardado como "${previous}" y "${name}" es un nombre distinto, asi que no se cambio nada. Si "${name}" es quien RECIBE el pedido, no es el nombre del cliente: no lo guardes aca, va en los datos de entrega del pedido. Si de verdad el cliente se corrigio y ahora se llama asi, decilo en tu respuesta y el negocio lo ajusta desde el panel.`,
          };
        }
      }

      await saveCustomerName(context.businessId, context.customerId, name);
      // Sin la bandera: registrar el estado corre siempre (ver saveDeliveryDataToSaleState). Lo que la
      // bandera sigue gobernando es exponerlo al modelo y aplicarlo, no anotarlo.
      await saveDeliveryDataToSaleState(context.conversationId, { customerName: name });
      return { saved: true, name };
    }
    case "save_customer_contact_info": {
      const idNumber = input.idNumber ? String(input.idNumber).trim() : undefined;
      const deliveryPhone = input.deliveryPhone ? String(input.deliveryPhone).trim() : undefined;
      const address = input.address ? String(input.address).trim() : undefined;
      if (!idNumber && !deliveryPhone && !address) return { error: "Falta la cedula, el celular o la direccion" };

      // Fase 2 (2026-09-15): rechazo por forma ANTES de guardar - valida el argumento de la
      // herramienta, no prosa generada (la clase de guard que el plan si permite). Sin regex nueva:
      // conteo de caracteres plano. Por campo, no todo-o-nada: lo que sirve se guarda igual.
      const onlyDigits = (s: string) => [...s].every((c) => c >= "0" && c <= "9");
      const rejected: Record<string, string> = {};
      let validIdNumber = idNumber;
      let validDeliveryPhone = deliveryPhone;
      if (idNumber && !(onlyDigits(idNumber) && idNumber.length >= 6 && idNumber.length <= 15)) {
        rejected.idNumber = `"${idNumber}" no parece un numero de cedula real (solo digitos, 6 a 15).`;
        validIdNumber = undefined;
      }
      if (deliveryPhone && !(onlyDigits(deliveryPhone) && deliveryPhone.length >= 7 && deliveryPhone.length <= 15)) {
        rejected.deliveryPhone = `"${deliveryPhone}" no parece un celular real (solo digitos, 7 a 15).`;
        validDeliveryPhone = undefined;
      }
      if (!validIdNumber && !validDeliveryPhone && !address) {
        return { saved: false, error: "Ningun dato tiene forma valida.", rejected };
      }

      await saveCustomerContactInfo(context.businessId, context.customerId, { idNumber: validIdNumber, deliveryPhone: validDeliveryPhone, address });
      await saveDeliveryDataToSaleState(context.conversationId, { idNumber: validIdNumber, deliveryPhone: validDeliveryPhone, address });
      return {
        saved: true,
        idNumber: validIdNumber,
        deliveryPhone: validDeliveryPhone,
        address,
        ...(Object.keys(rejected).length > 0 ? { rejected, note: "Alguno de los datos no tenia forma valida y no se guardo - pedile al cliente que lo confirme de nuevo." } : {}),
      };
    }
    case "update_conversation_status": {
      const status = ["INTERESTED", "QUOTED", "NEGOTIATING"].includes(String(input.status)) ? (input.status as "INTERESTED" | "QUOTED" | "NEGOTIATING") : null;
      if (!status) return { error: "Estado invalido" };
      await updateConversationStatus(businessId, context.conversationId, status);
      return { updated: true, status };
    }
    case "flag_conversation_intent": {
      const validIntents = ["PQR", "DEVOLUCION", "NO_RECIBIDO", "SOLICITA_AGENTE"] as const;
      const intent = validIntents.includes(input.intent as (typeof validIntents)[number])
        ? (input.intent as (typeof validIntents)[number])
        : "PQR";
      // Fase 9 del plan maestro (2026-09-15): null cuando el modelo no manda el campo (no deberia pasar,
      // es required en el schema, pero un caller viejo como el backstop de agent.ts puede seguir sin
      // mandarlo) - distinto de false, que es una afirmacion real de "esto lo deduje yo".
      const explicit = input.explicit === true ? true : input.explicit === false ? false : null;
      await setConversationIntent(businessId, context.conversationId, intent, explicit);
      await setHumanControl(businessId, context.conversationId, true);

      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (business?.contactPhone) {
        const label = {
          PQR: "PQR",
          DEVOLUCION: "una devolucion",
          NO_RECIBIDO: "un pedido no recibido",
          SOLICITA_AGENTE: "que pidio hablar con un asesor",
        }[intent];
        const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
        const customerLabel = await describeCustomer(context.customerId, context.recipientPhone);
        // Defecto real (2026-09-15): el modelo escalo SOLICITA_AGENTE porque el cliente escribio "Cerrar
        // conversation" - nunca pidio un asesor. Sin esta nota el dueno no puede distinguir una alerta
        // real de una que el bot dedujo mal, y la unica forma de darse cuenta era leer el chat entero.
        const inferredNote =
          explicit === false ? " OJO: el bot lo dedujo del contexto, el cliente no lo pidio con esas palabras - confirma antes de asumir." : "";
        const intentAlertText = `${greeting}, el cliente ${customerLabel} reporto ${label}.${inferredNote} El bot dejo de responderle, toma el control vos directamente.`;
        const intentAlert = await sendAlertToOwner(businessId, context.credentials, business.contactPhone, intentAlertText);
        await recordOwnerMessage(businessId, {
          direction: "OUT",
          body: intentAlertText,
          success: intentAlert.delivered,
          errorMessage: intentAlert.failure?.message ?? null,
        });
        if (!intentAlert.delivered) {
          console.error("No se pudo enviar la alerta de intent al dueno:", intentAlert.failure?.message);
        }
      }

      return {
        flagged: true,
        intent,
        note: "La conversacion quedo escalada a un humano. No sigas intentando resolverlo vos mismo: decile al cliente que un asesor lo va a atender directamente.",
      };
    }
    case "ask_owner": {
      const question = String(input.question ?? "").trim();
      if (!question) return { error: "Falta la pregunta" };

      // Correccion Fase 4 del plan maestro (2026-09-15), causa raiz C2: mientras esta conversacion tenga
      // CUALQUIER PendingOwnerQuestion abierta (no solo una parecida en texto - real incidente 2026-09-14
      // con "Y tiene radio" / "Pero tiene radio" repetidas), no se abre otra. blockedBy (ver saleState.ts,
      // inyectado como system message en agent.ts) ya bloquea la promesa nueva en el texto; esta es la
      // validacion del lado de la herramienta - un argumento contra la base, no una frase que el modelo
      // tiene que recordar.
      const openForConversation = await findOpenPendingOwnerQuestionsForConversation(context.conversationId);
      if (openForConversation.length > 0) {
        return {
          error: "Ya hay una pregunta esperando respuesta del dueno en esta conversacion.",
          note: "No llames ask_owner de nuevo hasta que el dueno responda la pregunta anterior. Decile al cliente honestamente que seguis esperando esa respuesta, y segui ayudando con cualquier otra cosa que necesite.",
        };
      }

      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (!business?.contactPhone) {
        return {
          asked: false,
          note: "Este negocio no tiene un numero de contacto configurado para escalar preguntas. Decile al cliente que no tenes esa informacion por ahora.",
        };
      }

      const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
      const customerLabel = await describeCustomer(context.customerId, context.recipientPhone);
      const text = [
        `${greeting}, el cliente ${customerLabel} pregunto algo que el bot no supo responder:`,
        `"${question}"`,
        'Respondeme citando (mantén presionado y "Responder") este mismo mensaje con la respuesta y se la reenvio tal cual al cliente.',
      ].join("\n\n");

      const askOwner = await sendAlertToOwner(businessId, context.credentials, business.contactPhone, text);
      const wamid = askOwner.delivered ? askOwner.wamid : "";
      await recordOwnerMessage(businessId, {
        direction: "OUT",
        body: text,
        success: Boolean(wamid),
        errorMessage: wamid ? null : askOwner.failure?.message ?? "Sin wamid",
      });
      if (!wamid) {
        return {
          asked: false,
          note: "No se pudo enviar la pregunta al dueno. Decile al cliente que un asesor le va a escribir pronto.",
        };
      }

      await createPendingOwnerQuestion(context.conversationId, wamid, question);
      // Fase 4 del plan maestro: la escalacion es un estado real, no una frase - mientras esta pregunta
      // siga sin respuesta, generateReply (agent.ts) fuerza un bloque fijo en vez de dejar que el modelo
      // prometa consultas de nuevo. Se desbloquea solo cuando conversation/service.ts borra la ultima
      // PendingOwnerQuestion abierta de esta conversacion.
      await setBlockedBy(context.conversationId, "PENDING_OWNER_QUESTION");

      return {
        asked: true,
        note: "La pregunta quedo escalada al dueno del negocio - vos segui atendiendo al cliente con normalidad mientras tanto (otras preguntas, catalogo, lo que necesite). No inventes la respuesta a ESTA pregunta puntual ni digas que ya la tenes: decile que estas confirmando esa info con el equipo y le respondes en breve. Si el cliente insiste en la misma pregunta antes de que el dueno responda, no llames ask_owner de nuevo para lo mismo - decile que segues esperando la respuesta.",
      };
    }
    case "ask_owner_about_photo": {
      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (!business?.contactPhone) {
        return {
          asked: false,
          note: "Este negocio no tiene un numero de contacto configurado para escalar preguntas. Decile al cliente que no tenes esa informacion por ahora.",
        };
      }

      const lastMedia = await prisma.message.findFirst({
        where: {
          conversationId: context.conversationId,
          role: "CUSTOMER",
          mediaS3Key: { not: null },
          mediaType: { in: ["IMAGE", "VIDEO"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!lastMedia?.mediaS3Key) {
        return {
          asked: false,
          note: "No encontre ninguna foto o video reciente del cliente para reenviar. No uses esta herramienta si el cliente no mando una imagen o video.",
        };
      }

      const mediaUrl = await getPresignedMediaUrl(lastMedia.mediaS3Key);
      const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
      const customerLabel = await describeCustomer(context.customerId, context.recipientPhone);
      const caption = [
        `${greeting}, el cliente ${customerLabel} pregunta por este producto y no lo pude identificar en el catalogo.`,
        "¿Cual es? Respondeme citando (mantén presionado y \"Responder\") este mismo mensaje con el nombre del producto.",
      ].join("\n\n");

      // Media send first (mejor experiencia, el dueno ve la foto/video directo en el chat). Si eso falla
      // (API error, tipo de media rechazado, etc), igual intentamos texto plano con el link de la foto -
      // mismo patron de degradacion que requestSaleConfirmation: dos intentos reales antes de rendirse,
      // para que el dueno no se quede sin ningun aviso.
      let wamid = "";
      let photoAlertError: unknown = null;
      const asMedia = await sendToOwner(businessId, context.credentials, business.contactPhone, {
        kind: lastMedia.mediaType === "VIDEO" ? "video" : "image",
        url: mediaUrl,
        caption,
      });
      if (asMedia.delivered) {
        wamid = asMedia.wamid;
      } else {
        photoAlertError = new Error(asMedia.failure?.message ?? "Sin wamid");
        console.error("No se pudo reenviar la foto/video como media al dueno, probando con link de texto:", photoAlertError);
        const asLink = await sendToOwner(businessId, context.credentials, business.contactPhone, {
          kind: "text",
          text: `${caption}\n\n${mediaUrl}`,
        });
        if (asLink.delivered) {
          wamid = asLink.wamid;
          photoAlertError = null;
        } else {
          photoAlertError = new Error(asLink.failure?.message ?? "Sin wamid");
          console.error("No se pudo enviar NINGUNA notificacion al dueno para identificar el producto (revisar manualmente):", photoAlertError, {
            businessId,
            conversationId: context.conversationId,
          });
        }
      }

      await recordOwnerMessage(businessId, {
        direction: "OUT",
        body: caption,
        success: Boolean(wamid),
        errorMessage: wamid ? null : photoAlertError instanceof Error ? photoAlertError.message : photoAlertError ? String(photoAlertError) : "Sin wamid",
      });

      if (!wamid) {
        return {
          asked: false,
          note: "No se pudo contactar al dueno de ninguna forma. Decile al cliente que un asesor le va a escribir pronto.",
        };
      }

      await setHumanControl(businessId, context.conversationId, true);
      await createPendingOwnerQuestion(
        context.conversationId,
        wamid,
        "Identificar el producto de la foto/video que mando el cliente",
        "PHOTO_PRODUCT"
      );

      return {
        asked: true,
        note: "La foto/video quedo escalada al dueno para identificar el producto. No sigas adivinando: decile al cliente que estas confirmando con el equipo cual es ese producto exactamente y le respondes en breve.",
      };
    }
    case "show_order_summary": {
      // Fase 2 (2026-09-15): con la bandera activa, el pedido sale de SaleState (lo que el motor ya
      // valido linea por linea via set_order_item), no de lo que el modelo mande en `items` - asi el
      // total nunca puede quedar corto por un producto mal escrito o una variante sin elegir.
      if (await isSaleStateEnabled(businessId)) {
        const state = await getSaleState(context.conversationId);
        if (!state || state.items.length === 0) {
          return { ready: false, note: "Todavia no hay ningun producto en el pedido en curso - usa set_order_item primero." };
        }
        return {
          ready: true,
          items: state.items.map((item) => ({
            productName: item.productName,
            variantLabel: item.variantLabel,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.unitPrice * item.quantity,
          })),
          subtotal: state.subtotal,
          shippingCost: state.shippingCost ?? 0,
          total: state.total,
          currency: state.items[0].currency,
          note: `No escribas vos los items, el envio ni el TOTAL: pone la marca ${ORDER_SUMMARY_BLOCK_MARKER} donde quieras mostrar el resumen completo (o ${TOTAL_BLOCK_MARKER} si solo necesitas el total suelto) y el sistema la reemplaza por estos numeros reales antes de enviar. Pedile que confirme antes de seguir.`,
        };
      }

      const shippingCost = input.shippingCost !== undefined && input.shippingCost !== null ? Number(input.shippingCost) : 0;
      const { items, unresolved, needsAttribute } = await resolveOrderItems(
        businessId,
        Array.isArray(input.items) ? (input.items as { productName: string; quantity: number; variantLabel?: string }[]) : []
      );

      // Same two blocking checks close_conversation uses, but stricter here on `unresolved` (a plain
      // warn-and-continue there) - closing can fall back to alerting the owner about a mismatched name
      // after the fact, but showing a customer a "total" that silently dropped an unmatched item would
      // just be a wrong number presented with full confidence. Nothing has been saved yet at this point,
      // so asking the customer to confirm the exact name first has no downside.
      if (needsAttribute.length > 0) {
        return {
          ready: false,
          note: `Todavia falta preguntar el color/talla de: ${needsAttribute.join(", ")}. Pregunta cual quiere y volve a llamar show_order_summary recien cuando lo tengas - no muestres el resumen sin eso.`,
        };
      }
      if (unresolved.length > 0) {
        return {
          ready: false,
          note: `No encontre en el catalogo: ${unresolved.join(", ")}. Confirma el nombre exacto con el cliente antes de mostrar el resumen.`,
        };
      }
      if (items.length === 0) {
        return { ready: false, note: "No se dio ningun item valido." };
      }

      const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
      const total = subtotal + shippingCost;
      // Espejo hacia SaleState de lo que el servidor ya resolvio contra el catalogo. No cambia nada de lo
      // que ve el cliente ni de lo que ve el modelo (sin la bandera, nadie lee SaleState.items en el
      // turno): deja el rastro del que se alimenta el disparador de efectos requeridos.
      await recordOrderItemsShown(
        context.conversationId,
        items.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          variantId: item.variantId ?? null,
          variantLabel: item.variantLabel ?? null,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          currency: item.currency,
        }))
      );
      return {
        ready: true,
        items: items.map((item) => ({
          productName: item.productName,
          variantLabel: item.variantLabel ?? null,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.unitPrice * item.quantity,
        })),
        subtotal,
        shippingCost,
        total,
        currency: items[0].currency,
        note: "Mostrale al cliente cada item con su precio, el envio (si aplica) y el TOTAL de aca tal cual - son los numeros reales del catalogo, no los redondees ni los cambies. Pedile que confirme antes de seguir.",
      };
    }
    case "close_conversation": {
      const outcome = input.outcome === "LOST" ? "LOST" : "SOLD";

      const saleStateOn = await isSaleStateEnabled(businessId);

      if (outcome === "SOLD") {
        const summary = String(input.summary ?? "").trim();
        const saleState = saleStateOn ? await getSaleState(context.conversationId) : null;

        // Fase 2 (2026-09-15): con la bandera activa, el pedido/direccion/pago salen de SaleState (ya
        // validados por set_order_item/save_customer_contact_info/set_payment_method), no de lo que el
        // modelo mande aca - close_conversation ya no puede cerrar un pedido distinto del que el motor
        // vino armando.
        const shippingAddress = saleStateOn ? saleState?.address ?? null : input.shippingAddress ? String(input.shippingAddress).trim() : null;
        const paymentMethodLabel = saleStateOn
          ? saleState?.paymentMethodLabel ?? null
          : input.paymentMethodLabel
            ? String(input.paymentMethodLabel).trim()
            : null;
        const shippingCost = saleStateOn
          ? saleState?.shippingCost ?? null
          : input.shippingCost !== undefined && input.shippingCost !== null
            ? Number(input.shippingCost)
            : null;
        const { items, unresolved, needsAttribute } = saleStateOn
          ? { items: saleState?.items ?? [], unresolved: [] as string[], needsAttribute: [] as string[] }
          : await resolveOrderItems(
              businessId,
              Array.isArray(input.items) ? (input.items as { productName: string; quantity: number; variantLabel?: string }[]) : []
            );

        if (saleStateOn && items.length === 0) {
          return { closed: false, note: "Todavia no hay ningun producto en el pedido en curso - usa set_order_item primero." };
        }

        // Real production incident (2026-09-12): a sale closed without ever asking the customer's color.
        // Unlike `unresolved` below (which only warns the owner and still closes), this BLOCKS the close -
        // the product exists and matched fine, but which color/size sold is still unknown, and that's not
        // something an owner can fix after the fact from an alert message the way a misspelled name is.
        // Con SaleState esto no puede pasar (set_order_item exige la variante al agregar la linea).
        if (needsAttribute.length > 0) {
          return {
            closed: false,
            note: `Antes de cerrar el pedido todavia falta preguntarle al cliente el color/talla de: ${needsAttribute.join(", ")}. Pregunta cual color o talla quiere de cada uno (mostrale las opciones reales que tenga ese producto) y volve a llamar close_conversation recien cuando lo tengas.`,
          };
        }

        if (unresolved.length > 0) {
          console.warn(
            `close_conversation: no se pudieron resolver estos items contra el catalogo (businessId=${businessId}, conversationId=${context.conversationId}):`,
            unresolved
          );
          const business = await prisma.business.findUnique({ where: { id: businessId } });
          if (business?.contactPhone) {
            const unresolvedText = `Aviso: en este pedido no pude identificar en el catalogo estos productos que menciono el cliente: ${unresolved.join(", ")}. Revisa el pedido manualmente, puede haber quedado incompleto.`;
            const unresolvedAlert = await sendAlertToOwner(businessId, context.credentials, business.contactPhone, unresolvedText);
            await recordOwnerMessage(businessId, {
              direction: "OUT",
              body: unresolvedText,
              success: unresolvedAlert.delivered,
              errorMessage: unresolvedAlert.failure?.message ?? null,
            });
            if (!unresolvedAlert.delivered) {
              console.error("No se pudo avisar al dueno de items no resueltos:", unresolvedAlert.failure?.message);
            }
          }
        }

        const existingOrder = await getOrderByConversationId(context.conversationId);
        if (existingOrder) {
          return {
            closed: false,
            note: "Esta conversacion ya tiene un pedido registrado - no se puede cerrar una venta nueva sobre la misma. Si el cliente quiere comprar algo mas, decile que un asesor lo va a confirmar directamente.",
          };
        }

        const pending = await requestSaleConfirmation(context, summary, { items, shippingAddress, paymentMethodLabel, shippingCost });
        if (pending) {
          return {
            closed: false,
            pending: true,
            unresolvedItems: unresolved.length > 0 ? unresolved : undefined,
            note: "El dueno del negocio tiene que confirmar el pago primero. No le digas al cliente que su compra quedo confirmada todavia - decile que estas verificando el pago con el equipo.",
          };
        }

        const order = await createOrder({
          businessId,
          customerId: context.customerId,
          conversationId: context.conversationId,
          summary,
          items,
          shippingAddress,
          paymentMethodLabel,
          shippingCost,
        });
        await askForCsat(context.credentials, order.id, context.recipientPhone);
      }

      // La venta de esta conversacion termino (vendida o perdida) - SaleState ya se volco a Order (o no
      // aplica, LOST), deja de ser la verdad en curso. deleteMany no falla si la fila no existe.
      if (saleStateOn) await prisma.saleState.deleteMany({ where: { conversationId: context.conversationId } });

      await updateConversationStatus(businessId, context.conversationId, outcome);
      return outcome === "SOLD"
        ? {
            closed: true,
            outcome,
            note: "El pedido quedo cerrado de una. Confirmaselo al cliente con calidez, agradecele la compra, y despedite - no dejes la conversacion en un simple 'listo' seco.",
          }
        : { closed: true, outcome };
    }
    case "set_order_item": {
      const result = await setSaleStateOrderItem(businessId, context.conversationId, {
        productId: String(input.productId ?? "").trim(),
        variantId: input.variantId ? String(input.variantId).trim() : undefined,
        quantity: Number(input.quantity),
      });
      if (!result.ok) return result;
      return {
        ok: true,
        item: result.item,
        missing: result.state.checkout.faltan,
        subtotal: result.state.subtotal,
        total: result.state.total,
      };
    }
    case "remove_order_item": {
      const result = await removeSaleStateOrderItem(context.conversationId, {
        productId: String(input.productId ?? "").trim(),
        variantId: input.variantId ? String(input.variantId).trim() : undefined,
      });
      if (!result.ok) return result;
      return { ok: true, items: result.state.items, missing: result.state.checkout.faltan, subtotal: result.state.subtotal, total: result.state.total };
    }
    case "set_shipping_modality": {
      const result = await setSaleStateShippingModality(businessId, context.conversationId, String(input.code ?? "").trim());
      if (!result.ok) return result;
      return { ok: true, modality: result.state.shippingModality };
    }
    case "set_payment_method": {
      const result = await setSaleStatePaymentMethod(businessId, context.conversationId, String(input.paymentMethodId ?? "").trim());
      if (!result.ok) return result;
      return { ok: true, method: { id: result.state.paymentMethodId, label: result.state.paymentMethodLabel } };
    }
    case "get_order_status": {
      const order = await getLatestOrderForCustomer(businessId, context.customerId);
      if (!order) return { found: false, note: "Este cliente no tiene ningun pedido registrado todavia." };
      return {
        found: true,
        fulfillmentStatus: order.fulfillmentStatus,
        summary: order.summary,
        totalAmount: order.totalAmount,
        currency: order.currency,
        shippedAt: order.shippedAt,
        shipmentNote: order.shipmentNote,
        canceledAt: order.canceledAt,
        createdAt: order.createdAt,
      };
    }
    case "cancel_order": {
      const order = await getLatestOrderForCustomer(businessId, context.customerId);
      if (!order) return { canceled: false, reason: "no_order", note: "Este cliente no tiene ningun pedido registrado." };
      if (order.fulfillmentStatus === "CANCELED") {
        return { canceled: false, reason: "already_canceled", note: "Este pedido ya estaba cancelado." };
      }
      if (order.fulfillmentStatus === "SHIPPED") {
        return {
          canceled: false,
          reason: "already_shipped",
          note: "Este pedido ya fue enviado. No lo canceles vos - decile al cliente que necesitas confirmar con el equipo, y usa ask_owner.",
        };
      }

      await markOrderCanceled(businessId, order.id);

      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (business?.contactPhone) {
        const customerLabel = await describeCustomer(context.customerId, context.recipientPhone);
        const cancelAlertText = `Aviso: el pedido de ${customerLabel} fue cancelado por el bot a pedido del cliente.\n\n${order.summary}`;
        const cancelAlert = await sendAlertToOwner(businessId, context.credentials, business.contactPhone, cancelAlertText);
        await recordOwnerMessage(businessId, {
          direction: "OUT",
          body: cancelAlertText,
          success: cancelAlert.delivered,
          errorMessage: cancelAlert.failure?.message ?? null,
        });
        if (!cancelAlert.delivered) {
          console.error("No se pudo avisar al dueno de la cancelacion:", cancelAlert.failure?.message);
        }
      }

      return { canceled: true };
    }
    case "get_previous_conversation": {
      const previous = await getPreviousClosedConversation(businessId, context.customerId, context.conversationId);
      if (!previous) {
        return {
          found: false,
          note: "Este cliente no tiene ninguna conversacion anterior cerrada. Tratalo como una conversacion nueva sin preguntar nada al respecto.",
        };
      }
      return {
        found: true,
        outcome: previous.status,
        summary: previous.contextSummary || previous.pendingOrderSummary || previous.order?.summary || "No hay un resumen guardado de esa conversacion.",
        updatedAt: previous.updatedAt,
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
