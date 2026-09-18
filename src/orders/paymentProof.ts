import { prisma } from "../db/client";

// EL COMPROBANTE DEJA DE SER UNA INSTRUCCION (2026-09-17).
//
// Hasta hoy, "no cierres la venta hasta que el cliente mande la foto del comprobante" era una frase del
// prompt y nada mas: `Business.requirePaymentProof` elegia uno de dos textos y ningun codigo miraba si la
// foto existia. Con la bandera encendida el cierre dependia de que el modelo obedeciera, y con la bandera
// apagada el "confirmame" del bot no esperaba nada, porque no habia nada que esperar.
//
// Lo que sigue es la version verificable: dos SELECT, sin leer una sola palabra de nadie.
//
// Que NO hace esto: decidir si una imagen es de verdad un comprobante. Nada en la base distingue la foto
// de una transferencia de la foto de un reloj, y deducirlo de la prosa seria el guard que este proyecto
// viene borrando. Lo que se verifica es lo unico verificable y ademas lo unico que importa para no cerrar
// a ciegas: que el cliente haya mandado UNA imagen DESPUES de que se le pasaran los datos de pago. Leer
// esa imagen y decir si el monto coincide sigue siendo trabajo del analisis de vision y del agente.

/**
 * El momento en que a este cliente se le pasaron los datos de pago, o null si nunca se le pasaron.
 *
 * Sale de `AgentTurn.toolsCalled`, que registra las herramientas que REALMENTE se llamaron en cada turno:
 * llamar get_payment_methods es lo que produce el bloque fijo con el numero, la llave y el titular. No es
 * una lectura de lo que el bot escribio, es el registro de lo que el servidor hizo.
 */
async function momentoEnQueSePasaronLosDatosDePago(conversationId: string): Promise<Date | null> {
  const turno = await prisma.agentTurn.findFirst({
    where: { conversationId, toolsCalled: { has: "get_payment_methods" } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return turno?.createdAt ?? null;
}

/**
 * True cuando este negocio exige comprobante, el pago es por adelantado, ya se le pasaron los datos de
 * pago al cliente y el cliente todavia no mando ninguna imagen desde entonces.
 *
 * `Business.requirePaymentProof` se lee aca adentro para que el llamador no tenga que arrastrarlo.
 * `pagoPorAdelantado` lo decide quien llama, con PaymentMethod.settlement (ver requiresPaymentConfirmation):
 * en un pedido contraentrega no hay comprobante que pedir porque el pago todavia no ocurrio, y pedirlo es
 * bloquear una venta que deberia cerrarse sola. Esa era la queja concreta del dueno del proyecto.
 *
 * Del lado seguro en las dos puntas: si nunca se le pasaron los datos de pago, no se le puede reclamar un
 * comprobante de algo que no se le pidio, asi que no bloquea. Una venta no se frena por una duda nuestra.
 */
export async function faltaComprobanteDePago(
  businessId: string,
  conversationId: string,
  opts: { pagoPorAdelantado: boolean }
): Promise<boolean> {
  if (!opts.pagoPorAdelantado) return false;

  const negocio = await prisma.business.findUnique({ where: { id: businessId }, select: { requirePaymentProof: true } });
  if (!negocio?.requirePaymentProof) return false;

  const desde = await momentoEnQueSePasaronLosDatosDePago(conversationId);
  if (!desde) return false;

  const imagen = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER", mediaType: "IMAGE", createdAt: { gte: desde } },
    select: { id: true },
  });
  return !imagen;
}

/**
 * True cuando esa imagen del cliente es, para el sistema, el comprobante de pago de esta conversación.
 *
 * Es la MISMA definición que usa `faltaComprobanteDePago` para no cerrar a ciegas: una imagen que el
 * cliente manda después de que se le pasaron los datos de pago. No mira la imagen ni lee prosa; es el
 * único hecho verificable que hay, y si alcanza para frenar un cierre alcanza para no reenviársela al
 * dueño como si fuera la foto de un producto.
 *
 * Defecto real (2026-09-18): una clienta mandó su comprobante de Nequi y `ask_owner_about_photo` se lo
 * reenvió al dueño con el texto "pregunta por este producto y no lo pude identificar en el catálogo.
 * ¿Cuál es?". El dueño vio una transferencia y una pregunta sobre qué producto era.
 */
export async function esLaImagenDelComprobante(conversationId: string, mensajeId: string, creadoEn: Date): Promise<boolean> {
  const desde = await momentoEnQueSePasaronLosDatosDePago(conversationId);
  if (!desde) return false;
  if (creadoEn < desde) return false;
  const existe = await prisma.message.findFirst({ where: { id: mensajeId, conversationId, role: "CUSTOMER" }, select: { id: true } });
  return Boolean(existe);
}

/** Lo que se le devuelve al modelo cuando el cierre se frena por esto. Dice que falta y que hacer. */
export const FALTA_COMPROBANTE_NOTE =
  "No se cerro nada y no se creo ningun pedido: este negocio pide ver el comprobante antes de cerrar, el pago de este pedido es por adelantado y el cliente todavia no mando ninguna imagen desde que se le pasaron los datos de pago. Pedile la foto del comprobante y volve a cerrar cuando la mande. Si el cliente va a pagar contraentrega, cerra con ese metodo de pago: ahi no hay comprobante que pedir.";
