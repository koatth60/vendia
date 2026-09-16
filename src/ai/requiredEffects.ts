import { prisma } from "../db/client";
import { getSaleState, getServerSaleEvidence, type SaleStateItem, type SaleStateSnapshot } from "../orders/saleState";
import { resolveShippingRateForCity } from "../catalog/shippingRates";
import { runCatalogTool, type ToolContext } from "./tools";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { sendAlertToOwner, isBsuid } from "../whatsapp/outbound";
import { formatPrice } from "../config/money";

// EFECTOS REQUERIDOS (2026-09-15).
//
// El problema que resuelve, en una frase: hasta ahora nadie verificaba que el turno hubiera hecho lo que
// su propio texto decia que hizo. Caso real, conversacion cmu3htnp0009y4k2kzxhy9dlz (2026-09-16 UTC): la
// clienta manda la foto del comprobante ($154.000 por Nequi), el turno registra UNA sola fila AiUsageLog
// (o sea, cero llamadas a herramientas), y el bot escribe "estoy validando tu comprobante... confirmando
// con el equipo" tres veces. En la base: PendingOwnerQuestion = 0, OwnerMessageLog = 0, Order = []. La
// clienta pago y la duena nunca se entero.
//
// Por que no alcanza con forzar tool_choice: medido el 2026-09-15 en cmu0ehwqx00076k2k64mjaats (21:56:45
// y 22:35:11), con tool_choice forzado a list_all_products DeepSeek devolvio texto sin tool_calls, una
// sola llamada, e invento productos que no existen. Mismo modelo que en los turnos vecinos donde si
// honro la herramienta. El reintento es necesario, pero no puede ser la unica defensa: de ahi la
// escalera reintento -> fallback por codigo -> escalacion.
//
// POR QUE EL DISPARADOR SE REESCRIBIO (2026-09-15, segunda pasada). La primera version exigia, como
// condicion (b), "venta en curso": pendingOrderSummary/pendingOrderItems, o un SaleState con producto,
// precio y forma de pago. Verificado contra la base de produccion, ninguna de esas tres cosas existia la
// noche de Milena y no podia existir:
//
//   - Aurora Joyas, Boutique Alondra y MAGByLizN tienen saleStateEnabled = false, asi que buildTools ni
//     siquiera le muestra al modelo las saleStateTools: set_order_item/set_payment_method no existen
//     para el y la fila de SaleState queda vacia (items: [], paymentMethodId: null).
//   - pendingOrderSummary/pendingOrderItems los escribe unicamente requestSaleConfirmation, que es parte
//     del cierre que este mecanismo trata de forzar. Exigirlo como condicion previa es circular.
//
// Resultado medido: computeRequiredEffects devolvia lista vacia y no exigia nada. Prender la bandera era
// un placebo. Ahora el disparador se apoya SOLO en lo que escribe el servidor - en el caso de Milena,
// SaleState.mediaSent, que escribe recordMediaSent cuando la foto del producto salio de verdad por
// WhatsApp - y para que eso exista tambien sin la bandera, REGISTRAR el SaleState se separo de EXPONERLO
// (ver el comentario de saveDeliveryDataToSaleState en orders/saleState.ts).
//
// Tampoco puede apoyarse en show_order_summary: en el turno de Milena (02:48:41) hubo UNA sola llamada
// CHAT y cero herramientas; el resumen con producto, precio, envio y forma de pago lo escribio el modelo
// de memoria. Cualquier disparador que dependa de una herramienta que el modelo puede no llamar es
// circular por construccion.
//
// REGLA DE ESTE MODULO: todo lo que se decide aca sale de estado de la base. Nunca de la prosa del
// modelo ni de la del cliente. No hay ni una expresion regular en este archivo, y no se agrega ninguna.

export type RequiredEffectKind =
  // Llego una imagen sobre una conversacion donde el servidor ya registro actividad de venta, pero no
  // hay un pedido resuelto contra el catalogo. El efecto exigido es que la DUENA QUEDE AVISADA, nada
  // mas: la condicion (a) es "llego una imagen" a secas, y nada en la base distingue un comprobante de
  // la foto de un producto sin leer prosa. Crear un pedido automatico sobre una imagen ambigua es un
  // riesgo real y caro; un aviso de mas no cuesta nada.
  | "OWNER_NOTIFIED_ABOUT_IMAGE"
  // El pedido esta realmente resuelto contra el catalogo (motor de venta activo, items con precio y
  // forma de pago). Recien ahi el efecto puede ser el cierre completo.
  | "SALE_REGISTERED_AND_OWNER_NOTIFIED";

export interface RequiredEffect {
  kind: RequiredEffectKind;
  /** Herramienta que produce este efecto - la que se fuerza con tool_choice en el reintento. */
  tool: string;
  /** Por que se exigio. Va al log del turno y al mensaje de sistema del reintento. */
  reason: string;
  /**
   * Momento en que se exigio, o sea el arranque del turno. Sin esto, "la duena quedo avisada" no se
   * puede responder con un SELECT: un aviso de hace tres dias probaria algo que no paso hoy.
   */
  since: Date;
}

/** Lo unico que se mira del mensaje entrante: su tipo de medio. Nunca su texto. */
export interface IncomingMessageFacts {
  mediaType: string | null;
}

interface ConversationFacts {
  businessId: string;
  saleStateEnabled: boolean;
  humanControl: boolean;
  pendingOrderSummary: string | null;
  pendingOrderItems: unknown;
  pendingConfirmationMessageId: string | null;
  hasOrder: boolean;
}

async function readConversationFacts(conversationId: string): Promise<ConversationFacts | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      humanControl: true,
      pendingOrderSummary: true,
      pendingOrderItems: true,
      pendingConfirmationMessageId: true,
      order: { select: { id: true } },
      customer: { select: { businessId: true, business: { select: { saleStateEnabled: true } } } },
    },
  });
  if (!row) return null;
  return {
    businessId: row.customer.businessId,
    saleStateEnabled: row.customer.business.saleStateEnabled,
    humanControl: row.humanControl,
    pendingOrderSummary: row.pendingOrderSummary,
    pendingOrderItems: row.pendingOrderItems,
    pendingConfirmationMessageId: row.pendingConfirmationMessageId,
    hasOrder: Boolean(row.order),
  };
}

/** Lo que el servidor escribio sobre esta conversacion. Ninguna de estas tres cosas la escribe el modelo. */
export interface ServerSaleEvidence {
  /** Items que el servidor resolvio contra el catalogo (set_order_item o show_order_summary). */
  items: SaleStateItem[];
  /** Fotos/videos de producto que SALIERON de verdad por WhatsApp (recordMediaSent). */
  mediaSent: string[];
  /** Ciudad con tarifa real confirmada (get_shipping_rate_for_city con match). */
  shippingCity: string | null;
}

/**
 * ¿El servidor ya registro actividad de venta en esta conversacion? Funcion pura sobre datos ya leidos
 * para poder probarla sin base, misma razon que findHealthIssues en jobs/conversationHealth.ts.
 *
 * `mediaSent` no vacio significa "a este cliente se le presento un producto concreto, y la foto salio de
 * verdad". Es mas debil que un pedido armado, y a proposito: lo unico que habilita es avisarle a la
 * duena, nunca crear un pedido.
 */
export function hasServerSaleEvidence(
  conversation: Pick<ConversationFacts, "pendingOrderSummary" | "pendingOrderItems">,
  evidence: ServerSaleEvidence
): boolean {
  // `pendingOrderItems` es una columna Json anulable: cuando se limpia queda como null JSON, que puede
  // volver del cliente como null o como el literal null. Solo cuenta un objeto de verdad.
  const hasDraft = typeof conversation.pendingOrderItems === "object" && conversation.pendingOrderItems !== null;
  if (conversation.pendingOrderSummary || hasDraft) return true;
  return evidence.items.length > 0 || evidence.mediaSent.length > 0;
}

/**
 * ¿El pedido esta resuelto del todo contra el catalogo? Producto, precio y forma de pago. El precio sale
 * del catalogo (set_order_item lo valida linea por linea), asi que un total > 0 ya significa "hay precio
 * real", no "el modelo dijo un numero". Solo con esto cierto se exige el cierre real en vez del aviso.
 */
export function isSaleFullyResolved(saleState: SaleStateSnapshot | null): boolean {
  if (!saleState) return false;
  return saleState.items.length > 0 && saleState.total > 0 && Boolean(saleState.paymentMethodLabel);
}

/**
 * Los efectos que ESTE turno esta obligado a producir, calculados solo desde estado de la base.
 *
 * Arranca con una sola fila a proposito: declarar un efecto como obligatorio cuando no lo era rompe
 * conversaciones que hoy funcionan bien. La estructura queda lista para mas filas (la de "se envio la
 * foto del producto en alcance" entra despues de la Fase B del plan de catalogo, cuando exista
 * resolveProductScope), pero no se agrega ninguna otra en esta fase.
 */
export async function computeRequiredEffects(
  conversationId: string,
  incomingMessage: IncomingMessageFacts
): Promise<RequiredEffect[]> {
  // (a) el mensaje entrante trae mediaType IMAGE
  if (incomingMessage.mediaType !== "IMAGE") return [];

  const conversation = await readConversationFacts(conversationId);
  if (!conversation) return [];

  // (c) la conversacion no esta en manos de una persona
  if (conversation.humanControl) return [];

  // (d) no existe ya un Order para esta conversacion. Este es el candado de idempotencia: dos fotos
  // seguidas no pueden crear dos pedidos ni dos avisos. La segunda condicion es el mismo candado un paso
  // antes - requestSaleConfirmation deja pendingConfirmationMessageId puesto y el Order recien se crea
  // cuando la duena contesta "si llego", asi que entre esos dos momentos el efecto YA ocurrio aunque no
  // haya Order.
  if (conversation.hasOrder || conversation.pendingConfirmationMessageId) return [];

  // (b) hay evidencia de venta en curso ESCRITA POR EL SERVIDOR
  const evidence = await getServerSaleEvidence(conversationId);
  if (!hasServerSaleEvidence(conversation, evidence)) return [];

  const since = new Date();

  // La distincion va explicita, no implicita: el cierre real solo cuando el negocio lleva el pedido en
  // el motor de venta Y ese pedido esta completo. En cualquier otro caso el efecto es el aviso.
  if (conversation.saleStateEnabled && isSaleFullyResolved(await getSaleState(conversationId))) {
    return [
      {
        kind: "SALE_REGISTERED_AND_OWNER_NOTIFIED",
        tool: "close_conversation",
        reason:
          "el cliente mando una imagen con un pedido ya resuelto contra el catalogo, asi que el pedido tiene que quedar registrado y el dueno avisado antes de responderle",
        since,
      },
    ];
  }

  return [
    {
      kind: "OWNER_NOTIFIED_ABOUT_IMAGE",
      tool: "ask_owner_about_photo",
      reason:
        "el cliente mando una imagen en una conversacion donde ya se le presento un producto, y puede ser un comprobante de pago: el dueno tiene que quedar avisado antes de responderle",
      since,
    },
  ];
}

/**
 * Comprueba contra la base cuales de los efectos exigidos NO ocurrieron. Se llama ANTES de mandar la
 * respuesta: si el efecto falta, el texto del modelo tambien esta mal ("estoy confirmando con el equipo"
 * cuando no se consulto a nadie no debe salir nunca).
 *
 * Devuelve los efectos que faltan (lista vacia = el turno hizo lo que dice que hizo).
 */
export async function verifyRequiredEffects(conversationId: string, effects: RequiredEffect[]): Promise<RequiredEffect[]> {
  if (effects.length === 0) return [];
  const conversation = await readConversationFacts(conversationId);
  if (!conversation) return [];

  // Dos formas validas de que el cierre haya ocurrido, y las dos salen de la base:
  //  - hay Order (negocio sin contactPhone: close_conversation autocierra y crea el pedido), o
  //  - hay pendingConfirmationMessageId (close_conversation le mando "¿Te llego el pago?" al dueno y
  //    quedo esperando su respuesta; ese campo solo se escribe cuando el envio devolvio wamid, o sea
  //    cuando el dueno REALMENTE recibio el aviso - ver requestSaleConfirmation en tools.ts).
  const saleClosed = conversation.hasOrder || Boolean(conversation.pendingConfirmationMessageId);

  const missing: RequiredEffect[] = [];
  for (const effect of effects) {
    if (effect.kind === "SALE_REGISTERED_AND_OWNER_NOTIFIED") {
      if (saleClosed) continue;
      missing.push(effect);
      continue;
    }
    if (effect.kind === "OWNER_NOTIFIED_ABOUT_IMAGE") {
      if (saleClosed || (await ownerWasNotifiedSince(conversationId, effect.since))) continue;
      missing.push(effect);
    }
  }
  return missing;
}

/**
 * ¿Salio un aviso REAL al dueno por esta conversacion desde que arranco el turno? Dos filas posibles, las
 * dos escritas por el servidor en el momento del envio y las dos acotadas a esta conversacion:
 *
 *  - PendingOwnerQuestion: la escriben ask_owner y ask_owner_about_photo, y solo con wamid en mano.
 *  - OwnerMessageLog con success y conversationId: el aviso del fallback de este mismo modulo.
 *
 * El corte por `since` no es cosmetico: sin el, un aviso viejo probaria un efecto de hoy.
 */
async function ownerWasNotifiedSince(conversationId: string, since: Date): Promise<boolean> {
  const pregunta = await prisma.pendingOwnerQuestion.count({ where: { conversationId, createdAt: { gte: since } } });
  if (pregunta > 0) return true;
  const aviso = await prisma.ownerMessageLog.count({
    where: { conversationId, direction: "OUT", success: true, createdAt: { gte: since } },
  });
  return aviso > 0;
}

// Resumen del pedido para el fallback, armado desde la base. Nunca desde la prosa del modelo: eso es
// justamente lo que este mecanismo existe para dejar de hacer.
function buildSaleSummaryFromDb(saleState: SaleStateSnapshot | null, locale: string, fallbackSummary: string | null): string {
  if (!saleState || saleState.items.length === 0) return fallbackSummary ?? "";
  const currency = saleState.items[0].currency;
  const lineas = saleState.items.map((item) => {
    const nombre = item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName;
    return `${item.quantity}x ${nombre} - ${formatPrice(item.unitPrice * item.quantity, currency, locale)}`;
  });
  if (saleState.shippingCost) lineas.push(`Envio: ${formatPrice(saleState.shippingCost, currency, locale)}`);
  lineas.push(`TOTAL: ${formatPrice(saleState.total, currency, locale)}`);
  if (saleState.paymentMethodLabel) lineas.push(`Pago: ${saleState.paymentMethodLabel}`);
  if (saleState.address) lineas.push(`Envio a: ${saleState.address}`);
  return lineas.join("\n");
}

/** Texto FIJO, escrito por nosotros, para cuando el pedido lo cerro el fallback y no el modelo. */
export const FALLBACK_SALE_REGISTERED_TEXT =
  "Listo, ya registré tu pedido y le pasé tu comprobante al equipo para que confirme el pago. Apenas lo confirmen te aviso por acá.";

/**
 * Texto FIJO para cuando el fallback avisó a la dueña pero NO registró ningún pedido. No afirma que haya
 * un pedido creado - porque no lo hay - y no le pide nada mas al cliente.
 */
export const FALLBACK_IMAGE_RECEIVED_TEXT =
  "Recibí tu imagen y ya se la pasé al equipo para que la revise y la confirme. Apenas me confirmen te aviso por acá.";

/** Texto FIJO para cuando no se pudo producir el efecto: no afirma que haya pasado nada. */
export const ESCALATION_TEXT =
  "Recibí tu mensaje. Un asesor del equipo va a continuar por acá contigo en un momento.";

export interface FallbackResult {
  ok: boolean;
  /** Que se hizo, para el incidente y el log del turno. */
  detail: string;
  /** Texto FIJO nuestro para el cliente, si el fallback funciono. Depende de que efecto se produjo. */
  customerText: string | null;
}

/** Como nombrar al cliente en el aviso al dueno. Misma regla de privacidad que describeCustomer en tools.ts. */
function describeCustomerRow(customer: { name: string | null; whatsappProfileName: string | null; phoneNumber: string }): string {
  const nombre = customer.name ?? customer.whatsappProfileName;
  if (!isBsuid(customer.phoneNumber)) {
    return nombre ? `${nombre} (${customer.phoneNumber})` : customer.phoneNumber;
  }
  return nombre ? `${nombre} (sin numero visible, privacidad de WhatsApp activada)` : "un cliente (sin numero visible, privacidad de WhatsApp activada)";
}

/**
 * FALLBACK del efecto OWNER_NOTIFIED_ABOUT_IMAGE: le avisa a la duena por el camino que ya existe
 * (sendAlertToOwner + recordOwnerMessage) con el resumen de lo que el SERVIDOR sabe, y dice
 * explicitamente que llego una imagen que puede ser un comprobante.
 *
 * NO crea el Order a proposito: nada en la base distingue un comprobante de cualquier otra foto, y un
 * pedido inventado sobre una imagen ambigua cuesta mucho mas que un aviso de mas.
 */
async function notifyOwnerAboutImage(context: ToolContext, evidence: ServerSaleEvidence): Promise<FallbackResult> {
  const business = await prisma.business.findUnique({
    where: { id: context.businessId },
    select: { contactPhone: true, contactName: true, currency: true },
  });
  if (!business?.contactPhone) {
    return { ok: false, detail: "El negocio no tiene Telefono de contacto configurado: no hay a quien avisarle.", customerText: null };
  }

  const customer = await prisma.customer.findUnique({
    where: { id: context.customerId },
    select: { name: true, whatsappProfileName: true, phoneNumber: true, idNumber: true, deliveryPhone: true, address: true },
  });
  const locale = context.locale ?? "es-CO";

  const datos: string[] = [];
  if (evidence.mediaSent.length > 0) datos.push(`Productos que ya se le mostraron: ${evidence.mediaSent.join(", ")}.`);
  if (evidence.items.length > 0) {
    const currency = evidence.items[0].currency;
    const lineas = evidence.items.map((i) => {
      const nombre = i.variantLabel ? `${i.productName} (${i.variantLabel})` : i.productName;
      return `${i.quantity}x ${nombre} - ${formatPrice(i.unitPrice * i.quantity, currency, locale)}`;
    });
    datos.push(`Ultimo resumen de pedido mostrado: ${lineas.join("; ")}.`);
  }
  if (evidence.shippingCity) {
    const tarifa = await resolveShippingRateForCity(context.businessId, evidence.shippingCity);
    datos.push(
      tarifa
        ? `Envio confirmado: ${evidence.shippingCity} - ${tarifa.label}, ${formatPrice(Number(tarifa.cost), business.currency, locale)}.`
        : `Ciudad de envio mencionada: ${evidence.shippingCity}.`
    );
  }
  const ficha = [
    customer?.idNumber ? `cedula ${customer.idNumber}` : null,
    customer?.deliveryPhone ? `celular ${customer.deliveryPhone}` : null,
    customer?.address ? `direccion ${customer.address}` : null,
  ].filter(Boolean);
  if (ficha.length > 0) datos.push(`Datos de entrega ya guardados: ${ficha.join(", ")}.`);

  const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
  const customerLabel = customer ? describeCustomerRow(customer) : context.recipientPhone;
  const text = [
    `${greeting}, el cliente ${customerLabel} mando una IMAGEN y el bot no la resolvio. Puede ser un comprobante de pago: hay que revisarla.`,
    datos.length > 0 ? datos.join("\n") : "Todavia no hay datos de pedido registrados en esta conversacion.",
    "El bot NO registro ningun pedido ni confirmo ningun pago. Abri esa conversacion en el panel y revisala vos.",
  ].join("\n\n");

  const alerta = await sendAlertToOwner(context.businessId, context.credentials, business.contactPhone, text);
  await recordOwnerMessage(context.businessId, {
    direction: "OUT",
    body: text,
    success: alerta.delivered,
    errorMessage: alerta.failure?.message ?? null,
    // Con esto el aviso es verificable por conversacion con un SELECT, que es lo que exige la regla de
    // admision del mecanismo (ver ONIX-PLAN-CATALOGO-Y-MEDIOS.md seccion 6).
    conversationId: context.conversationId,
  });
  if (!alerta.delivered) {
    console.error("No se pudo avisar al dueno de la imagen recibida:", alerta.failure?.message);
    return { ok: false, detail: `No se pudo avisar al dueno: ${alerta.failure?.message ?? "sin wamid"}`, customerText: null };
  }
  return { ok: true, detail: "aviso al dueno enviado; no se registro ningun pedido", customerText: FALLBACK_IMAGE_RECEIVED_TEXT };
}

/**
 * FALLBACK del efecto SALE_REGISTERED_AND_OWNER_NOTIFIED: ejecuta la herramienta que falta desde el
 * servidor, con argumentos derivados de la base. Reusa el MISMO camino que usa close_conversation hoy
 * (runCatalogTool -> requestSaleConfirmation -> createOrder); no existe una segunda forma de crear
 * pedidos.
 */
async function registerSaleFromServer(context: ToolContext, effect: RequiredEffect): Promise<FallbackResult> {
  const conversation = await readConversationFacts(context.conversationId);
  if (!conversation) return { ok: false, detail: "La conversacion ya no existe.", customerText: null };

  const saleState = await getSaleState(context.conversationId);
  const locale = context.locale ?? "es-CO";
  const summary = buildSaleSummaryFromDb(saleState, locale, conversation.pendingOrderSummary);

  // Negocio sin SaleState: los items salen del borrador ya persistido (pendingOrderItems), que tambien es
  // estado de la base. Con SaleState activo close_conversation ignora `items` y lee el motor, asi que
  // mandarlos igual no cambia nada.
  const draft = conversation.pendingOrderItems as { items?: { productName?: unknown; quantity?: unknown; variantLabel?: unknown }[] } | null;
  const items = Array.isArray(draft?.items)
    ? draft.items
        .filter((i) => typeof i?.productName === "string" && typeof i?.quantity === "number")
        .map((i) => ({
          productName: String(i.productName),
          quantity: Number(i.quantity),
          ...(typeof i.variantLabel === "string" ? { variantLabel: i.variantLabel } : {}),
        }))
    : [];

  try {
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary,
      ...(items.length > 0 ? { items } : {}),
    })) as { closed?: boolean; pending?: boolean; note?: string; error?: string };

    // No alcanza con que la herramienta no haya tirado: se vuelve a comprobar contra la base, que es lo
    // unico que prueba que el efecto ocurrio.
    const stillMissing = await verifyRequiredEffects(context.conversationId, [effect]);
    if (stillMissing.length === 0) {
      return {
        ok: true,
        detail: result?.pending ? "pedido registrado, esperando la confirmacion del dueno" : "pedido cerrado y registrado",
        customerText: FALLBACK_SALE_REGISTERED_TEXT,
      };
    }
    return {
      ok: false,
      detail: result?.note ?? result?.error ?? "close_conversation corrio pero el efecto sigue sin verse en la base",
      customerText: null,
    };
  } catch (error) {
    console.error("Fallo el fallback por codigo de un efecto requerido:", error);
    return { ok: false, detail: error instanceof Error ? error.message : String(error), customerText: null };
  }
}

/** FALLBACK POR CODIGO. Despacha segun el efecto: el aviso siempre, el cierre solo cuando se exigio. */
export async function runRequiredEffectFallback(context: ToolContext, effect: RequiredEffect): Promise<FallbackResult> {
  if (effect.kind === "SALE_REGISTERED_AND_OWNER_NOTIFIED") return registerSaleFromServer(context, effect);
  if (effect.kind === "OWNER_NOTIFIED_ABOUT_IMAGE") {
    const evidence = await getServerSaleEvidence(context.conversationId);
    const outcome = await notifyOwnerAboutImage(context, evidence);
    if (!outcome.ok) return outcome;
    // Misma regla que arriba: el resultado de la funcion no prueba nada, la base si.
    const stillMissing = await verifyRequiredEffects(context.conversationId, [effect]);
    if (stillMissing.length > 0) {
      return { ok: false, detail: "el aviso al dueno corrio pero el efecto sigue sin verse en la base", customerText: null };
    }
    return outcome;
  }
  return { ok: false, detail: `No hay fallback por codigo para el efecto ${effect.kind}.`, customerText: null };
}

/** Texto del aviso final al dueno cuando ni el reintento ni el fallback lograron el efecto. */
export function escalationOwnerAlertText(kind: RequiredEffectKind): string {
  if (kind === "SALE_REGISTERED_AND_OWNER_NOTIFIED") {
    return "Atencion: un cliente mando un comprobante con un pedido ya armado y el bot no logro registrarlo (ni el modelo ni el cierre automatico). Esa conversacion quedo esperandote en el panel - revisa el pago a mano.";
  }
  return "Atencion: un cliente mando una imagen que puede ser un comprobante de pago y el bot no logro avisarte por el camino normal. Esa conversacion quedo esperandote en el panel - revisala a mano.";
}

// OBSERVABILIDAD. Sin esto no hay forma de saber si el mecanismo sirve, y sobre todo: el contador
// `retryResolved` contra `fallbackUsed` es el numero que decide si en el futuro se puede confiar en el
// reintento (ver la medicion de tool_choice del 2026-09-15 que motivo todo esto).
// El caller real (routes/whatsapp.ts) descarta la respuesta si la conversacion quedo en control humano
// mientras se generaba - esa comprobacion existe para no pisar a una persona que tomo el chat a mano. La
// escalacion de abajo pone humanControl ella misma, asi que sin esta marca su texto neutro se descartaria
// y el cliente que acaba de pagar se quedaria sin ninguna respuesta: exactamente el silencio que este
// mecanismo existe para eliminar. La marca se consume una sola vez, en el mismo proceso y turno.
const escalatedTurns = new Set<string>();

export function markEscalatedTurn(conversationId: string): void {
  escalatedTurns.add(conversationId);
}

/** true si el turno que acaba de generarse escalo por su cuenta (y limpia la marca). */
export function consumeEscalatedTurn(conversationId: string): boolean {
  return escalatedTurns.delete(conversationId);
}

export interface RequiredEffectsTurnLog {
  conversationId: string;
  required: RequiredEffectKind[];
  missingAfterFirstAttempt: RequiredEffectKind[];
  retries: number;
  retryResolved: boolean;
  fallbackUsed: boolean;
  fallbackResolved: boolean;
  escalated: boolean;
}

export const requiredEffectStats = {
  turnsWithRequiredEffects: 0,
  missingAfterFirstAttempt: 0,
  retries: 0,
  retryResolved: 0,
  fallbackUsed: 0,
  fallbackResolved: 0,
  escalated: 0,
};

export function resetRequiredEffectStats(): void {
  requiredEffectStats.turnsWithRequiredEffects = 0;
  requiredEffectStats.missingAfterFirstAttempt = 0;
  requiredEffectStats.retries = 0;
  requiredEffectStats.retryResolved = 0;
  requiredEffectStats.fallbackUsed = 0;
  requiredEffectStats.fallbackResolved = 0;
  requiredEffectStats.escalated = 0;
}

export function recordRequiredEffectsTurn(log: RequiredEffectsTurnLog): void {
  requiredEffectStats.turnsWithRequiredEffects++;
  if (log.missingAfterFirstAttempt.length > 0) requiredEffectStats.missingAfterFirstAttempt++;
  requiredEffectStats.retries += log.retries;
  if (log.retryResolved) requiredEffectStats.retryResolved++;
  if (log.fallbackUsed) requiredEffectStats.fallbackUsed++;
  if (log.fallbackResolved) requiredEffectStats.fallbackResolved++;
  if (log.escalated) requiredEffectStats.escalated++;
  console.log(
    `[efectos-requeridos] conv=${log.conversationId} exigidos=${log.required.join(",") || "-"} ` +
      `faltaban=${log.missingAfterFirstAttempt.join(",") || "-"} reintentos=${log.retries} ` +
      `reintento_alcanzo=${log.retryResolved} fallback=${log.fallbackUsed} fallback_alcanzo=${log.fallbackResolved} escalado=${log.escalated}`
  );
}
