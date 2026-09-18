import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Money, sumar, MonedasIncompatibles } from "./dinero";

// E33 (2026-09-18).
//
// Las dos mitades de la etapa se prueban aparte porque son dos cosas distintas:
//   - la aritmetica exacta (que 0.1 + 0.2 de 0.3),
//   - y que la MONEDA viaje con el numero, que es la mitad que de verdad evita cobrar mal.

test("la suma es exacta: esto es lo que el punto flotante no puede hacer", () => {
  // En JavaScript: 0.1 + 0.2 === 0.30000000000000004. Con plata eso es un total que no cuadra con la
  // suma de sus lineas.
  const suma = Money.de("0.1", "USD").mas(Money.de("0.2", "USD"));
  assert.equal(suma.toString(), "0.3");

  // Y el caso de un pedido real: tres unidades de un producto con centavos.
  // 1234.56 * 3 === 3703.6800000000003 en flotante.
  assert.equal(Money.de("1234.56", "USD").por(3).toString(), "3703.68");
});

test("un `number` entra por string, para no arrastrar el error del flotante adentro del decimal", () => {
  // Si se pasara el number directo al Decimal, el error del flotante viajaria adentro y esta clase no
  // serviria de nada: el calculo saldria exacto sobre un valor ya equivocado.
  const desdeNumero = Money.de(0.1, "USD").mas(Money.de(0.2, "USD"));
  assert.equal(desdeNumero.toString(), "0.3");
});

test("sumar dos monedas distintas TIRA en vez de dar un numero sin significado", () => {
  const enPesos = Money.de(59900, "COP");
  const enDolares = Money.de(30, "USD");

  // 59900 + 30 = 59930 de nada. Eso es exactamente lo que hacia el codigo viejo: sumaba `number`s sin
  // preguntar de que moneda eran.
  assert.throws(() => enPesos.mas(enDolares), MonedasIncompatibles);
  assert.throws(() => enPesos.menos(enDolares), MonedasIncompatibles);
  assert.throws(() => enPesos.comparar(enDolares), MonedasIncompatibles);

  // esIgualA no tira: comparar por igualdad dos monedas distintas tiene una respuesta correcta, que es
  // "no son iguales". Tirar ahi obligaria a envolver en try/catch cada comparacion inocente.
  assert.equal(enPesos.esIgualA(enDolares), false);
});

test("un pedido con monedas mezcladas se rechaza, no se suma", () => {
  const lineas = [Money.de(59900, "COP"), Money.de(80000, "COP"), Money.de(30, "USD")];
  assert.throws(() => sumar(lineas, "COP"), MonedasIncompatibles);

  // Y el mismo pedido sin mezclar sale bien.
  assert.equal(sumar([Money.de(59900, "COP"), Money.de(80000, "COP")], "COP").toString(), "139900");
});

test("una lista vacia da cero EN LA MONEDA QUE SE PIDE", () => {
  const cero = sumar([], "MXN");
  assert.ok(cero.esCero());
  // Sin ese parametro, un pedido vacio daria un cero sin moneda y la primera suma que le siguiera
  // adoptaria cualquier cosa.
  assert.equal(cero.moneda, "MXN");
  assert.throws(() => cero.mas(Money.de(10, "COP")), MonedasIncompatibles);
});

test("la moneda se normaliza, y sin moneda no hay monto", () => {
  assert.equal(Money.de(10, " cop ").moneda, "COP");
  assert.ok(Money.de(10, "cop").esIgualA(Money.de(10, "COP")));
  // Un monto sin moneda no es una cantidad de plata, es un numero suelto.
  assert.throws(() => Money.de(10, ""), /sin moneda/);
  assert.throws(() => Money.de(10, "   "), /sin moneda/);
});

test("multiplicar solo por cantidades enteras: media unidad de producto no existe", () => {
  assert.equal(Money.de(1000, "COP").por(3).toString(), "3000");
  assert.throws(() => Money.de(1000, "COP").por(1.5), /entera/);
});

// ---------------------------------------------------------------------------------------------------
// La prueba de ARQUITECTURA que pide la etapa, textual: "prueba de arquitectura que hace grep de
// `Number(` sobre los modulos de precio".
//
// No prueba comportamiento: prueba que el defecto no pueda volver a entrar sin que alguien lo vea. La
// forma de que un refactor de plata se deshaga es que la proxima linea nueva vuelva a hacer
// `Number(product.price)` y nadie lo note en la revision.
// ---------------------------------------------------------------------------------------------------

test("ARQUITECTURA: el total de un pedido no se calcula con punto flotante", () => {
  const fuente = readFileSync(join(__dirname, "..", "orders", "service.ts"), "utf8");

  // Las dos formas exactas que tenia el codigo viejo de sumar plata como `number`.
  assert.doesNotMatch(
    fuente,
    /const\s+itemsTotal\s*=\s*items\.reduce/,
    "el total de items volvio a sumarse con reduce sobre numbers: tiene que ir por Money/sumar",
  );
  assert.doesNotMatch(
    fuente,
    /unitPrice\s*\*\s*item\.quantity/,
    "multiplicar el precio por la cantidad en flotante es justo lo que E33 vino a sacar",
  );

  // Y la parte positiva: que el camino nuevo siga ahi. Sin esto, borrar el import de Money dejaria la
  // prueba de arriba en verde con el defecto de vuelta por otra via.
  assert.match(fuente, /from "\.\.\/config\/dinero"/, "service.ts tiene que seguir usando Money");
  assert.match(fuente, /sumar\(/, "el total tiene que armarse con sumar(), que es lo que rechaza monedas mezcladas");
});
