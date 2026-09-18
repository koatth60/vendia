import { Router } from "express";
import type { PromotionKind, PromotionScope } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client";
import { categoriaNormalizada } from "../../catalog/promotions";
import { requireOwner } from "../../auth/requireOwner";
import { businessIdOf } from "./shared";

// E37 (2026-09-18). El panel de promociones.
//
// Va en la MISMA etapa que el dato a proposito: una promocion que solo se puede cargar con un script no
// existe para la duena, y lo que la duena no puede cargar lo sigue escribiendo como frase en las
// instrucciones -- que es de donde esta etapa vino a sacarlo.
export const promotionsRouter = Router();

const KINDS: PromotionKind[] = ["PERCENT", "AMOUNT"];
const SCOPES: PromotionScope[] = ["GLOBAL", "CATEGORY", "PRODUCT"];

/**
 * Valida el cuerpo entero antes de tocar la base. Una promocion a medias no se guarda: un porcentaje
 * de 200 o un alcance CATEGORY sin categoria terminaria en un precio que nadie eligio, y el precio es
 * lo que se le cobra a una clienta.
 */
function leerPromocion(body: Record<string, unknown>): { error: string } | { datos: Prisma.PromotionUncheckedCreateInput } {
  const name = String(body?.name ?? "").trim();
  if (!name) return { error: "Falta el nombre de la promoción" };

  const kind = String(body?.kind ?? "") as PromotionKind;
  if (!KINDS.includes(kind)) return { error: "El tipo tiene que ser PERCENT o AMOUNT" };

  const valor = Number(body?.value);
  if (!Number.isFinite(valor) || valor <= 0) return { error: "El descuento tiene que ser mayor que cero" };
  if (kind === "PERCENT" && valor > 100) return { error: "Un porcentaje no puede pasar de 100" };

  const scope = String(body?.scope ?? "") as PromotionScope;
  if (!SCOPES.includes(scope)) return { error: "El alcance tiene que ser GLOBAL, CATEGORY o PRODUCT" };

  const categoryLabel = String(body?.categoryLabel ?? "").trim() || null;
  const productId = String(body?.productId ?? "").trim() || null;
  if (scope === "CATEGORY" && !categoryLabel) return { error: "Una promoción de categoría necesita la categoría" };
  if (scope === "PRODUCT" && !productId) return { error: "Una promoción de producto necesita el producto" };

  const minQuantity = body?.minQuantity === undefined ? 1 : Math.floor(Number(body.minQuantity));
  if (!Number.isFinite(minQuantity) || minQuantity < 1) return { error: "El mínimo de unidades tiene que ser 1 o más" };

  const startsAt = body?.startsAt ? new Date(String(body.startsAt)) : null;
  const endsAt = body?.endsAt ? new Date(String(body.endsAt)) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) return { error: "La fecha de inicio no es válida" };
  if (endsAt && Number.isNaN(endsAt.getTime())) return { error: "La fecha de fin no es válida" };
  if (startsAt && endsAt && endsAt < startsAt) return { error: "La promoción no puede terminar antes de empezar" };

  return {
    datos: {
      businessId: "",
      name,
      kind,
      value: new Prisma.Decimal(valor.toString()),
      scope,
      // Solo se guarda lo que corresponde al alcance: una promocion GLOBAL con una categoria vieja
      // adentro es una trampa para el que la lea despues.
      categoryLabel: scope === "CATEGORY" ? categoryLabel : null,
      categoryNormalized: scope === "CATEGORY" ? categoriaNormalizada(categoryLabel) : null,
      productId: scope === "PRODUCT" ? productId : null,
      minQuantity,
      startsAt,
      endsAt,
      active: body?.active === undefined ? true : Boolean(body.active),
    },
  };
}

promotionsRouter.get("/api/promotions", async (req, res) => {
  const promociones = await prisma.promotion.findMany({
    where: { businessId: businessIdOf(req) },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    include: { product: { select: { id: true, name: true } } },
  });
  res.json(promociones);
});

promotionsRouter.post("/api/promotions", requireOwner, async (req, res) => {
  const leido = leerPromocion(req.body ?? {});
  if ("error" in leido) {
    res.status(400).json({ error: leido.error });
    return;
  }
  const businessId = businessIdOf(req);
  // El producto tiene que ser de ESTE negocio: sin esto, un id de otro inquilino dejaria una promocion
  // apuntando a un catalogo ajeno.
  if (leido.datos.productId) {
    const existe = await prisma.product.findFirst({ where: { id: leido.datos.productId, businessId }, select: { id: true } });
    if (!existe) {
      res.status(400).json({ error: "Ese producto no existe en este negocio" });
      return;
    }
  }
  res.status(201).json(await prisma.promotion.create({ data: { ...leido.datos, businessId } }));
});

promotionsRouter.put("/api/promotions/:id", requireOwner, async (req, res) => {
  const businessId = businessIdOf(req);
  const actual = await prisma.promotion.findFirst({ where: { id: String(req.params.id), businessId }, select: { id: true } });
  if (!actual) {
    res.status(404).json({ error: "No existe esa promoción" });
    return;
  }
  const leido = leerPromocion(req.body ?? {});
  if ("error" in leido) {
    res.status(400).json({ error: leido.error });
    return;
  }
  if (leido.datos.productId) {
    const existe = await prisma.product.findFirst({ where: { id: leido.datos.productId, businessId }, select: { id: true } });
    if (!existe) {
      res.status(400).json({ error: "Ese producto no existe en este negocio" });
      return;
    }
  }
  const { businessId: _ignorado, ...datos } = leido.datos;
  res.json(await prisma.promotion.update({ where: { id: actual.id }, data: datos }));
});

promotionsRouter.delete("/api/promotions/:id", requireOwner, async (req, res) => {
  const businessId = businessIdOf(req);
  const { count } = await prisma.promotion.deleteMany({ where: { id: String(req.params.id), businessId } });
  if (count === 0) {
    res.status(404).json({ error: "No existe esa promoción" });
    return;
  }
  res.status(204).end();
});
