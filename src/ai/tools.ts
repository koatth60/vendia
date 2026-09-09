import type OpenAI from "openai";
import { getProductById, listActiveProducts, searchProducts } from "../catalog/products";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { listActiveFaqEntries } from "../catalog/faq";
import {
  updateConversationStatus,
  setConversationIntent,
  setHumanControl,
  saveCustomerName,
} from "../conversation/service";
import { resolveOrderItems, createOrder, askForCsat, type ResolvedOrderItem } from "../orders/service";
import {
  sendImageMessage,
  sendVideoMessage,
  sendTextMessage,
  sendInteractiveButtonsMessage,
  isBsuid,
  type WhatsappCredentials,
} from "../whatsapp/client";
import { prisma } from "../db/client";

async function describeCustomer(customerId: string, recipientPhone: string): Promise<string> {
  if (!isBsuid(recipientPhone)) return recipientPhone;
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
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
        "Envia por WhatsApp las fotos y/o videos reales de un producto especifico. Usar SIEMPRE que el cliente pida ver fotos, imagenes o video de un producto. Esto manda los archivos de verdad, no hace falta describir la imagen en texto aparte. Busca el producto por nombre en el momento, no hace falta pasar ningun ID.",
      parameters: {
        type: "object",
        properties: {
          productName: {
            type: "string",
            description:
              "El nombre (o parte del nombre) del producto tal como lo menciono el cliente en ESTE mensaje, por ejemplo 'smartwatch serie 11 mini' o 'boombox'. Usa siempre el producto del que se esta hablando ahora mismo en la conversacion, no uno mencionado antes.",
          },
        },
        required: ["productName"],
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
        "Usa esta herramienta UNA SOLA VEZ cuando detectes que el cliente no esta haciendo una consulta de venta normal, sino que trae: una PQR (peticion, queja o reclamo sobre el servicio/producto), una solicitud de DEVOLUCION, o un reclamo de que su pedido NO_RECIBIDO (no le llego). NO la uses para preguntas normales de catalogo, precio o para cerrar una venta. Esto escala la conversacion a un humano del negocio automaticamente.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["PQR", "DEVOLUCION", "NO_RECIBIDO"] },
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
        "Usa esta herramienta cuando el cliente pregunta algo que no podes responder con las demas herramientas (catalogo, search_faq, formas de pago) y de verdad no sabes la respuesta. Le manda la pregunta EXACTA del cliente al dueno del negocio por WhatsApp para que la responda el mismo. Cuando el dueno responda, esa respuesta se le reenvia al cliente tal cual, sin que vos intervengas. Mientras tanto el bot deja de responderle a este cliente. NO inventes ni adivines la respuesta - preferi escalar. No la uses para PQR, devoluciones o pedidos no recibidos, para eso usa flag_conversation_intent.",
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
        },
        required: ["outcome"],
      },
    },
  },
];

interface PendingOrderDraft {
  items: ResolvedOrderItem[];
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
}

async function requestSaleConfirmation(context: ToolContext, summary: string, draft: PendingOrderDraft): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { id: context.businessId } });
  if (!business?.contactPhone) return false;

  const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
  const customerLabel = await describeCustomer(context.customerId, context.recipientPhone);
  const text = [
    `${greeting}, el cliente ${customerLabel} pago/confirmo este pedido:`,
    summary || "El cliente confirmo la compra, sin mas detalles registrados.",
    "¿Te llego el pago?",
  ].join("\n\n");

  const wamid = await sendInteractiveButtonsMessage(context.credentials, business.contactPhone, text, [
    { id: "confirm_yes", title: "✅ Si llego" },
    { id: "confirm_no", title: "❌ No llego" },
  ]);
  if (!wamid) return false;

  await prisma.conversation.update({
    where: { id: context.conversationId },
    data: {
      pendingConfirmationMessageId: wamid,
      pendingOrderSummary: summary || null,
      pendingOrderItems: draft as unknown as object,
    },
  });
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
      return results.map(formatProduct);
    }
    case "get_product_details": {
      const product = await getProductById(businessId, String(input.productId ?? ""));
      if (product) {
        await prisma.product.update({ where: { id: product.id }, data: { inquiryCount: { increment: 1 } } });
      }
      return formatProduct(product);
    }
    case "list_all_products": {
      const results = await listActiveProducts(businessId);
      return results.map(formatProduct);
    }
    case "send_product_media": {
      const query = String(input.productName ?? "");
      const matches = await searchProducts(businessId, query);

      if (matches.length === 0) {
        return { error: `No se encontro ningun producto que coincida con "${query}".` };
      }

      const product = matches[0];
      await prisma.product.update({ where: { id: product.id }, data: { inquiryCount: { increment: 1 } } });
      if (product.media.length === 0) {
        return { sent: false, product: product.name, reason: "Este producto no tiene fotos ni videos cargados" };
      }

      let sentCount = 0;
      for (const media of product.media) {
        if (media.type === "IMAGE") {
          await sendImageMessage(context.credentials, context.recipientPhone, media.url);
        } else {
          await sendVideoMessage(context.credentials, context.recipientPhone, media.url);
        }
        sentCount++;
      }
      return { sent: true, product: product.name, count: sentCount };
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
      await saveCustomerName(context.customerId, name);
      return { saved: true, name };
    }
    case "update_conversation_status": {
      const status = ["INTERESTED", "QUOTED", "NEGOTIATING"].includes(String(input.status)) ? (input.status as "INTERESTED" | "QUOTED" | "NEGOTIATING") : null;
      if (!status) return { error: "Estado invalido" };
      await updateConversationStatus(context.conversationId, status);
      return { updated: true, status };
    }
    case "flag_conversation_intent": {
      const intent = input.intent === "DEVOLUCION" || input.intent === "NO_RECIBIDO" ? input.intent : "PQR";
      await setConversationIntent(context.conversationId, intent);
      await setHumanControl(businessId, context.conversationId, true);

      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (business?.contactPhone) {
        const label = { PQR: "PQR", DEVOLUCION: "una devolucion", NO_RECIBIDO: "un pedido no recibido" }[intent];
        const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
        const customerLabel = await describeCustomer(context.customerId, context.recipientPhone);
        await sendTextMessage(
          context.credentials,
          business.contactPhone,
          `${greeting}, el cliente ${customerLabel} reporto ${label}. Tome control de la conversacion en el panel para atenderlo directamente, el bot dejo de responderle.`
        );
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

      const wamid = await sendTextMessage(context.credentials, business.contactPhone, text);
      if (!wamid) {
        return {
          asked: false,
          note: "No se pudo enviar la pregunta al dueno. Decile al cliente que un asesor le va a escribir pronto.",
        };
      }

      await setHumanControl(businessId, context.conversationId, true);
      await prisma.conversation.update({
        where: { id: context.conversationId },
        data: { pendingOwnerQuestionMessageId: wamid },
      });

      return {
        asked: true,
        note: "La pregunta quedo escalada al dueno del negocio. No sigas intentando responderla vos mismo ni inventes nada: decile al cliente que estas confirmando esa info con el equipo y le respondes en breve.",
      };
    }
    case "close_conversation": {
      const outcome = input.outcome === "LOST" ? "LOST" : "SOLD";

      if (outcome === "SOLD") {
        const summary = String(input.summary ?? "").trim();
        const shippingAddress = input.shippingAddress ? String(input.shippingAddress).trim() : null;
        const paymentMethodLabel = input.paymentMethodLabel ? String(input.paymentMethodLabel).trim() : null;
        const items = await resolveOrderItems(
          businessId,
          Array.isArray(input.items) ? (input.items as { productName: string; quantity: number }[]) : []
        );

        const pending = await requestSaleConfirmation(context, summary, { items, shippingAddress, paymentMethodLabel });
        if (pending) {
          return {
            closed: false,
            pending: true,
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
        });
        await askForCsat(context.credentials, order.id, context.recipientPhone);
      }

      await updateConversationStatus(context.conversationId, outcome);
      return { closed: true, outcome };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
