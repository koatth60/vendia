import type OpenAI from "openai";
import type { Prisma } from "@prisma/client";
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
import {
  listActivePaymentMethods,
  listPaymentMethods,
  isExactConfiguredPaymentMethod,
  requiresPaymentConfirmation,
  resolveConfiguredPaymentMethod,
} from "../catalog/paymentMethods";
import { faltaComprobanteDePago, FALTA_COMPROBANTE_NOTE } from "../orders/paymentProof";
import { resolverModalidadDelPedido, filtrarMetodosPorZona } from "../orders/paymentTiming";
import { listShippingRates, resolveShippingRateForCity } from "../catalog/shippingRates";
import { recordAgentIncident } from "./incidents";
import { getSaleGate } from "./configHealth";
import { normalizeForMatch } from "../search/text";
import { totalStock } from "../catalog/stock";
import type { ShippingPaymentModality } from "@prisma/client";
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
import {
  updateConversationStatus,
  setConversationIntent,
  setHumanControl,
  saveCustomerName,
  saveCustomerContactInfo,
  recordMessage,
  createPendingOwnerQuestion,
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
  getServerSaleEvidence,
} from "../orders/saleState";
import { formatPriceSlotsForOwner, ownerPriceFormatHint, type PriceSlot } from "../orders/agreedPrices";
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
import { sendMediaWithSpacing, UnsendableMediaError } from "../whatsapp/productMedia";

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
              "Palabra o frase para buscar. Si el cliente respondio solo con un numero eligiendo una opcion de una lista que TÚ mostraste antes, no busques ese numero - usa el nombre real del producto en esa posicion de tu propia lista.",
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
        "Busca productos por categoria y/o color reales del catalogo (no por texto libre) - úsala SIEMPRE que el cliente pida un tipo de producto con un color o categoria especifica (ej: 'reloj negro', 'el rosadito', 'audifonos rojos') en vez de search_products, para no mezclar categorias o colores que no pidio.",
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
              "El 'id' exacto del producto, si ya lo tienes de search_products o get_product_details en este turno. Preferilo sobre productName.",
          },
          productName: {
            type: "string",
            description:
              "El nombre del producto que el cliente menciono en ESTE mensaje (el que se esta hablando ahora, no uno anterior). Solo si no tienes productId. Si el cliente respondio con un numero de una lista tuya, resuélvelo al nombre real antes de pasarlo aca (ver SELECCION POR NUMERO).",
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
        "Busca si esta ciudad especifica tiene una tarifa de envio EXACTA configurada por el negocio (coincidencia literal de nombre, ej. 'Bogota'). Úsala apenas el cliente te de una ciudad puntual, antes de clasificarla tú de memoria en una categoria. Si no hay coincidencia exacta, no es un error - sigue las instrucciones del negocio para su categoria/tarifa general.",
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
        "Obtiene las modalidades reales de pago del ENVIO que ofrece este negocio (ej: todo anticipado, producto anticipado + envio contraentrega, todo contraentrega) - distinto del canal de pago ({{METODOS_PAGO}}/etc, ver get_payment_methods). Usar cuando el cliente este por confirmar una compra. Pasa la ciudad si ya la sabes: no todas las zonas admiten las mismas.",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "La ciudad de entrega, si el cliente ya la dijo. Sin ella se devuelven las modalidades generales del negocio, que pueden no aplicar en esa zona.",
          },
        },
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
              "true SOLO si el cliente lo pidio o lo dijo con sus propias palabras (ej: 'quiero hablar con un asesor', 'quiero devolver el producto'). false si tú lo dedujiste del contexto o del tono sin que el cliente lo haya dicho asi. El dueno ve esta diferencia en la alerta que recibe.",
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
        "Usa SOLO cuando el cliente hace una pregunta real que necesita un dato concreto del negocio y no la podes responder con el catalogo, las preguntas frecuentes de arriba en este chat, o las formas de pago. Manda la pregunta EXACTA al dueno por WhatsApp; mientras tanto el bot deja de responderle. No la uses para PQR/devolucion/no_recibido/pedido de hablar con un humano (para eso usa flag_conversation_intent), ni para un descuento o precio especial (para eso usa ask_owner_about_price, que ademas guarda el precio que el dueno autorice).",
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
      name: "ask_owner_about_price",
      description:
        "Úsala cuando el cliente pide un descuento, un precio especial o regatea sobre productos concretos. Le manda al dueno los productos del pedido con su precio actual y le pide un precio por cada uno; cuando el dueno confirma, el sistema guarda ese precio y se lo cobra a este cliente. Tú NO propones ni aceptas ningun precio: el numero lo pone el dueno. Un precio que diga el CLIENTE no vale nunca.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description:
              "Los productos sobre los que el cliente pide el descuento. Si el pedido en curso ya tiene productos cargados, el sistema usa esos y ignora esta lista.",
            items: {
              type: "object",
              properties: {
                productName: { type: "string", description: "Nombre del producto, tal como aparece en el catalogo" },
                quantity: { type: "number", description: "Cantidad de ese producto" },
                variantLabel: {
                  type: "string",
                  description: "SOLO si ese producto tiene varios colores/tallas: el color y/o talla que el cliente eligio.",
                },
              },
              required: ["productName", "quantity"],
            },
          },
        },
        required: [],
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
        "Úsala ANTES de pedir el comprobante de pago, apenas tengas producto(s)+cantidad, direccion, forma de pago y nombre - calcula el precio y total REALES del catalogo (nunca los calcules de memoria) para que se los muestres al cliente y le pidas que confirme, antes de seguir. Mismo formato de items que close_conversation. No cierra ni guarda nada, solo calcula.",
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
                    "SOLO si ese producto tiene varios colores/tallas (variantes): el color y/o talla que el cliente eligio, tal como lo dijo (ej: 'rojo', 'M', 'rojo talla M'). Si el producto tiene variantes y todavia no sabes cual, NO llames esta herramienta - pregúntale primero.",
                },
              },
              required: ["productName", "quantity"],
            },
          },
          shippingAddress: {
            type: "string",
            description: "SOLO para outcome=SOLD: la direccion de envio que dio el cliente, si aplica.",
          },
          paymentMethodId: {
            type: "string",
            description:
              "SOLO para outcome=SOLD: el id real de la forma de pago que eligio el cliente, tal como lo devolvio get_payment_methods. El sistema resuelve solo el nombre que se guarda en el pedido, asi que podes describirsela al cliente con tus palabras.",
          },
          paymentMethodLabel: {
            type: "string",
            description:
              "Solo si no tienes el paymentMethodId: el nombre de la forma de pago elegida (ej: {{METODOS_PAGO}}), exactamente como lo devolvio get_payment_methods.",
          },
          shippingCost: {
            type: "number",
            description:
              "SOLO para outcome=SOLD: costo de envio confirmado al cliente (0 si gratis/no aplica). El total del pedido = precio(s) + este valor, asi que si cobraste o mencionaste envio, incluilo para que el total registrado sea el real.",
          },
          shippingModality: {
            type: "string",
            enum: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"],
            description:
              "SOLO para outcome=SOLD: cuando paga el cliente, con el code exacto que devolvio get_shipping_payment_modalities para su ciudad. De aca sale cuanto tiene que cobrar el mensajero al entregar. Si mandas una que no aplica en esa zona se descarta y el sistema la resuelve solo.",
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
        // El pedido reciente (ultimos 30 dias) ya te llega SIEMPRE como dato del sistema, sin llamar nada:
        // ver src/orders/postSale.ts. Esta herramienta quedo para lo que ese dato no cubre.
        "Consulta el pedido mas reciente del cliente. Solo hace falta si pregunta por una compra vieja que no figure en los datos del pedido que ya tienes.",
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
        "Cancela el pedido mas reciente de este cliente, sea de esta conversacion o de otra. USA ESTA HERRAMIENTA SOLO despues de que el cliente ya confirmo explicitamente que si quiere cancelar (ver CANCELAR UN PEDIDO en tus instrucciones) - nunca en el mismo turno en que recien lo pide. Si el pedido ya fue enviado, esta herramienta lo va a rechazar.",
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
/**
 * La linea que encabeza lo que se le pregunta al dueno: cuanto tenia que llegarle por adelantado.
 *
 * Con "todo por adelantado" es el total; con "producto por adelantado, envio contraentrega" es SOLO el
 * producto, y ahi esta el caso que la hace falta - preguntarle "¿te llego el pago?" al lado de un resumen
 * que dice el total lo manda a buscar una transferencia que nunca existio. Sin modalidad resuelta no se
 * inventa ninguna cifra y la pregunta queda como estaba.
 */
function lineaDePagoEsperado(
  modality: ShippingPaymentModality | null,
  items: ResolvedOrderItem[],
  shippingCost: number | null | undefined,
  negocio: { currency: string; locale: string }
): string {
  const itemsTotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const envio = shippingCost || 0;
  const moneda = items[0]?.currency || negocio.currency;
  if (modality === "PREPAID_ALL") {
    return `Tenia que llegarte $${formatPrice(itemsTotal + envio, moneda, negocio.locale)} (producto + envio).

`;
  }
  if (modality === "PREPAID_PRODUCT_COD_SHIPPING") {
    return `Tenia que llegarte $${formatPrice(itemsTotal, moneda, negocio.locale)}, solo el producto: el envio de $${formatPrice(envio, moneda, negocio.locale)} se cobra al entregar.

`;
  }
  return "";
}

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
// Movida a src/catalog/stock.ts para que el presenter de la Fase B use la MISMA definicion: estaba
// duplicada en la capa de la IA y el camino nuevo no la encontro (incidente 2026-09-16, ver ese archivo).

// LIST_DESCRIPTION_MAX_CHARS: solo para vistas de LISTA (varios productos en un mismo tool result) - el
// modelo ahi solo necesita reconocer de cual producto se trata para decidir relevancia o pedir el detalle
// completo con get_product_details, no la ficha entera. Medido en catalogo real de produccion (16
// productos, ~1000 chars de descripcion promedio): el fallback de search_products sin truncar pesaba
// ~18.8k chars (~4.7k tokens) en un solo tool result, mas grande que BASE_SYSTEM_PROMPT completo, y
// siempre a precio cache-miss (contenido nuevo cada vez que se genera). Ver ONIX-RELIABILITY-PLAN.md Fase
// 6.0b.
const LIST_DESCRIPTION_MAX_CHARS = 150;

// Lo que se le dice al modelo cuando intento cerrar una venta sin ninguna linea real. Vive aca, y no
// dentro de close_conversation, para no alejar el chequeo de needsAttribute de su llamada a
// resolveOrderItems (ver src/orders/resolveOrderItems.arch.test.ts, que mide esa distancia).
const EMPTY_ORDER_NOTE =
  "No se cerro nada y no se creo ningun pedido: no hay ningun producto en `items` ni en el pedido en curso, o ninguno de los que pasaste existe en el catalogo. Volve a llamar close_conversation con los productos reales que el cliente esta comprando.";

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
const CATALOG_LIST_NOTE = `No escribas tú los nombres, los precios ni el stock de estos productos: pon la marca ${CATALOG_BLOCK_MARKER} donde quieras que aparezca la lista y el sistema la reemplaza por el catalogo real (numerado) antes de enviar. Redacta solo alrededor.`;
// Fase B del plan de catalogo y medios (2026-09-16): la nota terminaba con "Los datos de esta lista
// igual te sirven para decidir y para responder sobre un producto puntual". Esa frase era la que
// autorizaba al modelo a contestar sobre un producto SIN llamar get_product_details - y get_product_details
// era el unico camino de auto-envio de fotos que existia. Con la ficha de un producto puntual ahora
// compuesta por el servidor (resolveProductScope + renderCatalog), esa autorizacion solo servia para
// dejarlo describir de memoria un producto que nadie leyo de la base.

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
  /**
   * Los productos cuyos medios el servidor YA tiene armados para salir en ESTE turno (los bloques de
   * renderCatalog, ver agent.ts). El registro de la base (`Conversation.mediaSentProductIds`) todavia no
   * los tiene: los bloques se envian despues de que termina el turno, asi que sin este dato una llamada a
   * get_product_details o a send_product_media en el mismo turno mandaba las mismas fotos una segunda vez.
   *
   * No bloquea un reenvio explicito: si el cliente pide la foto de nuevo en un turno posterior, el
   * presentador ya no la adjunta (dedup por conversacion) y send_product_media la manda como siempre.
   */
  mediaQueuedProductIds?: string[];
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
  get_shipping_payment_modalities: z.object({ city: SCALAR_INPUT.optional() }),
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
    paymentMethodId: SCALAR_INPUT.optional(),
    paymentMethodLabel: SCALAR_INPUT.optional(),
    shippingCost: SCALAR_INPUT.optional(),
    shippingModality: SCALAR_INPUT.optional(),
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
        note: `No inventes datos de pago ni un total - pon la marca ${SALE_BLOCKED_BLOCK_MARKER} donde quieras ofrecerle al cliente dejar el pedido anotado para que el dueno lo confirme directamente, y redacta alrededor.`,
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
          note: "No hay ningun producto activo que cumpla ese color/categoria en el catalogo real. No inventes que si hay - dile al cliente honestamente que no tienes esa combinacion, o usa search_products si crees que puede estar descrito distinto.",
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
          ? `Estos resultados son de VARIAS categorias distintas - no asumas cual quiere el cliente ni mandes fotos todavia. Pregúntale cual categoria es (usa 'category' de cada uno para nombrarlas) antes de llamar send_product_media.${listNote}`
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
            ? `No hubo coincidencia exacta por palabra clave. Revisa este catalogo completo por significado antes de decir que no tienes el producto. ${CATALOG_LIST_NOTE}`
            : all.length === 1
              ? "No hubo coincidencia exacta por palabra clave. Revisa este catalogo completo por significado antes de decir que no tienes el producto."
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
        // Lo ya enviado en turnos anteriores (la base) MAS lo que el presentador de este turno ya tiene
        // armado para salir: los bloques se envian despues del turno, asi que la base todavia no los ve.
        const alreadySent =
          (conversation?.mediaSentProductIds.includes(product.id) ?? false) ||
          (context.mediaQueuedProductIds?.includes(product.id) ?? false);
        if (business?.autoSendPhotoOnQuote && !alreadySent) {
          // Mismo criterio que en send_product_media: una foto que WhatsApp no acepta no puede costarle
          // al cliente la respuesta del turno. Acá la foto sale sola, sin que nadie la pida, así que
          // menos todavía.
          let seEnvio = true;
          try {
            await sendMediaWithSpacing(
              businessId,
              context.credentials,
              context.recipientPhone,
              context.conversationId,
              product.id,
              product.name,
              allProductMedia
            );
          } catch (error) {
            if (!(error instanceof UnsendableMediaError)) throw error;
            seEnvio = false;
          }
          if (seEnvio) {
            await prisma.conversation.update({
              where: { id: context.conversationId },
              data: { mediaSentProductIds: { push: product.id } },
            });
            await recordMediaSent(context.conversationId, product.name);
            mediaJustSent = true;
          }
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
            error: `"${query}" coincide con varios productos por igual: ${match.candidates?.join(", ")}. Pídele al cliente que aclare cual, o usa get_product_details con el ID exacto de uno de search_products.`,
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

      // Los medios de este producto ya van a salir en este mismo turno, en los bloques que compuso el
      // servidor: mandarlos aca seria la misma foto dos veces seguidas. No es el freno de un reenvio
      // explicito - el cliente los recibe igual, en este turno - y en un turno posterior, donde el
      // presentador ya no los adjunta, esta llamada los manda como siempre.
      if (context.mediaQueuedProductIds?.includes(product.id)) {
        return { sent: true, product: product.name, variant: variantLabel, count: media.length, alreadyGoingOutThisTurn: true };
      }

      try {
        await sendMediaWithSpacing(
          businessId,
          context.credentials,
          context.recipientPhone,
          context.conversationId,
          product.id,
          variantLabel ? `${product.name} (${variantLabel})` : product.name,
          media
        );
      } catch (error) {
        // Un archivo que WhatsApp no acepta es un dato malo del catalogo, no una falla del sistema: el
        // turno sigue y el modelo se entera de que esa foto NO salio, en vez de cortar la respuesta
        // entera. Antes de E17 esa misma foto se "enviaba" con exito aparente y no llegaba nunca; que
        // ahora no llegue Y ADEMAS se pierda la respuesta del turno seria empeorar lo que habia.
        // Cualquier otro error de envio se propaga como siempre.
        if (!(error instanceof UnsendableMediaError)) throw error;
        return { sent: false, product: product.name, variant: variantLabel, reason: error.reason };
      }

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
    case "get_payment_methods": {
      // UN METODO QUE COBRA AL RECIBIR NO SE OFRECE DONDE NO SE HACE (2026-09-17).
      //
      // "Contraentrega" es un metodo de pago del negocio entero, pero pagar TODO al recibir casi nunca
      // aplica en todo el pais: MAG.IMP lo hace en Bogota y Soacha y no fuera. Sin este filtro, a una
      // clienta de Cali se le ofrecia igual y el bot le prometia algo que el negocio no iba a cumplir.
      //
      // El disparador es la ciudad que el SERVIDOR ya resolvio contra sus propias reglas (ver
      // recordShippingCity), no una lectura del mensaje. Sin ciudad resuelta no se filtra nada: todavia no
      // sabemos a donde va el pedido, y esconder un metodo por las dudas seria el error opuesto.
      const methods = await filtrarMetodosPorZona(businessId, await listActivePaymentMethods(businessId), context.conversationId);
      if (methods.length === 0) {
        return { methods: [], note: "Este negocio todavia no configuro formas de pago. Dile al cliente que un asesor le va a confirmar como pagar." };
      }
      return {
        // `id` agregado en Fase 2 (2026-09-15): lo necesita set_payment_method para guardar cual eligio
        // el cliente sin ambiguedad de label (dos metodos podrian compartir el mismo label).
        // `seCobraAlRecibir` sale de PaymentMethod.settlement, el mismo dato con el que el servidor decide
        // si hay que pedir comprobante y si hay que despertar al dueno. Viaja con el metodo a proposito:
        // sin el, el agente no tiene como saber que a este metodo no le corresponde ninguna foto de pago,
        // y la unica forma de que lo supiera era una regla escrita en el prompt.
        methods: methods.map((m) => ({
          id: m.id,
          type: m.type,
          label: m.label,
          details: m.details,
          seCobraAlRecibir: m.settlement === "ON_DELIVERY",
        })),
        note: `No escribas tú el numero/llave/titular: pon la marca ${PAYMENT_BLOCK_MARKER} donde quieras mostrarlos y el sistema la reemplaza por estos datos reales antes de enviar.`,
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
            ? `Hay una sola tarifa configurada: no escribas tú el numero, pon la marca ${SHIPPING_BLOCK_MARKER} donde quieras mostrarlo.`
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
          note: "Esta ciudad no tiene una regla exacta configurada. No inventes su categoria: sigue las instrucciones propias del negocio para clasificarla, y usa get_shipping_rates para confirmar el monto de la categoria que corresponda.",
        };
      }
      return {
        matched: true,
        label: resolved.label,
        cost: resolved.cost.toString(),
        // Las modalidades de ESTA zona salen en la misma respuesta que la tarifa (2026-09-17): es la
        // misma pregunta del cliente y el mismo viaje a la base, y asi el agente no puede ofrecerle
        // contraentrega a una ciudad donde el negocio no la hace. Antes eso vivia como prosa en las
        // instrucciones del negocio ("si la ciudad es Bogota o Soacha, ofrece ademas...").
        modalidadesDePago: resolved.paymentModalities.map((m) => ({ code: m, label: SHIPPING_MODALITY_LABELS[m] })),
        note: `No escribas tú el numero: pon la marca ${SHIPPING_BLOCK_MARKER} donde quieras mostrarlo y el sistema la reemplaza por este costo real.`,
      };
    }
    case "get_shipping_payment_modalities": {
      // Con ciudad, las de esa zona; sin ciudad, las del negocio. La zona manda porque la contraentrega
      // casi nunca es una politica del negocio entero (ver ShippingRate.paymentModalities).
      const city = String(input.city ?? "").trim();
      const deLaZona = city ? (await resolveShippingRateForCity(businessId, city))?.paymentModalities ?? null : null;
      let modalities = deLaZona;
      if (!modalities) {
        const business = await prisma.business.findUnique({ where: { id: businessId }, select: { shippingPaymentModalities: true } });
        modalities = business?.shippingPaymentModalities ?? [];
      }
      if (modalities.length === 0) {
        return { modalities: [], note: "Este negocio no configuro modalidades de pago de envio. Segui el flujo generico de pago." };
      }
      return {
        modalities: modalities.map((m) => ({ code: m, label: SHIPPING_MODALITY_LABELS[m] })),
        ...(city && deLaZona ? { note: `Estas son las modalidades que aplican en ${city}. No le ofrezcas otras.` } : {}),
      };
    }
    case "save_customer_name": {
      const name = String(input.name ?? "").trim();
      if (!name) return { error: "Falta el nombre" };

      // UNA FORMA DE PAGO NO ES UN NOMBRE (2026-09-17).
      //
      // Defecto real de produccion: una clienta quedo guardada como "Contraentrega" - la ficha del CRM y
      // la lista de pedidos la mostraban asi, porque las dos leen Customer.name. El bot habia pedido los
      // datos de entrega juntos ("...tu nombre completo, celular, direccion y como prefieres pagar"), la
      // clienta contesto solo "Contraentrega", y el backstop de nombres de agent.ts vio una palabra
      // alfabetica corta despues de un mensaje que decia "nombre completo" y la guardo. Reproducido:
      // extractNameFromAnswer devuelve "Contraentrega", "Nequi" y "Transferencia" como nombres validos.
      //
      // No es una palabra que le falte a una lista: es la clase entera de los valores que pertenecen a
      // OTRO campo del pedido. Por eso la comprobacion no es una lista escrita a mano sino los datos del
      // propio negocio, y por eso vive aca, en la escritura, y no en cada backstop: asi tambien tapa el
      // caso en que el modelo llama la herramienta con el mismo error.
      //
      // Solo formas de pago. Las ciudades quedan afuera a proposito: "Santander", "Bolivar", "Cordoba" y
      // "Narino" son departamentos Y apellidos colombianos reales, asi que rechazarlas romperia nombres
      // legitimos - justo lo contrario de lo que esta etapa viene a arreglar.
      const formasDePago = await listPaymentMethods(businessId);
      if (isExactConfiguredPaymentMethod(name, formasDePago)) {
        return {
          saved: false,
          note: `"${name}" es una de las formas de pago de este negocio, no el nombre de una persona, asi que no se guardo nada. Registra la forma de pago donde va y volve a pedirle el nombre al cliente.`,
        };
      }

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
        ...(Object.keys(rejected).length > 0 ? { rejected, note: "Alguno de los datos no tenia forma valida y no se guardo - pídele al cliente que lo confirme de nuevo." } : {}),
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
      await setHumanControl(businessId, context.conversationId, true, "INTENT_ESCALATION");

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
        const intentAlertText = `${greeting}, el cliente ${customerLabel} reporto ${label}.${inferredNote} El bot dejo de responderle, toma el control tú directamente.`;
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
        note: "La conversacion quedo escalada a un humano. No sigas intentando resolverlo tú mismo: dile al cliente que un asesor lo va a atender directamente.",
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
          note: "No llames ask_owner de nuevo hasta que el dueno responda la pregunta anterior. Dile al cliente honestamente que seguis esperando esa respuesta, y sigue ayudando con cualquier otra cosa que necesite.",
        };
      }

      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (!business?.contactPhone) {
        return {
          asked: false,
          note: "Este negocio no tiene un numero de contacto configurado para escalar preguntas. Dile al cliente que no tienes esa informacion por ahora.",
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
          note: "No se pudo enviar la pregunta al dueno. Dile al cliente que un asesor le va a escribir pronto.",
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
        note: "La pregunta quedo escalada al dueno del negocio - tú sigue atendiendo al cliente con normalidad mientras tanto (otras preguntas, catalogo, lo que necesite). No inventes la respuesta a ESTA pregunta puntual ni digas que ya la tienes: dile que estas confirmando esa info con el equipo y le respondes en breve. Si el cliente insiste en la misma pregunta antes de que el dueno responda, no llames ask_owner de nuevo para lo mismo - dile que segues esperando la respuesta.",
      };
    }
    // EL PRECIO ACORDADO (2026-09-16, seccion 12 del plan). El agente ya preguntaba por el descuento, y eso
    // estaba bien; lo que faltaba era que la respuesta de la duena se volviera DATO. Aca la pregunta sale
    // con las RANURAS adentro: los items exactos y su precio de hoy, escritos por el servidor. El modelo
    // no propone ni acepta ningun numero - elige sobre QUE productos se pregunta, y ni siquiera eso cuando
    // el pedido en curso ya los tiene.
    case "ask_owner_about_price": {
      const openForConversation = await findOpenPendingOwnerQuestionsForConversation(context.conversationId);
      if (openForConversation.length > 0) {
        return {
          error: "Ya hay una pregunta esperando respuesta del dueno en esta conversacion.",
          note: "No vuelvas a preguntar hasta que el dueno responda la anterior. Dile al cliente honestamente que seguis esperando esa respuesta, y sigue ayudando con cualquier otra cosa que necesite.",
        };
      }

      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (!business?.contactPhone) {
        return {
          asked: false,
          note: "Este negocio no tiene un numero de contacto configurado para consultar precios. Dile al cliente que el precio publicado es el que aplica por ahora.",
        };
      }

      // Los productos salen del pedido que el SERVIDOR ya tiene anotado (SaleState.items, que escriben
      // set_order_item y show_order_summary contra el catalogo real). Solo si no hay ninguno se usan los
      // que nombro el modelo, y aun ahi el precio no lo pone el: lo resuelve resolveOrderItems contra la
      // base. En los dos caminos el precio de la ranura es un SELECT.
      const evidencia = await getServerSaleEvidence(context.conversationId);
      const entrada =
        evidencia.items.length > 0
          ? evidencia.items.map((i) => ({ productId: i.productId, variantId: i.variantId ?? undefined, quantity: i.quantity }))
          : Array.isArray(input.items)
            ? (input.items as { productName: string; quantity: number; variantLabel?: string }[])
            : [];
      const { items: precioItems, unresolved, needsAttribute } = await resolveOrderItems(businessId, entrada, context.conversationId);
      if (needsAttribute.length > 0) {
        return {
          asked: false,
          note: `Todavia falta saber el color/talla de: ${needsAttribute.join(", ")}. Preguntaselo al cliente y recien despues consulta el precio.`,
        };
      }
      if (unresolved.length > 0) {
        return {
          asked: false,
          note: `No encontre en el catalogo: ${unresolved.join(", ")}. Confirma el nombre exacto con el cliente antes de consultar el precio.`,
        };
      }
      if (precioItems.length === 0) {
        return {
          asked: false,
          note: "No se dio ningun producto valido. Pregúntale al cliente sobre que producto quiere el descuento antes de consultar.",
        };
      }

      const negocioPrecio = await getBusinessLocale(businessId);
      const slots: PriceSlot[] = precioItems.map((item) => ({
        productId: item.productId,
        variantKey: item.variantId ?? "",
        productName: item.productName,
        variantLabel: item.variantLabel ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        currency: item.currency,
      }));

      const greetingPrecio = business.contactName ? `Hola ${business.contactName}` : "Hola";
      const customerLabelPrecio = await describeCustomer(context.customerId, context.recipientPhone);
      const askPriceText = [
        `${greetingPrecio}, el cliente ${customerLabelPrecio} pide un precio especial para esto:`,
        formatPriceSlotsForOwner(slots, negocioPrecio.locale),
        ownerPriceFormatHint(slots, negocioPrecio.locale),
      ].join("\n\n");

      const askPrice = await sendAlertToOwner(businessId, context.credentials, business.contactPhone, askPriceText);
      const pricewamid = askPrice.delivered ? askPrice.wamid : "";
      await recordOwnerMessage(businessId, {
        direction: "OUT",
        body: askPriceText,
        success: Boolean(pricewamid),
        errorMessage: pricewamid ? null : askPrice.failure?.message ?? "Sin wamid",
      });
      if (!pricewamid) {
        return {
          asked: false,
          note: "No se pudo enviar la consulta al dueno. Dile al cliente que un asesor le va a escribir pronto.",
        };
      }

      await createPendingOwnerQuestion(
        context.conversationId,
        pricewamid,
        `Precio especial para: ${slots.map((s) => s.productName).join(", ")}`,
        "PRICE",
        { items: slots } as unknown as Prisma.InputJsonValue
      );
      await setBlockedBy(context.conversationId, "PENDING_OWNER_QUESTION");

      return {
        asked: true,
        note: "La consulta de precio quedo escalada al dueno. NO le prometas ningun descuento ni le digas un numero al cliente: dile que estas consultando el precio con el equipo y le confirmas en breve. Cuando el dueno confirme, el sistema guarda el precio y se lo avisa al cliente solo. Mientras tanto sigue atendiendo cualquier otra cosa que necesite.",
      };
    }
    case "ask_owner_about_photo": {
      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (!business?.contactPhone) {
        return {
          asked: false,
          note: "Este negocio no tiene un numero de contacto configurado para escalar preguntas. Dile al cliente que no tienes esa informacion por ahora.",
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
          note: "No se pudo contactar al dueno de ninguna forma. Dile al cliente que un asesor le va a escribir pronto.",
        };
      }

      await setHumanControl(businessId, context.conversationId, true, "PHOTO_ESCALATION");
      await createPendingOwnerQuestion(
        context.conversationId,
        wamid,
        "Identificar el producto de la foto/video que mando el cliente",
        "PHOTO_PRODUCT"
      );

      return {
        asked: true,
        note: "La foto/video quedo escalada al dueno para identificar el producto. No sigas adivinando: dile al cliente que estas confirmando con el equipo cual es ese producto exactamente y le respondes en breve.",
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
          note: `No escribas tú los items, el envio ni el TOTAL: pon la marca ${ORDER_SUMMARY_BLOCK_MARKER} donde quieras mostrar el resumen completo (o ${TOTAL_BLOCK_MARKER} si solo necesitas el total suelto) y el sistema la reemplaza por estos numeros reales antes de enviar. Pídele que confirme antes de seguir.`,
        };
      }

      const shippingCost = input.shippingCost !== undefined && input.shippingCost !== null ? Number(input.shippingCost) : 0;
      const { items, unresolved, needsAttribute } = await resolveOrderItems(
        businessId,
        Array.isArray(input.items) ? (input.items as { productName: string; quantity: number; variantLabel?: string }[]) : [],
        // EL PRECIO ACORDADO: el precio de cada linea sale de la base - el que autorizo la duena si
        // existe, el de catalogo si no. Este es el camino por el que el resumen del caso real salia con
        // 75.000 y 70.000 despues de que la duena hubiera dejado los AirPods en 70 y el Alexa en 65.
        context.conversationId
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
        // 2026-09-16: la misma nota que la rama de arriba. Antes esta rama le pedia al modelo COPIAR las
        // cifras, y copiar de memoria es lo que fallo en produccion: en el turno de las 23:03 el resumen
        // salio con los precios de lista aunque la duena ya hubiera autorizado otros. Con la marca, que
        // cifra se escribe deja de ser una decision del modelo en los DOS caminos.
        note: `No escribas tú los items, el envio ni el TOTAL: pon la marca ${ORDER_SUMMARY_BLOCK_MARKER} donde quieras mostrar el resumen completo (o ${TOTAL_BLOCK_MARKER} si solo necesitas el total suelto) y el sistema la reemplaza por estos numeros reales antes de enviar. Pídele que confirme antes de seguir.`,
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
        // 2026-09-16: la etiqueta de la forma de pago la resuelve el SERVIDOR desde el id, igual que
        // src/orders/saleState.ts. Antes close_conversation le pedia al modelo REPRODUCIR DE MEMORIA la
        // cadena exacta de get_payment_methods, y el guard de agent.ts rechazaba el cierre por cualquier
        // variacion razonable ("Nequi (transferencia anticipada del producto)" contra "Nequi"): el
        // cliente leia "el sistema no me deja cerrar la venta automaticamente". Con el id, el modelo
        // queda libre de describirle la forma de pago al cliente con sus palabras.
        // El label sigue aceptado como camino de respaldo (con su guard intacto) para no romper una
        // conversacion en curso en el medio de un despliegue: el id gana cuando viene.
        let paymentMethodId = input.paymentMethodId ? String(input.paymentMethodId).trim() : "";
        let paymentMethodLabel: string | null = null;
        // SaleState manda cuando TIENE forma de pago. Cuando no la tiene, se resuelve igual que con la
        // bandera apagada, en vez de quedar en null.
        //
        // Defecto real de produccion (2026-09-17, conversacion cmu4e3q9l001ozi2ka2x1t1b1): con SaleState
        // prendido, el modelo llamo get_payment_methods y set_shipping_modality pero nunca
        // set_payment_method. La forma de pago quedo en null, requiresPaymentConfirmation no tuvo nada que
        // mirar y devolvio "hay que confirmar" - su respuesta segura - asi que una venta CONTRAENTREGA le
        // pidio confirmacion de pago a la duena a las 5 de la manana, por plata que se cobra al entregar.
        // El aviso hasta decia "Pago Contra Entrega Total" y preguntaba "¿Te llego el pago?" abajo: esa
        // frase salia del texto del modelo, no de una forma de pago resuelta, y por eso la compuerta no la
        // veia.
        //
        // Es la misma dependencia de ORDEN que se saco para los items y quedo viva para el pago. La
        // garantia no se afloja: el id o la etiqueta se resuelven igual contra las formas de pago
        // configuradas del negocio.
        const pagoDeSaleState = saleStateOn ? saleState?.paymentMethodLabel ?? null : null;
        if (pagoDeSaleState) {
          paymentMethodLabel = pagoDeSaleState;
          if (saleState?.paymentMethodId) paymentMethodId = saleState.paymentMethodId;
        } else if (paymentMethodId) {
          // Sin filtro `active`, igual que saleState.ts: si el dueno desactivo el metodo despues de que
          // el cliente lo eligio, la etiqueta sigue siendo real y la venta no tiene por que caerse.
          const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, businessId } });
          if (!method) {
            console.error(
              `close_conversation bloqueado: paymentMethodId inexistente (businessId=${businessId}):`,
              paymentMethodId
            );
            return {
              closed: false,
              note: "Ese paymentMethodId no existe en este negocio - no se cerro nada, no se creo ningun pedido. Volve a llamar get_payment_methods y pasa uno de los id que devuelve.",
            };
          }
          paymentMethodLabel = method.label;
        } else if (input.paymentMethodLabel) {
          // Lo que se guarda es la etiqueta que la duena CARGO, no la que el modelo escribio. "Contra
          // entrega total" y "Contraentrega" son la misma forma de pago; la redaccion del agente vive en
          // el mensaje al cliente y no tiene por que entrar a la base ni a un pedido.
          const configuradas = await listActivePaymentMethods(businessId);
          const resuelta = resolveConfiguredPaymentMethod(String(input.paymentMethodLabel), configuradas);
          if (resuelta) {
            paymentMethodLabel = resuelta.label;
            paymentMethodId = resuelta.id;
          } else {
            paymentMethodLabel = String(input.paymentMethodLabel).trim();
          }
        }
        const shippingCost = saleStateOn
          ? saleState?.shippingCost ?? null
          : input.shippingCost !== undefined && input.shippingCost !== null
            ? Number(input.shippingCost)
            : null;
        // SaleState manda cuando TIENE lineas; vacio, el cierre NO se bloquea y los items se resuelven
        // contra el catalogo igual que con la bandera apagada. Con saleStateEnabled en true el cierre
        // exigia que set_order_item se hubiera llamado ANTES y, si el modelo no lo hizo, la venta no
        // cerraba nunca: por eso encender la bandera dejaba al bot sin cerrar (diagnostico 2026-09-17).
        // Se elimina una decision de ORDEN, no una garantia - resolveOrderItems valida cada linea contra
        // el catalogo y saca el precio de la base, igual que set_order_item.
        const desdeSaleState = saleStateOn ? saleState?.items ?? [] : [];
        const { items, unresolved, needsAttribute } = desdeSaleState.length > 0
          ? { items: desdeSaleState, unresolved: [] as string[], needsAttribute: [] as string[] }
          : await resolveOrderItems(
              businessId,
              Array.isArray(input.items) ? (input.items as { productName: string; quantity: number; variantLabel?: string }[]) : [],
              // Mismo motivo que en show_order_summary: el pedido real que queda guardado lleva el precio
              // acordado, no el de lista. Con saleStateOn los items ya vienen de getSaleState, que aplica
              // el acordado al leer.
              context.conversationId
            );


        // Real production incident (2026-09-12): a sale closed without ever asking the customer's color.
        // Unlike `unresolved` below (which only warns the owner and still closes), this BLOCKS the close -
        // the product exists and matched fine, but which color/size sold is still unknown, and that's not
        // something an owner can fix after the fact from an alert message the way a misspelled name is.
        // Con SaleState esto no puede pasar (set_order_item exige la variante al agregar la linea).
        if (needsAttribute.length > 0) {
          return {
            closed: false,
            note: `Antes de cerrar el pedido todavia falta preguntarle al cliente el color/talla de: ${needsAttribute.join(", ")}. Pregunta cual color o talla quiere de cada uno (muéstrale las opciones reales que tenga ese producto) y volve a llamar close_conversation recien cuando lo tengas.`,
          };
        }

        // Va DESPUES del chequeo de color/talla, y no es casual: un producto con variantes y sin color
        // elegido no entra en `items` (sale por needsAttribute). Con este guard primero, el modelo leeria
        // que ese producto no existe en el catalogo - y se lo diria al cliente.
        // Un pedido sin lineas no es un pedido (produccion 2026-09-17, cmu4suduh001sq92ka4r3j35y: quedo
        // guardada una venta de cero lineas y totalAmount 0). Vale con SaleState prendido o apagado.
        if (items.length === 0) return { closed: false, note: EMPTY_ORDER_NOTE };

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
            note: "Esta conversacion ya tiene un pedido registrado - no se puede cerrar una venta nueva sobre la misma. Si el cliente quiere comprar algo mas, dile que un asesor lo va a confirmar directamente.",
          };
        }

        // No se le pide al dueno que confirme plata que todavia no existe. Con contraentrega no hay nada
        // que verificar antes de despachar: el pedido se crea de una. Lo decide PaymentMethod.settlement,
        // un dato del negocio - ver requiresPaymentConfirmation. Sin metodo identificable devuelve true,
        // que es el comportamiento de siempre.
        const debeConfirmar = await requiresPaymentConfirmation(businessId, {
          paymentMethodId: saleStateOn ? saleState?.paymentMethodId : paymentMethodId,
          paymentMethodLabel,
        });
        // EL COMPROBANTE SE VERIFICA, NO SE PIDE POR PROMPT (2026-09-17). `debeConfirmar` ya significa
        // "el pago de este pedido es por adelantado": con contraentrega es false y esto ni corre, que es
        // exactamente lo que faltaba - hasta hoy la directiva del prompt le pedia al cliente la foto de un
        // pago que todavia no habia ocurrido y frenaba una venta que debia cerrarse sola.
        if (await faltaComprobanteDePago(businessId, context.conversationId, { pagoPorAdelantado: debeConfirmar })) {
          return { closed: false, note: FALTA_COMPROBANTE_NOTE };
        }

        // CUANDO SE PAGA ESTE PEDIDO (2026-09-17, fase 3). Se resuelve con datos - la modalidad declarada
        // validada contra las de la zona, el settlement del metodo elegido, o la unica modalidad posible -
        // y si ninguna de las tres alcanza queda null, que es lo honesto. De ahi sale el monto que el
        // mensajero tiene que cobrar, guardado en el pedido y no deducido despues releyendo el chat.
        //
        // Se resuelve ANTES de la confirmacion porque tambien decide QUE preguntarle al dueno: no es lo
        // mismo "¿te llego el pago?" por el total que por el producto solo.
        const shippingModality = await resolverModalidadDelPedido(businessId, {
          declarada: typeof input.shippingModality === "string" ? input.shippingModality : saleState?.shippingModality,
          cobraAlRecibir: !debeConfirmar,
          // La ciudad que el SERVIDOR resolvio contra sus propias reglas al calcular el envio, no la que
          // el modelo escriba ahora: ver recordShippingCity en get_shipping_rate_for_city.
          city: (await getServerSaleEvidence(context.conversationId))?.shippingCity ?? null,
        });

        const pending = debeConfirmar
          ? await requestSaleConfirmation(
              context,
              // LA PREGUNTA TIENE QUE DECIR CUANTO (2026-09-17). Con "producto por adelantado, envio
              // contraentrega" el dueno recibe el producto solo, no el total, y preguntarle "¿te llego el
              // pago?" al lado de un resumen que dice $154.000 lo hace buscar una transferencia que nunca
              // existio. La linea la compone el servidor con el precio real, y viaja DENTRO del resumen
              // para que los reintentos del perseguidor digan exactamente lo mismo (ver ownerConfirmation).
              lineaDePagoEsperado(shippingModality, items, shippingCost, await getBusinessLocale(businessId)) + summary,
              { items, shippingAddress, paymentMethodLabel, shippingCost }
            )
          : false;
        if (pending) {
          return {
            closed: false,
            pending: true,
            unresolvedItems: unresolved.length > 0 ? unresolved : undefined,
            note: "El dueno del negocio tiene que confirmar el pago primero. No le digas al cliente que su compra quedo confirmada todavia - dile que estas verificando el pago con el equipo.",
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
          shippingModality,
        });
        await askForCsat(context.credentials, order.id, context.recipientPhone);

        // AVISO DE VENTA SIN PAGO PREVIO (2026-09-17). El camino con pago por adelantado ya le escribe al
        // dueno ("¿te llego el pago?"); este no le escribia nada, asi que una venta contraentrega ocurria
        // y el dueno solo se enteraba si entraba al panel. Y es justo la venta en la que tiene algo que
        // hacer: decirle al mensajero cuanto cobrar.
        const negocioDelAviso = await prisma.business.findUnique({
          where: { id: businessId },
          select: { contactPhone: true, contactName: true },
        });
        if (negocioDelAviso?.contactPhone) {
          const cobrar = order.amountOnDelivery === null ? null : Number(order.amountOnDelivery);
          const alerta = [
            `${negocioDelAviso.contactName ? `Hola ${negocioDelAviso.contactName}` : "Hola"}, nueva venta de ${await describeCustomer(context.customerId, context.recipientPhone)}:`,
            summary || "Sin resumen registrado.",
            cobrar === null
              ? "No quedo registrado cuanto hay que cobrar al entregar - revisalo en el panel."
              : `Cobrar al entregar: $${formatPrice(cobrar, order.currency, (await getBusinessLocale(businessId)).locale)}`,
          ].join("\n\n");
          const aviso = await sendAlertToOwner(businessId, context.credentials, negocioDelAviso.contactPhone, alerta);
          if (!aviso.delivered) {
            console.error("No se pudo avisarle al dueno de la venta sin pago previo (no bloqueante):", aviso.failure?.message);
          }
        }
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
          note: "Este pedido ya fue enviado. No lo canceles tú - dile al cliente que necesitas confirmar con el equipo, y usa ask_owner.",
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
