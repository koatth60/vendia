import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { touchCustomerLastContact } from "../crm/customers";
import { getPresignedMediaUrl } from "../media/s3";
import { emitNewMessage, emitNewConversation, emitConversationUpdated, type ConversationRow, type CustomerRow } from "../realtime/events";
import { clearBlockedByIfNoPendingQuestions } from "../orders/saleState";
import { getBusinessLocale } from "../config/businessConfig";

// WhatsApp only allows free-form text/media within 24h of the customer's last message (Meta's
// "customer service window") - past that, only an approved template gets through (error 131047
// otherwise). This is the one place that threshold is defined; everything that needs to know whether a
// conversation can still take a plain message goes through getWindowState below instead of
// re-deriving its own 24h constant.
export const WHATSAPP_WINDOW_HOURS = 24;

export interface WindowState {
  windowOpen: boolean;
  hoursSinceLastCustomerMessage: number | null;
}

// Real incident (2026-09-14): the admin panel composer and the escalation-reminder job both sent
// free-form text 30+ hours after the customer's last message. WhatsApp accepted both (returned a real
// wamid) and only reported the failure later via the async status webhook (error 131047) - so the
// owner saw what looked like two sent messages, and the customer got neither. Checking the window
// BEFORE attempting to send is the only way to catch this ahead of time instead of after the fact.
export async function getWindowState(conversationId: string): Promise<WindowState> {
  const last = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return { windowOpen: false, hoursSinceLastCustomerMessage: null };
  const hoursSinceLastCustomerMessage = (Date.now() - last.createdAt.getTime()) / (60 * 60 * 1000);
  return { windowOpen: hoursSinceLastCustomerMessage <= WHATSAPP_WINDOW_HOURS, hoursSinceLastCustomerMessage };
}

// Cola de salida para la ventana cerrada (ver QueuedOutboundMessage en schema.prisma). Antes, cuando la
// ventana de 24h ya estaba cerrada, el texto real que el equipo queria mandar se descartaba: se mandaba
// una plantilla generica y listo. Aca queda guardado y flushQueuedOutbound lo entrega en cuanto el
// cliente vuelve a escribir, que es exactamente el instante en que WhatsApp reabre la ventana.
export async function queueOutboundMessage(
  businessId: string,
  conversationId: string,
  body: string,
  origin: "PANEL" | "OWNER_ANSWER"
) {
  return prisma.queuedOutboundMessage.create({
    data: { businessId, conversationId, body, origin },
  });
}

// Fase 8, punto 3: recibe businessId y filtra por el. Antes bastaba con el id de una conversacion
// para leer lo que estaba encolado en ella, viniera de donde viniera la llamada - y el id de una
// conversacion no dice de quien es. Con el negocio en el filtro, pedir la cola de una conversacion
// ajena devuelve vacio en vez de datos de otro cliente.
export async function listQueuedOutbound(businessId: string, conversationId: string) {
  return prisma.queuedOutboundMessage.findMany({
    where: { businessId, conversationId, sentAt: null, cancelledAt: null, failedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

// El flush del webhook busca por CLIENTE, no por conversacion: si el dueno deja un mensaje en cola y la
// venta se cierra antes de que el cliente conteste, el siguiente mensaje entrante abre una conversacion
// nueva (getOrCreateOpenConversation excluye SOLD/LOST) y lo encolado quedaria huerfano para siempre.
export async function listQueuedOutboundForCustomer(businessId: string, customerId: string) {
  return prisma.queuedOutboundMessage.findMany({
    where: { businessId, sentAt: null, cancelledAt: null, failedAt: null, conversation: { customerId } },
    orderBy: { createdAt: "asc" },
  });
}

export async function cancelQueuedOutbound(businessId: string, id: string) {
  const { count } = await prisma.queuedOutboundMessage.updateMany({
    where: { id, businessId, sentAt: null, cancelledAt: null, failedAt: null },
    data: { cancelledAt: new Date() },
  });
  return count > 0;
}

export async function markQueuedOutboundSent(id: string) {
  await prisma.queuedOutboundMessage.update({ where: { id }, data: { sentAt: new Date() } });
}

// Cuantas conversaciones de este negocio tienen algo esperando a que el cliente vuelva a escribir -
// alimenta el contador de "Salud del bot" para que esto no sea otra cosa que solo se ve entrando chat
// por chat.
export async function countConversationsWithQueuedOutbound(businessId: string): Promise<number> {
  const rows = await prisma.queuedOutboundMessage.findMany({
    where: { businessId, sentAt: null, cancelledAt: null, failedAt: null },
    select: { conversationId: true },
    distinct: ["conversationId"],
  });
  return rows.length;
}

// Cross-references each message against DeliveryFailure by wamid so the thread can show "no llegó"
// instead of a normal-looking bubble the customer never actually saw - a message can get a real wamid
// (WhatsApp accepted it) and still fail minutes or hours later via the async status webhook, so a
// present whatsappMessageId is not proof of delivery.
async function attachDeliveryFailures<T extends { whatsappMessageId: string | null }>(
  businessId: string,
  messages: T[]
): Promise<(T & { deliveryFailed: boolean; deliveryError: string | null })[]> {
  const wamids = messages.map((m) => m.whatsappMessageId).filter((w): w is string => Boolean(w));
  const failures = wamids.length
    ? await prisma.deliveryFailure.findMany({ where: { businessId, wamid: { in: wamids } } })
    : [];
  const failureByWamid = new Map(failures.map((f) => [f.wamid, f]));
  return messages.map((m) => {
    const failure = m.whatsappMessageId ? failureByWamid.get(m.whatsappMessageId) : undefined;
    return { ...m, deliveryFailed: Boolean(failure), deliveryError: failure?.errorMessage ?? null };
  });
}

// El nombre para MOSTRAR. Precedencia deliberada: primero el autoritativo (lo dijo la clienta o lo
// escribio el dueno), despues el de su perfil de WhatsApp, y el numero solo si no hay ninguno. Vive
// aca y no en el front para que todas las vistas digan lo mismo sin repetir la cadena en cada lugar.
export function customerDisplayName(customer: {
  name: string | null;
  whatsappProfileName: string | null;
  phoneNumber: string;
}): string {
  return customer.name || customer.whatsappProfileName || customer.phoneNumber;
}

export async function getOrCreateCustomer(businessId: string, phoneNumber: string, whatsappProfileName?: string | null) {
  // El nombre de perfil se refresca en CADA mensaje: la persona lo puede cambiar cuando quiera y el
  // valor viejo no sirve. Nunca toca `name` - ese solo lo cambia una persona a proposito.
  const profile = whatsappProfileName?.trim() || undefined;
  return prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId, phoneNumber } },
    update: profile ? { whatsappProfileName: profile } : {},
    create: { businessId, phoneNumber, whatsappProfileName: profile ?? null },
  });
}

export async function getOrCreateOpenConversation(businessId: string, customerId: string) {
  const existing = await prisma.conversation.findFirst({
    where: {
      customerId,
      status: { notIn: ["SOLD", "LOST"] },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    // Fase 9 del plan maestro (2026-09-15): ABANDONED no es un rechazo como LOST, es solo que el cliente
    // dejo de escribir - si vuelve, seguimos usando ESTA conversacion (no una nueva) para no perder el
    // SaleState/carrito que ya tenia armado. El status vuelve a NEW: mostrarla todavia como "Abandonada"
    // en el panel mientras el cliente esta escribiendo de nuevo mentiria. cartRecoverySentAt se limpia
    // para que un abandono posterior pueda volver a mandar la plantilla de recuperacion.
    if (existing.status === "ABANDONED") {
      const reopened = await prisma.conversation.update({
        where: { id: existing.id },
        data: { status: "NEW", cartRecoverySentAt: null },
      });
      return reopened;
    }
    return existing;
  }

  const conversation = await prisma.conversation.create({
    data: { customerId, status: "NEW", contextSummary: await summarizePreviousPurchase(businessId, customerId) },
    include: { customer: true },
  });
  emitNewConversation(businessId, formatConversationRow(conversation));
  return conversation;
}

// Real (2026-09-15): una clienta cerro su compra y minutos despues escribio "Vale gracias". Como su
// conversacion ya estaba en SOLD, eso abrio una conversacion NUEVA y vacia, donde el bot no tenia idea de
// que acababa de comprar - le respondio "¿hay algo más en lo que te pueda ayudar?" como si no se
// conocieran. El panel ya agrupa las conversaciones por cliente; lo que faltaba era que el BOT tambien
// supiera. Se siembra el resumen de contexto con lo minimo para no arrancar de cero: que compro y cuando.
// Una sola frase y solo de lo reciente - no es el historial completo, es el hilo que no hay que soltar.
const PREVIOUS_PURCHASE_WINDOW_DAYS = 7;

async function summarizePreviousPurchase(businessId: string, customerId: string): Promise<string | null> {
  const since = new Date(Date.now() - PREVIOUS_PURCHASE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const order = await prisma.order.findFirst({
    where: { customerId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });
  if (!order) return null;

  const productos = order.items.map((i) => `${i.quantity}x ${i.productName}`).join(", ");
  // Fase 11: la fecha se escribe en el locale y la zona horaria del negocio, no siempre en es-CO. Un
  // pedido de las 23:00 en Ciudad de Mexico no es del dia siguiente.
  const { locale, timezone } = await getBusinessLocale(businessId);
  const cuando = order.createdAt.toLocaleDateString(locale, { day: "numeric", month: "long", timeZone: timezone });
  const estado =
    order.fulfillmentStatus === "SHIPPED"
      ? "ya fue despachado"
      : order.fulfillmentStatus === "CANCELED"
        ? "quedo cancelado"
        : "todavia no ha sido despachado";
  return `Este cliente ya compro con nosotros el ${cuando}: ${productos || "un pedido"} por un total de ${order.totalAmount.toString()} ${order.currency}, y ese pedido ${estado}. No lo trates como un cliente nuevo ni le pidas de nuevo los datos que ya dio, y si escribe por ese pedido respondele sobre el.`;
}

export async function recordMessage(
  businessId: string,
  conversationId: string,
  role: "CUSTOMER" | "ASSISTANT" | "SYSTEM",
  content: string,
  whatsappMessageId?: string,
  media?: { s3Key: string; type: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT"; filename?: string; peaks?: string | null },
  imageAnalysis?: string,
  relatedProductId?: string
) {
  const message = await prisma.message.create({
    data: {
      conversationId,
      role,
      content,
      whatsappMessageId,
      mediaS3Key: media?.s3Key,
      mediaType: media?.type,
      mediaFilename: media?.filename,
      mediaPeaks: media?.peaks ?? undefined,
      imageAnalysis,
      relatedProductId,
    },
  });
  // A CUSTOMER message only counts as "unread" while the bot has stopped answering
  // (humanControl:true - escalated via flag_conversation_intent/ask_owner, or the owner took over
  // manually). While the bot is handling a conversation on its own, every customer message already
  // gets an automatic reply - counting those as needing the owner's attention would make the badge
  // climb on ordinary bot-handled traffic and drown out the conversations that actually need a human.
  const touched = await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
    select: { humanControl: true, unreadCount: true, customerId: true },
  });

  // Recencia a nivel CLIENTE, para que la lista del CRM pueda ordenar y paginar por indice en vez de
  // agrupar conversaciones en memoria (ver Customer.lastContactAt en schema.prisma). Es un UPDATE por
  // id; si falla, el mensaje ya quedo guardado y enviado, asi que no se deja propagar - a lo sumo ese
  // cliente queda un mensaje desactualizado en el orden de la lista.
  try {
    await touchCustomerLastContact(touched.customerId, message.createdAt);
  } catch (error) {
    console.error("No se pudo actualizar lastContactAt del cliente:", error);
  }

  let unreadCount = touched.unreadCount;
  if (role === "CUSTOMER" && touched.humanControl) {
    const bumped = await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: { increment: 1 } },
      select: { unreadCount: true },
    });
    unreadCount = bumped.unreadCount;
  }

  emitNewMessage(
    businessId,
    conversationId,
    touched.customerId,
    {
      id: message.id,
      role: message.role,
      content: message.content,
      mediaUrl: media ? await getPresignedMediaUrl(media.s3Key) : null,
      mediaType: message.mediaType,
      mediaFilename: message.mediaFilename,
      mediaPeaks: message.mediaPeaks,
      createdAt: message.createdAt,
    },
    unreadCount
  );
}

// Fase 7 del plan maestro (2026-09-15): Meta manda sent/delivered/read via el webhook de `statuses`,
// matcheado por whatsappMessageId - antes se descartaba en un console.log y el panel no podia mostrar si
// un mensaje llego. El rank evita que un "sent" que llegue tarde o duplicado pise un "read" mas reciente;
// Meta no garantiza el orden de entrega de los webhooks de estado.
const DELIVERY_STATUS_RANK: Record<"SENT" | "DELIVERED" | "READ", number> = { SENT: 1, DELIVERED: 2, READ: 3 };

// Los estados de Meta llegan fuera de orden con frecuencia (un `sent` tardio despues de un `delivered`).
// El rango evita que un acuse viejo pise uno mejor que ya esta escrito.
function isBetterStatus(current: "SENT" | "DELIVERED" | "READ" | null, next: "SENT" | "DELIVERED" | "READ"): boolean {
  return !current || DELIVERY_STATUS_RANK[current] < DELIVERY_STATUS_RANK[next];
}

/**
 * Un solo camino para el acuse de entrega de Meta, sobre las DOS tablas que guardan un wamid propio:
 *
 *  - `Message`: lo que sale hacia el cliente.
 *  - `OwnerMessageLog`: lo que sale hacia el dueno (avisos, escalaciones, confirmaciones de venta).
 *
 * El segundo faltaba, y era el agujero del caso de Milena (2026-09-16): el acuse de la pregunta
 * "¿Te llego el pago?" llegaba por el webhook, no matcheaba contra ningun `Message` y se descartaba, asi
 * que `delivered: true` (o sea "Meta acepto el envio") era todo lo que se sabia nunca. Un wamid solo
 * puede estar en una de las dos tablas, asi que no hay ambiguedad: se intentan las dos y matchea una.
 */
export async function recordMessageDeliveryStatus(whatsappMessageId: string, status: string): Promise<void> {
  const mapped = status.toUpperCase();
  if (mapped !== "SENT" && mapped !== "DELIVERED" && mapped !== "READ") return;

  const existing = await prisma.message.findUnique({
    where: { whatsappMessageId },
    select: { id: true, deliveryStatus: true },
  });
  if (existing) {
    if (!isBetterStatus(existing.deliveryStatus, mapped)) return;
    await prisma.message.update({
      where: { id: existing.id },
      data: { deliveryStatus: mapped, deliveryStatusAt: new Date() },
    });
    return;
  }

  const ownerMessage = await prisma.ownerMessageLog.findUnique({
    where: { wamid: whatsappMessageId },
    select: { id: true, deliveryStatus: true },
  });
  if (!ownerMessage) return;
  if (!isBetterStatus(ownerMessage.deliveryStatus, mapped)) return;
  await prisma.ownerMessageLog.update({
    where: { id: ownerMessage.id },
    data: { deliveryStatus: mapped, deliveryStatusAt: new Date() },
  });
}

/**
 * El producto de la foto que el cliente CITO, como id y ya verificado contra el catalogo activo de este
 * negocio.
 *
 * Es la version sin prosa de getRelatedProductNameForMessage. El nombre sirve para que la conversacion
 * se lea ("el cliente esta respondiendo a la foto de X"); para DECIDIR de que producto habla el turno
 * hace falta el id, porque un nombre metido en el texto vuelve a pasar por el mismo match por palabras
 * que la vitrina de categoria vino a hacer innecesario. Tocar "Responder" sobre una foto es un gesto tan
 * inequivoco como tocar una fila de una lista interactiva, y resuelve igual: por id, sin adivinar.
 */
export async function getRelatedProductIdForMessage(
  businessId: string,
  whatsappMessageId: string
): Promise<string | null> {
  const message = await prisma.message.findUnique({
    where: { whatsappMessageId },
    select: { relatedProductId: true },
  });
  if (!message?.relatedProductId) return null;
  const product = await prisma.product.findFirst({
    where: { id: message.relatedProductId, businessId, active: true },
    select: { id: true },
  });
  return product?.id ?? null;
}

export async function getRelatedProductNameForMessage(whatsappMessageId: string): Promise<string | null> {
  const message = await prisma.message.findUnique({
    where: { whatsappMessageId },
    select: { relatedProductId: true },
  });
  if (!message?.relatedProductId) return null;
  const product = await prisma.product.findUnique({
    where: { id: message.relatedProductId },
    select: { name: true },
  });
  return product?.name ?? null;
}

export async function updateConversationStatus(
  businessId: string,
  conversationId: string,
  status: "NEW" | "INTERESTED" | "QUOTED" | "NEGOTIATING" | "SOLD" | "LOST"
) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Real production bug (2026-09-13): saveCustomerName/saveCustomerContactInfo/setCustomerTags update
// Customer, not Conversation, so none of them ever emitted conversation:updated the way
// updateConversationStatus/setHumanControl/setConversationIntent do - a name saved mid-conversation never
// reached an already-open admin panel (the sidebar row and chat header kept showing the phone number
// until a full page reload). A customer can have several conversations (see the "group by customer"
// deferral) - emit one row per conversation so every open panel tab for this customer updates.
async function emitConversationRowsForCustomer(businessId: string, customerId: string): Promise<void> {
  const conversations = await prisma.conversation.findMany({
    where: { customerId },
    include: { customer: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  for (const conversation of conversations) {
    emitConversationUpdated(businessId, formatConversationRow(conversation));
  }
}

export async function saveCustomerName(businessId: string, customerId: string, name: string | null) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: { name },
  });
  await emitConversationRowsForCustomer(businessId, customerId);
  return updated;
}

export async function saveCustomerContactInfo(
  businessId: string,
  customerId: string,
  // `address` se sumo el 2026-09-15: la direccion de entrega no tenia donde guardarse. Una clienta
  // mando "Cra 17 # 23-03 villa alegria" y Customer.address seguia vacio - el dato solo sobrevivia como
  // prosa dentro del resumen del pedido, donde no se puede buscar ni exportar ni usar para la guia.
  data: { idNumber?: string; deliveryPhone?: string; address?: string }
) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: {
      ...(data.idNumber ? { idNumber: data.idNumber } : {}),
      ...(data.deliveryPhone ? { deliveryPhone: data.deliveryPhone } : {}),
      ...(data.address ? { address: data.address } : {}),
    },
  });
  await emitConversationRowsForCustomer(businessId, customerId);
  return updated;
}

export async function setCustomerTags(businessId: string, customerId: string, tags: string[]) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: { tags },
  });
  await emitConversationRowsForCustomer(businessId, customerId);
  return updated;
}

export async function setConversationIntent(
  businessId: string,
  conversationId: string,
  intent: "PQR" | "DEVOLUCION" | "NO_RECIBIDO" | "SOLICITA_AGENTE",
  // Fase 9 del plan maestro (2026-09-15): si el cliente lo pidio con sus propias palabras o si el modelo
  // lo dedujo del contexto (ver Conversation.intentExplicit) - null para el caller viejo que todavia no
  // manda este dato, para no fingir certeza que no existe.
  explicit: boolean | null = null
) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { intent, intentExplicit: explicit },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Lets the owner manually dismiss an intent badge from the admin panel once they've resolved it (a
// PQR they already handled, a return already processed, etc.) - before this, flag_conversation_intent
// was the only thing that ever touched this field, so a resolved PQR badge sat on the conversation
// until the whole sales cycle closed. Scoped by businessId via findFirst first (like setHumanControl),
// unlike setConversationIntent above which trusts a caller-supplied conversationId alone - this is a
// new admin-panel-triggered action, so it gets the safer check from the start.
export async function clearConversationIntent(businessId: string, conversationId: string) {
  const existing = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
  });
  if (!existing) return null;
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { intent: null, intentExplicit: null },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

/**
 * Por que esta conversacion pasa (o vuelve) a manos de una persona. Ver HumanControlReason en el esquema.
 *
 * Es obligatorio al TOMAR el control: la pregunta "¿por que se calló el bot solo?" no se puede contestar
 * con un SELECT si nadie escribio el motivo, y seis de los diez caminos que toman el control no los
 * dispara ningun clic.
 */
export type HumanControlReasonValue =
  | "PANEL_TOGGLE"
  | "PANEL_MESSAGE"
  | "PANEL_TEMPLATE"
  | "PANEL_QUEUE"
  | "INTENT_ESCALATION"
  | "PHOTO_ESCALATION"
  | "OWNER_QUESTION_TIMEOUT"
  | "SALE_CONFIRMATION_TIMEOUT"
  | "STALE_REPLY"
  | "REQUIRED_EFFECT";

export async function setHumanControl(
  businessId: string,
  conversationId: string,
  active: boolean,
  reason?: HumanControlReasonValue
) {
  const existing = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
  });
  if (!existing) return null;
  // Real incident 2026-09-14 (conversacion 573133260330): la duena estaba chateando a mano con el
  // cliente y el bot le metia "Ya te leimos, en un momento te contesta el equipo directamente" entre
  // sus propios mensajes, una y otra vez. Cada mensaje manual del panel llama a setHumanControl(true),
  // y esto limpiaba humanControlAckSent SIEMPRE - asi que una duena que estaba demostrablemente ahi,
  // respondiendo, re-armaba el aviso de "ya te contestamos" en cada turno. El acuse es uno solo por
  // PAUSA, no por mensaje: solo se reinicia en una transicion real false->true (o al devolverle el
  // control al bot, para que la proxima pausa tenga el suyo).
  //
  // El reloj del watchdog (humanControlSince/stalledReminder*) SI se re-arma en cada llamada, y eso es
  // deliberado - ver findStalledConversationsDueForReminder: mide desde el ultimo mensaje del cliente,
  // no desde aca, y necesita saber que el humano volvio a engancharse.
  const keepAck = active && existing.humanControl;
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      humanControl: active,
      // El motivo se conserva mientras dure la pausa: un mensaje del panel encima de una escalacion del
      // bot no puede reescribir la historia de quien la empezo. Al devolver el control queda en null.
      humanControlReason: active ? (existing.humanControl ? existing.humanControlReason : (reason ?? null)) : null,
      humanControlAckSent: keepAck ? existing.humanControlAckSent : false,
      humanControlSince: active ? new Date() : null,
      stalledReminderStage: 0,
      stalledReminderSentAt: null,
    },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Called only when the OWNER manually takes control from the admin panel (not when the bot itself
// auto-escalates via flag_conversation_intent, which sets this same "pide agente" badge in the same
// breath - clearing it there would erase the flag the bot just set). The badge has done its job once a
// human is actually handling it; if the customer asks for an agent again later, the bot sets it right
// back via set_conversation_intent.
export async function clearAgentRequestFlag(businessId: string, conversationId: string) {
  await prisma.conversation.updateMany({
    where: { id: conversationId, customer: { businessId }, intent: "SOLICITA_AGENTE" },
    data: { intent: null },
  });
}

export async function findConversationByPendingConfirmation(pendingConfirmationMessageId: string) {
  return prisma.conversation.findUnique({
    where: { pendingConfirmationMessageId },
    include: { customer: true },
  });
}

// Limpia TODO el estado de la confirmacion, no solo el wamid: si quedara `pendingConfirmationAskedAt`,
// el perseguidor seguiria insistiendo por una venta que el dueno ya contesto.
export async function clearPendingConfirmation(conversationId: string) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      pendingConfirmationMessageId: null,
      pendingOrderSummary: null,
      pendingOrderItems: Prisma.JsonNull,
      pendingConfirmationAskedAt: null,
      pendingConfirmationRemindedAt: null,
      pendingConfirmationAttempts: 0,
      pendingConfirmationChannel: null,
      pendingConfirmationButtonsQueued: false,
    },
  });
}

export async function createPendingOwnerQuestion(
  conversationId: string,
  wamid: string,
  question: string,
  kind: "TEXT" | "PHOTO_PRODUCT" | "PRICE" = "TEXT",
  // Las ranuras que el servidor espera llenar con la respuesta (ver PendingOwnerQuestion.payload en
  // schema.prisma). Solo las preguntas de precio la usan hoy; TEXT y PHOTO_PRODUCT la dejan en NULL.
  payload?: Prisma.InputJsonValue
) {
  await prisma.pendingOwnerQuestion.create({
    data: { conversationId, wamid, question, kind, ...(payload === undefined ? {} : { payload }) },
  });
}

/**
 * Reescribe una pregunta abierta sin resolverla. Lo necesita la pregunta de PRECIO, que tiene dos pasos:
 * el dueno responde con los numeros y el servidor le devuelve la propuesta ya formateada para que la
 * confirme. Ese segundo mensaje tiene su propio wamid, asi que citarlo tiene que seguir resolviendo a la
 * misma fila. Nada se escribe en AgreedPrice hasta la confirmacion.
 */
export async function updatePendingOwnerQuestion(
  questionId: string,
  data: { wamid?: string; payload?: Prisma.InputJsonValue }
) {
  await prisma.pendingOwnerQuestion.update({
    where: { id: questionId },
    data: {
      ...(data.wamid === undefined ? {} : { wamid: data.wamid }),
      ...(data.payload === undefined ? {} : { payload: data.payload }),
    },
  });
}

export async function findConversationByPendingOwnerQuestion(wamid: string) {
  const pending = await prisma.pendingOwnerQuestion.findUnique({
    where: { wamid },
    include: { conversation: { include: { customer: true } } },
  });
  if (!pending) return null;
  return {
    questionId: pending.id,
    question: pending.question,
    kind: pending.kind,
    payload: pending.payload,
    conversationId: pending.conversationId,
    customer: pending.conversation.customer,
  };
}

export async function clearPendingOwnerQuestion(questionId: string) {
  const pending = await prisma.pendingOwnerQuestion.delete({ where: { id: questionId } });
  await clearBlockedByIfNoPendingQuestions(pending.conversationId);
}

// Marcar resuelta a mano desde el panel (Bot > Salud), para el caso que clearPendingOwnerQuestion
// no cubre: el dueño ya resolvió la pregunta por fuera del panel (por telefono, en persona) y solo
// quiere sacarla de la lista, sin tener que escribirle algo al cliente para que se limpie sola.
// Scoped por businessId - a diferencia de clearPendingOwnerQuestion (uso interno, ya confia en el
// llamador), este lo expone un endpoint HTTP y necesita el chequeo de que la pregunta es de este
// negocio antes de borrarla.
export async function resolvePendingOwnerQuestion(businessId: string, questionId: string): Promise<boolean> {
  const pending = await prisma.pendingOwnerQuestion.findFirst({
    where: { id: questionId, conversation: { customer: { businessId } } },
    select: { id: true, conversationId: true },
  });
  if (!pending) return false;
  await prisma.pendingOwnerQuestion.delete({ where: { id: pending.id } });
  await clearBlockedByIfNoPendingQuestions(pending.conversationId);
  return true;
}

// Only the WhatsApp-reply path (quoting the alert, or the single-pending fallback) ever cleared a
// PendingOwnerQuestion - an owner who instead resolves it by typing directly into the admin panel's
// conversation view left the row open indefinitely, remindedAt still null. Harmless while the reminder
// job's own bug meant it almost never fired (see findPendingOwnerQuestionsDueForReminder) - once that got
// fixed (2026-09-12) this orphaned row was exactly what let a real, already-resolved conversation get a
// confusing "seguimos revisando" follow-up hours later. Called wherever the owner addresses a conversation
// through the admin panel instead of WhatsApp.
export async function clearPendingOwnerQuestionsForConversation(conversationId: string) {
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId } });
  await clearBlockedByIfNoPendingQuestions(conversationId);
}

// Used when the owner replies WITHOUT quoting a specific message (common on mobile, where long-pressing
// to reply is easy to skip) - lets the webhook auto-resolve the reply only when there's exactly one
// thing open for that business, instead of always demanding a quote even when there's nothing to
// disambiguate.
export async function findOpenPendingOwnerQuestionsForBusiness(businessId: string) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: { conversation: { customer: { businessId } } },
    include: { conversation: { include: { customer: true } } },
    orderBy: { createdAt: "desc" },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    kind: p.kind,
    payload: p.payload,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

// Correccion Fase 4 del plan maestro (2026-09-15): la pregunta REAL, no solo el marcador blockedBy -
// generateReply (agent.ts) la usa para decirle al modelo que ya la escaló en vez de dejarlo prometer
// de nuevo, y runCatalogTool (ask_owner en tools.ts) la usa para negarse a abrir una segunda mientras
// esta siga sin respuesta.
export async function findOpenPendingOwnerQuestionsForConversation(conversationId: string) {
  return prisma.pendingOwnerQuestion.findMany({
    where: { conversationId },
    select: { question: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Las confirmaciones de venta vivas de un negocio: las que ya se le preguntaron al dueno y siguen sin
 * respuesta.
 *
 * Lo vivo lo marca `pendingConfirmationAskedAt`, NO el wamid. Esa distincion es el punto: cuando los
 * tres escalones de envio fallan no hay wamid y la confirmacion existe igual - antes esas desaparecian
 * de esta consulta y nadie las volvia a mirar nunca. El wamid sigue siendo la clave para matchear la
 * respuesta citada del dueno, que es otra cosa.
 *
 * Una sola consulta para los tres usos (handleOwnerReply cuando el dueno responde sin citar, el
 * perseguidor de jobs/escalationReminder.ts, y el panel), acotada con `filter`:
 *   - `dueBefore`: ya le toca el proximo reintento (ver pendingConfirmationNextAttemptAt, que lo escribe
 *     ownerConfirmation.ts con espaciado creciente; con cadencia fija alcanzaba comparar contra la fecha
 *     del ultimo aviso, con espaciado creciente el intervalo depende del numero de intento).
 *   - `askedBefore`: la pregunta original es mas vieja que eso -> vencio.
 */
export async function findOpenPendingConfirmationsForBusiness(
  businessId: string,
  filter?: { dueBefore?: Date; askedBefore?: Date }
) {
  const where: Prisma.ConversationWhereInput = {
    customer: { businessId },
    pendingConfirmationAskedAt: filter?.askedBefore ? { lte: filter.askedBefore } : { not: null },
  };
  if (filter?.dueBefore) {
    where.pendingConfirmationNextAttemptAt = { lte: filter.dueBefore };
  }
  return prisma.conversation.findMany({
    where,
    include: { customer: true },
    orderBy: { pendingConfirmationAskedAt: "asc" },
  });
}

// Correccion Fase 4 del plan maestro (2026-09-15), causa raiz C2: blockedBy no tenia salida si el
// dueno nunca respondia - la conversacion quedaba muda para siempre. jobs/escalationReminder.ts usa
// esto para encontrar, por negocio, las preguntas que ya superaron Business.ownerQuestionTimeoutHours
// (a diferencia de findPendingOwnerQuestionsDueForReminder, no filtra por remindedAt: un recordatorio
// ya mandado no evita el timeout).
export async function findPendingOwnerQuestionsPastTimeout(businessId: string, olderThan: Date) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: {
      conversation: { customer: { businessId }, status: { notIn: ["SOLD", "LOST", "ABANDONED"] } },
      createdAt: { lte: olderThan },
    },
    include: { conversation: { include: { customer: true } } },
    orderBy: { createdAt: "asc" },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    kind: p.kind,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

// Escalations the owner never answered - one reminder per question (remindedAt gates it so the
// reminder job doesn't re-send every tick), independent of the sale follow-up job above.
export async function findPendingOwnerQuestionsDueForReminder(businessId: string, olderThan: Date) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: {
      // Must still be an open conversation - a real orphaned row from a 2026-09-11 migration backfill
      // (see that migration's SQL) triggered a false reminder in production for a conversation that had
      // already closed a sale hours earlier, reminding about a question that isn't actually blocking
      // anything anymore. This used to be gated on humanControl:true instead, but that's wrong for the
      // majority of pending questions: plain ask_owner deliberately leaves humanControl false (the bot
      // keeps chatting about everything else while that one question is escalated, see tools.ts), so the
      // humanControl gate silently excluded almost every ask_owner reminder and only ever fired for
      // ask_owner_about_photo (the one case that does set humanControl). status is the real "still open"
      // signal regardless of which escalation path set it.
      conversation: { customer: { businessId }, status: { notIn: ["SOLD", "LOST", "ABANDONED"] } },
      remindedAt: null,
      createdAt: { lte: olderThan },
    },
    include: { conversation: { include: { customer: true } } },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    kind: p.kind,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

export async function markPendingOwnerQuestionReminded(questionId: string) {
  await prisma.pendingOwnerQuestion.update({
    where: { id: questionId },
    data: { remindedAt: new Date() },
  });
}

// Lives here, not next to the job that sends it, because the stalled-conversation query below has to be
// able to tell it apart from a real reply: it's an ASSISTANT message like any other, but it answers
// nothing, so it must not count as "the business already responded".
export const CUSTOMER_FOLLOWUP_TEXT = "Seguimos revisando tu consulta con el equipo, en un momento te confirmamos por aqui 🙏";

export type StalledConversation = {
  conversationId: string;
  customer: { id: string; name: string | null; whatsappProfileName: string | null; phoneNumber: string };
  intent: string | null;
  // Fase 9: null para conversaciones estancadas por PendingOwnerQuestion (no aplica) o por una fila
  // anterior a esta fase (nunca se le pregunto al modelo) - ver Conversation.intentExplicit.
  intentExplicit: boolean | null;
  nextStage: 1 | 2;
  openQuestion: string | null;
};

// Generalizes escalation reminders beyond ask_owner/ask_owner_about_photo (the only two paths that create
// a PendingOwnerQuestion): flag_conversation_intent and a manual panel takeover both set humanControl:true
// with no question row at all, so findPendingOwnerQuestionsDueForReminder above never sees them - a
// conversation escalated that way could go silent forever with nobody reminded. This watches the last
// message instead (the customer must be the one waiting - see the loop below), and stages the escalation
// (fires once at stage1Before, once more at stage2Before, then caps) so a still-unanswered conversation
// gets progressively louder instead of exactly one reminder for its entire life.
//
// A conversation that DOES have a PendingOwnerQuestion is deliberately left to that dedicated mechanism for
// its first reminder (same 3h-class threshold, already reminds with the actual question text) - only
// picked up here for the second/final nudge at stage2Before, so the two mechanisms never both fire for the
// same conversation in the same run.
export async function findStalledConversationsDueForReminder(
  businessId: string,
  stage1Before: Date,
  stage2Before: Date
): Promise<StalledConversation[]> {
  const candidates = await prisma.conversation.findMany({
    where: {
      customer: { businessId },
      humanControl: true,
      status: { notIn: ["SOLD", "LOST", "ABANDONED"] },
      humanControlSince: { not: null },
      OR: [{ stalledReminderStage: 0 }, { stalledReminderStage: 1, stalledReminderSentAt: { lte: stage1Before } }],
    },
    // 5 is enough to walk back past our own follow-ups (deduped to one per conversation per run) to the
    // last thing that was actually said.
    include: { customer: true, pendingOwnerQuestions: true, messages: { orderBy: { createdAt: "desc" }, take: 5 } },
  });

  const result: StalledConversation[] = [];
  for (const c of candidates) {
    // Nobody is waiting on the business unless the CUSTOMER spoke last, and the wait starts at that
    // message - not at humanControlSince. Real incident 2026-09-14: the owner answered from the panel and
    // asked the customer a question back; every panel message calls setHumanControl(true), which re-armed
    // humanControlSince, so her own reply is what scheduled a "seguimos revisando" to the customer minutes
    // later - while the conversation was actually waiting on HIM.
    let waitingSince: Date | null = null;
    for (const m of c.messages) {
      if (m.role === "CUSTOMER") {
        waitingSince = m.createdAt;
        break;
      }
      // Our own nudge answers nothing, so it must not read as a reply - otherwise it would silence the
      // 24h stage-2 reminder for exactly the conversations that need it most (owner never answered, and
      // the customer has been sitting on that canned line ever since).
      if (m.role === "ASSISTANT" && m.content !== CUSTOMER_FOLLOWUP_TEXT) break;
    }
    if (!waitingSince) continue;

    const hasQuestionThisEscalation = c.pendingOwnerQuestions.some((q) => q.createdAt >= c.humanControlSince!);
    if (c.stalledReminderStage === 0) {
      if (!hasQuestionThisEscalation && waitingSince <= stage1Before) {
        result.push({ conversationId: c.id, customer: c.customer, intent: c.intent, intentExplicit: c.intentExplicit, nextStage: 1, openQuestion: null });
      } else if (waitingSince <= stage2Before) {
        const openQuestion = c.pendingOwnerQuestions.find((q) => !q.remindedAt)?.question ?? c.pendingOwnerQuestions[0]?.question ?? null;
        result.push({ conversationId: c.id, customer: c.customer, intent: c.intent, intentExplicit: c.intentExplicit, nextStage: 2, openQuestion });
      }
    } else if (c.stalledReminderStage === 1 && c.stalledReminderSentAt! <= stage2Before) {
      result.push({ conversationId: c.id, customer: c.customer, intent: c.intent, intentExplicit: c.intentExplicit, nextStage: 2, openQuestion: null });
    }
  }
  return result;
}

export async function markStalledReminderSent(conversationId: string, stage: 1 | 2) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { stalledReminderStage: stage, stalledReminderSentAt: new Date() },
  });
}

export type IntentEscalationTimeout = {
  conversationId: string;
  customer: { id: string; name: string | null; whatsappProfileName: string | null; phoneNumber: string };
  intent: string | null;
  intentExplicit: boolean | null;
};

// Fase 9 del plan maestro (2026-09-15): findStalledConversationsDueForReminder de arriba ya avisa al
// dueno dos veces (a las Business.ownerReminderMinutes y de nuevo a las 24h) cuando flag_conversation_intent
// dejo una conversacion muda esperandolo - pero si nunca responde, esa conversacion queda humanControl:true
// para siempre. Mismo patron de escape que findPendingOwnerQuestionsPastTimeout mas abajo (ask_owner): pasadas
// Business.intentEscalationTimeoutHours sin que humanControlSince se refresque (el dueno nunca respondio
// desde el panel - cada mensaje suyo lo refresca, ver setHumanControl), el bot recupera el control solo.
// `intent: { not: null }` es justamente lo que distingue este origen de una toma de control manual (esa
// deja intent en null) y de ask_owner (ese no toca intent en absoluto, usa PendingOwnerQuestion).
export async function findFlagIntentEscalationsPastTimeout(
  businessId: string,
  timeoutBefore: Date
): Promise<IntentEscalationTimeout[]> {
  const conversations = await prisma.conversation.findMany({
    where: {
      customer: { businessId },
      humanControl: true,
      intent: { not: null },
      status: { notIn: ["SOLD", "LOST", "ABANDONED"] },
      humanControlSince: { lte: timeoutBefore },
    },
    include: { customer: true },
  });
  return conversations.map((c) => ({
    conversationId: c.id,
    customer: c.customer,
    intent: c.intent,
    intentExplicit: c.intentExplicit,
  }));
}

export type AbandonedConversationCandidate = {
  id: string;
  customer: { id: string; name: string | null; whatsappProfileName: string | null; phoneNumber: string };
};

// Fase 9 del plan maestro (2026-09-15), causa raiz C1+eje 18: el 61% de las conversaciones NEW no cerraba
// nunca y no contaba como perdida - esta es la consulta que jobs/abandonment.ts usa para encontrarlas.
// Mide por el ULTIMO MENSAJE DEL CLIENTE, no por Conversation.updatedAt: ese campo lo tocan tambien los
// jobs de recordatorio (stalledReminderSentAt, etc), asi que una conversacion que el propio sistema
// sigue "tocando" nunca se veria vieja aunque el cliente lleve semanas en silencio. groupBy en vez de una
// consulta por conversacion (como getWindowState) porque esto corre sobre TODAS las conversaciones
// abiertas de un negocio, potencialmente miles en el caso que motivo esta fase.
export async function findConversationsDueForAbandonment(
  businessId: string,
  olderThan: Date
): Promise<AbandonedConversationCandidate[]> {
  const candidates = await prisma.conversation.findMany({
    where: { customer: { businessId }, status: { notIn: ["SOLD", "LOST", "ABANDONED"] } },
    select: { id: true, createdAt: true, customer: true },
  });
  if (candidates.length === 0) return [];

  const lastCustomerMessages = await prisma.message.groupBy({
    by: ["conversationId"],
    where: { conversationId: { in: candidates.map((c) => c.id) }, role: "CUSTOMER" },
    _max: { createdAt: true },
  });
  const lastByConversation = new Map(lastCustomerMessages.map((m) => [m.conversationId, m._max.createdAt!]));

  return candidates
    .filter((c) => (lastByConversation.get(c.id) ?? c.createdAt) <= olderThan)
    .map((c) => ({ id: c.id, customer: c.customer }));
}

export async function markConversationAbandoned(businessId: string, conversationId: string) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "ABANDONED" },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Solo las que ya estan ABANDONED y con la plantilla sin mandar - deliberadamente separada de
// findConversationsDueForAbandonment de arriba (esa decide el status, esta decide el reintento del
// envio) para que un fallo de entrega (rate limit, plantilla no aprobada) se reintente en la proxima
// pasada del job sin volver a re-evaluar inactividad, igual que findConversationsDueForFollowUp.
export async function findConversationsDueForCartRecovery(businessId: string) {
  return prisma.conversation.findMany({
    where: { customer: { businessId }, status: "ABANDONED", cartRecoverySentAt: null },
    include: { customer: true },
  });
}

export async function markCartRecoverySent(conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { cartRecoverySentAt: new Date() },
  });
}

export async function findConversationsDueForFollowUp(businessId: string, olderThan: Date) {
  return prisma.conversation.findMany({
    where: {
      customer: { businessId },
      status: "SOLD",
      followUpSentAt: null,
      updatedAt: { lte: olderThan },
    },
    include: { customer: true },
  });
}

export async function markFollowUpSent(conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { followUpSentAt: new Date() },
  });
}

export async function wasWhatsappMessageProcessed(whatsappMessageId: string): Promise<boolean> {
  const existing = await prisma.message.findUnique({ where: { whatsappMessageId } });
  return existing !== null;
}

export async function getRecentHistory(conversationId: string, limit = 20) {
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const ordered = messages.reverse();

  return Promise.all(
    ordered.map(async (m) => ({
      ...m,
      mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
    }))
  );
}

// Shared row shape for the conversations sidebar - used both by the REST list endpoint and by the
// realtime conversation:new/conversation:updated emits, so the two never drift apart.
function formatConversationRow(c: {
  id: string;
  status: string;
  intent: string | null;
  humanControl: boolean;
  updatedAt: Date;
  unreadCount: number;
  customer: { id: string; phoneNumber: string; name: string | null; whatsappProfileName: string | null; tags: string[] };
  messages?: { role: string; content: string; mediaType: string | null; createdAt: Date }[];
}): ConversationRow {
  return {
    id: c.id,
    status: c.status,
    intent: c.intent,
    humanControl: c.humanControl,
    updatedAt: c.updatedAt,
    unreadCount: c.unreadCount,
    customer: {
      id: c.customer.id,
      phoneNumber: c.customer.phoneNumber,
      name: c.customer.name,
      displayName: customerDisplayName(c.customer),
      tags: c.customer.tags,
    },
    lastMessage: formatLastMessagePreview(c.messages?.[0]),
  };
}

// Shared by formatConversationRow and formatCustomerRow so the sidebar preview text (media captions
// included) never drifts between the per-conversation and per-customer row shapes.
function formatLastMessagePreview(last?: { role: string; content: string; mediaType: string | null; createdAt: Date }) {
  if (!last) return null;
  return {
    role: last.role,
    content:
      last.mediaType === "IMAGE"
        ? last.content || "📷 Imagen"
        : last.mediaType === "VIDEO"
          ? last.content || "🎥 Video"
          : last.content,
    createdAt: last.createdAt,
  };
}

export async function listConversationsForBusiness(businessId: string) {
  const conversations = await prisma.conversation.findMany({
    where: { customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });

  return conversations.map(formatConversationRow);
}

export async function getConversationForBusiness(businessId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!conversation) return null;

  // Opening a conversation in the admin panel IS reading it - reset the unread badge here as a side
  // effect of the fetch, instead of a separate "mark as read" round trip the frontend would have to
  // remember to call. Emit so other open admin tabs/devices for this business see the badge clear too.
  if (conversation.unreadCount > 0) {
    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
      include: { customer: true },
    });
    emitConversationUpdated(businessId, formatConversationRow(updated));
    conversation.unreadCount = 0;
  }

  const windowState = await getWindowState(conversationId);
  const messagesWithMedia = await Promise.all(
    conversation.messages.map(async (m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
      mediaType: m.mediaType,
      mediaFilename: m.mediaFilename,
      mediaPeaks: m.mediaPeaks,
      whatsappMessageId: m.whatsappMessageId,
    }))
  );

  return {
    id: conversation.id,
    status: conversation.status,
    intent: conversation.intent,
    humanControl: conversation.humanControl,
    // Para que el panel pueda decir POR QUE quedo en manos de una persona en vez de solo que lo esta.
    humanControlReason: conversation.humanControlReason,
    humanControlSince: conversation.humanControlSince,
    updatedAt: conversation.updatedAt,
    unreadCount: conversation.unreadCount,
    windowOpen: windowState.windowOpen,
    hoursSinceLastCustomerMessage: windowState.hoursSinceLastCustomerMessage,
    queuedOutbound: await listQueuedOutbound(businessId, conversationId),
    customer: {
      id: conversation.customer.id,
      phoneNumber: conversation.customer.phoneNumber,
      name: conversation.customer.name,
      displayName: customerDisplayName(conversation.customer),
      tags: conversation.customer.tags,
    },
    messages: await attachDeliveryFailures(businessId, messagesWithMedia),
  };
}

// Groups a customer's Conversation rows into one row for the admin panel's Conversaciones list (see
// [[onix-conversations-group-by-customer]]) - the data model is unchanged (still one Conversation per
// sales cycle, Order.conversationId stays @unique), this only changes what the LIST shows. `conversations`
// must already be sorted updatedAt desc and belong to a single customer - conversations[0] (`mostRecent`)
// still decides the fallback `active` cycle when todos son SOLD/LOST, pero el mensaje/hora que se
// muestran en la fila se calculan aparte, por el createdAt real de los mensajes (ver más abajo) - no
// por conversations[0], que puede no ser la conversación con la actividad más reciente de verdad.
function formatCustomerRow(
  conversations: {
    id: string;
    customerId: string;
    status: string;
    intent: string | null;
    humanControl: boolean;
    updatedAt: Date;
    unreadCount: number;
    customer: { id: string; phoneNumber: string; name: string | null; whatsappProfileName: string | null; tags: string[] };
    messages?: { role: string; content: string; mediaType: string | null; createdAt: Date }[];
  }[]
): CustomerRow {
  const mostRecent = conversations[0];
  const active = conversations.find((c) => c.status !== "SOLD" && c.status !== "LOST") ?? mostRecent;
  const unreadCount = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
  // One Order per SOLD conversation (Order.conversationId is @unique) - counting SOLD conversations is
  // exactly counting this customer's completed orders, with no extra join.
  const orderCount = conversations.filter((c) => c.status === "SOLD").length;

  // El mensaje (y la hora) de la fila son el mensaje más reciente DE VERDAD entre todas las
  // conversaciones del cliente, no el de `mostRecent` (conversations[0], por conversation.updatedAt):
  // cancelar una venta vieja, editar un pedido o agregar una nota le pisa el updatedAt a ESA
  // conversación aunque el cliente lleve horas hablando en otra más nueva. Caso real, Laura
  // Manjarrez (2026-09-16): cancelar su venta SOLD vieja le puso "Tu pedido fue cancelado" en la
  // fila, tapando lo que en verdad estaba pasando en su conversación NEW activa - y al abrir el
  // chat ese mensaje no estaba, porque vivía en la otra conversación. El createdAt de un mensaje no
  // se mueve nunca después de escrito, así que ordenar por ahí no se corrompe con acciones que no
  // son mensajes.
  const latestMessage = conversations
    .map((c) => c.messages?.[0])
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  return {
    customerId: active.customerId,
    activeConversationId: active.id,
    status: active.status,
    intent: active.intent,
    humanControl: active.humanControl,
    updatedAt: latestMessage?.createdAt ?? mostRecent.updatedAt,
    unreadCount,
    orderCount,
    customer: {
      id: active.customer.id,
      phoneNumber: active.customer.phoneNumber,
      name: active.customer.name,
      displayName: customerDisplayName(active.customer),
      tags: active.customer.tags,
    },
    lastMessage: formatLastMessagePreview(latestMessage),
    cycles: conversations.map((c) => ({ id: c.id, status: c.status, updatedAt: c.updatedAt })),
  };
}

export async function listCustomerThreadsForBusiness(businessId: string): Promise<CustomerRow[]> {
  const conversations = await prisma.conversation.findMany({
    where: { customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });

  const byCustomer = new Map<string, typeof conversations>();
  for (const c of conversations) {
    const group = byCustomer.get(c.customerId);
    if (group) group.push(c);
    else byCustomer.set(c.customerId, [c]);
  }

  const rows = [...byCustomer.values()].map(formatCustomerRow);
  // Sorted explicitly rather than relying on Map insertion order matching it (it already does, since
  // `conversations` above is globally sorted desc and a customer's first appearance in that stream is
  // always their own max updatedAt) - explicit is cheap here and doesn't depend on that holding under
  // timestamp ties or future changes to the query above.
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return rows;
}

// The grouped-thread view behind a customer row: messages for ONE cycle (the active one, or an older
// one via `before`) plus lightweight metadata for every cycle so the frontend can render "Venta cerrada
// · <fecha> · <resumen>" separators between them. Deliberately doesn't load every cycle's messages up
// front - getConversationForBusiness already showed that firing a fresh presigned S3 URL for every
// piece of media adds up, and a customer with several closed sales would multiply that on every open.
/**
 * Cuantos mensajes se ven al abrir un hilo, como minimo, sin tener que pedir mas.
 *
 * Decision del dueno (2026-09-17): "se debe poder ver los 30 ultimos mensajes al menos, antes de tener
 * que darle click a cargar mas. No importa si es una conversacion vieja o nueva, cerrada o lo que sea."
 */
const MIN_THREAD_MESSAGES = 30;

/** Un mensaje tal como lo consume el panel: con su media firmada y su estado de entrega. */
export interface ThreadMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaFilename: string | null;
  mediaPeaks: string | null;
  whatsappMessageId: string | null;
  deliveryFailed: boolean;
  deliveryError: string | null;
}

export async function getCustomerThreadForBusiness(businessId: string, customerId: string, before?: string) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;

  // Ordenados por el mensaje más reciente DE VERDAD de cada ciclo (el createdAt de su propio último
  // Message), no por conversation.updatedAt ni conversation.createdAt:
  //
  //  - updatedAt se mueve por motivos que no tienen nada que ver con "cuándo pasó esta conversación"
  //    (una nota, una edición de pedido) - eso fue el bug de Milena Hernández Parra (2026-09-16): su
  //    SOLD quedaba con updatedAt más nuevo que su ciclo activo y "hasMore" salía false con historia
  //    real esperando.
  //  - createdAt tampoco alcanza: un ciclo SOLD puede recibir un mensaje genuino (aviso de envío,
  //    aviso de cancelación) horas después de que el siguiente ciclo ya arrancó - eso fue el caso de
  //    Laura Manjarrez (2026-09-16), y también, se confirmó, el MISMO Milena ("¡Tu pedido fue
  //    enviado!" a las 14:28, en su ciclo SOLD, mucho después de que su ciclo NEW ya existía).
  //
  // El createdAt de un Message no se mueve nunca después de escrito - por eso este orden no se
  // corrompe con NINGUNA acción que no sea "se escribió un mensaje nuevo", y decisión del dueño
  // (2026-09-16): el ciclo que se abre por defecto es el de índice 0 acá, el del mensaje más
  // reciente, sea SOLD/LOST/NEW - no siempre "el ciclo sin cerrar".
  const conversationsRaw = await prisma.conversation.findMany({
    where: { customerId },
    include: {
      order: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  if (conversationsRaw.length === 0) return null;

  const conversations = conversationsRaw.sort((a, b) => {
    const at = a.messages[0]?.createdAt.getTime() ?? a.createdAt.getTime();
    const bt = b.messages[0]?.createdAt.getTime() ?? b.createdAt.getTime();
    return bt - at;
  });

  const cycles = conversations.map((c) => ({
    id: c.id,
    status: c.status,
    updatedAt: c.updatedAt,
    order: c.order ? { summary: c.order.summary, totalAmount: Number(c.order.totalAmount), currency: c.order.currency } : null,
  }));
  // El ciclo donde el composer/handoff/cerrar-venta actúan - siempre el que sigue abierto, sin
  // importar cuál se esté MOSTRANDO por defecto (eso lo decide targetIndex más abajo). Dos preguntas
  // distintas: "¿a cuál le hablo si escribo ahora?" vs "¿cuál ciclo entro a ver primero?".
  const activeConversationId =
    conversations.find((c) => c.status !== "SOLD" && c.status !== "LOST")?.id ?? conversations[0].id;
  const customerBasic = {
    id: customer.id,
    phoneNumber: customer.phoneNumber,
    name: customer.name,
    displayName: customerDisplayName(customer),
    tags: customer.tags,
  };

  let targetIndex: number;
  if (before) {
    // "Load the cycle before this one" - conversations is sorted by mensaje-más-reciente desc, so the
    // next-less-reciente cycle sits right after `before`'s own position in the array.
    const beforeIndex = conversations.findIndex((c) => c.id === before);
    targetIndex = beforeIndex === -1 ? conversations.length : beforeIndex + 1;
  } else {
    // Índice 0 siempre - conversations ya está ordenado por mensaje más reciente, así que esto es
    // exactamente "el ciclo con la actividad más nueva de verdad", sea SOLD/LOST/NEW.
    targetIndex = 0;

    // Opening the grouped thread reads every conversation of this customer at once - unlike the old
    // single-cycle view, there's no per-cycle "currently open elsewhere" concept left to protect, so
    // nothing stays half-read behind the cycle that's actually shown.
    const unreadIds = conversations.filter((c) => c.unreadCount > 0).map((c) => c.id);
    if (unreadIds.length > 0) {
      await prisma.conversation.updateMany({ where: { id: { in: unreadIds } }, data: { unreadCount: 0 } });
      await emitConversationRowsForCustomer(businessId, customerId);
    }
  }

  // The composer always sends into activeConversationId regardless of which cycle's messages are on
  // screen (loadOlderCycle only prepends older history, it never changes what "send" targets) - so the
  // window has to be checked against that conversation, not whichever `target` this call happens to be
  // returning messages for.
  const windowState = await getWindowState(activeConversationId);

  if (targetIndex >= conversations.length) {
    // `before` pointed at the oldest cycle already, or at an id this customer doesn't have (stale
    // client state) - nothing older left to show.
    return {
      customerId: customer.id,
      customer: customerBasic,
      activeConversationId,
      conversationId: null,
      status: null,
      intent: null,
      humanControl: false,
      hasMore: false,
      cycles,
      blocks: [] as { conversationId: string; messages: ThreadMessage[] }[],
      windowOpen: windowState.windowOpen,
      hoursSinceLastCustomerMessage: windowState.hoursSinceLastCustomerMessage,
      queuedOutbound: [],
      messages: [] as ThreadMessage[],
    };
  }

  const target = conversations[targetIndex];

  // ABRIR UN HILO MUESTRA CONVERSACION, NO UN CICLO (2026-09-17).
  //
  // Hasta hoy se cargaba UN ciclo: el de la actividad mas nueva. Cuando una venta cerraba y el cliente
  // escribia de nuevo, ese ciclo tenia un solo mensaje - y el dueno abria el chat, veia una linea suelta
  // y tenia que apretar "Ver conversacion anterior" para entender de que se estaba hablando. Con dos o
  // tres ventas seguidas, dos o tres clics.
  //
  // Ahora se siguen cargando ciclos hacia atras hasta juntar MIN_THREAD_MESSAGES. El corte por ciclo no
  // desaparece - los separadores de "Venta cerrada" siguen ahi y el boton sigue existiendo para lo mas
  // viejo - pero deja de decidir CUANTO se ve. Si la conversacion de arriba ya trae 30 mensajes, esto no
  // cambia nada y se carga un solo ciclo, igual que antes.
  const cargados: { conversationId: string; status: string; messages: Awaited<ReturnType<typeof prisma.message.findMany>> }[] = [];
  let ultimoIndice = targetIndex;
  let total = 0;
  for (let i = targetIndex; i < conversations.length; i++) {
    const ciclo = conversations[i];
    const filas = await prisma.message.findMany({ where: { conversationId: ciclo.id }, orderBy: { createdAt: "asc" } });
    // Un ciclo vacio no cuenta como "ya mostre algo": se salta y se sigue buscando hacia atras.
    if (filas.length === 0 && i !== targetIndex) continue;
    cargados.unshift({ conversationId: ciclo.id, status: ciclo.status, messages: filas });
    ultimoIndice = i;
    total += filas.length;
    if (total >= MIN_THREAD_MESSAGES) break;
  }

  const hasMore = ultimoIndice + 1 < conversations.length;
  const messages = cargados[cargados.length - 1]?.messages ?? [];

  const conMedios = async (filas: typeof messages) =>
    attachDeliveryFailures(
      businessId,
      await Promise.all(
        filas.map(async (m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
          mediaType: m.mediaType,
          mediaFilename: m.mediaFilename,
          mediaPeaks: m.mediaPeaks,
          whatsappMessageId: m.whatsappMessageId,
        }))
      )
    );

  // Un bloque por ciclo cargado, del mas viejo al mas nuevo. El panel los pinta con su separador de
  // "Venta cerrada" entre medio, igual que cuando se cargaban de a uno con el boton.
  const bloques = await Promise.all(
    cargados.map(async (b) => ({ conversationId: b.conversationId, messages: await conMedios(b.messages) }))
  );

  return {
    customerId: customer.id,
    customer: customerBasic,
    activeConversationId,
    conversationId: target.id,
    status: target.status,
    intent: target.intent,
    humanControl: target.humanControl,
    hasMore,
    cycles,
    blocks: bloques,
    windowOpen: windowState.windowOpen,
    hoursSinceLastCustomerMessage: windowState.hoursSinceLastCustomerMessage,
    queuedOutbound: await listQueuedOutbound(businessId, activeConversationId),
    // `messages` sigue siendo el ciclo mas nuevo, como siempre: lo usan el cargado incremental del boton
    // y cualquier cliente que no lea `blocks`.
    messages: bloques[bloques.length - 1]?.messages ?? [],
  };
}
