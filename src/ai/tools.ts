import type OpenAI from "openai";
import {
  getProductById,
  listActiveProducts,
  searchProducts,
  findConfidentProductMatch,
  findProductsByAttributes,
} from "../catalog/products";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { listShippingRates, resolveShippingRateForCity } from "../catalog/shippingRates";

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
  sendImageMessage,
  sendVideoMessage,
  sendTextMessage,
  sendOwnerAlert,
  sendInteractiveButtonsMessage,
  isBsuid,
  type WhatsappCredentials,
} from "../whatsapp/client";
import { prisma } from "../db/client";
import { getPresignedMediaUrl } from "../media/s3";
import { recordOwnerMessage } from "../delivery/ownerLog";

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
    const wamid =
      mediaType === "IMAGE"
        ? await sendImageMessage(credentials, recipientPhone, item.url)
        : await sendVideoMessage(credentials, recipientPhone, item.url);
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
  if (!isBsuid(recipientPhone)) {
    return customer?.name ? `${customer.name} (${recipientPhone})` : recipientPhone;
  }
  return customer?.name
    ? `${customer.name} (sin numero visible, privacidad de WhatsApp activada)`
    : "un cliente (sin numero visible, privacidad de WhatsApp activada)";
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
        "Busca productos por categoria y/o color reales del catalogo (no por texto libre) - usala SIEMPRE que el cliente pida un tipo de producto con un color o categoria especifica (ej: 'reloj negro', 'el rosadito', 'audifonos rojos') en vez de search_products, para no mezclar categorias o colores que no pidio. Si el color no aparece en ninguna categoria clara, te devuelve los resultados agrupados por categoria para que le preguntes al cliente cual - nunca asumas ni mandes fotos de todas mezcladas.",
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
        "Obtiene el detalle completo de un producto especifico por su ID, incluyendo precio, stock y URLs de fotos/videos.",
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
        "Envia por WhatsApp las fotos/videos reales de un producto. Usar SIEMPRE que el cliente pida verlas - manda el archivo real, no hace falta describirlo en texto. Preferi productId (mas confiable) si lo obtuviste este turno con search_products o get_product_details; si no, usa productName.",
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
        "Obtiene las tarifas de envio reales configuradas por este negocio. Usar SIEMPRE antes de decirle un costo de envio al cliente cuando las instrucciones del negocio describen tarifas por ciudad/categoria - nunca copies el numero de esa prosa de memoria, confirmalo aca.",
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
        "Busca si esta ciudad especifica tiene una tarifa de envio EXACTA configurada por el negocio (coincidencia literal de nombre, ej. 'Bogota'). Usala apenas el cliente te de una ciudad puntual, antes de clasificarla vos de memoria en una categoria. Si no hay coincidencia exacta, NO es un error: segui las instrucciones propias del negocio para ubicarla en su categoria/tarifa general (usa get_shipping_rates para los montos), tal como lo venias haciendo.",
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
        "Obtiene las modalidades reales de pago del ENVIO que ofrece este negocio (ej: todo anticipado, producto anticipado + envio contraentrega, todo contraentrega) - distinto del canal de pago (Nequi/tarjeta/etc, ver get_payment_methods). Usar cuando el cliente este por confirmar una compra y el negocio tiene esto configurado.",
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
        "Guarda el numero de cedula y/o el celular de contacto del cliente cuando los da para el envio (envios nacionales, o si pide contactarlo a un numero distinto al de WhatsApp). Llamala apenas tengas cualquiera de los dos datos, no hace falta esperar a tener ambos.",
      parameters: {
        type: "object",
        properties: {
          idNumber: { type: "string", description: "Numero de cedula tal como lo dio el cliente" },
          deliveryPhone: { type: "string", description: "Celular de contacto para la entrega, tal como lo dio el cliente" },
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
        "Usa UNA SOLA VEZ cuando el cliente trae, no una consulta de venta normal: PQR (queja/reclamo), DEVOLUCION, NO_RECIBIDO (dice que no le llego el pedido), o SOLICITA_AGENTE (pide explicitamente hablar con una persona/asesor/humano, no con vos). No la uses para catalogo, precio o cerrar venta. Escala automaticamente a un humano del negocio.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["PQR", "DEVOLUCION", "NO_RECIBIDO", "SOLICITA_AGENTE"] },
        },
        required: ["intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_owner",
      description:
        "Usa SOLO cuando el cliente hace una pregunta real que necesita un dato concreto del negocio y no la podes responder con catalogo/get_faq/pagos. Manda la pregunta EXACTA al dueno por WhatsApp; su respuesta se reenvia tal cual al cliente, y mientras tanto el bot deja de responderle - por eso NUNCA para saludo, disculpas, agradecimiento o despedida (respondelo vos). No inventes ni adivines: preferi escalar. No la uses para PQR/devolucion/no_recibido, para eso usa flag_conversation_intent.",
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
        "Ultimo recurso, solo si TODO esto se cumplio: el cliente mando foto/video de un producto; el analisis de imagen no lo identifico con confianza (ni con segunda opinion); ya le pediste foto mas clara o el nombre y no pudo darlo; y search_products no encontro ningun candidato relacionado. Reenvia la foto/video real al dueno para que diga que producto es (un humano reconoce lo que la IA no pudo); su respuesta se confirma sola al cliente (con la foto real del catalogo si aplica). El bot deja de responderle mientras tanto. NO la uses de entrada ni para saltar el paso de buscar en catalogo - es cara en tiempo del dueno.",
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
        "Usa outcome=SOLD cuando el cliente ya confirmo su pedido final (producto, cantidad, direccion y forma de pago) y mando comprobante de pago valido. Si el negocio tiene un numero de contacto configurado, esto NO cierra la venta de inmediato: le manda el resumen al dueno para que confirme el pago, y el resultado te va a decir si quedo pendiente - en ese caso NO le digas al cliente que su compra esta confirmada, decile que estas verificando el pago con el equipo. Usa outcome=LOST si el cliente dice explicitamente que no le interesa o no va a comprar. No la uses para nada mas.",
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
            description: "SOLO para outcome=SOLD: el nombre de la forma de pago elegida (ej: 'Nequi', 'Contraentrega'), tal como la devolvio get_payment_methods.",
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
        "Cancela el pedido mas reciente de este cliente. USA ESTA HERRAMIENTA SOLO despues de que el cliente ya confirmo explicitamente que si quiere cancelar: primero preguntale en texto plano '¿confirmas que queres cancelar tu pedido?' y esperá su respuesta en un mensaje aparte - nunca la llames en el mismo turno en el que recien pide cancelar. Si el pedido ya fue enviado, esta herramienta lo va a rechazar; en ese caso no insistas, escala con ask_owner.",
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

interface PendingOrderDraft {
  items: ResolvedOrderItem[];
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shippingCost: number | null;
}

// Returns true whenever this business requires owner confirmation before closing a sale (i.e. has a
// contactPhone configured) - the caller must NOT auto-close the order in that case, regardless of
// whether the alert actually reached the owner. Previously, sendInteractiveButtonsMessage throwing (a
// real WhatsApp API error, not just an empty response) was uncaught here, which bubbled all the way up
// through generateReply and was swallowed by the webhook's outer try/catch - the customer got NO reply
// at all for that turn. And even when it didn't throw, `!wamid` was read as "no confirmation needed",
// so a failed send silently auto-approved an unconfirmed sale instead of blocking it. Now: buttons are
// tried first, falling back to plain text (compatible with the same "si"/"no" parsing in
// handleOwnerReply) if that fails, and the sale is only ever treated as NOT requiring confirmation when
// no contactPhone is configured at all - a total failure to reach the owner still blocks auto-closing,
// it just can't be resolved by quote-reply later (logged loudly for manual follow-up instead).
async function requestSaleConfirmation(context: ToolContext, summary: string, draft: PendingOrderDraft): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { id: context.businessId } });
  if (!business?.contactPhone) {
    // No hay a quien mandarle WhatsApp - la venta se autoconfirma igual (comportamiento existente),
    // pero sin este log quedaba sin ningun rastro de que el dueno nunca se entero en tiempo real.
    await recordOwnerMessage(context.businessId, {
      direction: "OUT",
      body: `Venta autoconfirmada sin aviso al dueno (falta configurar Telefono de contacto en el negocio): ${summary || "sin resumen"}`,
      success: false,
      errorMessage: "Sin contactPhone configurado",
    });
    return false;
  }

  const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
  const customerLabel = await describeCustomer(context.customerId, context.recipientPhone);
  const text = [
    `${greeting}, el cliente ${customerLabel} pago/confirmo este pedido:`,
    summary || "El cliente confirmo la compra, sin mas detalles registrados.",
    "¿Te llego el pago?",
  ].join("\n\n");

  let wamid = "";
  let lastError: unknown = null;
  try {
    wamid = await sendInteractiveButtonsMessage(context.credentials, business.contactPhone, text, [
      { id: "confirm_yes", title: "✅ Si llego" },
      { id: "confirm_no", title: "❌ No llego" },
    ]);
  } catch (error) {
    lastError = error;
    console.error("No se pudo enviar los botones de confirmacion de venta al dueno, probando texto libre:", error);
  }

  if (!wamid) {
    try {
      wamid = await sendTextMessage(
        context.credentials,
        business.contactPhone,
        `${text}\n\nRespondeme "si" o "no" citando este mismo mensaje, por favor.`
      );
      lastError = null;
    } catch (error) {
      lastError = error;
      console.error("No se pudo enviar la confirmacion de venta al dueno de ninguna forma (revisar manualmente):", error, {
        businessId: context.businessId,
        conversationId: context.conversationId,
      });
    }
  }

  await recordOwnerMessage(context.businessId, {
    direction: "OUT",
    body: text,
    success: Boolean(wamid),
    errorMessage: wamid ? null : lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "Sin wamid",
  });

  if (wamid) {
    await prisma.conversation.update({
      where: { id: context.conversationId },
      data: {
        pendingConfirmationMessageId: wamid,
        pendingOrderSummary: summary || null,
        pendingOrderItems: draft as unknown as object,
      },
    });
  }
  return true;
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

function formatProduct(product: Awaited<ReturnType<typeof getProductById>>) {
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price.toString(),
    currency: product.currency,
    stock: totalStock(product),
    category: product.category,
    media: product.media.map((m) => ({ type: m.type, url: m.url })),
  };
}

export interface ToolContext {
  businessId: string;
  conversationId: string;
  customerId: string;
  credentials: WhatsappCredentials;
  recipientPhone: string;
}

export async function runCatalogTool(context: ToolContext, name: string, input: Record<string, unknown>) {
  const { businessId } = context;
  switch (name) {
    case "find_products_by_attributes": {
      const category = input.category ? String(input.category).trim() : undefined;
      const color = input.color ? String(input.color).trim() : undefined;
      const freeText = input.freeText ? String(input.freeText).trim() : undefined;
      const { matches, categoriesFound } = await findProductsByAttributes(businessId, { category, color, freeText });

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
          ? "Estos resultados son de VARIAS categorias distintas - no asumas cual quiere el cliente ni mandes fotos todavia. Mostrale las opciones agrupadas por categoria (usa 'productName' y 'category' de cada una) y preguntale cual es, antes de llamar send_product_media."
          : "Estos son los productos/variantes reales que cumplen lo que pidio el cliente - no menciones ni mandes fotos de ningun otro color/categoria que no este en esta lista.",
      };
    }
    case "search_products": {
      const results = await searchProducts(businessId, String(input.query ?? ""));
      if (results.length > 0) return results.map(formatProduct);

      // No hubo coincidencia por palabra clave - el catalogo suele ser chico por negocio, asi que en
      // vez de decir "no existe" le mostramos todo lo activo para que lo revise por significado (el
      // cliente puede estar describiendo el producto con otras palabras que las del catalogo).
      const all = await listActiveProducts(businessId);
      return {
        results: all.map(formatProduct),
        note:
          all.length > 0
            ? "No hubo coincidencia exacta por palabra clave. Revisa este catalogo completo por significado antes de decir que no tenes el producto."
            : "Este negocio todavia no tiene productos activos en el catalogo.",
      };
    }
    case "get_product_details": {
      const product = await getProductById(businessId, String(input.productId ?? ""));
      if (!product) return formatProduct(product);

      await prisma.product.update({ where: { id: product.id }, data: { inquiryCount: { increment: 1 } } });

      // Deterministic auto-send: don't rely on the model remembering to separately call
      // send_product_media on first detail - it sometimes skips it despite the prompt instruction.
      // Send here in code instead, once per product per conversation (tracked via
      // Conversation.mediaSentProductIds), gated by the business's autoSendPhotoOnQuote setting.
      let mediaJustSent = false;
      if (product.media.length > 0) {
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
            product.media
          );
          await prisma.conversation.update({
            where: { id: context.conversationId },
            data: { mediaSentProductIds: { push: product.id } },
          });
          mediaJustSent = true;
        }
      }

      return { ...formatProduct(product), mediaJustSent };
    }
    case "list_all_products": {
      const results = await listActiveProducts(businessId);
      return results.map(formatProduct);
    }
    case "send_product_media": {
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

      await sendMediaWithSpacing(
        businessId,
        context.credentials,
        context.recipientPhone,
        context.conversationId,
        product.id,
        variantLabel ? `${product.name} (${variantLabel})` : product.name,
        media
      );
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
        methods: methods.map((m) => ({ type: m.type, label: m.label, details: m.details })),
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
      return { rates: rates.map((r) => ({ label: r.label, cost: r.cost.toString() })) };
    }
    case "get_shipping_rate_for_city": {
      const city = String(input.city ?? "").trim();
      if (!city) return { matched: false, note: "Falta la ciudad." };

      const resolved = await resolveShippingRateForCity(businessId, city);
      if (!resolved) {
        return {
          matched: false,
          note: "Esta ciudad no tiene una regla exacta configurada. No inventes su categoria: segui las instrucciones propias del negocio para clasificarla, y usa get_shipping_rates para confirmar el monto de la categoria que corresponda.",
        };
      }
      return { matched: true, label: resolved.label, cost: resolved.cost.toString() };
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
      await saveCustomerName(context.businessId, context.customerId, name);
      return { saved: true, name };
    }
    case "save_customer_contact_info": {
      const idNumber = input.idNumber ? String(input.idNumber).trim() : undefined;
      const deliveryPhone = input.deliveryPhone ? String(input.deliveryPhone).trim() : undefined;
      if (!idNumber && !deliveryPhone) return { error: "Falta la cedula o el celular" };
      await saveCustomerContactInfo(context.businessId, context.customerId, { idNumber, deliveryPhone });
      return { saved: true, idNumber, deliveryPhone };
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
      await setConversationIntent(businessId, context.conversationId, intent);
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
        const intentAlertText = `${greeting}, el cliente ${customerLabel} reporto ${label}. El bot dejo de responderle, toma el control vos directamente.`;
        try {
          await sendOwnerAlert(context.credentials, business.contactPhone, intentAlertText);
          await recordOwnerMessage(businessId, { direction: "OUT", body: intentAlertText, success: true });
        } catch (error) {
          await recordOwnerMessage(businessId, {
            direction: "OUT",
            body: intentAlertText,
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          console.error("No se pudo enviar la alerta de intent al dueno:", error);
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

      let wamid = "";
      let askOwnerError: unknown = null;
      try {
        wamid = await sendOwnerAlert(context.credentials, business.contactPhone, text);
      } catch (error) {
        askOwnerError = error;
      }
      await recordOwnerMessage(businessId, {
        direction: "OUT",
        body: text,
        success: Boolean(wamid),
        errorMessage: wamid ? null : askOwnerError instanceof Error ? askOwnerError.message : askOwnerError ? String(askOwnerError) : "Sin wamid",
      });
      if (!wamid) {
        return {
          asked: false,
          note: "No se pudo enviar la pregunta al dueno. Decile al cliente que un asesor le va a escribir pronto.",
        };
      }

      await createPendingOwnerQuestion(context.conversationId, wamid, question);

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
      try {
        wamid =
          lastMedia.mediaType === "VIDEO"
            ? await sendVideoMessage(context.credentials, business.contactPhone, mediaUrl, caption)
            : await sendImageMessage(context.credentials, business.contactPhone, mediaUrl, caption);
      } catch (error) {
        photoAlertError = error;
        console.error("No se pudo reenviar la foto/video como media al dueno, probando con link de texto:", error);
      }

      if (!wamid) {
        try {
          wamid = await sendTextMessage(context.credentials, business.contactPhone, `${caption}\n\n${mediaUrl}`);
          photoAlertError = null;
        } catch (error) {
          photoAlertError = error;
          console.error("No se pudo enviar NINGUNA notificacion al dueno para identificar el producto (revisar manualmente):", error, {
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

      if (outcome === "SOLD") {
        const summary = String(input.summary ?? "").trim();
        const shippingAddress = input.shippingAddress ? String(input.shippingAddress).trim() : null;
        const paymentMethodLabel = input.paymentMethodLabel ? String(input.paymentMethodLabel).trim() : null;
        const shippingCost = input.shippingCost !== undefined && input.shippingCost !== null ? Number(input.shippingCost) : null;
        const { items, unresolved, needsAttribute } = await resolveOrderItems(
          businessId,
          Array.isArray(input.items) ? (input.items as { productName: string; quantity: number; variantLabel?: string }[]) : []
        );

        // Real production incident (2026-09-12): a sale closed without ever asking the customer's color.
        // Unlike `unresolved` below (which only warns the owner and still closes), this BLOCKS the close -
        // the product exists and matched fine, but which color/size sold is still unknown, and that's not
        // something an owner can fix after the fact from an alert message the way a misspelled name is.
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
            try {
              await sendOwnerAlert(context.credentials, business.contactPhone, unresolvedText);
              await recordOwnerMessage(businessId, { direction: "OUT", body: unresolvedText, success: true });
            } catch (error) {
              await recordOwnerMessage(businessId, {
                direction: "OUT",
                body: unresolvedText,
                success: false,
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              console.error("No se pudo avisar al dueno de items no resueltos:", error);
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

      await updateConversationStatus(businessId, context.conversationId, outcome);
      return outcome === "SOLD"
        ? {
            closed: true,
            outcome,
            note: "El pedido quedo cerrado de una. Confirmaselo al cliente con calidez, agradecele la compra, y despedite - no dejes la conversacion en un simple 'listo' seco.",
          }
        : { closed: true, outcome };
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
        try {
          await sendOwnerAlert(context.credentials, business.contactPhone, cancelAlertText);
          await recordOwnerMessage(businessId, { direction: "OUT", body: cancelAlertText, success: true });
        } catch (error) {
          await recordOwnerMessage(businessId, {
            direction: "OUT",
            body: cancelAlertText,
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          console.error("No se pudo avisar al dueno de la cancelacion:", error);
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
