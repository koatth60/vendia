import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client";
import { listarCombos } from "../../catalog/bundles";
import { requireOwner } from "../../auth/requireOwner";
import { businessIdOf } from "./shared";

// E38 (2026-09-18). El panel de combos.
//
// Va en la misma etapa que el dato, como manda la regla: un combo que solo se puede cargar con un
// script no existe para la duena, y lo que la duena no puede cargar lo sigue escribiendo como prosa en
// la descripcion de un producto -- que es de donde esta etapa vino a sacarlo.
export const bundlesRouter = Router();

interface ContenidoLeido {
  productId: string;
  variantId: string | null;
  quantity: number;
}

function leerContenido(valor: unknown): ContenidoLeido[] | null {
  if (!Array.isArray(valor) || valor.length === 0) return null;
  const items: ContenidoLeido[] = [];
  for (const crudo of valor) {
    const productId = String((crudo as { productId?: unknown })?.productId ?? "").trim();
    if (!productId) return null;
    const quantity = Math.floor(Number((crudo as { quantity?: unknown })?.quantity ?? 1));
    if (!Number.isFinite(quantity) || quantity < 1) return null;
    const variantId = String((crudo as { variantId?: unknown })?.variantId ?? "").trim() || null;
    items.push({ productId, variantId, quantity });
  }
  return items;
}

/**
 * Valida el combo entero antes de tocar la base, y valida que cada componente sea de ESTE negocio.
 *
 * Un combo a medias no se guarda: sin componentes su disponibilidad es 0 y el bot no puede prometerlo,
 * asi que guardarlo solo deja una fila que no sirve y que alguien tiene que descubrir.
 */
async function leerCombo(businessId: string, body: Record<string, unknown>) {
  const name = String(body?.name ?? "").trim();
  if (!name) return { error: "Falta el nombre del combo" } as const;

  const price = Number(body?.price);
  if (!Number.isFinite(price) || price <= 0) return { error: "El precio del combo tiene que ser mayor que cero" } as const;

  const contenido = leerContenido(body?.items);
  if (!contenido) return { error: "Un combo necesita al menos un producto, con su cantidad" } as const;

  const productos = await prisma.product.findMany({
    where: { id: { in: contenido.map((c) => c.productId) }, businessId },
    select: { id: true, currency: true, variants: { select: { id: true } } },
  });
  for (const componente of contenido) {
    const producto = productos.find((p) => p.id === componente.productId);
    if (!producto) return { error: "Uno de los productos del combo no existe en este negocio" } as const;
    if (componente.variantId && !producto.variants.some((v) => v.id === componente.variantId)) {
      return { error: "Una de las variantes elegidas no pertenece a su producto" } as const;
    }
  }

  // La moneda sale de los productos, no del formulario: un combo en otra moneda que sus componentes no
  // es un combo, es un total sin significado (ver src/config/dinero.ts).
  const monedas = [...new Set(productos.map((p) => p.currency))];
  if (monedas.length > 1) return { error: "Los productos del combo están en monedas distintas" } as const;

  return {
    datos: {
      name,
      description: String(body?.description ?? "").trim() || null,
      price: new Prisma.Decimal(price.toString()),
      currency: monedas[0],
      active: body?.active === undefined ? true : Boolean(body.active),
    },
    contenido,
  } as const;
}

bundlesRouter.get("/api/bundles", async (req, res) => {
  const combos = await listarCombos(businessIdOf(req), { soloActivos: false });
  // `price` es un Money: al panel va como numero, que es donde se muestra y ya no se opera.
  res.json(combos.map((c) => ({ ...c, price: c.price.comoNumeroParaMostrar() })));
});

bundlesRouter.post("/api/bundles", requireOwner, async (req, res) => {
  const businessId = businessIdOf(req);
  const leido = await leerCombo(businessId, req.body ?? {});
  if ("error" in leido) {
    res.status(400).json({ error: leido.error });
    return;
  }
  const creado = await prisma.bundle.create({
    data: {
      businessId,
      ...leido.datos,
      items: { create: leido.contenido },
    },
  });
  res.status(201).json(creado);
});

bundlesRouter.put("/api/bundles/:id", requireOwner, async (req, res) => {
  const businessId = businessIdOf(req);
  const id = String(req.params.id);
  const actual = await prisma.bundle.findFirst({ where: { id, businessId }, select: { id: true } });
  if (!actual) {
    res.status(404).json({ error: "No existe ese combo" });
    return;
  }
  const leido = await leerCombo(businessId, req.body ?? {});
  if ("error" in leido) {
    res.status(400).json({ error: leido.error });
    return;
  }
  // El contenido se reemplaza entero en la misma transaccion: un combo a mitad de edicion -- con los
  // componentes viejos borrados y los nuevos sin escribir -- es un combo que el bot puede cotizar vacio.
  const actualizado = await prisma.$transaction(async (tx) => {
    await tx.bundleItem.deleteMany({ where: { bundleId: id } });
    return tx.bundle.update({
      where: { id },
      data: { ...leido.datos, items: { create: leido.contenido } },
    });
  });
  res.json(actualizado);
});

bundlesRouter.delete("/api/bundles/:id", requireOwner, async (req, res) => {
  const businessId = businessIdOf(req);
  const { count } = await prisma.bundle.deleteMany({ where: { id: String(req.params.id), businessId } });
  if (count === 0) {
    res.status(404).json({ error: "No existe ese combo" });
    return;
  }
  res.status(204).end();
});
