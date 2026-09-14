import { Router } from "express";
import { prisma } from "../../db/client";
import { businessIdOf } from "./shared";

// Fase 5 (ver ONIX-CRM-REORG-PLAN.md): buscador global - un cuadro, cuatro fuentes (P10 del
// diagnostico original: "no hay buscador en conversaciones, clientes, productos ni pedidos").
// Deliberadamente NO toca la Bandeja ni el hilo de mensajes: esos ya tienen su propio buscador de
// clientes (Fase 2, /api/crm/customers?q=) y paginar su lista en vivo exige tocar los handlers de
// Socket.IO que hoy operan directo sobre las filas ya renderizadas (conversation:new/updated buscan
// el .conv-row en el DOM) - un cambio real, no cosmetico, que queda fuera de esta pasada para no
// arriesgar esa vista en vivo sin la verificacion que merece.
export const searchRouter = Router();

const RESULT_LIMIT = 5;

searchRouter.get("/api/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.json({ customers: [], products: [], orders: [], faq: [] });
    return;
  }
  const businessId = businessIdOf(req);
  const digits = q.replace(/[^\d]/g, "");

  const [customers, products, orders, faq] = await Promise.all([
    prisma.customer.findMany({
      where: {
        businessId,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { idNumber: { contains: q, mode: "insensitive" } },
          ...(digits.length >= 3 ? [{ phoneNumber: { contains: digits } }] : []),
        ],
      },
      take: RESULT_LIMIT,
      select: { id: true, name: true, phoneNumber: true },
    }),
    prisma.product.findMany({
      where: { businessId, name: { contains: q, mode: "insensitive" } },
      take: RESULT_LIMIT,
      select: { id: true, name: true, price: true, currency: true },
    }),
    prisma.order.findMany({
      where: {
        businessId,
        OR: [{ summary: { contains: q, mode: "insensitive" } }, { customer: { name: { contains: q, mode: "insensitive" } } }],
      },
      take: RESULT_LIMIT,
      orderBy: { createdAt: "desc" },
      select: { id: true, summary: true, totalAmount: true, currency: true, fulfillmentStatus: true, customer: { select: { name: true, phoneNumber: true } } },
    }),
    prisma.faqEntry.findMany({
      where: { businessId, OR: [{ question: { contains: q, mode: "insensitive" } }, { answer: { contains: q, mode: "insensitive" } }] },
      take: RESULT_LIMIT,
      select: { id: true, question: true },
    }),
  ]);

  res.json({
    customers,
    products: products.map((p) => ({ ...p, price: Number(p.price) })),
    orders: orders.map((o) => ({ ...o, totalAmount: Number(o.totalAmount) })),
    faq,
  });
});
