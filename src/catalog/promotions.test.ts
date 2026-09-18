import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { Money } from "../config/dinero";
import { promocionQueAplica, precioConDescuento, categoriaNormalizada, type PromocionAplicable } from "./promotions";
import { precioDeVentaConPromocion } from "./precioDeVenta";

// E37 (2026-09-18). Una promocion es un dato. Lo que estas pruebas fijan es que la CIFRA no la escribe
// nadie a mano: ni el modelo, ni el llamador.

function promo(parcial: Partial<PromocionAplicable> & { id: string }): PromocionAplicable {
  return {
    name: "Promo",
    kind: "PERCENT",
    value: new Prisma.Decimal("10"),
    scope: "GLOBAL",
    categoryNormalized: null,
    productId: null,
    minQuantity: 1,
    ...parcial,
  };
}

const linea = { productId: "prod-1", category: "Relojes", quantity: 1 };

test("un porcentaje se calcula con Decimal, no con flotante", () => {
  // 59900 * 0.2 en flotante da 11980.000000000002, y eso se resta de un precio y se cobra.
  const precio = precioConDescuento(Money.de("59900", "COP"), promo({ id: "a", value: new Prisma.Decimal("20") }));
  assert.equal(precio.toString(), "47920");
});

test("un monto fijo mas grande que el precio deja la linea en cero, no en deuda", () => {
  const precio = precioConDescuento(
    Money.de("10000", "COP"),
    promo({ id: "a", kind: "AMOUNT", value: new Prisma.Decimal("25000") }),
  );
  assert.equal(precio.toString(), "0");
  assert.equal(precio.esNegativo(), false);
});

test("una promocion de categoria no alcanza a un producto de otra categoria", () => {
  const dePerfumes = promo({ id: "a", scope: "CATEGORY", categoryNormalized: categoriaNormalizada("Perfumes") });
  assert.equal(promocionQueAplica([dePerfumes], Money.de("50000", "COP"), linea), null);

  const deRelojes = promo({ id: "b", scope: "CATEGORY", categoryNormalized: categoriaNormalizada("relojes") });
  // La comparacion es normalizada: la duena escribe "Relojes" y el catalogo dice "relojes".
  assert.equal(promocionQueAplica([deRelojes], Money.de("50000", "COP"), linea)?.id, "b");
});

test("el minimo de cantidad se respeta", () => {
  const porTresUnidades = promo({ id: "a", minQuantity: 3 });
  assert.equal(promocionQueAplica([porTresUnidades], Money.de("50000", "COP"), { ...linea, quantity: 2 }), null);
  assert.equal(promocionQueAplica([porTresUnidades], Money.de("50000", "COP"), { ...linea, quantity: 3 })?.id, "a");
});

test("con dos promociones vigentes gana la que deja el precio mas bajo, no la primera", () => {
  const global20 = promo({ id: "a", value: new Prisma.Decimal("20") });
  const delProducto = promo({ id: "b", scope: "PRODUCT", productId: "prod-1", kind: "AMOUNT", value: new Prisma.Decimal("30000") });

  // 50000 - 20% = 40000; 50000 - 30000 = 20000.
  assert.equal(promocionQueAplica([global20, delProducto], Money.de("50000", "COP"), linea)?.id, "b");
});

test("empatadas en precio, gana la mas especifica, y el resultado no depende del orden", () => {
  const global = promo({ id: "z", scope: "GLOBAL", value: new Prisma.Decimal("10") });
  const deProducto = promo({ id: "a", scope: "PRODUCT", productId: "prod-1", value: new Prisma.Decimal("10") });

  assert.equal(promocionQueAplica([global, deProducto], Money.de("50000", "COP"), linea)?.id, "a");
  assert.equal(promocionQueAplica([deProducto, global], Money.de("50000", "COP"), linea)?.id, "a");
});

test("no apila descuentos: aplica una sola", () => {
  const veinte = promo({ id: "a", value: new Prisma.Decimal("20") });
  const diez = promo({ id: "b", value: new Prisma.Decimal("10") });
  const elegida = promocionQueAplica([veinte, diez], Money.de("100000", "COP"), linea);
  assert.equal(precioConDescuento(Money.de("100000", "COP"), elegida).toString(), "80000");
});

// La parte que importa de verdad: lo que el bot dice y lo que se cobra salen del mismo lugar.
test("el descuento entra en el unico camino de precio, junto con el precio por variante", () => {
  const producto = { id: "prod-1", category: "Relojes", price: new Prisma.Decimal("50000"), currency: "COP" };
  const variante = { price: new Prisma.Decimal("62000") };
  const promociones = [promo({ id: "a", scope: "CATEGORY", categoryNormalized: categoriaNormalizada("Relojes"), value: new Prisma.Decimal("50") })];

  const resultado = precioDeVentaConPromocion(producto, variante, { promociones, cantidad: 1 });

  // El descuento se calcula sobre el precio de la VARIANTE (E36), no sobre el del producto.
  assert.equal(resultado.precioDeLista.toString(), "62000");
  assert.equal(resultado.precio.toString(), "31000");
  assert.equal(resultado.promocion?.id, "a");
});

test("sin promociones vigentes el precio es exactamente el de siempre", () => {
  const producto = { id: "prod-1", category: "Relojes", price: new Prisma.Decimal("50000"), currency: "COP" };
  const resultado = precioDeVentaConPromocion(producto, null, { promociones: [], cantidad: 1 });
  assert.equal(resultado.precio.toString(), "50000");
  assert.equal(resultado.promocion, null);
});
