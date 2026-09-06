import type OpenAI from "openai";
import { getProductById, listActiveProducts, searchProducts } from "../catalog/products";
import { listActivePaymentMethods } from "../catalog/paymentMethods";
import { updateConversationStatus } from "../conversation/service";
import { sendImageMessage, sendVideoMessage, sendTextMessage, type WhatsappCredentials } from "../whatsapp/client";
import { prisma } from "../db/client";

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
      name: "close_conversation",
      description:
        "Marca esta conversacion como cerrada. Usa outcome=SOLD justo despues de confirmarle al cliente su pedido final (ya con producto, cantidad, direccion y forma de pago). Usa outcome=LOST si el cliente dice explicitamente que no le interesa o no va a comprar. No la uses para nada mas.",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["SOLD", "LOST"] },
          summary: {
            type: "string",
            description:
              "SOLO para outcome=SOLD: un resumen corto del pedido para el dueno del negocio, con producto(s) y cantidad, direccion de envio, forma de pago elegida, y el nombre/telefono de contacto que dio el cliente (si lo dio). No hace falta para outcome=LOST.",
          },
        },
        required: ["outcome"],
      },
    },
  },
];

async function notifyBusinessOfSale(context: ToolContext, summary: string) {
  try {
    const business = await prisma.business.findUnique({ where: { id: context.businessId } });
    if (!business?.contactPhone) return;

    const text = [
      "🟢 *Nueva venta cerrada por el bot*",
      `Cliente (WhatsApp): ${context.recipientPhone}`,
      summary || "El cliente confirmo la compra, sin mas detalles registrados.",
    ].join("\n\n");

    await sendTextMessage(context.credentials, business.contactPhone, text);
  } catch (error) {
    console.error("No se pudo notificar la venta al numero de contacto del negocio:", error);
  }
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
    case "get_payment_methods": {
      const methods = await listActivePaymentMethods(businessId);
      if (methods.length === 0) {
        return { methods: [], note: "Este negocio todavia no configuro formas de pago. Decile al cliente que un asesor le va a confirmar como pagar." };
      }
      return {
        methods: methods.map((m) => ({ type: m.type, label: m.label, details: m.details })),
      };
    }
    case "close_conversation": {
      const outcome = input.outcome === "LOST" ? "LOST" : "SOLD";
      await updateConversationStatus(context.conversationId, outcome);

      if (outcome === "SOLD") {
        const summary = String(input.summary ?? "").trim();
        await notifyBusinessOfSale(context, summary);
      }

      return { closed: true, outcome };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
