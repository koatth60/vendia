// Fase 7 del plan maestro (2026-09-15), causa raiz C4. Unico punto de salida hacia WhatsApp: nada
// fuera de este archivo importa src/whatsapp/client.ts (hay una prueba de arquitectura que lo verifica,
// outbound.arch.test.ts). Antes cada sitio de llamada repetia su propio try/catch, su propia idea de la
// ventana de 24h y su propia interpretacion del error de Meta - 15 puntos de perdida silenciosa en la
// auditoria. Aca viven, en un solo lugar:
//
//   1. la ventana de 24h se verifica SIEMPRE antes de un mensaje libre a un cliente;
//   2. con la ventana cerrada se cae a plantilla aprobada o a la cola, nunca al vacio;
//   3. el error de Meta se parsea como JSON y se ramifica por error.code, nunca por texto;
//   4. los errores reintentables se reintentan con backoff;
//   5. lo que no se pudo entregar deja un DeliveryFailure, que es lo que ve la duena en el panel.
//
// Reexporta lo que NO es envio (descarga de medios, gestion de plantillas, foto de perfil, formato de
// texto) para que el resto del codigo tenga un solo import de WhatsApp y la regla "cero llamadas
// directas a client.ts" sea literal y verificable con un grep, en vez de una lista de excepciones.
import { prisma } from "../db/client";
import {
  GraphApiError,
  sendImageMessage,
  sendInteractiveButtonsMessage,
  sendOwnerAlert,
  sendTemplateMessage,
  sendTextMessage,
  sendVideoMessage,
  type WhatsappCredentials,
} from "./client";
import {
  getWindowState,
  markQueuedOutboundSent,
  queueOutboundMessage,
  recordMessage,
} from "../conversation/service";
import { recordDeliveryFailure } from "../delivery/failures";

export {
  createTemplate,
  deleteTemplate,
  downloadMedia,
  formatForWhatsapp,
  isBsuid,
  listAllTemplates,
  listApprovedTemplates,
  normalizeTemplateName,
  setBusinessProfilePhoto,
  GraphApiError,
} from "./client";
export type { ApprovedTemplate, WhatsappCredentials, WhatsappTemplate } from "./client";

// ---------------------------------------------------------------------------
// Clasificacion del error de Meta
// ---------------------------------------------------------------------------

// Los unicos codigos por los que se ramifica. Meta reescribe el texto del mensaje cuando quiere; el
// numero es la parte estable. Cualquier codigo que no este aca cae en TRANSIENT (5xx/red) o PERMANENT.
export const META_ERROR_CODES = {
  // Ventana de servicio de 24h cerrada: solo entra una plantilla aprobada.
  WINDOW_CLOSED: 131047,
  // El cliente bloqueo los mensajes de este negocio. Reintentar es spam y no va a funcionar nunca.
  OPTED_OUT: 131050,
  // Token de acceso vencido o revocado: la conexion de WhatsApp de este negocio esta caida.
  TOKEN_EXPIRED: 190,
  // Cuerpo de plantilla invalido (saltos de linea, tabulaciones o 5+ espacios en un parametro).
  TEMPLATE_FORMAT: 132018,
} as const;

// Limite de tasa. Meta lo reporta de varias formas segun donde se pego el techo, y ademas como HTTP 429.
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048]);

export type OutboundFailureKind =
  | "WINDOW_CLOSED"
  | "OPTED_OUT"
  | "TOKEN_EXPIRED"
  | "RATE_LIMITED"
  | "TEMPLATE_FORMAT"
  | "TRANSIENT"
  | "PERMANENT";

export interface OutboundFailure {
  kind: OutboundFailureKind;
  code: number | null;
  message: string;
  retryable: boolean;
}

export function classifyOutboundError(error: unknown): OutboundFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof GraphApiError)) {
    // No viene de la API: es un bug nuestro o de la base. Reintentarlo no lo arregla.
    return { kind: "PERMANENT", code: null, message, retryable: false };
  }
  // Timeout o red caida: no hay codigo de Meta porque Meta nunca contesto.
  if (error.status === null) return { kind: "TRANSIENT", code: null, message, retryable: true };

  switch (error.code) {
    case META_ERROR_CODES.WINDOW_CLOSED:
      return { kind: "WINDOW_CLOSED", code: error.code, message, retryable: false };
    case META_ERROR_CODES.OPTED_OUT:
      return { kind: "OPTED_OUT", code: error.code, message, retryable: false };
    case META_ERROR_CODES.TOKEN_EXPIRED:
      return { kind: "TOKEN_EXPIRED", code: error.code, message, retryable: false };
    case META_ERROR_CODES.TEMPLATE_FORMAT:
      return { kind: "TEMPLATE_FORMAT", code: error.code, message, retryable: false };
  }
  if (error.status === 429 || (error.code !== null && RATE_LIMIT_CODES.has(error.code))) {
    return { kind: "RATE_LIMITED", code: error.code, message, retryable: true };
  }
  if (error.status >= 500) return { kind: "TRANSIENT", code: error.code, message, retryable: true };
  return { kind: "PERMANENT", code: error.code, message, retryable: false };
}

// ---------------------------------------------------------------------------
// Reintentos
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
// Un limite de tasa necesita esperar mucho mas que un 500 suelto: reintentar rapido contra un 429 solo
// profundiza el castigo.
const BACKOFF_MS: Record<"TRANSIENT" | "RATE_LIMITED", number[]> = {
  TRANSIENT: [500, 2000],
  RATE_LIMITED: [2000, 8000],
};

// Fija la espera entre reintentos en vez de usar la escalera de arriba. Existe para que las pruebas no
// tengan que esperar 10 segundos reales para comprobar que un 429 se reintenta; en produccion no se
// define y la escalera manda.
const BACKOFF_OVERRIDE_MS = process.env.WHATSAPP_RETRY_BACKOFF_MS ? Number(process.env.WHATSAPP_RETRY_BACKOFF_MS) : null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface AttemptResult {
  wamid: string | null;
  attempts: number;
  failure: OutboundFailure | null;
}

async function sendWithRetries(send: () => Promise<string>): Promise<AttemptResult> {
  let failure: OutboundFailure | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return { wamid: await send(), attempts: attempt, failure: null };
    } catch (error) {
      failure = classifyOutboundError(error);
      if (!failure.retryable || attempt === MAX_ATTEMPTS) {
        return { wamid: null, attempts: attempt, failure };
      }
      const schedule = BACKOFF_MS[failure.kind === "RATE_LIMITED" ? "RATE_LIMITED" : "TRANSIENT"];
      await sleep(BACKOFF_OVERRIDE_MS ?? schedule[attempt - 1] ?? schedule[schedule.length - 1]);
    }
  }
  return { wamid: null, attempts: MAX_ATTEMPTS, failure };
}

// ---------------------------------------------------------------------------
// Contenido y resultado
// ---------------------------------------------------------------------------

export type OutboundContent =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; caption?: string }
  | { kind: "video"; url: string; caption?: string }
  | { kind: "buttons"; text: string; buttons: { id: string; title: string }[] }
  | { kind: "template"; name: string; language: string; params?: string[] };

// Una plantilla aprobada es el unico contenido que Meta entrega con la ventana cerrada; todo lo demas
// es texto libre y depende de la ventana.
function isFreeForm(content: OutboundContent): boolean {
  return content.kind !== "template";
}

function dispatch(credentials: WhatsappCredentials, to: string, content: OutboundContent): Promise<string> {
  switch (content.kind) {
    case "text":
      return sendTextMessage(credentials, to, content.text);
    case "image":
      return sendImageMessage(credentials, to, content.url, content.caption);
    case "video":
      return sendVideoMessage(credentials, to, content.url, content.caption);
    case "buttons":
      return sendInteractiveButtonsMessage(credentials, to, content.text, content.buttons);
    case "template":
      return sendTemplateMessage(credentials, to, content.name, content.language, content.params);
  }
}

export type OutboundOutcome =
  // El destinatario recibio exactamente lo que se le queria mandar.
  | "SENT"
  // Ventana cerrada: salio la plantilla de reenganche en lugar del texto real.
  | "SENT_AS_TEMPLATE"
  // Ventana cerrada: el texto real quedo guardado y se entrega cuando el cliente vuelva a escribir.
  | "QUEUED"
  // El cliente bloqueo los mensajes de este negocio. No se reintenta nunca.
  | "OPTED_OUT"
  // No se pudo entregar nada. Siempre deja un DeliveryFailure.
  | "FAILED";

export interface OutboundResult {
  outcome: OutboundOutcome;
  // Si el destinatario recibio ALGO (el texto real o la plantilla de reenganche).
  delivered: boolean;
  wamid: string;
  attempts: number;
  windowOpen: boolean | null;
  queued: boolean;
  queuedId: string | null;
  failure: OutboundFailure | null;
}

// Que hacer cuando la ventana de 24h esta cerrada y el contenido es texto libre.
//   "template" - mandar la plantilla de reenganche del negocio (el texto real se pierde).
//   "queue"    - guardar el texto real y ademas mandar la plantilla de reenganche si hay.
//   "fail"     - no mandar nada; el llamador ya decidio que hacer (el panel devuelve 409).
export type WindowClosedPolicy = "template" | "queue" | "fail";

export interface SendToCustomerParams {
  businessId: string;
  conversationId: string;
  credentials: WhatsappCredentials;
  to: string;
  content: OutboundContent;
  onWindowClosed?: WindowClosedPolicy;
  queueOrigin?: "PANEL" | "OWNER_ANSWER";
  // Guarda el Message en la conversacion cuando el envio sale bien. Los llamadores que ya lo hacen a
  // mano (porque necesitan adjuntar s3Key, producto, etc.) lo dejan sin definir.
  recordAs?: { text: string } | null;
}

async function reengagementTemplate(businessId: string): Promise<{ name: string; language: string } | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { followUpTemplateName: true, followUpTemplateLanguage: true },
  });
  if (!business?.followUpTemplateName) return null;
  return { name: business.followUpTemplateName, language: business.followUpTemplateLanguage };
}

async function noteFailure(businessId: string, to: string, failure: OutboundFailure, wamid = ""): Promise<void> {
  // Un token vencido o un cliente que bloqueo al negocio no se arreglan solos: van como criticos para
  // que salten arriba en "Salud del bot" en vez de mezclarse con los fallos transitorios.
  const critical = failure.kind === "TOKEN_EXPIRED" || failure.kind === "OPTED_OUT";
  try {
    await recordDeliveryFailure(businessId, {
      wamid,
      recipientPhone: to,
      errorCode: failure.code,
      errorMessage: failure.message,
      critical,
    });
  } catch (error) {
    console.error("No se pudo registrar el fallo de entrega:", error);
  }
  if (failure.kind === "TOKEN_EXPIRED") await markConnectionBroken(businessId);
}

// Error 190 de Meta: token vencido o revocado. `updateMany` con el filtro en `whatsappConnectionBrokenAt:
// null` evita reescribir la fecha en cada envio que siga fallando mientras la conexion sigue caida - se
// guarda el momento en que se cayo, no el ultimo intento fallido.
async function markConnectionBroken(businessId: string): Promise<void> {
  try {
    await prisma.business.updateMany({
      where: { id: businessId, whatsappConnectionBrokenAt: null },
      data: { whatsappConnectionBrokenAt: new Date() },
    });
  } catch (error) {
    console.error("No se pudo marcar la conexion de WhatsApp como caida:", error);
  }
}

function failed(failure: OutboundFailure, attempts: number, windowOpen: boolean | null): OutboundResult {
  return {
    outcome: failure.kind === "OPTED_OUT" ? "OPTED_OUT" : "FAILED",
    delivered: false,
    wamid: "",
    attempts,
    windowOpen,
    queued: false,
    queuedId: null,
    failure,
  };
}

// Unico camino para hablarle a un cliente. Verifica la ventana ANTES de intentar: Meta acepta un texto
// libre fuera de ventana y devuelve un wamid real, y recien reporta el 131047 horas despues por el
// webhook de estados - para entonces la duena ya creyo que el mensaje salio (incidente real del
// 2026-09-14, dos mensajes "enviados" que nadie recibio).
export async function sendToCustomer(params: SendToCustomerParams): Promise<OutboundResult> {
  const { businessId, conversationId, credentials, to, content } = params;
  const policy = params.onWindowClosed ?? "template";

  const windowState = await getWindowState(conversationId);
  if (isFreeForm(content) && !windowState.windowOpen) {
    return handleClosedWindow(params, policy);
  }

  const { wamid, attempts, failure } = await sendWithRetries(() => dispatch(credentials, to, content));
  if (failure) {
    // La ventana se cerro entre la verificacion y el envio, o Meta y nosotros no coincidimos en cuando
    // empieza: se trata igual que si hubiera dado cerrada desde el principio.
    if (failure.kind === "WINDOW_CLOSED" && isFreeForm(content)) {
      return handleClosedWindow(params, policy);
    }
    await noteFailure(businessId, to, failure);
    return failed(failure, attempts, windowState.windowOpen);
  }

  if (params.recordAs) {
    await recordMessage(businessId, conversationId, "ASSISTANT", params.recordAs.text, wamid || undefined);
  }
  return {
    outcome: "SENT",
    delivered: true,
    wamid: wamid ?? "",
    attempts,
    windowOpen: windowState.windowOpen,
    queued: false,
    queuedId: null,
    failure: null,
  };
}

async function handleClosedWindow(params: SendToCustomerParams, policy: WindowClosedPolicy): Promise<OutboundResult> {
  const { businessId, conversationId, credentials, to, content } = params;
  const closed: OutboundFailure = {
    kind: "WINDOW_CLOSED",
    code: META_ERROR_CODES.WINDOW_CLOSED,
    message: "Pasaron mas de 24h desde el ultimo mensaje del cliente: WhatsApp no entrega texto libre.",
    retryable: false,
  };

  if (policy === "fail") {
    return failed(closed, 0, false);
  }

  // Encolar solo tiene sentido con texto: una foto o un video en cola no se puede reenviar sin volver a
  // resolver la URL firmada, que para entonces ya vencio.
  let queuedId: string | null = null;
  if (policy === "queue" && params.queueOrigin && content.kind === "text") {
    try {
      const queued = await queueOutboundMessage(businessId, conversationId, content.text, params.queueOrigin);
      queuedId = queued.id;
    } catch (error) {
      console.error("No se pudo dejar el mensaje en cola:", error);
    }
  }

  const template = await reengagementTemplate(businessId);
  if (template) {
    const nudge = await sendWithRetries(() => sendTemplateMessage(credentials, to, template.name, template.language));
    if (!nudge.failure) {
      // La plantilla salio, pero el mensaje que se queria mandar NO llego: para la duena eso sigue
      // siendo un mensaje sin entregar y tiene que verlo en el panel. Sin esto, "le mandamos un aviso
      // para que vuelva a escribir" se leia como si el tema estuviera resuelto.
      await noteFailure(businessId, to, closed);
      return {
        outcome: queuedId ? "QUEUED" : "SENT_AS_TEMPLATE",
        delivered: true,
        wamid: nudge.wamid ?? "",
        attempts: nudge.attempts,
        windowOpen: false,
        queued: queuedId !== null,
        queuedId,
        failure: null,
      };
    }
    await noteFailure(businessId, to, nudge.failure);
    return {
      outcome: queuedId ? "QUEUED" : "FAILED",
      delivered: false,
      wamid: "",
      attempts: nudge.attempts,
      windowOpen: false,
      queued: queuedId !== null,
      queuedId,
      failure: nudge.failure,
    };
  }

  // Sin plantilla configurada no hay forma de alcanzar al cliente. Queda el registro para que la duena
  // lo vea en el panel y decida, en vez de que el mensaje desaparezca.
  await noteFailure(businessId, to, closed);
  return {
    outcome: queuedId ? "QUEUED" : "FAILED",
    delivered: false,
    wamid: "",
    attempts: 0,
    windowOpen: false,
    queued: queuedId !== null,
    queuedId,
    failure: closed,
  };
}

// ---------------------------------------------------------------------------
// Salida hacia la duena
// ---------------------------------------------------------------------------

// La duena no es un Customer y no tiene Conversation, asi que no hay ventana de 24h que consultar en la
// base para ella: sendOwnerAlert ya resuelve eso mandando la plantilla aprobada primero y cayendo a
// texto libre solo si la plantilla no existe todavia. Lo que faltaba era el reintento y el registro.
export async function sendAlertToOwner(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string,
  text: string
): Promise<OutboundResult> {
  const { wamid, attempts, failure } = await sendWithRetries(() => sendOwnerAlert(credentials, ownerPhone, text));
  if (failure) {
    await noteFailure(businessId, ownerPhone, failure);
    return failed(failure, attempts, null);
  }
  return {
    outcome: "SENT",
    delivered: true,
    wamid: wamid ?? "",
    attempts,
    windowOpen: null,
    queued: false,
    queuedId: null,
    failure: null,
  };
}

// Cualquier otra cosa hacia la duena que no sea la alerta con plantilla: los botones de confirmacion de
// venta, la foto que el cliente mando para identificar un producto, o el texto plano al que esos dos
// caen cuando Meta los rechaza. Son respuestas dentro de un intercambio que ella misma esta teniendo,
// asi que su ventana esta abierta; lo que faltaba era reintento y registro del fallo.
export async function sendToOwner(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string,
  content: OutboundContent
): Promise<OutboundResult> {
  const { wamid, attempts, failure } = await sendWithRetries(() => dispatch(credentials, ownerPhone, content));
  if (failure) {
    await noteFailure(businessId, ownerPhone, failure);
    return failed(failure, attempts, null);
  }
  return {
    outcome: "SENT",
    delivered: true,
    wamid: wamid ?? "",
    attempts,
    windowOpen: null,
    queued: false,
    queuedId: null,
    failure: null,
  };
}

// ---------------------------------------------------------------------------
// Drenaje de la cola
// ---------------------------------------------------------------------------

// Cuantas veces se intenta un item de la cola antes de darlo por muerto. Antes no habia limite ni
// contador: el primero que fallaba cortaba el drenaje entero de ese cliente (un `return` en el bucle) y
// se reintentaba igual para siempre, sin registro y sin que nadie se enterara.
export const MAX_QUEUE_ATTEMPTS = 5;
const QUEUE_BACKOFF_MINUTES = [1, 5, 15, 60, 240];

export type QueueItemOutcome = "SENT" | "RETRY" | "WAITING" | "DEAD";

interface QueuedItem {
  id: string;
  businessId: string;
  conversationId: string;
  body: string;
  attempts: number;
}

async function deadLetter(item: QueuedItem, to: string, failure: OutboundFailure): Promise<"DEAD"> {
  await prisma.queuedOutboundMessage.update({
    where: { id: item.id },
    data: { failedAt: new Date(), attempts: item.attempts + 1, lastError: failure.message },
  });
  await noteFailure(item.businessId, to, failure);
  return "DEAD";
}

// Entrega un item de la cola. No consume un intento cuando la ventana sigue cerrada: eso no es un fallo,
// es exactamente la condicion por la que el mensaje esta en cola.
export async function deliverQueuedItem(
  item: QueuedItem,
  credentials: WhatsappCredentials,
  customerPhone: string
): Promise<QueueItemOutcome> {
  const windowState = await getWindowState(item.conversationId);
  if (!windowState.windowOpen) return "WAITING";

  const { failure, wamid } = await sendWithRetries(() => sendTextMessage(credentials, customerPhone, item.body));

  if (!failure) {
    await recordMessage(item.businessId, item.conversationId, "ASSISTANT", item.body, wamid || undefined);
    await markQueuedOutboundSent(item.id);
    return "SENT";
  }

  if (failure.kind === "WINDOW_CLOSED") return "WAITING";
  if (!failure.retryable) return deadLetter(item, customerPhone, failure);

  const nextAttempts = item.attempts + 1;
  if (nextAttempts >= MAX_QUEUE_ATTEMPTS) return deadLetter(item, customerPhone, failure);

  const minutes = QUEUE_BACKOFF_MINUTES[nextAttempts - 1] ?? QUEUE_BACKOFF_MINUTES[QUEUE_BACKOFF_MINUTES.length - 1];
  await prisma.queuedOutboundMessage.update({
    where: { id: item.id },
    data: {
      attempts: nextAttempts,
      nextAttemptAt: new Date(Date.now() + minutes * 60 * 1000),
      lastError: failure.message,
    },
  });
  return "RETRY";
}

// El cliente acaba de escribir, asi que su ventana esta abierta de nuevo: se entrega lo que habia
// quedado pendiente. Un item que falla ya no corta la fila - los que siguen se intentan igual (antes un
// `return` dejaba el resto de la cola de ese cliente bloqueado para siempre).
export async function drainQueuedOutboundForCustomer(
  businessId: string,
  customerId: string,
  credentials: WhatsappCredentials,
  customerPhone: string
): Promise<void> {
  try {
    const queued = await prisma.queuedOutboundMessage.findMany({
      where: { businessId, sentAt: null, cancelledAt: null, failedAt: null, conversation: { customerId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, businessId: true, conversationId: true, body: true, attempts: true },
    });
    for (const item of queued) {
      try {
        await deliverQueuedItem(item, credentials, customerPhone);
      } catch (error) {
        console.error(`No se pudo entregar el mensaje en cola ${item.id}:`, error);
      }
    }
  } catch (error) {
    console.error("No se pudo revisar la cola de salida:", error);
  }
}

// Job periodico. Hasta la Fase 7 la cola solo se drenaba cuando el cliente escribia: si ese drenaje
// fallaba, el texto se quedaba ahi sin que nada volviera a intentarlo nunca.
export async function drainOutboundQueue(
  batchSize = 100
): Promise<{ sent: number; retry: number; waiting: number; dead: number }> {
  const tally = { sent: 0, retry: 0, waiting: 0, dead: 0 };
  const due = await prisma.queuedOutboundMessage.findMany({
    where: { sentAt: null, cancelledAt: null, failedAt: null, nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: {
      id: true,
      businessId: true,
      conversationId: true,
      body: true,
      attempts: true,
      conversation: { select: { customer: { select: { phoneNumber: true } } } },
    },
  });
  if (due.length === 0) return tally;

  const businesses = await prisma.business.findMany({
    where: { id: { in: [...new Set(due.map((d) => d.businessId))] }, active: true },
    select: { id: true, whatsappPhoneNumberId: true, whatsappAccessToken: true },
  });
  const credentialsByBusiness = new Map<string, WhatsappCredentials>();
  for (const business of businesses) {
    if (!business.whatsappPhoneNumberId || !business.whatsappAccessToken) continue;
    credentialsByBusiness.set(business.id, {
      phoneNumberId: business.whatsappPhoneNumberId,
      accessToken: business.whatsappAccessToken,
    });
  }

  for (const row of due) {
    const credentials = credentialsByBusiness.get(row.businessId);
    // Negocio desactivado o sin WhatsApp conectado: se deja quieto, no se gasta un intento. Si vuelve a
    // conectarse, la cola sigue intacta.
    if (!credentials) {
      tally.waiting++;
      continue;
    }
    try {
      const outcome = await deliverQueuedItem(
        {
          id: row.id,
          businessId: row.businessId,
          conversationId: row.conversationId,
          body: row.body,
          attempts: row.attempts,
        },
        credentials,
        row.conversation.customer.phoneNumber
      );
      if (outcome === "SENT") tally.sent++;
      else if (outcome === "RETRY") tally.retry++;
      else if (outcome === "DEAD") tally.dead++;
      else tally.waiting++;
    } catch (error) {
      console.error(`Error drenando el mensaje en cola ${row.id}:`, error);
    }
  }
  return tally;
}
