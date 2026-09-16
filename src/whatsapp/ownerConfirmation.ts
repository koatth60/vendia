// Confirmacion de venta: garantizar que la pregunta "¿Te llego el pago?" LLEGUE al dueno y que se
// insista hasta que responda (2026-09-16).
//
// EL AGUJERO QUE CIERRA, medido en produccion. Conversacion cmu3htnp0009y4k2kzxhy9dlz: la clienta pago
// $154.000 por Nequi y la duena se entero horas despues, a mano. Habia cuatro huecos encadenados:
//
//   1. `delivered: true` solo significaba que Meta acepto el envio, no que le llego al telefono. El
//      acuse real de Meta llega por el webhook de estados, que matchea por wamid contra `Message`; los
//      mensajes al dueno viven en `OwnerMessageLog`, que no guardaba el wamid, asi que el acuse llegaba
//      y se descartaba.
//   2. La escalera de envio terminaba en texto libre, que WhatsApp NO entrega con la ventana de 24h
//      cerrada. Un fin de semana sin ventas en vivo deja a la duena mas de 24h sin escribirle al numero
//      del negocio: el lunes, el primer comprobante no le llegaba.
//   3. Si los dos escalones fallaban, quedaba un `console.error` y nada mas. Nadie reintentaba.
//   4. Nadie perseguia una confirmacion sin responder: jobs/escalationReminder.ts solo miraba
//      PendingOwnerQuestion.
//
// LA ESCALERA. botones -> texto libre -> plantilla `onix_owner_alert` (via sendAlertToOwner). La
// plantilla es el unico contenido que Meta entrega con la ventana cerrada, y ya estaba aprobada para
// este negocio; lo que faltaba era usarla desde aca. Cuando la pregunta sale por plantilla, el mensaje
// real con botones queda ENCOLADO (pendingConfirmationButtonsQueued) y sale apenas el dueno escriba
// cualquier cosa, porque esa respuesta suya reabre su ventana.
//
// LO QUE NO CAMBIA, Y NO SE NEGOCIA: el pedido sigue sin crearse hasta que el dueno confirme. Es la
// unica persona que puede verificar que la plata entro al Nequi. Este modulo garantiza que la pregunta
// llegue y que se insista, nunca que se pueda saltear. No hay un solo createOrder en este archivo.
import { prisma } from "../db/client";
import { isBsuid, sendAlertToOwner, sendToOwner, type WhatsappCredentials } from "./outbound";
import { recordOwnerMessage } from "../delivery/ownerLog";

export interface OwnerConfirmationCustomer {
  name: string | null;
  phoneNumber: string;
}

// El numero del cliente no siempre se puede mostrar: con la privacidad de WhatsApp activada llega un
// BSUID opaco en vez de un telefono, y mandarselo al dueno es ruido que no puede marcar.
export function describeCustomerForOwner(customer: OwnerConfirmationCustomer): string {
  if (!isBsuid(customer.phoneNumber)) {
    return customer.name ? `${customer.name} (${customer.phoneNumber})` : customer.phoneNumber;
  }
  return customer.name
    ? `${customer.name} (sin numero visible, privacidad de WhatsApp activada)`
    : "un cliente (sin numero visible, privacidad de WhatsApp activada)";
}

// El texto se COMPONE, no se guarda: el perseguidor lo vuelve a armar desde los mismos datos de la base
// (pendingOrderSummary + el cliente) en cada reintento. Asi un reintento no puede mandar algo distinto
// de lo que se mando la primera vez, y no hay una segunda copia del texto que se pueda desincronizar.
export function buildSaleConfirmationText(params: {
  contactName: string | null;
  customerLabel: string;
  summary: string | null;
}): string {
  const greeting = params.contactName ? `Hola ${params.contactName}` : "Hola";
  return [
    `${greeting}, el cliente ${params.customerLabel} pago/confirmo este pedido:`,
    params.summary || "El cliente confirmo la compra, sin mas detalles registrados.",
    "¿Te llego el pago?",
  ].join("\n\n");
}

export const CONFIRMATION_BUTTONS = [
  { id: "confirm_yes", title: "✅ Si llego" },
  { id: "confirm_no", title: "❌ No llego" },
];

// ---------------------------------------------------------------------------
// Politica de insistencia
// ---------------------------------------------------------------------------
//
// Insistir con cadencia fija hasta el vencimiento sale caro de tres formas, y las tres eran reales con
// la config de MAGByLizN (5 minutos, 24 horas = ~288 mensajes por UNA venta):
//
//   1. La duena silencia el numero. El mecanismo que existe para que se entere garantiza que deje de
//      mirar, que es exactamente el problema que vino a resolver.
//   2. Meta le baja la calificacion de calidad a la linea por mensajes repetidos sin respuesta. Es la
//      MISMA linea por la que se les habla a todos los clientes.
//   3. Cada plantilla onix_owner_alert es UTILITY y se factura por mensaje.
//
// Multiplicadores de Business.ownerReminderMinutes, no minutos absolutos: la configuracion del dueno
// sigue mandando sobre el PRIMER aviso (por eso el primer paso es 1) y la escalera define como crece de
// ahi en adelante. El ultimo paso se repite hasta el vencimiento.
//
// Con base 5 minutos y vencimiento a las 24 horas esto da 26 recordatorios (27 mensajes contando el
// pedido inicial) en vez de 287.
export const CONFIRMATION_REMINDER_STEPS = [1, 2, 3, 4, 6, 9, 13];

/** Cuanto falta para el proximo intento, dados los intentos YA hechos (el inicial cuenta como 1). */
export function nextConfirmationDelayMinutes(reminderMinutes: number, attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), CONFIRMATION_REMINDER_STEPS.length - 1);
  return reminderMinutes * CONFIRMATION_REMINDER_STEPS[index];
}

// Tope de plantillas por confirmacion. La plantilla es el unico escalon que cuesta plata y el unico que
// entra con la ventana cerrada; las otras dos vias fallan gratis. Tres es el presupuesto entero.
export const MAX_CONFIRMATION_TEMPLATES = 3;

// Y separadas en el tiempo. Sin esto el presupuesto se gastaba entero en los primeros 15 minutos (los
// tres primeros reintentos de la escalera) y no quedaba forma de alcanzar al dueno en las 23 horas
// siguientes - justo el caso que motivo todo esto: sabado a la noche, la clienta paga, la duena no mira
// hasta el domingo.
export const CONFIRMATION_TEMPLATE_SPACING_MINUTES = 240;

export interface TemplateBudget {
  templatesSent: number;
  lastTemplateAt: Date | null;
}

/** Funcion pura: se prueba sin base, sin red y sin reloj real. */
export function canSpendTemplate(budget: TemplateBudget, now: Date): boolean {
  if (budget.templatesSent >= MAX_CONFIRMATION_TEMPLATES) return false;
  if (!budget.lastTemplateAt) return true;
  return now.getTime() - budget.lastTemplateAt.getTime() >= CONFIRMATION_TEMPLATE_SPACING_MINUTES * 60 * 1000;
}

export type OwnerConfirmationChannel = "BUTTONS" | "TEXT" | "TEMPLATE" | "NONE";

export interface LadderOutcome {
  /** Por cual escalon salio. NONE = no salio por ninguno. */
  channel: OwnerConfirmationChannel;
  /** wamid del mensaje que el dueno tiene que responder, para matchear su respuesta citada. */
  wamid: string | null;
  /** Salio por plantilla, asi que el mensaje real con botones sigue debiendo salir. */
  buttonsQueued: boolean;
  /** El ultimo error real, cuando no salio nada. */
  error: string | null;
}

// Los tres escalones, en orden, parando en el primero que entrega. Cada uno cubre un modo de falla
// distinto del anterior: los botones pueden ser rechazados por formato, el texto libre no cruza la
// ventana de 24h cerrada, y la plantilla si la cruza.
export async function sendConfirmationLadder(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string,
  text: string,
  // El tercer escalon se puede negar por presupuesto (ver canSpendTemplate). Los dos primeros siempre se
  // intentan: con la ventana cerrada fallan gratis, y si esta abierta son el mejor mensaje posible.
  allowTemplate = true
): Promise<LadderOutcome> {
  const buttons = await sendToOwner(businessId, credentials, ownerPhone, {
    kind: "buttons",
    text,
    buttons: CONFIRMATION_BUTTONS,
  });
  if (buttons.delivered) return { channel: "BUTTONS", wamid: buttons.wamid, buttonsQueued: false, error: null };
  console.error("Confirmacion de venta: fallaron los botones, probando texto libre:", buttons.failure?.message);

  const plain = await sendToOwner(businessId, credentials, ownerPhone, {
    kind: "text",
    text: `${text}\n\nRespondeme "si" o "no" citando este mismo mensaje, por favor.`,
  });
  if (plain.delivered) return { channel: "TEXT", wamid: plain.wamid, buttonsQueued: false, error: null };
  console.error("Confirmacion de venta: fallo el texto libre, probando la plantilla:", plain.failure?.message);

  // Tercer escalon. sendAlertToOwner -> sendOwnerAlert manda la plantilla `onix_owner_alert` (aprobada,
  // es, UTILITY), que es lo unico que entra con la ventana cerrada. El mensaje con botones queda
  // pendiente: una plantilla no lleva botones de respuesta rapida propios.
  const template = allowTemplate ? await sendAlertToOwner(businessId, credentials, ownerPhone, text) : null;
  if (template?.delivered) return { channel: "TEMPLATE", wamid: template.wamid, buttonsQueued: true, error: null };

  const error = template?.failure?.message ?? plain.failure?.message ?? buttons.failure?.message ?? "Sin wamid";
  console.error("Confirmacion de venta: no salio por ninguna via, queda pendiente de reintento:", error);
  return { channel: "NONE", wamid: null, buttonsQueued: false, error };
}

export interface PendingOrderDraft {
  items: unknown[];
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shippingCost: number | null;
}

export interface AskOwnerResult {
  /** true = hay una confirmacion viva; el llamador NO puede cerrar la venta solo. */
  pending: boolean;
  /** false cuando ya habia una confirmacion viva y esta llamada no mando nada. */
  sent: boolean;
  outcome: LadderOutcome | null;
}

/**
 * Pide la confirmacion al dueno y deja la conversacion esperando su respuesta.
 *
 * IDEMPOTENCIA - esto toca plata. Una sola confirmacion viva por conversacion, garantizada por la base y
 * no por el orden de las llamadas: la reserva es un `updateMany` condicionado a
 * `pendingConfirmationAskedAt: null`, asi que de N llamadas simultaneas exactamente una escribe y las
 * otras N-1 ven `count: 0` y no mandan nada. Diez reintentos seguidos dejan un solo pedido y una sola
 * pregunta al dueno.
 *
 * La reserva va ANTES del envio, no despues: si se enviara primero, dos llamadas concurrentes mandarian
 * dos preguntas y recien despues descubririan que una sobra.
 */
export async function askOwnerToConfirmSale(params: {
  businessId: string;
  conversationId: string;
  customerId: string;
  credentials: WhatsappCredentials;
  summary: string;
  draft: PendingOrderDraft;
}): Promise<AskOwnerResult> {
  const business = await prisma.business.findUnique({
    where: { id: params.businessId },
    select: { contactPhone: true, contactName: true, ownerReminderMinutes: true },
  });
  if (!business?.contactPhone) {
    // No hay a quien mandarle WhatsApp - la venta se autoconfirma igual (comportamiento existente),
    // pero sin este registro no quedaba ningun rastro de que el dueno nunca se entero en tiempo real.
    await recordOwnerMessage(params.businessId, {
      direction: "OUT",
      conversationId: params.conversationId,
      body: `Venta autoconfirmada sin aviso al dueno (falta configurar Telefono de contacto en el negocio): ${params.summary || "sin resumen"}`,
      success: false,
      errorMessage: "Sin contactPhone configurado",
    });
    return { pending: false, sent: false, outcome: null };
  }

  const reserved = await prisma.conversation.updateMany({
    where: { id: params.conversationId, pendingConfirmationAskedAt: null },
    data: {
      pendingConfirmationAskedAt: new Date(),
      pendingConfirmationAttempts: 1,
      pendingOrderSummary: params.summary || null,
      // Se guarda SIEMPRE, incluso si despues no sale ningun envio: es lo que el perseguidor necesita
      // para poder volver a preguntar, y lo que handleOwnerReply necesita para crear el pedido cuando el
      // dueno finalmente conteste. Antes solo se guardaba si habia wamid, asi que un envio fallido
      // borraba el pedido del mapa.
      pendingOrderItems: params.draft as unknown as object,
    },
  });
  if (reserved.count === 0) return { pending: true, sent: false, outcome: null };

  const customer = await prisma.customer.findUnique({
    where: { id: params.customerId },
    select: { name: true, phoneNumber: true },
  });
  const text = buildSaleConfirmationText({
    contactName: business.contactName,
    customerLabel: describeCustomerForOwner(customer ?? { name: null, phoneNumber: "" }),
    summary: params.summary,
  });

  const outcome = await deliverAndRecord({
    businessId: params.businessId,
    conversationId: params.conversationId,
    credentials: params.credentials,
    ownerPhone: business.contactPhone,
    text,
    attempts: 1,
    reminderMinutes: business.ownerReminderMinutes,
    // Primer pedido: el presupuesto de plantillas esta entero.
    budget: { templatesSent: 0, lastTemplateAt: null },
  });
  return { pending: true, sent: outcome.channel !== "NONE", outcome };
}

// Corre la escalera, deja el rastro (OwnerMessageLog con wamid, para que el acuse de Meta tenga donde
// aterrizar) y escribe en la conversacion por donde salio. Compartido por el primer pedido y por cada
// reintento del perseguidor, para que los dos caminos dejen exactamente el mismo estado.
interface DeliverParams {
  businessId: string;
  conversationId: string;
  credentials: WhatsappCredentials;
  ownerPhone: string;
  text: string;
  /** Intentos hechos contando ESTE. El pedido inicial es 1. */
  attempts: number;
  reminderMinutes: number;
  budget: TemplateBudget;
}

async function deliverAndRecord(params: DeliverParams): Promise<LadderOutcome> {
  const now = new Date();
  const allowTemplate = canSpendTemplate(params.budget, now);
  const outcome = await sendConfirmationLadder(
    params.businessId,
    params.credentials,
    params.ownerPhone,
    params.text,
    allowTemplate
  );

  await recordOwnerMessage(params.businessId, {
    direction: "OUT",
    conversationId: params.conversationId,
    body: params.text,
    success: outcome.channel !== "NONE",
    errorMessage: outcome.error,
    wamid: outcome.wamid,
  });

  const spentTemplate = outcome.channel === "TEMPLATE";
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      pendingConfirmationMessageId: outcome.wamid,
      pendingConfirmationChannel: outcome.channel,
      pendingConfirmationButtonsQueued: outcome.buttonsQueued,
      pendingConfirmationAttempts: params.attempts,
      // La proxima fecha se escribe SIEMPRE, incluso cuando no salio nada: un intento fallido no puede
      // dejar la confirmacion sin reloj, porque entonces el perseguidor no la vuelve a ver.
      pendingConfirmationNextAttemptAt: new Date(
        now.getTime() + nextConfirmationDelayMinutes(params.reminderMinutes, params.attempts) * 60 * 1000
      ),
      ...(spentTemplate
        ? {
            pendingConfirmationTemplatesSent: params.budget.templatesSent + 1,
            pendingConfirmationLastTemplateAt: now,
          }
        : {}),
    },
  });
  return outcome;
}

/**
 * Un reintento del perseguidor (jobs/escalationReminder.ts). Vuelve a armar el mismo texto desde la base
 * y lo manda por la escalera completa: un reintento no hereda el escalon del intento anterior, porque la
 * ventana del dueno pudo abrirse o cerrarse entre medio.
 */
export async function retrySaleConfirmation(params: {
  businessId: string;
  conversationId: string;
  credentials: WhatsappCredentials;
  ownerPhone: string;
  contactName: string | null;
  customer: OwnerConfirmationCustomer;
  summary: string | null;
  attempt: number;
  reminderMinutes: number;
  budget: TemplateBudget;
}): Promise<LadderOutcome> {
  const base = buildSaleConfirmationText({
    contactName: params.contactName,
    customerLabel: describeCustomerForOwner(params.customer),
    summary: params.summary,
  });
  const text = `Recordatorio (intento ${params.attempt}): todavia no me confirmaste este pago y el cliente sigue esperando.\n\n${base}`;

  const outcome = await deliverAndRecord({
    businessId: params.businessId,
    conversationId: params.conversationId,
    credentials: params.credentials,
    ownerPhone: params.ownerPhone,
    text,
    attempts: params.attempt,
    reminderMinutes: params.reminderMinutes,
    budget: params.budget,
  });
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { pendingConfirmationRemindedAt: new Date() },
  });
  return outcome;
}

/**
 * El dueno acaba de escribir cualquier cosa, asi que su ventana de 24h esta abierta de nuevo: sale el
 * mensaje real con botones que habia quedado encolado porque la pregunta tuvo que salir por plantilla.
 *
 * Se llama DESPUES de procesar su respuesta: si lo que escribio ERA la respuesta, la confirmacion ya se
 * cerro y aca no queda nada por mandar - mandarlo antes seria preguntarle algo que acaba de contestar.
 *
 * El wamid de los botones reemplaza al de la plantilla como clave de matcheo, y tiene que ser asi: al
 * apretar un boton, WhatsApp cita el mensaje de los BOTONES, no la plantilla vieja.
 */
export async function drainOwnerConfirmationQueue(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string
): Promise<number> {
  let sent = 0;
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { contactName: true } });
    const queued = await prisma.conversation.findMany({
      where: {
        customer: { businessId },
        pendingConfirmationAskedAt: { not: null },
        pendingConfirmationButtonsQueued: true,
      },
      include: { customer: { select: { name: true, phoneNumber: true } } },
      orderBy: { pendingConfirmationAskedAt: "asc" },
    });

    for (const conversation of queued) {
      const text = buildSaleConfirmationText({
        contactName: business?.contactName ?? null,
        customerLabel: describeCustomerForOwner(conversation.customer),
        summary: conversation.pendingOrderSummary,
      });
      const buttons = await sendToOwner(businessId, credentials, ownerPhone, {
        kind: "buttons",
        text,
        buttons: CONFIRMATION_BUTTONS,
      });
      await recordOwnerMessage(businessId, {
        direction: "OUT",
        conversationId: conversation.id,
        body: text,
        success: buttons.delivered,
        errorMessage: buttons.failure?.message ?? null,
        wamid: buttons.delivered ? buttons.wamid : null,
      });
      if (!buttons.delivered) {
        // Sigue encolado y sigue vivo: el perseguidor lo toma igual en su proxima pasada.
        console.error(`No se pudo entregar la confirmacion encolada (conversation=${conversation.id}):`, buttons.failure?.message);
        continue;
      }
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          pendingConfirmationMessageId: buttons.wamid,
          pendingConfirmationChannel: "BUTTONS",
          pendingConfirmationButtonsQueued: false,
        },
      });
      sent++;
    }
  } catch (error) {
    // Nunca puede romper el procesamiento del mensaje del dueno: esto es una mejora sobre lo que ya
    // salio, no el camino principal.
    console.error("No se pudo drenar la cola de confirmaciones al dueno:", error);
  }
  return sent;
}
