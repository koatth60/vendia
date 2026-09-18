import { Prisma, type Promotion, type PromotionKind, type PromotionScope } from "@prisma/client";
import { prisma } from "../db/client";
import { Money } from "../config/dinero";
import { normalizeForMatch } from "../search/text";

// E37 (2026-09-18). UNA PROMOCION ES UN DATO.
//
// Antes un descuento del negocio vivia como frase en `customInstructions` y el modelo tenia que
// acordarse de aplicarlo. Acordarse no es una garantia: lo aplicaba a veces, y cuando lo aplicaba
// calculaba el numero el mismo.
//
// QUE DECISION LE QUITA AL MODELO: cual es el precio con descuento. Ahora no hay ninguna: el descuento
// entra en `precioDeVenta`, que es el unico lugar que le pone precio a una linea, asi que lo que el bot
// DICE y lo que se COBRA salen del mismo calculo. El modelo puede contar que hay una promo; no puede
// equivocarse en la cifra porque no la escribe.

/** Lo minimo que hace falta de una promocion para decidir y calcular. */
export interface PromocionAplicable {
  id: string;
  name: string;
  kind: PromotionKind;
  value: Prisma.Decimal;
  scope: PromotionScope;
  categoryNormalized: string | null;
  productId: string | null;
  minQuantity: number;
}

/** Las vigentes AHORA: activas y dentro de fechas. La vigencia la decide la base, no el modelo. */
export async function promocionesVigentes(businessId: string, ahora = new Date()): Promise<Promotion[]> {
  return prisma.promotion.findMany({
    where: {
      businessId,
      active: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: ahora } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: ahora } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Cuanto mas especifica es. Un descuento de un producto gana sobre uno de categoria, y ese sobre uno global. */
function especificidad(scope: PromotionScope): number {
  return scope === "PRODUCT" ? 3 : scope === "CATEGORY" ? 2 : 1;
}

function alcanza(promo: PromocionAplicable, linea: { productId: string; category: string | null; quantity: number }): boolean {
  if (linea.quantity < promo.minQuantity) return false;
  if (promo.scope === "GLOBAL") return true;
  if (promo.scope === "PRODUCT") return promo.productId === linea.productId;
  if (!promo.categoryNormalized) return false;
  return normalizeForMatch(linea.category ?? "") === promo.categoryNormalized;
}

/**
 * Cual promocion aplica a esta linea. UNA, no varias: apilar descuentos es una decision de negocio que
 * nadie tomo, y la suma de dos promociones puede dejar un precio en cero sin que la duena lo pidiera.
 *
 * El orden de desempate es fijo -- primero la que deja el precio mas bajo (que es lo que la clienta
 * espera cuando ve dos carteles), despues la mas especifica, despues la mas vieja. Fijo importa mas que
 * cual sea: dos turnos con el mismo catalogo tienen que dar el mismo precio.
 */
export function promocionQueAplica(
  promociones: PromocionAplicable[],
  precioDeLista: Money,
  linea: { productId: string; category: string | null; quantity: number },
): PromocionAplicable | null {
  const candidatas = promociones.filter((p) => alcanza(p, linea));
  if (candidatas.length === 0) return null;

  return candidatas.reduce((mejor, actual) => {
    const compara = precioConDescuento(precioDeLista, actual).comparar(precioConDescuento(precioDeLista, mejor));
    if (compara !== 0) return compara < 0 ? actual : mejor;
    const esp = especificidad(actual.scope) - especificidad(mejor.scope);
    if (esp !== 0) return esp > 0 ? actual : mejor;
    return actual.id < mejor.id ? actual : mejor;
  });
}

/**
 * El precio unitario con el descuento puesto.
 *
 * NUNCA NEGATIVO: un monto fijo mas grande que el precio deja la linea en cero, no en deuda. Se topea
 * en cero y punto -- rechazar la promo entera aca dejaria a la clienta viendo un precio distinto del
 * que vio hace un segundo, y la promo mal cargada se arregla en el panel, no a mitad de una venta.
 */
export function precioConDescuento(precioDeLista: Money, promo: PromocionAplicable | null): Money {
  if (!promo) return precioDeLista;
  const descuento =
    promo.kind === "PERCENT" ? precioDeLista.porPorcentaje(promo.value) : Money.de(promo.value, precioDeLista.moneda);
  const conDescuento = precioDeLista.menos(descuento);
  return conDescuento.esNegativo() ? Money.cero(precioDeLista.moneda) : conDescuento;
}

/** Normaliza lo que escribio la duena, para poder comparar con `Product.category` sin acentos ni mayusculas. */
export function categoriaNormalizada(categoria: string | null | undefined): string | null {
  const limpia = (categoria ?? "").trim();
  return limpia ? normalizeForMatch(limpia) : null;
}

/**
 * Las promociones vigentes, como DATO para el turno.
 *
 * POR QUE NO ES UNA HERRAMIENTA, aunque la ficha de E37 decia `get_active_promotions`. Una herramienta
 * cuesta tokens en CADA peticion de CADA negocio -- tenga promociones o no -- y solo sirve si el modelo
 * se acuerda de llamarla. Esto cuesta cero cuando no hay ninguna promocion (que es el caso normal) y no
 * se puede ignorar cuando la hay, porque ya esta delante del modelo.
 *
 * Y sobre todo: la cifra no depende de esto. El precio con descuento sale de `precioDeVenta`, asi que
 * aunque el modelo no mencione la promo, la clienta la paga igual. Esto es para que pueda CONTARLA.
 */
export async function promocionesParaElModelo(
  businessId: string,
  formatoDeFecha: { locale: string; timezone: string },
  ahora = new Date(),
): Promise<{ promocion: string; alcance: string; descuento: string; minimo?: number; hasta?: string }[]> {
  const vigentes = await promocionesVigentes(businessId, ahora);
  return vigentes.map((p) => ({
    promocion: p.name,
    alcance:
      p.scope === "GLOBAL"
        ? "todo el catalogo"
        : p.scope === "CATEGORY"
          ? `la categoria ${p.categoryLabel ?? p.categoryNormalized ?? ""}`.trim()
          : "un producto puntual",
    descuento: p.kind === "PERCENT" ? `${p.value.toString()}%` : `${p.value.toString()} de descuento`,
    ...(p.minQuantity > 1 ? { minimo: p.minQuantity } : {}),
    ...(p.endsAt
      ? {
          hasta: p.endsAt.toLocaleDateString(formatoDeFecha.locale, {
            timeZone: formatoDeFecha.timezone,
            day: "numeric",
            month: "long",
          }),
        }
      : {}),
  }));
}
