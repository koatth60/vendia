import { prisma } from "../db/client";
import { Money } from "../config/dinero";
import { normalizeForMatch } from "../search/text";

// E38 (2026-09-18). EL COMBO, CON SU CONTENIDO EN FILAS Y NO EN PROSA.
//
// QUE DECISION SE LE QUITA A ALGUIEN: el stock de un combo deja de ser un numero que la duena mantiene
// a mano. Se CALCULA: lo que alcance el componente mas escaso. Un combo cuyo stock se escribe a mano
// siempre miente, porque cada venta de un componente suelto lo cambia sin tocarlo.
//
// Y de paso desaparece el defecto que documenta src/catalog/products.ts: con el contenido en filas, la
// busqueda por color no tiene ninguna prosa que malinterpretar.

export interface ComboResuelto {
  id: string;
  name: string;
  description: string | null;
  price: Money;
  currency: string;
  active: boolean;
  /** Cuantos combos se pueden armar hoy con el stock que hay. */
  disponibles: number;
  contenido: {
    productId: string;
    productName: string;
    variantId: string | null;
    variantLabel: string | null;
    quantity: number;
    /** Stock del componente (el de la variante cuando el combo pide una variante puntual). */
    stock: number;
  }[];
}

const INCLUDE = {
  items: {
    include: {
      product: {
        select: { id: true, name: true, stock: true, variants: { select: { id: true, color: true, size: true, stock: true } } },
      },
    },
  },
} as const;

type FilaConItems = Awaited<ReturnType<typeof prisma.bundle.findMany<{ include: typeof INCLUDE }>>>[number];

function etiquetaDeVariante(color: string | null, size: string | null): string | null {
  return [color, size].filter(Boolean).join(" / ") || null;
}

/**
 * Cuantos combos se pueden armar. El minimo entre lo que da cada componente, entero hacia abajo.
 *
 * Un combo SIN componentes da 0, no infinito: un combo vacio es una carga a medias, y prometerlo
 * disponible es exactamente la clase de promesa que el sistema no puede cumplir.
 */
export function combosDisponibles(contenido: { quantity: number; stock: number }[]): number {
  if (contenido.length === 0) return 0;
  return contenido.reduce((menor, item) => {
    const alcanza = item.quantity > 0 ? Math.floor(item.stock / item.quantity) : 0;
    return Math.min(menor, Math.max(0, alcanza));
  }, Number.POSITIVE_INFINITY);
}

function resolver(fila: FilaConItems): ComboResuelto {
  const contenido = fila.items.map((item) => {
    const variante = item.variantId ? item.product.variants.find((v) => v.id === item.variantId) ?? null : null;
    return {
      productId: item.productId,
      productName: item.product.name,
      variantId: item.variantId,
      variantLabel: variante ? etiquetaDeVariante(variante.color, variante.size) : null,
      quantity: item.quantity,
      // Cuando el combo pide una variante puntual, el stock que manda es el de ESA variante: el del
      // producto padre no significa nada en un producto con variantes (ver ProductVariant en el schema).
      stock: variante ? variante.stock : item.product.stock,
    };
  });

  return {
    id: fila.id,
    name: fila.name,
    description: fila.description,
    price: Money.de(fila.price, fila.currency),
    currency: fila.currency,
    active: fila.active,
    disponibles: combosDisponibles(contenido),
    contenido,
  };
}

/** Los combos activos del negocio, con su contenido y su disponibilidad ya calculada. */
export async function listarCombos(businessId: string, opciones: { soloActivos?: boolean } = {}): Promise<ComboResuelto[]> {
  const filas = await prisma.bundle.findMany({
    where: { businessId, ...(opciones.soloActivos === false ? {} : { active: true }) },
    include: INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  return filas.map(resolver);
}

export async function obtenerCombo(businessId: string, id: string): Promise<ComboResuelto | null> {
  const fila = await prisma.bundle.findFirst({ where: { id, businessId }, include: INCLUDE });
  return fila ? resolver(fila) : null;
}

/**
 * Busca un combo por nombre, normalizado. Es para el camino en el que el modelo escribe el nombre en
 * vez del id -- el mismo caso que ya cubre `findConfidentProductMatch` para productos.
 *
 * COINCIDENCIA EXACTA (normalizada) Y NADA MAS. Un combo mal identificado no es un producto de mas en
 * una lista: es una venta con el precio de otro combo. Si no coincide exacto, el llamador se entera de
 * que no hay y pregunta.
 */
export async function buscarComboPorNombre(businessId: string, nombre: string): Promise<ComboResuelto | null> {
  const buscado = normalizeForMatch(nombre.trim());
  if (!buscado) return null;
  const combos = await listarCombos(businessId);
  return combos.find((c) => normalizeForMatch(c.name) === buscado) ?? null;
}

/**
 * Los combos como DATO del turno, con la misma forma que las promociones (E37): sin promesas que el
 * servidor no pueda cumplir y sin una sola instruccion alrededor.
 *
 * Un combo sin stock para armar UNO se manda igual, marcado: el agente tiene que poder decir "ese combo
 * se agoto" en vez de callarlo y que la clienta lo pida igual.
 */
export async function combosParaElModelo(
  businessId: string,
  locale: string,
): Promise<{ id: string; combo: string; precio: string; incluye: string[]; disponibles: number }[]> {
  const combos = await listarCombos(businessId);
  return combos.map((c) => ({
    id: c.id,
    combo: c.name,
    precio: c.price.comoNumeroParaMostrar().toLocaleString(locale),
    incluye: c.contenido.map(
      (item) => `${item.quantity}x ${item.productName}${item.variantLabel ? ` (${item.variantLabel})` : ""}`,
    ),
    disponibles: c.disponibles,
  }));
}
