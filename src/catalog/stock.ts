// El stock real de un producto, en un solo lugar.
//
// `Product.stock` es el campo BASE y queda en 0 para todo producto cuyo inventario se lleva por
// color o talla: ahí las unidades viven en `ProductVariant.stock`. Leer el campo base directo
// reporta "sin stock" para un producto que tiene decenas de unidades.
//
// Incidente real 2026-09-16: el presenter de la Fase B leía `product.stock` directo. 12 de los 37
// productos activos de MAG.IMP —117 unidades— se mostraban "(sin stock)" teniéndolo, y el bot le
// dijo a una clienta que no había unidades del Smartwatch Serie 12 Ultra 3, que tenía 15. Se perdió
// esa venta. La función existía (`totalStock` en src/ai/tools.ts) pero estaba duplicada en la capa
// equivocada, así que el camino nuevo no la usó.
//
// Va acá, sin importar prisma, para que `src/catalog/presenter.ts` la pueda usar y seguir
// probándose sin base de datos ni red.
export function totalStock(product: { stock: number; variants: { stock: number; active: boolean }[] }): number {
  if (product.variants.length === 0) return product.stock;
  return product.variants.filter((v) => v.active).reduce((sum, v) => sum + v.stock, 0);
}
