import type OpenAI from "openai";
import { getProductById, listActiveProducts, searchProducts, findConfidentProductMatch } from "../catalog/products";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { listActiveFaqEntries } from "../catalog/faq";
import {
  updateConversationStatus,
  setConversationIntent,
  setHumanControl,
  saveCustomerName,
  saveCustomerContactInfo,
  recordMessage,
  createPendingOwnerQuestion,
} from "../conversation/service";
import {
  resolveOrderItems,
  createOrder,
  askForCsat,
  getLatestOrderForCustomer,
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
          query: { type: "string", description: "Palabra o frase para buscar" },
        },
        required: ["query"],
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
        "Envia por WhatsApp las fotos y/o videos reales de un producto especifico. Usar SIEMPRE que el cliente pida ver fotos, imagenes o video de un producto. Esto manda los archivos de verdad, no hace falta describir la imagen en texto aparte. Si ya sabes el ID exacto del producto (porque lo acabas de obtener con search_products o get_product_details en este mismo turno), pasalo en productId - es mas confiable que buscar de nuevo por nombre y evita mandar la foto de un producto distinto al que se esta hablando. Si solo tenes el nombre (el cliente lo escribio en el chat), usa productName.",
      parameters: {
        type: "object",
        properties: {
          productId: {
            type: "string",
            description:
              "El campo 'id' exacto del producto, si ya lo obtuviste en este turno con search_products o get_product_details. Preferi este sobre productName siempre que lo tengas.",
          },
          productName: {
            type: "string",
            description:
              "El nombre (o parte del nombre) del producto tal como lo menciono el cliente en ESTE mensaje, por ejemplo 'smartwatch serie 11 mini' o 'boombox'. Usa siempre el producto del que se esta hablando ahora mismo en la conversacion, no uno mencionado antes. Solo hace falta si no tenes productId.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_faq",
      description:
        "Trae TODAS las preguntas frecuentes configuradas por el negocio (politicas de envio, garantia, horarios, cambios, etc). Usar cuando el cliente pregunte algo que no es sobre un producto especifico ni sobre formas de pago, antes de responder de memoria o decir que no sabes. Revisa vos mismo la lista completa por significado, no solo por si aparecen las mismas palabras - el cliente puede preguntar lo mismo con otras palabras.",
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
        "Usa esta herramienta UNA SOLA VEZ cuando detectes que el cliente no esta haciendo una consulta de venta normal, sino que trae: una PQR (peticion, queja o reclamo sobre el servicio/producto), una solicitud de DEVOLUCION, un reclamo de que su pedido NO_RECIBIDO (no le llego), o SOLICITA_AGENTE cuando el cliente pide explicitamente hablar con una persona real, un asesor, un agente o un humano (no con vos). NO la uses para preguntas normales de catalogo, precio o para cerrar una venta. Esto escala la conversacion a un humano del negocio automaticamente.",
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
        "Usa esta herramienta SOLO cuando el cliente hace una pregunta real que necesita un dato concreto del negocio, y no podes responderla con las demas herramientas (catalogo, get_faq, formas de pago). Le manda la pregunta EXACTA del cliente al dueno del negocio por WhatsApp para que la responda el mismo. Cuando el dueno responda, esa respuesta se le reenvia al cliente tal cual, sin que vos intervengas. Mientras tanto el bot deja de responderle a este cliente - por eso NUNCA la uses para un mensaje social o de charla (saludo, disculpa por tardar, agradecimiento, despedida): eso respondelo vos mismo directo, no es una pregunta que requiera al dueno. NO inventes ni adivines la respuesta a una pregunta real - preferi escalar. No la uses para PQR, devoluciones o pedidos no recibidos, para eso usa flag_conversation_intent.",
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
        "Usa esta herramienta SOLO como ultimo recurso, despues de agotar todo lo demas: el cliente mando una foto o video de un producto, el analisis de imagen no logro identificarlo con confianza (ni siquiera despues de la segunda opinion), YA le pediste una foto mas clara o el nombre y el cliente insiste sin poder darlo, Y search_products no encontro ningun candidato remotamente relacionado para ofrecer. Le reenvia la foto/video REAL del cliente al dueno del negocio por WhatsApp para que diga que producto es - un humano suele reconocer en una foto borrosa algo que la IA no puede. Cuando el dueno responda, se le confirma al cliente automaticamente (con la foto real del catalogo si el dueno nombro un producto que existe ahi). Mientras tanto el bot deja de responderle a este cliente. NO la uses de entrada ni para ahorrarte el paso de buscar en el catalogo primero - es cara en tiempo del dueno, se usa poco.",
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
              "SOLO para outcome=SOLD: el costo del envio que le confirmaste al cliente (0 si el envio es gratis o no aplica). El total del pedido se calcula como precio del/los producto(s) mas este valor - siempre que hayas cobrado o mencionado un costo de envio, incluilo aca para que el pedido registrado refleje el total real que pago el cliente, no solo el producto.",
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
        "Consulta el estado real del pedido mas reciente de este cliente: si sigue pendiente, ya fue enviado o fue cancelado, ademas del resumen, nota de envio y total. Usa esta herramienta SIEMPRE que el cliente pregunte como va su pedido, si ya se lo enviaron, pida la factura o el numero de guia, o pregunte por algo que ya compro antes. Nunca respondas de memoria del historial del chat ni inventes un estado - esta herramienta es la unica fuente real.",
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

function formatProduct(product: Awaited<ReturnType<typeof getProductById>>) {
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price.toString(),
    currency: product.currency,
    stock: product.stock,
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
      if (product.media.length === 0) {
        return { sent: false, product: product.name, reason: "Este producto no tiene fotos ni videos cargados" };
      }

      await sendMediaWithSpacing(
        businessId,
        context.credentials,
        context.recipientPhone,
        context.conversationId,
        product.id,
        product.name,
        product.media
      );
      return { sent: true, product: product.name, count: product.media.length };
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
    case "close_conversation": {
      const outcome = input.outcome === "LOST" ? "LOST" : "SOLD";

      if (outcome === "SOLD") {
        const summary = String(input.summary ?? "").trim();
        const shippingAddress = input.shippingAddress ? String(input.shippingAddress).trim() : null;
        const paymentMethodLabel = input.paymentMethodLabel ? String(input.paymentMethodLabel).trim() : null;
        const shippingCost = input.shippingCost !== undefined && input.shippingCost !== null ? Number(input.shippingCost) : null;
        const { items, unresolved } = await resolveOrderItems(
          businessId,
          Array.isArray(input.items) ? (input.items as { productName: string; quantity: number }[]) : []
        );
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
