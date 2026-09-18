import { Prisma } from "@prisma/client";

// E33 (2026-09-18). LA PLATA DEJA DE SER UN `number`.
//
// El archivo se llama `dinero.ts` y no `Money.ts` porque al lado vive `money.ts`, que formatea por
// moneda y locale. Dos archivos que solo se diferencian en mayusculas compilan en Linux y revientan en
// macOS y Windows, donde el sistema de archivos no las distingue. Son cosas distintas: `money.ts` decide
// como SE MUESTRA un monto, esto decide como SE OPERA.
//
// En la base los precios son `Decimal(12,2)`. En el codigo eran `Number(product.price)` -- punto
// flotante -- y de ahi en adelante todo lo que se sumara, multiplicara o comparara pasaba por IEEE 754.
//
// Por que importa con plata de verdad, y no es teorico:
//
//   0.1 + 0.2 === 0.30000000000000004
//   1234.56 * 3 === 3703.6800000000003
//
// En COP, que no usa centavos, eso casi nunca se ve. En MXN, USD o EUR se ve al tercer producto de un
// pedido, y lo que se ve es un total que no cuadra con la suma de las lineas -- que es la clase de error
// que una duena descubre cuando una clienta reclama, no antes.
//
// LO QUE ESTA CLASE HACE, Y LO QUE NO:
//   - Hace: aritmetica exacta (Prisma.Decimal, base 10) y arrastrar la MONEDA junto al numero.
//   - No hace: formatear. Eso ya lo resuelve formatPrice (src/config/money.ts) por moneda y locale.
//
// LA MONEDA VIAJA CON EL NUMERO A PROPOSITO. Ese es el punto entero, mas que la precision: `59900` no
// significa nada solo. Sumar 59900 COP con 30 USD da 59930 de nada, y eso es exactamente lo que el
// codigo hacia -- sumaba `number`s sin preguntar. Aca no se puede: sumar dos monedas distintas tira.

export class MonedasIncompatibles extends Error {
  constructor(
    readonly unaMoneda: string,
    readonly otraMoneda: string,
  ) {
    super(
      `No se puede operar ${unaMoneda} con ${otraMoneda}: son unidades distintas. ` +
        `Sumarlas daria un numero sin significado.`,
    );
    this.name = "MonedasIncompatibles";
  }
}

export class Money {
  private constructor(
    readonly monto: Prisma.Decimal,
    readonly moneda: string,
  ) {}

  /**
   * Desde lo que sea que haya: el `Decimal` de Prisma, un string, o un `number` de codigo viejo.
   *
   * El `number` se acepta pero se convierte VIA STRING. Pasar el number directo a Decimal arrastraria el
   * error del flotante adentro del decimal, que es justo lo que esta clase existe para cortar.
   */
  static de(valor: Prisma.Decimal | string | number, moneda: string): Money {
    const codigo = moneda.trim().toUpperCase();
    if (!codigo) throw new Error("Un monto sin moneda no es una cantidad de plata, es un numero suelto");
    const monto =
      typeof valor === "number"
        ? new Prisma.Decimal(valor.toString())
        : valor instanceof Prisma.Decimal
          ? valor
          : new Prisma.Decimal(valor);
    return new Money(monto, codigo);
  }

  static cero(moneda: string): Money {
    return Money.de(0, moneda);
  }

  private mismaMoneda(otro: Money): void {
    if (this.moneda !== otro.moneda) throw new MonedasIncompatibles(this.moneda, otro.moneda);
  }

  mas(otro: Money): Money {
    this.mismaMoneda(otro);
    return new Money(this.monto.plus(otro.monto), this.moneda);
  }

  menos(otro: Money): Money {
    this.mismaMoneda(otro);
    return new Money(this.monto.minus(otro.monto), this.moneda);
  }

  /** Por una cantidad. La cantidad es un entero (unidades de producto), no plata. */
  por(cantidad: number): Money {
    if (!Number.isInteger(cantidad)) {
      throw new Error(`Una cantidad de producto tiene que ser entera, llego ${cantidad}`);
    }
    return new Money(this.monto.times(cantidad), this.moneda);
  }

  comparar(otro: Money): -1 | 0 | 1 {
    this.mismaMoneda(otro);
    return this.monto.comparedTo(otro.monto) as -1 | 0 | 1;
  }

  esIgualA(otro: Money): boolean {
    return this.moneda === otro.moneda && this.monto.equals(otro.monto);
  }

  esCero(): boolean {
    return this.monto.isZero();
  }

  esNegativo(): boolean {
    return this.monto.isNegative();
  }

  /** Para guardar en la base. Prisma acepta el Decimal tal cual. */
  paraLaBase(): Prisma.Decimal {
    return this.monto;
  }

  /**
   * Para mostrar. Devuelve el string exacto, sin separadores: el formato por locale lo pone
   * `formatPrice` (src/config/money.ts), que ya sabe que COP no lleva centavos y MXN si.
   */
  toString(): string {
    return this.monto.toString();
  }

  /**
   * El escape hacia `number`, con nombre feo A PROPOSITO.
   *
   * Existe porque hay fronteras que solo hablan number: `toLocaleString`, el JSON que va al panel, las
   * respuestas HTTP. En todas esas el numero ya no se va a operar, solo mostrar.
   *
   * Si aparece en el medio de un calculo, es un defecto: el calculo tiene que hacerse con Money y
   * convertirse una sola vez, al final. El nombre esta para que eso se vea al leer el diff.
   */
  comoNumeroParaMostrar(): number {
    return this.monto.toNumber();
  }
}

/**
 * Suma una lista. Vacia devuelve cero EN LA MONEDA QUE SE PIDE -- sin ese parametro, un pedido vacio
 * daria un cero sin moneda y la primera suma que le siguiera adoptaria cualquier cosa.
 *
 * Si las lineas traen monedas distintas, tira. Es el caso que el plan pide explicitamente: "un pedido
 * con monedas mezcladas se rechaza en vez de sumar numeros sin significado".
 */
export function sumar(montos: Money[], monedaSiEstaVacio: string): Money {
  if (montos.length === 0) return Money.cero(monedaSiEstaVacio);
  return montos.reduce((acumulado, actual) => acumulado.mas(actual));
}
