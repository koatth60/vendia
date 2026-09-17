import { prisma } from "../db/client";

// LOS PLANES SE VENDEN POR CHATS, NO POR MENSAJES (2026-09-17).
//
// Un chat es una INTERACCION COMPLETA con un cliente: puede terminar en compra o quedar a medias. Se
// abre con el primer mensaje de ese cliente y se cierra sola cuando pasan CHAT_WINDOW_HOURS sin que
// nadie escriba. Todo lo que decide si un chat esta abierto sale de la base (BillableChat.lastMessageAt
// contra el reloj): no hay job que cierre nada, no hay estado que mantener al dia, y dos consultas
// hechas en el mismo instante no pueden llegar a cuentas distintas.
//
// Reemplaza a PLAN_MESSAGE_CAPS, que vivia en ai/usage.ts y contaba filas de Message. Ese contador no
// era la unidad que se vende: un cliente que manda "hola", "?", "ahi estas?" gastaba tres del plan.

export const CHAT_WINDOW_HOURS = 48;

// Topes de la propuesta comercial vigente (presentacion "Propuesta Comercial y Beneficios").
// Ninguno es ilimitado: NEGOCIO tambien tiene tope, y pasarlo ya no apaga nada, se factura.
export const PLAN_CHAT_CAPS: Record<string, number> = {
  BASICO: 500, // Starter
  EMPRENDEDOR: 1200, // Crecimiento
  NEGOCIO: 2700, // Escala
};

// Lo que cuesta cada chat por encima del tope del plan. En COP porque es el precio de lista publicado;
// un negocio que factura en otra moneda se cotiza aparte, no se convierte aca a una tasa inventada.
export const EXTRA_CHAT_PRICE_COP = 350;

export function getChatCap(planTier: string): number {
  return PLAN_CHAT_CAPS[planTier] ?? PLAN_CHAT_CAPS.BASICO;
}

/** Primer instante del mes calendario al que pertenece `date`. El periodo de facturacion. */
export function periodStartOf(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Registra que este cliente acaba de escribir (o que le acaban de escribir) y devuelve si eso ABRIO un
 * chat nuevo o si cayo dentro de uno que ya estaba abierto.
 *
 * Es la unica puerta por la que se cuenta un chat. Se llama con el mensaje entrante del cliente ya
 * identificado, antes de decidir nada sobre la respuesta: un chat se factura porque el cliente
 * interactuo con el negocio, no porque el bot haya contestado. Una conversacion en control humano, o
 * una que el bot no supo resolver, cuenta igual - es la misma interaccion vendida.
 */
export async function recordBillableChat(params: {
  businessId: string;
  customerId: string;
  conversationId?: string;
  at?: Date;
}): Promise<{ chatId: string; opened: boolean }> {
  const at = params.at ?? new Date();
  const windowStart = new Date(at.getTime() - CHAT_WINDOW_HOURS * 60 * 60 * 1000);

  const open = await prisma.billableChat.findFirst({
    where: { customerId: params.customerId, lastMessageAt: { gte: windowStart } },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, lastMessageAt: true },
  });

  if (open) {
    await prisma.billableChat.update({
      where: { id: open.id },
      data: {
        // Un webhook que llega tarde no debe mover el reloj hacia atras y reabrir una ventana que ya
        // habia cerrado para los mensajes que vinieron despues.
        lastMessageAt: at > open.lastMessageAt ? at : open.lastMessageAt,
        messageCount: { increment: 1 },
      },
    });
    return { chatId: open.id, opened: false };
  }

  const created = await prisma.billableChat.create({
    data: {
      businessId: params.businessId,
      customerId: params.customerId,
      conversationId: params.conversationId,
      startedAt: at,
      lastMessageAt: at,
      periodStart: periodStartOf(at),
    },
    select: { id: true },
  });
  return { chatId: created.id, opened: true };
}

export interface ChatUsage {
  planTier: string;
  chatCap: number;
  chatsUsed: number;
  /** Chats por encima del tope. 0 si todavia no lo paso. */
  extraChats: number;
  /** Lo que suman esos chats extra al precio de lista. 0 si no hay extras. */
  extraChargeCop: number;
  extraChatPriceCop: number;
  usagePercent: number;
  periodStart: Date;
}

/** Cuantos chats lleva este negocio en el mes corriente, y cuanto debe por los que pasaron del tope. */
export async function getChatUsage(businessId: string, now = new Date()): Promise<ChatUsage> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { planTier: true },
  });
  const planTier = business?.planTier ?? "BASICO";
  const chatCap = getChatCap(planTier);
  const periodStart = periodStartOf(now);

  const chatsUsed = await prisma.billableChat.count({ where: { businessId, periodStart } });
  const extraChats = Math.max(0, chatsUsed - chatCap);

  return {
    planTier,
    chatCap,
    chatsUsed,
    extraChats,
    extraChargeCop: extraChats * EXTRA_CHAT_PRICE_COP,
    extraChatPriceCop: EXTRA_CHAT_PRICE_COP,
    usagePercent: Math.round((chatsUsed / chatCap) * 1000) / 10,
    periodStart,
  };
}

/**
 * Si este negocio ya paso el tope de su plan, y si es la PRIMERA vez que lo pasa en este periodo (lo
 * unico que decide si hay que avisarle al dueno).
 *
 * NO apaga el bot. Antes esto se llamaba checkPlanCap y cortaba la respuesta automatica hasta el mes
 * siguiente; desde que los chats extra se facturan a EXTRA_CHAT_PRICE_COP, cortar el servicio seria
 * cobrar por algo que no se presta. El unico efecto de cruzar el tope es el aviso al dueno.
 *
 * ESTO DEJA AL SISTEMA SIN FRENO DE GASTO. Era el unico tope que existia: un negocio con un pico raro
 * (o con un bucle) ahora sigue llamando a la IA sin limite. El freno que reemplaza al corte tiene que
 * ser un techo explicito y configurable, no este.
 */
export async function checkChatOverage(
  businessId: string
): Promise<{ overLimit: boolean; justCrossed: boolean } & ChatUsage> {
  const usage = await getChatUsage(businessId);
  if (usage.extraChats === 0) {
    return { ...usage, overLimit: false, justCrossed: false };
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { capNotifiedAt: true },
  });
  const justCrossed = !business?.capNotifiedAt || business.capNotifiedAt < usage.periodStart;
  if (justCrossed) {
    await prisma.business.update({ where: { id: businessId }, data: { capNotifiedAt: new Date() } });
  }

  return { ...usage, overLimit: true, justCrossed };
}
