import type { PaymentSettlement, ShippingPaymentModality } from "@prisma/client";

// E15b: LA MODALIDAD Y EL METODO DE PAGO SON DOS DATOS, NO DOS VECES LA MISMA PREGUNTA (2026-09-18).
//
// Conversación real de prueba, con una clienta que habla como habla la gente:
//
//   CLIENTE | Ah ok. Pago todo contraentrega. Que necesitas de mi?
//     ONIX  | ¡Listo, Carolina! Todo contraentrega entonces. Para dejarte el pedido listo necesito: ...
//   CLIENTE | Carolina Ruiz. Cedula 1018223344. Celular 3105558899. Calle 53 #24-18, barrio Galerias...
//     ONIX  | ¿cómo prefieres pagar el producto? Estas son las opciones: *Nequi, Llave...*
//   CLIENTE | Yo pago todo contraentrega, como te dije.
//
// La clienta tuvo que repetirse. Y en la conversación de Dennis (2026-09-18) pasó lo peor: eligió
// "Contraentrega" para el envío y después "Nequi" para el producto, y el sistema se quedó con
// Contraentrega **sin decírselo**. Elegir dos veces y que una respuesta se descarte en silencio es peor
// que preguntar una vez.
//
// Son dos datos de verdad -- CUÁNDO se paga y CON QUÉ se paga -- pero no son independientes: elegida la
// modalidad, el momento en que entra la plata queda determinado, y con él el `settlement` que puede
// tener el método. Eso es una tabla de tres filas, no una interpretación:
//
//   COD_ALL                       todo al recibir            -> el metodo cobra AL RECIBIR
//   PREPAID_ALL                   todo por adelantado        -> el metodo cobra POR ADELANTADO
//   PREPAID_PRODUCT_COD_SHIPPING  el producto adelantado     -> el metodo cobra POR ADELANTADO
//
// Con eso, la lista de métodos deja de ofrecer lo que ya se decidió, y un método que contradice la
// modalidad no se guarda en silencio: se rechaza diciendo cuál es la contradicción, y el cierre queda
// frenado hasta que el cliente resuelva cuál de las dos vale.
//
// Lo que NO se hace, y el plan lo dice explicito: pedirle al modelo en el prompt que "no vuelva a
// preguntar". Eso es una regla mas que puede desobedecer, y la contradiccion se volveria a resolver sola
// en silencio cada vez que no la obedezca.

/**
 * Cuándo tiene que entrar la plata del PRODUCTO, dada la modalidad elegida.
 *
 * `null` cuando todavía no se eligió modalidad: ahí no hay contradicción posible y no se filtra nada.
 * Esconder métodos por las dudas sería el error opuesto.
 */
export function settlementQueExigeLaModalidad(
  modalidad: ShippingPaymentModality | null | undefined,
): PaymentSettlement | null {
  if (!modalidad) return null;
  return modalidad === "COD_ALL" ? "ON_DELIVERY" : "PREPAID";
}

/** Los métodos que siguen teniendo sentido con esa modalidad. Sin modalidad, todos. */
export function metodosCompatibles<T extends { settlement: PaymentSettlement }>(
  metodos: T[],
  modalidad: ShippingPaymentModality | null | undefined,
): T[] {
  const exigido = settlementQueExigeLaModalidad(modalidad);
  if (!exigido) return metodos;
  return metodos.filter((m) => m.settlement === exigido);
}

/**
 * Por qué ese método contradice la modalidad ya elegida, o `null` si no la contradice.
 *
 * El texto va dirigido al modelo y nombra las DOS cosas que chocan, para que pueda preguntarle al
 * cliente cuál vale en vez de quedarse con una a escondidas.
 */
export function contradiceLaModalidad(
  metodo: { label: string; settlement: PaymentSettlement },
  modalidad: ShippingPaymentModality | null | undefined,
): string | null {
  const exigido = settlementQueExigeLaModalidad(modalidad);
  if (!exigido || metodo.settlement === exigido) return null;

  if (exigido === "ON_DELIVERY") {
    return `El cliente eligio pagar TODO al recibir, y "${metodo.label}" se cobra por adelantado. No se guardo nada: preguntale cual de las dos vale -- si paga todo al recibir, o si prefiere pagar el producto ahora por ${metodo.label} y solo el envio al recibir.`;
  }
  return `El cliente eligio pagar el producto POR ADELANTADO, y "${metodo.label}" se cobra al recibir. No se guardo nada: preguntale cual de las dos vale -- si paga por adelantado y con que, o si prefiere pagar todo al recibir.`;
}
