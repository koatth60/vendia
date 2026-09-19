import { prisma } from "../db/client";
import { esLaImagenDelComprobante, faltaComprobanteDePago } from "../orders/paymentProof";
import { getSaleState, getServerSaleEvidence, type SaleStateItem, type SaleStateSnapshot } from "../orders/saleState";
import { resolveShippingRateForCity } from "../catalog/shippingRates";
import { runCatalogTool, type ToolContext } from "./tools";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { sendAlertToOwner, isBsuid } from "../whatsapp/outbound";
import { formatPrice } from "../config/money";
import { totalDeLinea } from "../config/dinero";

// EFECTOS REQUERIDOS (2026-09-15).
//
// El problema que resuelve, en una frase: hasta ahora nadie verificaba que el turno hubiera hecho lo que
// su propio texto decia que hizo. Caso real, conversacion cmu3htnp0009y4k2kzxhy9dlz (2026-09-16 UTC): la
// clienta manda la foto del comprobante ($154.000 por Nequi), el turno registra UNA sola fila AiUsageLog
// (o sea, cero llamadas a herramientas), y el bot escribe "estoy validando tu comprobante... confirmando
// con el equipo" tres veces. En la base: PendingOwnerQuestion = 0, OwnerMessageLog = 0, Order = []. La
// clienta pago y la duena nunca se entero.
//
// Por que no alcanza con forzar tool_choice: medido el 2026-09-15 en cmu0ehwqx00076k2k64mjaats (21:56:45
// y 22:35:11), con tool_choice forzado a list_all_products DeepSeek devolvio texto sin tool_calls, una
// sola llamada, e invento productos que no existen. Mismo modelo que en los turnos vecinos donde si
// honro la herramienta. El reintento es necesario, pero no puede ser la unica defensa: de ahi la
// escalera reintento -> fallback por codigo -> escalacion.
//
// POR QUE EL DISPARADOR SE REESCRIBIO (2026-09-15, segunda pasada). La primera version exigia, como
// condicion (b), "venta en curso": pendingOrderSummary/pendingOrderItems, o un SaleState con producto,
// precio y forma de pago. Verificado contra la base de produccion, ninguna de esas tres cosas existia la
// noche de Milena y no podia existir:
//
//   - Aurora Joyas, Boutique Alondra y MAGByLizN tienen saleStateEnabled = false, asi que buildTools ni
//     siquiera le muestra al modelo las saleStateTools: set_order_item/set_payment_method no existen
//     para el y la fila de SaleState queda vacia (items: [], paymentMethodId: null).
//   - pendingOrderSummary/pendingOrderItems los escribe unicamente requestSaleConfirmation, que es parte
//     del cierre que este mecanismo trata de forzar. Exigirlo como condicion previa es circular.
//
// Resultado medido: computeRequiredEffects devolvia lista vacia y no exigia nada. Prender la bandera era
// un placebo. Ahora el disparador se apoya SOLO en lo que escribe el servidor - en el caso de Milena,
// SaleState.mediaSent, que escribe recordMediaSent cuando la foto del producto salio de verdad por
// WhatsApp - y para que eso exista tambien sin la bandera, REGISTRAR el SaleState se separo de EXPONERLO
// (ver el comentario de saveDeliveryDataToSaleState en orders/saleState.ts).
//
// Tampoco puede apoyarse en show_order_summary: en el turno de Milena (02:48:41) hubo UNA sola llamada
// CHAT y cero herramientas; el resumen con producto, precio, envio y forma de pago lo escribio el modelo
// de memoria. Cualquier disparador que dependa de una herramienta que el modelo puede no llamar es
// circular por construccion.
//
// REGLA DE ESTE MODULO: todo lo que se decide aca sale de estado de la base. Nunca de la prosa del
// modelo ni de la del cliente. No hay ni una expresion regular en este archivo, y no se agrega ninguna.

export type RequiredEffectKind =
  // Llego una imagen sobre una conversacion donde el servidor ya registro actividad de venta, pero no
  // hay un pedido resuelto contra el catalogo. El efecto exigido es que la DUENA QUEDE AVISADA, nada
  // mas: la condicion (a) es "llego una imagen" a secas, y nada en la base distingue un comprobante de
  // la foto de un producto sin leer prosa. Crear un pedido automatico sobre una imagen ambigua es un
  // riesgo real y caro; un aviso de mas no cuesta nada.
  | "OWNER_NOTIFIED_ABOUT_IMAGE"
  // Llego una imagen que el SERVIDOR ya clasifico como comprobante de pago (Message.imageAnalysis
  // empieza con "COMPROBANTE:", escrito por ai/vision.ts antes de que el turno arranque), sobre una
  // conversacion con venta en curso. El efecto exigido es que el DUENO QUEDE AVISADO DEL PAGO.
  //
  // POR QUE EXISTE COMO EFECTO PROPIO (2026-09-18). El commit que dejo de escalar los comprobantes como
  // "foto de producto sin identificar" los saco del disparador y no puso nada en su lugar, con el
  // argumento de que "el pago tiene su propio camino: el cierre le pregunta al dueno si le llego la
  // plata". Ese camino solo existe si el modelo llama close_conversation, y medido enseguida en
  // produccion (Sandra Gil, conversacion cmu7l6eb50012w82khu91rx8n) no la llamo: escribio "¡Perfecto,
  // todo queda listo! en total fueron $149.000, tu pedido sale para Bogota" con CERO herramientas en
  // los nueve turnos. Order = 0, PendingOwnerQuestion = 0, conversacion todavia en NEW. La clienta creyo
  // que compro, el dueno nunca se entero, y no habia ningun pedido.
  //
  // O sea: se cambio un aviso mal redactado por NINGUN aviso. Esto lo cierra - y por el camino correcto,
  // que es preguntarle al dueno si le llego la plata, no que producto es la foto.
  | "OWNER_NOTIFIED_ABOUT_PAYMENT"
  // El pedido esta realmente resuelto contra el catalogo (motor de venta activo, items con precio y
  // forma de pago). Recien ahi el efecto puede ser el cierre completo.
  | "SALE_REGISTERED_AND_OWNER_NOTIFIED";

export interface RequiredEffect {
  kind: RequiredEffectKind;
  /** Herramienta que produce este efecto - la que se fuerza con tool_choice en el reintento. */
  tool: string;
  /** Por que se exigio. Va al log del turno y al mensaje de sistema del reintento. */
  reason: string;
  /**
   * Momento en que se exigio, o sea el arranque del turno. Sin esto, "la duena quedo avisada" no se
   * puede responder con un SELECT: un aviso de hace tres dias probaria algo que no paso hoy.
   */
  since: Date;
}

/**
 * Lo unico que se mira del mensaje entrante: su tipo de medio. Nunca su texto.
 *
 * Se conserva por compatibilidad con los llamadores, pero ya no es lo que dispara el efecto: una imagen
 * sigue sin atender aunque el cliente escriba diez mensajes de texto despues de mandarla. Ver
 * findUnattendedCustomerImage.
 */
export interface IncomingMessageFacts {
  mediaType: string | null;
}

/**
 * Cuando llego la ultima imagen del cliente que TODAVIA no fue atendida, o null si no hay ninguna.
 *
 * "Atendida" es cualquiera de dos cosas, las dos consultables con un SELECT:
 *   1. el servidor resolvio la foto solo y le mando al cliente la media del producto identificado
 *      (productMediaSentSince) - la mas fuerte, porque el cliente YA tiene la respuesta en pantalla;
 *   2. salio un aviso real a la duena por esta conversacion (ownerWasNotifiedSince:
 *      PendingOwnerQuestion, o un OwnerMessageLog exitoso).
 *
 * La segunda es la misma definicion que usa la verificacion, asi que el efecto no puede exigir algo
 * distinto de lo que despues comprueba. La primera solo puede APAGAR el efecto, nunca exigirlo, asi que
 * no abre esa brecha.
 *
 * Solo se miran las imagenes recientes: un comprobante de hace una semana no es una tarea pendiente, y
 * sin este corte una conversacion vieja con una foto sin avisar volveria a disparar el efecto para
 * siempre.
 */
const UNATTENDED_IMAGE_WINDOW_HOURS = 24;

/**
 * E13b (2026-09-18). La tercera forma de "atendida", y la mas fuerte de las tres: el servidor ya
 * identifico el producto de esa foto y le mando al cliente la media de ESE producto.
 *
 * Caso real, conversacion cmu6b0uja0028od2ka6c04qol (Dennis): a las 01:58:52 el servidor le mando al
 * cliente las dos fotos del Smartwatch gen 9, y a las 02:00:25 el turno igual desperto a la duena para
 * preguntarle que producto era. Ya estaba resuelto y en la pantalla del cliente. Pasaba porque
 * "atendida" solo contemplaba avisos a la duena: que el servidor lo resolviera SOLO no contaba, que es
 * exactamente al reves de lo que uno esperaria.
 *
 * Se mira Message y no SaleState.mediaSent a proposito: mediaSent es un arreglo de ids sin fecha, y la
 * pregunta de aca es "DESPUES de esa imagen". Sin marca de tiempo no se puede responder con un SELECT,
 * y habria que deducirla - que es justo lo que la regla de efectos requeridos prohibe.
 */
export async function productMediaSentSince(conversationId: string, since: Date): Promise<boolean> {
  const enviada = await prisma.message.count({
    where: {
      conversationId,
      role: "ASSISTANT",
      mediaType: { not: null },
      relatedProductId: { not: null },
      createdAt: { gte: since },
    },
  });
  return enviada > 0;
}

export async function findUnattendedCustomerImage(conversationId: string): Promise<Date | null> {
  const desde = new Date(Date.now() - UNATTENDED_IMAGE_WINDOW_HOURS * 60 * 60 * 1000);
  const imagen = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER", mediaType: "IMAGE", createdAt: { gte: desde } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!imagen) return null;
  if (await productMediaSentSince(conversationId, imagen.createdAt)) return null;
  return (await ownerWasNotifiedSince(conversationId, imagen.createdAt)) ? null : imagen.createdAt;
}

interface ConversationFacts {
  businessId: string;
  saleStateEnabled: boolean;
  humanControl: boolean;
  pendingOrderSummary: string | null;
  pendingOrderItems: unknown;
  pendingConfirmationMessageId: string | null;
  // Marca de "ya se le pidio la confirmacion al dueno por esta conversacion", exista o no wamid. El
  // wamid falta justamente cuando el envio fallo por las tres vias, y en ese caso el efecto ya se
  // intento: volver a dispararlo duplicaria la pregunta sin arreglar nada.
  pendingConfirmationAskedAt: Date | null;
  hasOrder: boolean;
}

async function readConversationFacts(conversationId: string): Promise<ConversationFacts | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      humanControl: true,
      pendingOrderSummary: true,
      pendingOrderItems: true,
      pendingConfirmationMessageId: true,
      pendingConfirmationAskedAt: true,
      order: { select: { id: true } },
      customer: { select: { businessId: true, business: { select: { saleStateEnabled: true } } } },
    },
  });
  if (!row) return null;
  return {
    businessId: row.customer.businessId,
    saleStateEnabled: row.customer.business.saleStateEnabled,
    humanControl: row.humanControl,
    pendingOrderSummary: row.pendingOrderSummary,
    pendingOrderItems: row.pendingOrderItems,
    pendingConfirmationMessageId: row.pendingConfirmationMessageId,
    pendingConfirmationAskedAt: row.pendingConfirmationAskedAt,
    hasOrder: Boolean(row.order),
  };
}

/** Lo que el servidor escribio sobre esta conversacion. Ninguna de estas tres cosas la escribe el modelo. */
export interface ServerSaleEvidence {
  /** Items que el servidor resolvio contra el catalogo (set_order_item o show_order_summary). */
  items: SaleStateItem[];
  /** Fotos/videos de producto que SALIERON de verdad por WhatsApp (recordMediaSent). */
  mediaSent: string[];
  /** Ciudad con tarifa real confirmada (get_shipping_rate_for_city con match). */
  shippingCity: string | null;
}

/**
 * ¿El servidor ya registro actividad de venta en esta conversacion? Funcion pura sobre datos ya leidos
 * para poder probarla sin base, misma razon que findHealthIssues en jobs/conversationHealth.ts.
 *
 * `mediaSent` no vacio significa "a este cliente se le presento un producto concreto, y la foto salio de
 * verdad". Es mas debil que un pedido armado, y a proposito: lo unico que habilita es avisarle a la
 * duena, nunca crear un pedido.
 */
export function hasServerSaleEvidence(
  conversation: Pick<ConversationFacts, "pendingOrderSummary" | "pendingOrderItems">,
  evidence: ServerSaleEvidence
): boolean {
  // `pendingOrderItems` es una columna Json anulable: cuando se limpia queda como null JSON, que puede
  // volver del cliente como null o como el literal null. Solo cuenta un objeto de verdad.
  const hasDraft = typeof conversation.pendingOrderItems === "object" && conversation.pendingOrderItems !== null;
  if (conversation.pendingOrderSummary || hasDraft) return true;
  return evidence.items.length > 0 || evidence.mediaSent.length > 0;
}

/**
 * ¿El pedido esta resuelto del todo contra el catalogo? Producto, precio y forma de pago. El precio sale
 * del catalogo (set_order_item lo valida linea por linea), asi que un total > 0 ya significa "hay precio
 * real", no "el modelo dijo un numero". Solo con esto cierto se exige el cierre real en vez del aviso.
 */
export function isSaleFullyResolved(saleState: SaleStateSnapshot | null): boolean {
  if (!saleState) return false;
  return saleState.items.length > 0 && saleState.total > 0 && Boolean(saleState.paymentMethodLabel);
}

/**
 * Lo mismo, PERO SIN EXIGIR EL CANAL DE PAGO, y solo para el camino del comprobante reconocido.
 *
 * POR QUE EXISTE (2026-09-18). Medido en produccion, conversacion de Marcela Ospina: la clienta eligio
 * Nequi, el bot contesto "¡Perfecto, Nequi!" con el resumen completo, y NUNCA llamo set_payment_method.
 * El SaleState quedo con producto, cantidad, precio, modalidad, cedula, celular y direccion -- y
 * `paymentMethodId` en null. Con eso isSaleFullyResolved daba false, el efecto exigido fue el debil (que
 * solo avisa) en vez del fuerte (cuyo respaldo CREA el pedido), y cuando el aviso por WhatsApp fallo no
 * quedaba ninguna salida: pedido 0 y conversacion a control humano.
 *
 * El canal de pago no hace falta para registrar el pedido: `registerSaleFromServer` llama a
 * close_conversation SIN pasarle forma de pago, y la pregunta que se le manda al dueno es "¿te llego
 * $X?", no "¿por cual canal?". Ademas, con un comprobante reconocido el canal ya esta en la imagen que
 * el dueno va a mirar.
 *
 * Lo que esto quita es una DECISION DEL MODELO: que el pedido se registre ya no depende de que se haya
 * acordado de llamar set_payment_method. No se lee prosa en ningun lado -- items y total salen del motor
 * de venta, que valida contra el catalogo linea por linea.
 */
function isSaleResolvedForPaymentProof(saleState: SaleStateSnapshot | null): boolean {
  if (!saleState) return false;
  return saleState.items.length > 0 && saleState.total > 0;
}

/**
 * Cuando quedo lista para registrarse una venta que NADIE registro, o null si no hay ninguna.
 *
 * EL AGUJERO QUE CIERRA, medido el 2026-09-17 sobre 14 dias de produccion: 22 pedidos creados, y el
 * agente llamo close_conversation en 2 turnos. Las otras 20 ventas las cerro la duena a mano desde el
 * panel. El caso completo es Carlos Mendoza (cmu4e3q9l001ozi2ka2x1t1b1, 19:27): SaleState con el item,
 * checkout completo, Contraentrega, Bogota, total 94.000, y el cliente confirmando - y el bot mando el
 * texto de cierre copiado de la plantilla del negocio sin llamar ninguna herramienta. Copiar la
 * plantilla no crea nada: la conversacion quedo en NEW y el pedido no existe.
 *
 * Hasta hoy el unico disparador de este mecanismo era una imagen del cliente sin atender, o sea el
 * comprobante de pago. Una venta contraentrega no tiene comprobante, asi que no disparaba nada - y
 * contraentrega es la modalidad de la mayoria de las ventas de este negocio.
 *
 * LAS TRES CONDICIONES DE ADMISION:
 *
 *  - Disparador determinista: `SaleState.checkout.completo`, que computeCheckoutState calcula desde la
 *    base, mas la fecha del ultimo mensaje del cliente. Dos SELECT. No se lee una sola palabra, ni del
 *    cliente ni del modelo.
 *  - Verificable con una consulta: existe o no una fila Order para esta conversacion.
 *  - Con fallback sin modelo: registerSaleFromServer, que ya existe y ya corre para el otro disparador.
 *
 * POR QUE EL ULTIMO MENSAJE DEL CLIENTE TIENE QUE SER POSTERIOR AL ESTADO COMPLETO. Es el disparador
 * invertido: el turno en el que el estado se completa - el cliente acaba de elegir la forma de pago - NO
 * registra nada. Recien el turno siguiente, o sea despues de que el cliente volvio a escribir con el
 * pedido ya armado delante, el pedido tiene que existir. Asi el cliente siempre tiene un mensaje entero
 * para decir "esperate, no" antes de que se registre nada, y esa garantia no depende de leerle la
 * respuesta: depende de comparar dos fechas.
 */
async function saleReadyToRegisterSince(
  businessId: string,
  conversationId: string,
  saleState: SaleStateSnapshot | null
): Promise<Date | null> {
  if (!saleState || !saleState.checkout.completo) return null;

  const row = await prisma.saleState.findUnique({ where: { conversationId }, select: { updatedAt: true } });
  if (!row) return null;

  const ultimoDelCliente = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!ultimoDelCliente) return null;

  // El estado se completo DESPUES del ultimo mensaje del cliente: este es el turno en el que se
  // completo, y el cliente todavia no dijo nada con el pedido armado delante. No se registra nada.
  if (ultimoDelCliente.createdAt <= row.updatedAt) return null;

  // UNA VENTA QUE NO SE PUEDE REGISTRAR NO SE EXIGE (2026-09-18).
  //
  // El pedido puede estar completo y aun asi ser imposible de cerrar: si el negocio pide comprobante,
  // el pago es por adelantado y el cliente todavia no mando la foto, `close_conversation` se niega, y
  // con razon. Exigir el efecto igual hacia esto, medido en una conversacion de prueba:
  //
  //   el modelo no llama close_conversation -> reintento -> reintento -> fallback por codigo, que
  //   devuelve "este negocio pide ver el comprobante" -> escalacion -> la conversacion se va a control
  //   humano y el cliente queda esperando a una persona.
  //
  // Tres llamadas al modelo y una conversacion muerta por algo que no es culpa de nadie: falta un dato
  // del cliente. Mientras falte, la venta no esta lista, y lo que hay que hacer es pedir la foto -- no
  // registrar un pedido que no se puede registrar.
  //
  // Es la misma consulta con la que el cierre decide negarse, asi que las dos partes no pueden opinar
  // distinto.
  const metodo = saleState.paymentMethodId
    ? await prisma.paymentMethod.findUnique({ where: { id: saleState.paymentMethodId }, select: { settlement: true } })
    : null;
  const pagoPorAdelantado = metodo?.settlement === "PREPAID";
  if (await faltaComprobanteDePago(businessId, conversationId, { pagoPorAdelantado })) return null;

  // El reloj del efecto arranca en el mensaje del cliente: lo que hay que probar es que el pedido existe
  // al terminar ESTE turno.
  return ultimoDelCliente.createdAt;
}

/**
 * Los efectos que ESTE turno esta obligado a producir, calculados solo desde estado de la base.
 *
 * Dos disparadores, los dos leidos de la base y ninguno de prosa: una venta lista que nadie registro
 * (2026-09-17) y una imagen del cliente sin atender (2026-09-16). El primero va antes porque es el mas
 * fuerte: si el pedido se puede registrar, registrarlo es lo que hay que hacer, haya foto o no.
 */
export async function computeRequiredEffects(
  conversationId: string,
  incomingMessage: IncomingMessageFacts
): Promise<RequiredEffect[]> {
  const conversation = await readConversationFacts(conversationId);
  if (!conversation) return [];

  // La conversacion no esta en manos de una persona.
  if (conversation.humanControl) return [];

  // Candado de idempotencia, comun a los dos disparadores: no existe ya un Order para esta conversacion,
  // ni una confirmacion de pago esperando a la duena - entre pedirla y que conteste, el efecto YA ocurrio
  // aunque todavia no haya fila.
  if (conversation.hasOrder || conversation.pendingConfirmationAskedAt) return [];

  const saleState = conversation.saleStateEnabled ? await getSaleState(conversationId) : null;

  // DISPARADOR 1: la venta esta lista y nadie la registro.
  const ventaLista = await saleReadyToRegisterSince(conversation.businessId, conversationId, saleState);
  if (ventaLista) {
    return [
      {
        kind: "SALE_REGISTERED_AND_OWNER_NOTIFIED",
        tool: "close_conversation",
        reason:
          "el pedido de esta conversacion esta completo contra el catalogo (producto, datos de entrega y forma de pago) y el cliente volvio a escribir con el ya armado: tiene que quedar registrado antes de responderle",
        since: ventaLista,
      },
    ];
  }

  // DISPARADOR 2: hay una imagen del cliente SIN ATENDER en esta conversacion.
  //
  // Antes la condicion era "el mensaje entrante trae mediaType IMAGE", y ese era el agujero F1. Caso real
  // de produccion (Milena, 2026-09-16 03:20-03:22): mando el comprobante y enseguida escribio "Te envie
  // lo del envio de paso". Ese texto paso a ser el ultimo mensaje, el efecto no se exigio, y el bot le
  // dijo "estoy validando tu comprobante y confirmando con el equipo" sin que se abriera nada. La duena
  // nunca se entero y la clienta quedo esperando. Diez incidentes en catorce dias, todos este mismo caso.
  //
  // La imagen no deja de existir porque llegue un mensaje de texto despues. El disparador pasa a ser el
  // estado de la conversacion - una fila de Message con mediaType IMAGE - y no la posicion de ese mensaje
  // en la fila. Sigue siendo metadato estructurado, nunca prosa: no se lee que dice la imagen ni que dice
  // el texto.
  const imagenSinAtender = await findUnattendedCustomerImage(conversationId);
  if (!imagenSinAtender) return [];

  // UN COMPROBANTE NO ES UNA FOTO SIN IDENTIFICAR, PERO TAMPOCO ES NADA (2026-09-18, segunda pasada).
  //
  // Este disparador existe para la foto de un producto que el bot no supo reconocer. Un comprobante de
  // pago no es eso, y ademas ask_owner_about_photo se NIEGA a escalarlo como producto (E81) -- con lo
  // cual ese efecto quedaba imposible de cumplir y la conversacion terminaba en "un asesor del equipo va
  // a continuar contigo", con el bot apagado.
  //
  // La primera version de este guard resolvio eso devolviendo lista vacia, o sea NO EXIGIENDO NADA, con
  // el argumento de que el pago tiene su propio camino (close_conversation le pregunta al dueno si le
  // llego la plata). Medido en produccion horas despues: ese camino no corre si el modelo no llama la
  // herramienta, y no la llamo. Ver el comentario de OWNER_NOTIFIED_ABOUT_PAYMENT arriba.
  //
  // Ahora el comprobante NO sale por la puerta de atras: cambia de efecto. Se le exige al turno que el
  // dueno quede avisado DEL PAGO, con close_conversation como herramienta forzada -- que es la que
  // corresponde y la unica que crea el pedido -- y con el mismo respaldo por codigo que la imagen
  // generica, que avisa sin el modelo adentro.
  const mensajeDeLaImagen = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER", mediaType: "IMAGE", createdAt: { gte: imagenSinAtender } },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
  const esComprobante =
    Boolean(mensajeDeLaImagen) &&
    (await esLaImagenDelComprobante(conversationId, mensajeDeLaImagen!.id, mensajeDeLaImagen!.createdAt));

  // Hay evidencia de venta en curso ESCRITA POR EL SERVIDOR.
  const evidence = await getServerSaleEvidence(conversationId);
  if (!hasServerSaleEvidence(conversation, evidence)) return [];

  // El reloj del efecto arranca cuando LLEGO LA IMAGEN, no cuando arranca el turno: lo que hay que
  // probar es que la duena quedo avisada de ESA imagen. Un aviso posterior a ella ya la atiende, aunque
  // haya salido en un turno anterior.
  const since = imagenSinAtender;

  // El comprobante va DESPUES de la rama del cierre completo a proposito: cuando el negocio lleva el
  // pedido en el motor de venta y ese pedido esta completo, SALE_REGISTERED_AND_OWNER_NOTIFIED es el
  // efecto mas fuerte de los dos -- su respaldo por codigo CREA el pedido (registerSaleFromServer), y el
  // de aca solo avisa. Con un comprobante en la mano, crear el pedido es mejor que avisar de el.

  // La distincion va explicita, no implicita: el cierre real solo cuando el negocio lleva el pedido en
  // el motor de venta Y ese pedido esta completo. En cualquier otro caso el efecto es el aviso.
  if (conversation.saleStateEnabled && isSaleFullyResolved(saleState)) {
    return [
      {
        kind: "SALE_REGISTERED_AND_OWNER_NOTIFIED",
        tool: "close_conversation",
        reason:
          "el cliente mando una imagen con un pedido ya resuelto contra el catalogo, asi que el pedido tiene que quedar registrado y el dueno avisado antes de responderle",
        since,
      },
    ];
  }

  // Comprobante reconocido con el pedido armado en el motor de venta: va el efecto FUERTE, aunque falte
  // el canal de pago. Ver isSaleResolvedForPaymentProof -- el canal no hace falta para registrar, y
  // exigirlo dejaba la venta de Marcela sin pedido cuando el aviso por WhatsApp fallo.
  if (esComprobante && conversation.saleStateEnabled && isSaleResolvedForPaymentProof(saleState)) {
    return [
      {
        kind: "SALE_REGISTERED_AND_OWNER_NOTIFIED",
        tool: "close_conversation",
        reason:
          "el cliente mando el comprobante de pago y el pedido ya esta armado contra el catalogo: tiene que quedar registrado y el dueno avisado antes de responderle",
        since,
      },
    ];
  }

  // Comprobante reconocido, sin motor de venta o sin items todavia: se fuerza el cierre igual -- es la
  // herramienta que le pregunta al dueno si le llego la plata, y la unica que crea el pedido -- y si el
  // modelo no la llama, el respaldo por codigo le avisa igual. Lo que ya NO puede pasar es que el
  // turno no exija nada, que es como Sandra Gil termino con "todo queda listo" y cero pedido.
  if (esComprobante) {
    return [
      {
        kind: "OWNER_NOTIFIED_ABOUT_PAYMENT",
        tool: "close_conversation",
        reason:
          "el cliente mando el comprobante de pago de esta conversacion: el pedido tiene que quedar registrado y el dueno avisado para que confirme si le llego la plata, antes de responderle",
        since,
      },
    ];
  }

  return [
    {
      kind: "OWNER_NOTIFIED_ABOUT_IMAGE",
      tool: "ask_owner_about_photo",
      reason:
        "el cliente mando una imagen en una conversacion donde ya se le presento un producto, y puede ser un comprobante de pago: el dueno tiene que quedar avisado antes de responderle",
      since,
    },
  ];
}

/**
 * Comprueba contra la base cuales de los efectos exigidos NO ocurrieron. Se llama ANTES de mandar la
 * respuesta: si el efecto falta, el texto del modelo tambien esta mal ("estoy confirmando con el equipo"
 * cuando no se consulto a nadie no debe salir nunca).
 *
 * Devuelve los efectos que faltan (lista vacia = el turno hizo lo que dice que hizo).
 */
export async function verifyRequiredEffects(conversationId: string, effects: RequiredEffect[]): Promise<RequiredEffect[]> {
  if (effects.length === 0) return [];
  const conversation = await readConversationFacts(conversationId);
  if (!conversation) return [];

  // Dos formas validas de que el cierre haya ocurrido, y las dos salen de la base:
  //  - hay Order (negocio sin contactPhone: close_conversation autocierra y crea el pedido), o
  //  - hay pendingConfirmationMessageId (close_conversation le mando "¿Te llego el pago?" al dueno y
  //    quedo esperando su respuesta; ese campo solo se escribe cuando el envio devolvio wamid, o sea
  //    cuando el dueno REALMENTE recibio el aviso - ver ownerConfirmation.ts).
  //
  // A proposito el wamid y no pendingConfirmationAskedAt, que es la marca de "hay confirmacion viva":
  // una confirmacion reservada cuyos tres envios fallaron NO prueba que el dueno se entero, asi que el
  // efecto sigue faltando y la escalacion de este modulo tiene que correr igual.
  const saleClosed = conversation.hasOrder || Boolean(conversation.pendingConfirmationMessageId);

  const missing: RequiredEffect[] = [];
  for (const effect of effects) {
    if (effect.kind === "SALE_REGISTERED_AND_OWNER_NOTIFIED") {
      if (saleClosed) continue;
      missing.push(effect);
      continue;
    }
    if (effect.kind === "OWNER_NOTIFIED_ABOUT_IMAGE" || effect.kind === "OWNER_NOTIFIED_ABOUT_PAYMENT") {
      // Mismo criterio para los dos, y es el correcto para el pago: `saleClosed` incluye
      // pendingConfirmationMessageId, o sea el "¿Te llego el pago?" que close_conversation le manda al
      // dueno con wamid en mano. Si eso salio, el dueno esta avisado del pago por el camino bueno.
      if (saleClosed || (await ownerWasNotifiedSince(conversationId, effect.since))) continue;
      missing.push(effect);
    }
  }
  return missing;
}

/**
 * ¿Salio un aviso REAL al dueno por esta conversacion desde que arranco el turno? Dos filas posibles, las
 * dos escritas por el servidor en el momento del envio y las dos acotadas a esta conversacion:
 *
 *  - PendingOwnerQuestion: la escriben ask_owner y ask_owner_about_photo, y solo con wamid en mano.
 *  - OwnerMessageLog con success y conversationId: el aviso del fallback de este mismo modulo.
 *
 * El corte por `since` no es cosmetico: sin el, un aviso viejo probaria un efecto de hoy.
 *
 * E56 (2026-09-17): el conteo de PendingOwnerQuestion NO filtra por `resolvedAt`, y esa es la
 * diferencia con todas las demas consultas de este repositorio. Acá la pregunta no es "¿sigue
 * abierta?" sino "¿se le aviso al dueno?", y avisado sigue avisado despues de que conteste. Mientras
 * resolver era BORRAR la fila, la respuesta del dueno hacia desaparecer la prueba del aviso: la imagen
 * quedaba sin atender para siempre y cada turno volvia a forzar ask_owner_about_photo y a reenviar la
 * misma identificacion de producto (conversacion cmu4xfymx00bxq92kb1aj3iil, el mismo mensaje dos veces
 * con cuatro minutos de diferencia).
 */
async function ownerWasNotifiedSince(conversationId: string, since: Date): Promise<boolean> {
  const pregunta = await prisma.pendingOwnerQuestion.count({ where: { conversationId, createdAt: { gte: since } } });
  if (pregunta > 0) return true;
  const aviso = await prisma.ownerMessageLog.count({
    where: { conversationId, direction: "OUT", success: true, createdAt: { gte: since } },
  });
  return aviso > 0;
}

// Resumen del pedido para el fallback, armado desde la base. Nunca desde la prosa del modelo: eso es
// justamente lo que este mecanismo existe para dejar de hacer.
function buildSaleSummaryFromDb(saleState: SaleStateSnapshot | null, locale: string, fallbackSummary: string | null): string {
  if (!saleState || saleState.items.length === 0) return fallbackSummary ?? "";
  const currency = saleState.items[0].currency;
  const lineas = saleState.items.map((item) => {
    const nombre = item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName;
    return `${item.quantity}x ${nombre} - ${formatPrice(totalDeLinea(item.unitPrice, item.quantity, item.currency).comoNumeroParaMostrar(), currency, locale)}`;
  });
  if (saleState.shippingCost) lineas.push(`Envio: ${formatPrice(saleState.shippingCost, currency, locale)}`);
  lineas.push(`TOTAL: ${formatPrice(saleState.total, currency, locale)}`);
  if (saleState.paymentMethodLabel) lineas.push(`Pago: ${saleState.paymentMethodLabel}`);
  if (saleState.address) lineas.push(`Envio a: ${saleState.address}`);
  return lineas.join("\n");
}

/** Texto FIJO, escrito por nosotros, para cuando el pedido lo cerro el fallback y no el modelo. */
export const FALLBACK_SALE_REGISTERED_TEXT =
  "Listo, ya registré tu pedido y le pasé tu comprobante al equipo para que confirme el pago. Apenas lo confirmen te aviso por acá.";

/**
 * Texto FIJO para cuando el fallback avisó a la dueña pero NO registró ningún pedido. No afirma que haya
 * un pedido creado - porque no lo hay - y no le pide nada mas al cliente.
 */
export const FALLBACK_IMAGE_RECEIVED_TEXT =
  "Recibí tu imagen y ya se la pasé al equipo para que la revise y la confirme. Apenas me confirmen te aviso por acá.";

/**
 * Igual que el anterior pero para un comprobante YA RECONOCIDO por el servidor. Dice comprobante porque
 * el servidor sabe que lo es, y sigue sin afirmar que el pago este confirmado ni que exista un pedido:
 * eso lo decide el dueno mirando su cuenta.
 */
export const FALLBACK_PAYMENT_RECEIVED_TEXT =
  "Recibí tu comprobante y ya se lo pasé al equipo para que confirme el pago. Apenas me confirmen te aviso por acá.";

/** Texto FIJO para cuando no se pudo producir el efecto: no afirma que haya pasado nada. */
export const ESCALATION_TEXT =
  "Recibí tu mensaje. Un asesor del equipo va a continuar por acá contigo en un momento.";

export interface FallbackResult {
  ok: boolean;
  /** Que se hizo, para el incidente y el log del turno. */
  detail: string;
  /** Texto FIJO nuestro para el cliente, si el fallback funciono. Depende de que efecto se produjo. */
  customerText: string | null;
}

/** Como nombrar al cliente en el aviso al dueno. Misma regla de privacidad que describeCustomer en tools.ts. */
function describeCustomerRow(customer: { name: string | null; whatsappProfileName: string | null; phoneNumber: string }): string {
  const nombre = customer.name ?? customer.whatsappProfileName;
  if (!isBsuid(customer.phoneNumber)) {
    return nombre ? `${nombre} (${customer.phoneNumber})` : customer.phoneNumber;
  }
  return nombre ? `${nombre} (sin numero visible, privacidad de WhatsApp activada)` : "un cliente (sin numero visible, privacidad de WhatsApp activada)";
}

/**
 * FALLBACK del efecto OWNER_NOTIFIED_ABOUT_IMAGE: le avisa a la duena por el camino que ya existe
 * (sendAlertToOwner + recordOwnerMessage) con el resumen de lo que el SERVIDOR sabe, y dice
 * explicitamente que llego una imagen que puede ser un comprobante.
 *
 * NO crea el Order a proposito: nada en la base distingue un comprobante de cualquier otra foto, y un
 * pedido inventado sobre una imagen ambigua cuesta mucho mas que un aviso de mas.
 */
async function notifyOwnerAboutImage(
  context: ToolContext,
  evidence: ServerSaleEvidence,
  esComprobanteReconocido = false
): Promise<FallbackResult> {
  const business = await prisma.business.findUnique({
    where: { id: context.businessId },
    select: { contactPhone: true, contactName: true, currency: true },
  });
  if (!business?.contactPhone) {
    return { ok: false, detail: "El negocio no tiene Telefono de contacto configurado: no hay a quien avisarle.", customerText: null };
  }

  const customer = await prisma.customer.findUnique({
    where: { id: context.customerId },
    select: { name: true, whatsappProfileName: true, phoneNumber: true, idNumber: true, deliveryPhone: true, address: true },
  });
  const locale = context.locale ?? "es-CO";

  const datos: string[] = [];
  if (evidence.mediaSent.length > 0) datos.push(`Productos que ya se le mostraron: ${evidence.mediaSent.join(", ")}.`);
  if (evidence.items.length > 0) {
    const currency = evidence.items[0].currency;
    const lineas = evidence.items.map((i) => {
      const nombre = i.variantLabel ? `${i.productName} (${i.variantLabel})` : i.productName;
      return `${i.quantity}x ${nombre} - ${formatPrice(totalDeLinea(i.unitPrice, i.quantity, i.currency).comoNumeroParaMostrar(), currency, locale)}`;
    });
    datos.push(`Ultimo resumen de pedido mostrado: ${lineas.join("; ")}.`);
  }
  if (evidence.shippingCity) {
    const tarifa = await resolveShippingRateForCity(context.businessId, evidence.shippingCity);
    datos.push(
      tarifa
        ? `Envio confirmado: ${evidence.shippingCity} - ${tarifa.label}, ${formatPrice(Number(tarifa.cost), business.currency, locale)}.`
        : `Ciudad de envio mencionada: ${evidence.shippingCity}.`
    );
  }
  const ficha = [
    customer?.idNumber ? `cedula ${customer.idNumber}` : null,
    customer?.deliveryPhone ? `celular ${customer.deliveryPhone}` : null,
    customer?.address ? `direccion ${customer.address}` : null,
  ].filter(Boolean);
  if (ficha.length > 0) datos.push(`Datos de entrega ya guardados: ${ficha.join(", ")}.`);

  const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
  const customerLabel = customer ? describeCustomerRow(customer) : context.recipientPhone;
  const text = [
    esComprobanteReconocido
      ? `${greeting}, el cliente ${customerLabel} mando un COMPROBANTE DE PAGO y el bot no logro cerrar el pedido. Revisa si te llego la plata.`
      : `${greeting}, el cliente ${customerLabel} mando una IMAGEN y el bot no la resolvio. Puede ser un comprobante de pago: hay que revisarla.`,
    datos.length > 0 ? datos.join("\n") : "Todavia no hay datos de pedido registrados en esta conversacion.",
    "El bot NO registro ningun pedido ni confirmo ningun pago. Abre esa conversacion en el panel y revísala tú.",
  ].join("\n\n");

  const alerta = await sendAlertToOwner(context.businessId, context.credentials, business.contactPhone, text);
  await recordOwnerMessage(context.businessId, {
    direction: "OUT",
    body: text,
    success: alerta.delivered,
    errorMessage: alerta.failure?.message ?? null,
    // Con esto el aviso es verificable por conversacion con un SELECT, que es lo que exige la regla de
    // admision del mecanismo (ver ONIX-PLAN-CATALOGO-Y-MEDIOS.md seccion 6).
    conversationId: context.conversationId,
  });
  if (!alerta.delivered) {
    console.error("No se pudo avisar al dueno de la imagen recibida:", alerta.failure?.message);
    return { ok: false, detail: `No se pudo avisar al dueno: ${alerta.failure?.message ?? "sin wamid"}`, customerText: null };
  }
  return {
    ok: true,
    detail: esComprobanteReconocido
      ? "aviso al dueno enviado por el comprobante; no se registro ningun pedido"
      : "aviso al dueno enviado; no se registro ningun pedido",
    customerText: esComprobanteReconocido ? FALLBACK_PAYMENT_RECEIVED_TEXT : FALLBACK_IMAGE_RECEIVED_TEXT,
  };
}

/**
 * FALLBACK del efecto SALE_REGISTERED_AND_OWNER_NOTIFIED: ejecuta la herramienta que falta desde el
 * servidor, con argumentos derivados de la base. Reusa el MISMO camino que usa close_conversation hoy
 * (runCatalogTool -> requestSaleConfirmation -> createOrder); no existe una segunda forma de crear
 * pedidos.
 */
async function registerSaleFromServer(context: ToolContext, effect: RequiredEffect): Promise<FallbackResult> {
  const conversation = await readConversationFacts(context.conversationId);
  if (!conversation) return { ok: false, detail: "La conversacion ya no existe.", customerText: null };

  const saleState = await getSaleState(context.conversationId);
  const locale = context.locale ?? "es-CO";
  const summary = buildSaleSummaryFromDb(saleState, locale, conversation.pendingOrderSummary);

  // Negocio sin SaleState: los items salen del borrador ya persistido (pendingOrderItems), que tambien es
  // estado de la base. Con SaleState activo close_conversation ignora `items` y lee el motor, asi que
  // mandarlos igual no cambia nada.
  const draft = conversation.pendingOrderItems as { items?: { productName?: unknown; quantity?: unknown; variantLabel?: unknown }[] } | null;
  const items = Array.isArray(draft?.items)
    ? draft.items
        .filter((i) => typeof i?.productName === "string" && typeof i?.quantity === "number")
        .map((i) => ({
          productName: String(i.productName),
          quantity: Number(i.quantity),
          ...(typeof i.variantLabel === "string" ? { variantLabel: i.variantLabel } : {}),
        }))
    : [];

  try {
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary,
      ...(items.length > 0 ? { items } : {}),
    })) as { closed?: boolean; pending?: boolean; note?: string; error?: string };

    // No alcanza con que la herramienta no haya tirado: se vuelve a comprobar contra la base, que es lo
    // unico que prueba que el efecto ocurrio.
    const stillMissing = await verifyRequiredEffects(context.conversationId, [effect]);
    if (stillMissing.length === 0) {
      return {
        ok: true,
        detail: result?.pending ? "pedido registrado, esperando la confirmacion del dueno" : "pedido cerrado y registrado",
        customerText: FALLBACK_SALE_REGISTERED_TEXT,
      };
    }
    return {
      ok: false,
      detail: result?.note ?? result?.error ?? "close_conversation corrio pero el efecto sigue sin verse en la base",
      customerText: null,
    };
  } catch (error) {
    console.error("Fallo el fallback por codigo de un efecto requerido:", error);
    return { ok: false, detail: error instanceof Error ? error.message : String(error), customerText: null };
  }
}

/** FALLBACK POR CODIGO. Despacha segun el efecto: el aviso siempre, el cierre solo cuando se exigio. */
export async function runRequiredEffectFallback(context: ToolContext, effect: RequiredEffect): Promise<FallbackResult> {
  if (effect.kind === "SALE_REGISTERED_AND_OWNER_NOTIFIED") return registerSaleFromServer(context, effect);
  if (effect.kind === "OWNER_NOTIFIED_ABOUT_IMAGE" || effect.kind === "OWNER_NOTIFIED_ABOUT_PAYMENT") {
    const evidence = await getServerSaleEvidence(context.conversationId);
    // El aviso es el mismo camino (sendAlertToOwner + recordOwnerMessage) y sigue sin crear ningun
    // Order: el fallback avisa, no cobra. La diferencia es el texto, que con un comprobante reconocido
    // puede decirle al dueno exactamente que revise -- si le llego la plata -- en vez de "puede ser un
    // comprobante".
    const outcome = await notifyOwnerAboutImage(context, evidence, effect.kind === "OWNER_NOTIFIED_ABOUT_PAYMENT");
    if (!outcome.ok) return outcome;
    // Misma regla que arriba: el resultado de la funcion no prueba nada, la base si.
    const stillMissing = await verifyRequiredEffects(context.conversationId, [effect]);
    if (stillMissing.length > 0) {
      return { ok: false, detail: "el aviso al dueno corrio pero el efecto sigue sin verse en la base", customerText: null };
    }
    return outcome;
  }
  return { ok: false, detail: `No hay fallback por codigo para el efecto ${effect.kind}.`, customerText: null };
}

/** Texto del aviso final al dueno cuando ni el reintento ni el fallback lograron el efecto. */
export function escalationOwnerAlertText(kind: RequiredEffectKind): string {
  if (kind === "SALE_REGISTERED_AND_OWNER_NOTIFIED") {
    return "Atencion: un cliente tiene un pedido ya armado y el bot no logro registrarlo (ni el modelo ni el cierre automatico). Esa conversacion quedo esperandote en el panel - revisala a mano.";
  }
  if (kind === "OWNER_NOTIFIED_ABOUT_PAYMENT") {
    return "Atencion: un cliente mando un COMPROBANTE DE PAGO y el bot no logro registrar el pedido ni avisarte por el camino normal. Revisa si te llego la plata - esa conversacion quedo esperandote en el panel.";
  }
  return "Atencion: un cliente mando una imagen que puede ser un comprobante de pago y el bot no logro avisarte por el camino normal. Esa conversacion quedo esperandote en el panel - revísala a mano.";
}

// OBSERVABILIDAD. Sin esto no hay forma de saber si el mecanismo sirve, y sobre todo: el contador
// `retryResolved` contra `fallbackUsed` es el numero que decide si en el futuro se puede confiar en el
// reintento (ver la medicion de tool_choice del 2026-09-15 que motivo todo esto).
// El caller real (routes/whatsapp.ts) descarta la respuesta si la conversacion quedo en control humano
// mientras se generaba - esa comprobacion existe para no pisar a una persona que tomo el chat a mano. La
// escalacion de abajo pone humanControl ella misma, asi que sin esta marca su texto neutro se descartaria
// y el cliente que acaba de pagar se quedaria sin ninguna respuesta: exactamente el silencio que este
// mecanismo existe para eliminar. La marca se consume una sola vez, en el mismo proceso y turno.
const escalatedTurns = new Set<string>();

export function markEscalatedTurn(conversationId: string): void {
  escalatedTurns.add(conversationId);
}

/** true si el turno que acaba de generarse escalo por su cuenta (y limpia la marca). */
export function consumeEscalatedTurn(conversationId: string): boolean {
  return escalatedTurns.delete(conversationId);
}

export interface RequiredEffectsTurnLog {
  conversationId: string;
  required: RequiredEffectKind[];
  missingAfterFirstAttempt: RequiredEffectKind[];
  retries: number;
  retryResolved: boolean;
  fallbackUsed: boolean;
  fallbackResolved: boolean;
  escalated: boolean;
}

export const requiredEffectStats = {
  turnsWithRequiredEffects: 0,
  missingAfterFirstAttempt: 0,
  retries: 0,
  retryResolved: 0,
  fallbackUsed: 0,
  fallbackResolved: 0,
  escalated: 0,
};

export function resetRequiredEffectStats(): void {
  requiredEffectStats.turnsWithRequiredEffects = 0;
  requiredEffectStats.missingAfterFirstAttempt = 0;
  requiredEffectStats.retries = 0;
  requiredEffectStats.retryResolved = 0;
  requiredEffectStats.fallbackUsed = 0;
  requiredEffectStats.fallbackResolved = 0;
  requiredEffectStats.escalated = 0;
}

export function recordRequiredEffectsTurn(log: RequiredEffectsTurnLog): void {
  requiredEffectStats.turnsWithRequiredEffects++;
  if (log.missingAfterFirstAttempt.length > 0) requiredEffectStats.missingAfterFirstAttempt++;
  requiredEffectStats.retries += log.retries;
  if (log.retryResolved) requiredEffectStats.retryResolved++;
  if (log.fallbackUsed) requiredEffectStats.fallbackUsed++;
  if (log.fallbackResolved) requiredEffectStats.fallbackResolved++;
  if (log.escalated) requiredEffectStats.escalated++;
  console.log(
    `[efectos-requeridos] conv=${log.conversationId} exigidos=${log.required.join(",") || "-"} ` +
      `faltaban=${log.missingAfterFirstAttempt.join(",") || "-"} reintentos=${log.retries} ` +
      `reintento_alcanzo=${log.retryResolved} fallback=${log.fallbackUsed} fallback_alcanzo=${log.fallbackResolved} escalado=${log.escalated}`
  );
}
