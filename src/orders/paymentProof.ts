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
export async function momentoEnQueSePasaronLosDatosDePago(conversationId: string): Promise<Date | null> {
  // TRES CAMINOS, NO DOS (2026-09-18, segunda pasada el mismo dia).
  //
  // Hasta la manana esto era solo `get_payment_methods`. Con el commit 73dd8aa el bloque de pago se arma
  // leyendo la base al empezar el turno, llame el modelo a la herramienta o no -- y de paso el prompt
  // perdio la directiva de llamarla, asi que dejo de llamarse. Se agrego `set_payment_method` como
  // segundo camino esa misma manana, pero esa herramienta solo existe con Business.saleStateEnabled: en
  // un negocio sin la bandera (Boutique Alondra, Aurora Joyas, MAGByLizN) ningun camino podia ocurrir
  // nunca, y la funcion volvia a null aunque el cliente tuviera el numero de Nequi a la vista.
  //
  // Medido en la conversacion de Paula (Boutique Alondra, 2026-09-18 18:03): el bloque de pago salio
  // completo en su chat sin que ninguna herramienta corriera (toolsCalled: [] es la norma ahora, no la
  // excepcion), mando el comprobante, y como para el sistema nunca se le habian pasado datos de pago la
  // imagen se escalo al dueno como "pregunta por este producto y no lo pude identificar".
  //
  // El tercer camino es el hecho que de verdad importa y que los otros dos aproximaban indirectamente:
  // SaleState.paymentDataShownAt, que el servidor escribe en el momento exacto en que renderFixedBlocks
  // rellena la marca con datos reales (ver recordPaymentDataShown en orders/saleState.ts) -- sin pasar
  // por ninguna herramienta ni por saleStateEnabled. Se toma el MAS TEMPRANO de los tres: cualquiera que
  // haya ocurrido primero es cuando el cliente vio el dato.
  const [turno, saleState] = await Promise.all([
    prisma.agentTurn.findFirst({
      where: {
        conversationId,
        OR: [{ toolsCalled: { has: "get_payment_methods" } }, { toolsCalled: { has: "set_payment_method" } }],
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.saleState.findUnique({ where: { conversationId }, select: { paymentDataShownAt: true } }),
  ]);
  const candidatos = [turno?.createdAt, saleState?.paymentDataShownAt ?? undefined].filter(
    (d): d is Date => d instanceof Date
  );
  if (candidatos.length === 0) return null;
  return candidatos.reduce((antes, actual) => (actual < antes ? actual : antes));
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
 * DOS SEÑALES, EN ESTE ORDEN (2026-09-18, segunda pasada del día):
 *
 * 1. LO QUE EL SERVIDOR YA VIO EN LA IMAGEN. `Message.imageAnalysis` lo escribe el servidor en
 *    routes/whatsapp.ts ANTES de que el turno del modelo empiece: toda imagen entrante pasa por
 *    `analyzeCustomerImage`, cuyo prompt obliga a que la respuesta empiece con `COMPROBANTE:`,
 *    `PRODUCTO:`, `PRODUCTO_POCO_CLARO:` u `OTRO:` (ver ai/visionPrompt.ts). Eso NO es prosa del
 *    modelo del turno: es una clasificación estructurada, guardada, que se responde con un SELECT.
 *    La primera versión de esta función la descartó por miedo a caer en un guard de clase D y quedó
 *    apoyada solo en (2) -- con lo cual el sistema tenía la respuesta escrita en su propia base y no
 *    la miraba.
 *
 * 2. CUÁNDO LLEGÓ, como respaldo. Una imagen mandada después de que se le pasaron los datos de pago
 *    es la misma definición que usa `faltaComprobanteDePago` para no cerrar a ciegas. Cubre el caso
 *    en que la visión no corrió (error de red, key sin configurar, video sin frame legible) o dijo
 *    algo que no arranca con ningún prefijo conocido.
 *
 * Por qué el orden es ése y no al revés: (1) distingue una captura de la lista del mercado de un
 * comprobante de Nequi, y (2) no -- para (2) cualquier imagen posterior al bloque de pago es "el
 * comprobante". Cuando la visión habla, sabe más.
 *
 * Defecto real (2026-09-18): una clienta mandó su comprobante de Nequi y `ask_owner_about_photo` se lo
 * reenvió al dueño con el texto "pregunta por este producto y no lo pude identificar en el catálogo.
 * ¿Cuál es?". El dueño vio una transferencia y una pregunta sobre qué producto era.
 */
export async function esLaImagenDelComprobante(conversationId: string, mensajeId: string, creadoEn: Date): Promise<boolean> {
  const mensaje = await prisma.message.findFirst({
    where: { id: mensajeId, conversationId, role: "CUSTOMER" },
    select: { id: true, imageAnalysis: true },
  });
  if (!mensaje) return false;

  // (1) El veredicto que el servidor ya guardó sobre ESTA imagen. `COMPROBANTE:` es el prefijo exacto
  // que impone buildVisionPrompt, y conIdentificacionDelServidor solo le agrega texto a `PRODUCTO:`,
  // así que este prefijo llega intacto a la base.
  const analisis = (mensaje.imageAnalysis ?? "").trimStart();
  if (analisis.startsWith("COMPROBANTE:")) return true;
  // Un `PRODUCTO:` explícito es lo contrario de un comprobante, y decirlo acá es lo que permite que la
  // foto de un producto mandada DESPUÉS del bloque de pago siga escalándose para identificarla, en vez
  // de desaparecer tragada por (2).
  if (analisis.startsWith("PRODUCTO:") || analisis.startsWith("PRODUCTO_POCO_CLARO:")) return false;

  // (2) Respaldo por tiempo, para cuando no hay veredicto utilizable.
  const desde = await momentoEnQueSePasaronLosDatosDePago(conversationId);
  if (!desde) return false;
  return creadoEn >= desde;
}

/** Lo que se le devuelve al modelo cuando el cierre se frena por esto. Dice que falta y que hacer. */
export const FALTA_COMPROBANTE_NOTE =
  "No se cerro nada y no se creo ningun pedido: este negocio pide ver el comprobante antes de cerrar, el pago de este pedido es por adelantado y el cliente todavia no mando ninguna imagen desde que se le pasaron los datos de pago. Pedile la foto del comprobante y volve a cerrar cuando la mande. Si el cliente va a pagar contraentrega, cerra con ese metodo de pago: ahi no hay comprobante que pedir.";
