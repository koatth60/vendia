import type { CustomerStage, Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { Money, sumarParaMostrar } from "../config/dinero";

// Capa de lectura/escritura del CRM de clientes (Fase 2, ver ONIX-CRM-REORG-PLAN.md).
//
// Deliberadamente separada de conversation/service.ts: ese archivo modela la conversacion (el ciclo de
// venta) y lo consume el agente en el camino caliente de WhatsApp. Esto modela al CLIENTE como persona
// y solo lo consume el panel. Mantenerlos aparte evita que una consulta pesada del CRM termine colgada
// del webhook.

export const CUSTOMER_STAGES = ["NUEVO", "ACTIVO", "COMPRADOR", "RECURRENTE", "INACTIVO"] as const;

export function isCustomerStage(value: unknown): value is CustomerStage {
  return typeof value === "string" && (CUSTOMER_STAGES as readonly string[]).includes(value);
}

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export interface CustomerListFilters {
  q?: string;
  stage?: string;
  tag?: string;
  cursor?: string;
  limit?: number;
}

// Paginacion por cursor sobre (lastContactAt desc, id desc) en vez de skip/take: con skip, insertar un
// mensaje nuevo mientras el dueño pagina corre todas las filas y le repite o le saltea clientes. El
// cursor es el id de la ultima fila entregada; se resuelve su lastContactAt y se pide "lo estrictamente
// anterior a ese par", que es estable aunque entren clientes nuevos entre una pagina y la siguiente.
export async function listCustomersForBusiness(businessId: string, filters: CustomerListFilters = {}) {
  const take = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const conditions: Prisma.CustomerWhereInput[] = [];

  const q = filters.q?.trim();
  if (q) conditions.push(buildSearchCondition(q));
  if (isCustomerStage(filters.stage)) conditions.push({ stage: filters.stage });
  if (filters.tag?.trim()) conditions.push({ tags: { has: filters.tag.trim() } });

  // El cursor va aparte de los filtros: el total tiene que contar TODO lo que
  // matchea los filtros, no solo lo que queda despues de esta pagina.
  const cursorConditions: Prisma.CustomerWhereInput[] = [];

  if (filters.cursor) {
    const anchor = await prisma.customer.findFirst({
      where: { id: filters.cursor, businessId },
      select: { id: true, lastContactAt: true },
    });
    // Cursor desconocido (fila borrada entre dos paginas): se ignora y se devuelve la primera pagina,
    // en vez de fallar o devolver vacio.
    if (anchor) {
      cursorConditions.push(
        anchor.lastContactAt
          ? {
              OR: [
                { lastContactAt: { lt: anchor.lastContactAt } },
                { lastContactAt: anchor.lastContactAt, id: { lt: anchor.id } },
              ],
            }
          : { lastContactAt: null, id: { lt: anchor.id } }
      );
    }
  }

  const filterWhere: Prisma.CustomerWhereInput =
    conditions.length > 0 ? { businessId, AND: conditions } : { businessId };
  const pageConditions = [...conditions, ...cursorConditions];
  const where: Prisma.CustomerWhereInput =
    pageConditions.length > 0 ? { businessId, AND: pageConditions } : { businessId };

  const total = await prisma.customer.count({ where: filterWhere });

  const rows = await prisma.customer.findMany({
    where,
    orderBy: [{ lastContactAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      email: true,
      stage: true,
      channel: true,
      tags: true,
      lastContactAt: true,
      createdAt: true,
      _count: { select: { orders: true } },
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    customers: page.map((c) => ({
      id: c.id,
      name: c.name,
      phoneNumber: c.phoneNumber,
      email: c.email,
      stage: c.stage,
      channel: c.channel,
      tags: c.tags,
      lastContactAt: c.lastContactAt,
      createdAt: c.createdAt,
      orderCount: c._count.orders,
    })),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    total,
  };
}

function buildSearchCondition(q: string): Prisma.CustomerWhereInput {
  const digits = q.replace(/[^\d]/g, "");
  const or: Prisma.CustomerWhereInput[] = [
    { name: { contains: q, mode: "insensitive" } },
    { email: { contains: q, mode: "insensitive" } },
    { idNumber: { contains: q, mode: "insensitive" } },
  ];
  if (digits.length >= 3) or.push({ phoneNumber: { contains: digits } });
  return { OR: or };
}

// Ficha completa: identidad + metricas calculadas desde Order + pedidos + notas + ciclos de conversacion.
// Las metricas se calculan al vuelo a proposito (ver plan 2.4): con los indices actuales es una sola
// consulta por cliente abierto, no vale la pena desnormalizar todavia y asi nunca quedan desfasadas.
export async function getCustomerProfile(businessId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId },
    include: {
      orders: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          summary: true,
          totalAmount: true,
          currency: true,
          fulfillmentStatus: true,
          createdAt: true,
          conversationId: true,
        },
      },
      notes: { orderBy: { createdAt: "desc" } },
      conversations: {
        orderBy: { updatedAt: "desc" },
        select: { id: true, status: true, intent: true, humanControl: true, updatedAt: true, channel: true },
      },
    },
  });
  if (!customer) return null;

  const paidOrders = customer.orders.filter((o) => o.fulfillmentStatus !== "CANCELED");
  const orderCount = paidOrders.length;
  const currency = paidOrders[0]?.currency ?? "COP";
  // E33: lo que un cliente gasto es plata, y sumarla en flotante es lo que esta etapa vino a sacar.
  const totalSpent = sumarParaMostrar(
    paidOrders.map((o) => Money.de(o.totalAmount, o.currency)),
    currency,
    "el total gastado por un cliente",
  ).comoNumeroParaMostrar();
  const purchaseDates = paidOrders.map((o) => o.createdAt).sort((a, b) => a.getTime() - b.getTime());
  const daysSinceContact = customer.lastContactAt
    ? Math.floor((Date.now() - customer.lastContactAt.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  // La conversacion "activa" es la misma que usa la Bandeja: el ciclo que todavia no cerro. Se devuelve
  // para que la ficha pueda enlazar directo al chat sin que el frontend tenga que repetir esa regla.
  const activeConversationId =
    customer.conversations.find((c) => c.status !== "SOLD" && c.status !== "LOST")?.id ??
    customer.conversations[0]?.id ??
    null;

  return {
    id: customer.id,
    name: customer.name,
    phoneNumber: customer.phoneNumber,
    email: customer.email,
    address: customer.address,
    idNumber: customer.idNumber,
    deliveryPhone: customer.deliveryPhone,
    stage: customer.stage,
    channel: customer.channel,
    source: customer.source,
    tags: customer.tags,
    lastContactAt: customer.lastContactAt,
    createdAt: customer.createdAt,
    activeConversationId,
    metrics: {
      totalSpent,
      currency,
      orderCount,
      avgTicket: orderCount > 0 ? totalSpent / orderCount : 0,
      firstPurchaseAt: purchaseDates[0] ?? null,
      lastPurchaseAt: purchaseDates[purchaseDates.length - 1] ?? null,
      daysSinceContact,
    },
    orders: customer.orders.map((o) => ({
      id: o.id,
      summary: o.summary,
      totalAmount: Number(o.totalAmount),
      currency: o.currency,
      fulfillmentStatus: o.fulfillmentStatus,
      createdAt: o.createdAt,
      conversationId: o.conversationId,
    })),
    notes: customer.notes.map((n) => ({
      id: n.id,
      body: n.body,
      authorName: n.authorName,
      createdAt: n.createdAt,
    })),
    conversations: customer.conversations,
  };
}

export interface CustomerProfileUpdate {
  name?: string | null;
  email?: string | null;
  address?: string | null;
  idNumber?: string | null;
  deliveryPhone?: string | null;
  source?: string | null;
  stage?: string;
  tags?: string[];
}

// Solo escribe los campos que vienen definidos. Cualquier campo ausente se deja como esta (undefined =
// Prisma lo omite del UPDATE) - importante porque la ficha guarda por seccion y no manda el objeto entero.
export async function updateCustomerProfile(
  businessId: string,
  customerId: string,
  data: CustomerProfileUpdate
) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } });
  if (!existing) return null;

  return prisma.customer.update({
    where: { id: customerId },
    data: {
      name: data.name === undefined ? undefined : data.name || null,
      email: data.email === undefined ? undefined : data.email || null,
      address: data.address === undefined ? undefined : data.address || null,
      idNumber: data.idNumber === undefined ? undefined : data.idNumber || null,
      deliveryPhone: data.deliveryPhone === undefined ? undefined : data.deliveryPhone || null,
      source: data.source === undefined ? undefined : data.source || null,
      stage: isCustomerStage(data.stage) ? data.stage : undefined,
      tags: data.tags === undefined ? undefined : data.tags.map((t) => String(t).trim()).filter(Boolean),
    },
  });
}

/**
 * E41 (2026-09-18). La etapa del cliente la calcula el SERVIDOR, a partir de sus pedidos.
 *
 * Hasta hoy `CustomerStage` estaba practicamente muerta: nada escribia jamas COMPRADOR ni RECURRENTE.
 * Medido en produccion, los 84 clientes tocados en siete dias estaban TODOS en NUEVO, incluidos los que
 * ya habian comprado. O sea que la columna existia, el panel la mostraba, y no significaba nada.
 *
 * La regla, en orden y sin empates posibles:
 *
 *   2 o mas pedidos  -> RECURRENTE
 *   1 pedido         -> COMPRADOR
 *   ningun pedido    -> se deja como esta (NUEVO, ACTIVO o INACTIVO)
 *
 * Solo SUBE. Un cliente que ya compro no vuelve a NUEVO porque se le cancele algo o pase el tiempo: eso
 * lo maneja markCustomerInactive, que a proposito no toca a COMPRADOR ni RECURRENTE.
 *
 * Se cuentan los pedidos que existen, no los "cerrados con exito": un pedido cancelado igual prueba que
 * esta persona llego a comprar. Si mas adelante se quiere excluir los cancelados, es un where aca y una
 * decision aparte - no un cambio de forma.
 */
export async function recalcularEtapaDelCliente(businessId: string, customerId: string): Promise<void> {
  const pedidos = await prisma.order.count({
    where: { conversation: { customer: { id: customerId, businessId } } },
  });
  if (pedidos === 0) return;
  const etapa = pedidos >= 2 ? "RECURRENTE" : "COMPRADOR";
  // updateMany con la etapa actual en el WHERE: no reescribe la fila si ya estaba bien, asi que el job
  // diario no genera escrituras por cada cliente en cada pasada.
  await prisma.customer.updateMany({
    where: { id: customerId, businessId, stage: { not: etapa } },
    data: { stage: etapa },
  });
}

// Fase 9 del plan maestro (2026-09-15): CustomerStage.INACTIVO existia en el enum desde antes pero nada
// lo escribia nunca (comentario del propio schema.prisma:520). jobs/abandonment.ts llama esto cuando una
// de las conversaciones del cliente pasa a ABANDONED por inactividad. Solo baja NUEVO/ACTIVO - un cliente
// que ya es COMPRADOR/RECURRENTE no pierde ese historial porque UNA conversacion se enfrio; su etapa la
// sigue decidiendo el dueno a mano desde el panel.
export async function markCustomerInactive(businessId: string, customerId: string): Promise<void> {
  await prisma.customer.updateMany({
    where: { id: customerId, businessId, stage: { in: ["NUEVO", "ACTIVO"] } },
    data: { stage: "INACTIVO" },
  });
}

export async function addCustomerNote(
  businessId: string,
  customerId: string,
  body: string,
  authorName: string | null
) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } });
  if (!customer) return null;
  return prisma.customerNote.create({ data: { businessId, customerId, body, authorName } });
}

export async function deleteCustomerNote(businessId: string, noteId: string): Promise<boolean> {
  const result = await prisma.customerNote.deleteMany({ where: { id: noteId, businessId } });
  return result.count > 0;
}

export async function listCustomerTags(businessId: string) {
  return prisma.customerTag.findMany({ where: { businessId }, orderBy: { label: "asc" } });
}

export async function createCustomerTag(businessId: string, label: string, color?: string) {
  const clean = label.trim();
  if (!clean) throw new Error("La etiqueta no puede estar vacia");
  return prisma.customerTag.upsert({
    where: { businessId_label: { businessId, label: clean } },
    update: color ? { color } : {},
    create: { businessId, label: clean, color: color || undefined },
  });
}

export async function deleteCustomerTag(businessId: string, id: string): Promise<boolean> {
  const result = await prisma.customerTag.deleteMany({ where: { id, businessId } });
  return result.count > 0;
}

// Linea de tiempo unificada: mensajes, pedidos y notas del cliente en un solo orden cronologico. Se
// arma en memoria sobre tres consultas acotadas en vez de una vista SQL - son tablas distintas sin
// nada en comun mas que el cliente, y el volumen por cliente es chico.
export async function getCustomerTimeline(businessId: string, customerId: string, limit = 60) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } });
  if (!customer) return null;

  const [messages, orders, notes] = await Promise.all([
    prisma.message.findMany({
      where: { conversation: { customerId } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, role: true, content: true, mediaType: true, createdAt: true },
    }),
    prisma.order.findMany({
      where: { customerId, businessId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, summary: true, totalAmount: true, currency: true, fulfillmentStatus: true, createdAt: true },
    }),
    prisma.customerNote.findMany({
      where: { customerId, businessId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, body: true, authorName: true, createdAt: true },
    }),
  ]);

  const events = [
    ...messages.map((m) => ({
      kind: "MESSAGE" as const,
      id: m.id,
      createdAt: m.createdAt,
      detail: m.mediaType ? `[${m.mediaType}] ${m.content}` : m.content,
      meta: { role: m.role },
    })),
    ...orders.map((o) => ({
      kind: "ORDER" as const,
      id: o.id,
      createdAt: o.createdAt,
      detail: o.summary,
      meta: { totalAmount: Number(o.totalAmount), currency: o.currency, status: o.fulfillmentStatus },
    })),
    ...notes.map((n) => ({
      kind: "NOTE" as const,
      id: n.id,
      createdAt: n.createdAt,
      detail: n.body,
      meta: { authorName: n.authorName },
    })),
  ];

  events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return events.slice(0, limit);
}

// Usado por recordMessage en cada mensaje: marca la recencia del cliente para la lista del CRM. Es un
// UPDATE por id sin joins; si falla, no debe tumbar el mensaje que ya se guardo (el llamador lo envuelve).
export async function touchCustomerLastContact(customerId: string, at: Date = new Date()): Promise<void> {
  await prisma.customer.update({ where: { id: customerId }, data: { lastContactAt: at } });
}
