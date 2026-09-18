import { Money } from "../config/dinero";
import type { Prisma } from "@prisma/client";
import { promocionQueAplica, precioConDescuento, type PromocionAplicable } from "./promotions";

// E36 (2026-09-18). EL PRECIO DE LO QUE SE VENDE, EN UN SOLO LUGAR.
//
// Una talla XL puede costar mas que una S. Hasta hoy el precio era del PRODUCTO y punto: los dos
// caminos que arman una linea de pedido (src/orders/saleState.ts y src/orders/service.ts) hacian
// `Number(product.price)` aunque la clienta hubiera elegido una variante.
//
// POR QUE UNA FUNCION Y NO DOS LINEAS COPIADAS: son dos caminos distintos que tienen que dar el MISMO
// numero. saleState es lo que el bot le DICE a la clienta mientras arma el pedido; service es lo que se
// GUARDA y se le cobra. Si divergen, la clienta ve un precio y le cobran otro -- y esa clase de
// diferencia no la encuentra ninguna prueba que mire un solo camino.

/** Lo minimo que hace falta saber de un producto para ponerle precio a su linea. */
export interface ProductoConPrecio {
  price: Prisma.Decimal;
  currency: string;
  // E37: para decidir si una promocion lo alcanza. Opcionales porque hay llamadores que solo tienen
  // precio y moneda; sin ellos, una promocion de producto o de categoria simplemente no aplica.
  id?: string;
  category?: string | null;
}

/** Y de la variante elegida, si hubo. `price` null = usa el del producto. */
export interface VarianteConPrecio {
  price: Prisma.Decimal | null;
}

/**
 * El precio unitario de esta linea.
 *
 * NULL EN LA VARIANTE SIGNIFICA "EL DEL PRODUCTO", NO "GRATIS". Es la decision entera de la columna:
 * con un default de 0, cada catalogo existente habria pasado a tener todas sus variantes a cero y el
 * bot habria vendido regalado hasta que alguien lo viera. Con null, un catalogo que nunca toco precios
 * por variante se comporta exactamente igual que antes.
 *
 * La moneda es SIEMPRE la del producto: una variante es el mismo producto en otra talla o color, y dos
 * tallas en monedas distintas no es un caso real -- seria un producto distinto.
 */
export function precioDeVenta(producto: ProductoConPrecio, variante?: VarianteConPrecio | null): Money {
  const precio = variante?.price ?? producto.price;
  return Money.de(precio, producto.currency);
}

/**
 * E37 (2026-09-18). EL MISMO PRECIO, CON LA PROMOCION DEL NEGOCIO YA PUESTA.
 *
 * Va en ESTA funcion y no en cada llamador por el motivo de siempre: los dos caminos que arman una
 * linea tienen que dar el mismo numero. Si el descuento se aplicara solo donde el bot cotiza, la
 * clienta veria el precio con promo y le cobrarian el de lista.
 *
 * Devuelve tambien CUAL promocion se aplico, para que el bot pueda contarlo sin tener que deducirlo de
 * la cifra -- y sobre todo sin tener que calcularla el.
 */
export function precioDeVentaConPromocion(
  producto: ProductoConPrecio,
  variante: VarianteConPrecio | null | undefined,
  contexto: { promociones: PromocionAplicable[]; cantidad: number },
): { precio: Money; precioDeLista: Money; promocion: PromocionAplicable | null } {
  const precioDeLista = precioDeVenta(producto, variante);
  if (contexto.promociones.length === 0) return { precio: precioDeLista, precioDeLista, promocion: null };

  const promocion = promocionQueAplica(contexto.promociones, precioDeLista, {
    productId: producto.id ?? "",
    category: producto.category ?? null,
    quantity: contexto.cantidad,
  });
  return { precio: precioConDescuento(precioDeLista, promocion), precioDeLista, promocion };
}
