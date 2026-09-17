import { prisma } from "../db/client";

// LOS DATOS DEL CLIENTE SON DEL CLIENTE, NO DE LA CONVERSACION (2026-09-17, etapa E02 de ONIX-PLAN.md).
//
// LA DECISION QUE LE QUITA AL MODELO: que datos del cliente faltan.
//
// EL DEFECTO QUE CIERRA, medido en produccion. Andres cerro un pedido el 16 de septiembre a las 19:36;
// su conversacion quedo en SOLD y, cuando escribio de nuevo 23 minutos despues, eso abrio una
// conversacion NUEVA. El bot le pidio ciudad, barrio, nombre completo, celular y direccion. Se los
// volvio a pedir al dia siguiente. La base ya tenia los cuatro:
//
//   name "Andres" | idNumber 3103325677 | deliveryPhone 3103325677
//   address "Calle 22 #108-62, Fontibon Ferrocarril, Bogota (Bodega naranja)"
//
// Esos campos de `Customer` NO ENTRABAN A NINGUN PROMPT, NUNCA. El unico camino por el que llegaban al
// modelo era `SaleState`, que es por conversacion: una conversacion nueva arrancaba sin ellos. El
// bloque del pedido cerrado (postSale.ts) tampoco alcanzaba, porque lleva el PEDIDO y no la PERSONA -
// un cliente que todavia no cerro ninguna compra no tiene pedido, y sus datos se pierden igual.
//
// QUE NO VA ACA, a proposito, para no pagar dos veces los mismos tokens:
//
// - Los pedidos del cliente ya viajan en su propio bloque (customerCommerceState.ts, "PEDIDOS DE ESTE
//   CLIENTE"), con resumen, total, estado y fecha.
// - El ultimo pedido con todo su detalle ya viaja en el suyo (postSale.ts).
// - El precio acordado con el dueno ya viaja en el suyo (agreedPrices.ts).
//
// Lo que faltaba era exactamente la identidad, y eso es lo unico que agrega este archivo.
//
// `whatsappProfileName` queda AFUERA aunque este en la misma fila: es el nombre que la persona puso en
// su propio perfil ("milenaparra55", "andy Nrz") y el bot lo usaria para dirigirse a ella. El nombre
// que vale es el que dijo por chat o el que escribio el dueno, que es `name`.

export interface CustomerIdentityFacts {
  nombre: string | null;
  documento: string | null;
  telefonoDeEntrega: string | null;
  direccionDeEntrega: string | null;
  /** Correo, si alguna vez lo dio. Va porque es un dato de contacto mas y cuesta lo mismo. */
  correo: string | null;
}

export interface CustomerFacts {
  identidad: CustomerIdentityFacts;
  /** Cuantos pedidos tiene con este negocio, en total. El detalle va en el bloque de pedidos. */
  pedidosEnTotal: number;
}

/** Las filas tal como salen de la base. El constructor no sabe de Prisma, solo de esta forma. */
export interface CustomerFactsRow {
  name: string | null;
  idNumber: string | null;
  deliveryPhone: string | null;
  address: string | null;
  email: string | null;
}

/**
 * Los hechos del cliente, listos para el mensaje de sistema. Funcion pura: se prueba sin base.
 *
 * Devuelve null cuando no hay un solo dato guardado. Un cliente nuevo no paga ni un token por esta
 * pieza, y el modelo no recibe un objeto lleno de `null` que tendria que interpretar.
 */
export function buildCustomerFacts(row: CustomerFactsRow | null, ordersCount: number): CustomerFacts | null {
  if (!row) return null;
  const identidad: CustomerIdentityFacts = {
    nombre: row.name,
    documento: row.idNumber,
    telefonoDeEntrega: row.deliveryPhone,
    direccionDeEntrega: row.address,
    correo: row.email,
  };
  const hayAlgo = Object.values(identidad).some((v) => v !== null && v !== "");
  if (!hayAlgo) return null;
  return { identidad, pedidosEnTotal: ordersCount };
}

export async function getCustomerFacts(businessId: string, customerId: string): Promise<CustomerFacts | null> {
  const [row, ordersCount] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { name: true, idNumber: true, deliveryPhone: true, address: true, email: true },
    }),
    prisma.order.count({ where: { businessId, customerId } }),
  ]);
  return buildCustomerFacts(row, ordersCount);
}

/**
 * El bloque `system`. DATO, sin una sola instruccion sobre que hacer con el.
 *
 * La frase final no dice como preguntar ni en que orden: dice de donde salio el dato y hasta donde
 * llega su autoridad, que es lo mismo que ya hacen los bloques del catalogo y de los pedidos. La
 * conversacion sigue siendo del agente (ver la prueba de duplicacion en promptDuplication.arch.test.ts,
 * que falla si este texto repite una regla de conversacion del prompt base).
 */
export function formatCustomerFactsForModel(facts: CustomerFacts): string {
  return (
    `DATOS DE ESTE CLIENTE, leidos de la base de este negocio. Son los que ya dio, en esta conversacion ` +
    `o en cualquier otra:\n\n` +
    JSON.stringify(facts) +
    `\n\nUn campo en null es un dato que no tenemos.`
  );
}
