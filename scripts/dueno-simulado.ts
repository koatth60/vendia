import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client";
import { sendToCustomer } from "../src/whatsapp/outbound";
import { setHumanControl } from "../src/conversation/service";
import { esDuenoSimulado } from "../src/whatsapp/simulacion";

// EL DUEÑO, VIVO DENTRO DE LA CONVERSACIÓN (2026-09-18).
//
// Hasta hoy las pruebas corrían la conversación entera y recién al final alguien contestaba como dueño.
// Eso mide un flujo cortado por la mitad: cuando el bot escala, la clienta se queda esperando una
// respuesta que en esa corrida no va a llegar nunca, y la conversación se cuenta como fallida por algo
// que en la realidad se habría resuelto en un minuto.
//
// Lo dijo el dueño del proyecto: "asegúrate de que el flujo sea el adecuado; tú interceptas el mensaje,
// tú deberías responder". Esto es eso: entre turno y turno de la clienta, si quedó algo esperando a una
// persona, se contesta y se sigue.
//
// Hay DOS caminos de escalación y no se parecen:
//
//   ask_owner / ask_owner_about_price / ask_owner_about_photo -> crean una PendingOwnerQuestion, que se
//     contesta CITANDO el mensaje del bot (context.id con su wamid, ver handleOwnerReply).
//   flag_conversation_intent -> no crea nada: apaga el bot y espera a que alguien entre al panel. Se
//     contesta escribiéndole al cliente como persona y devolviendo el control.
//   la CONFIRMACIÓN DE VENTA -> el bot le manda al dueño "¿te llegó el pago?" y guarda el wamid en
//     Conversation.pendingConfirmationMessageId. En un pedido prepago el Order NO EXISTE hasta que el
//     dueño contesta que sí: medido el 2026-09-18, tres conversaciones con el comprobante ya mandado, el
//     bot diciéndole al cliente "tu pedido está completo y en verificación de pago", y cero pedidos en
//     la lista. No es que el bot fallara: nadie contestó la confirmación.

const URL_BASE = process.env.URL ?? "http://localhost:3000";

function cuerpoDeWebhookDelDueno(phoneNumberId: string, desde: string, texto: string, citando: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "dueno",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573000000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Dueno" }, wa_id: desde }],
              messages: [
                {
                  from: desde,
                  id: `wamid.DUENO.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: texto },
                  context: { id: citando },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Qué contesta el dueño según lo que le preguntaron.
 *
 * El contenido da igual con tal de que sea del tipo correcto: lo que se prueba es el circuito. Lo único
 * que importa es que cada tipo reciba algo que el servidor pueda procesar -- un producto real para
 * PHOTO_PRODUCT, un número válido por item para PRICE, prosa para TEXT.
 */
async function respuestaPara(kind: string, businessId: string, conversationId: string): Promise<string> {
  if (kind === "PHOTO_PRODUCT") {
    // EL PRODUCTO QUE ESTA EN JUEGO, NO UNO CUALQUIERA (2026-09-18).
    //
    // Antes se contestaba con el primero del catalogo con stock, y eso descarrilaba la conversacion: a
    // una clienta que estaba comprando un parlante le llego "Segun nuestro equipo, el producto que
    // buscas es: AIRPODS MAX - $95000". La venta se perdia por culpa del banco de pruebas, no del bot.
    const estado = await prisma.saleState.findFirst({ where: { conversationId }, select: { items: true } });
    const items = (estado?.items as { productName?: string }[] | null) ?? [];
    if (items[0]?.productName) return items[0].productName;

    // Sin nada en el pedido todavia, el ultimo producto del que el servidor mando una foto.
    const conMedia = await prisma.agentTurn.findFirst({
      where: { conversationId, mediaProductIds: { isEmpty: false } },
      orderBy: { createdAt: "desc" },
      select: { mediaProductIds: true },
    });
    const ultimoId = conMedia?.mediaProductIds?.[conMedia.mediaProductIds.length - 1];
    if (ultimoId) {
      const p = await prisma.product.findUnique({ where: { id: ultimoId }, select: { name: true } });
      if (p?.name) return p.name;
    }
    return "No lo tengo en el catalogo";
  }
  if (kind === "PRICE") {
    const estado = await prisma.saleState.findFirst({ where: { conversationId }, select: { items: true } });
    const items = (estado?.items as { unitPrice?: number }[] | null) ?? [];
    if (items.length === 0) return "80000";
    return items.map((i) => Math.max(1000, Math.round((i.unitPrice ?? 80000) * 0.9))).join(" ");
  }
  return "Si, lo manejamos sin problema. Decile que si y segui con el pedido.";
}

const RESPUESTA_POR_INTENT: Record<string, string> = {
  PQR: "Hola, soy del equipo. Ya revise tu caso y lo resolvemos hoy mismo. Contame que paso exactamente.",
  DEVOLUCION: "Hola, soy del equipo. Aceptamos cambios dentro de los 5 dias siguientes a la entrega, con el producto sin usar. Contame cual es el pedido.",
  NO_RECIBIDO: "Hola, soy del equipo. Ya estoy revisando tu envio con la transportadora y te confirmo hoy mismo donde va.",
  SOLICITA_AGENTE: "Hola, soy del equipo, ya estoy aca. Contame en que te ayudo.",
};

export interface Credenciales {
  phoneNumberId: string;
  accessToken: string;
}

/**
 * Atiende TODO lo que esta conversación tenga esperando a una persona. Devuelve cuántas cosas atendió.
 *
 * Se llama entre turno y turno de la clienta: si no hay nada pendiente devuelve 0 y no cuesta nada.
 */
export async function atenderComoDueno(
  businessId: string,
  conversationId: string,
  credenciales: Credenciales,
  telefonoDelDueno: string,
): Promise<number> {
  // SI EL DUEÑO ES UNA PERSONA DE VERDAD, NO SE CONTESTA POR ELLA (2026-09-18).
  //
  // El dueño puso su propio numero para atender el las escalaciones, y esto siguio contestando igual:
  // le quito la conversacion antes de que alcanzara a responder, y al cliente le llego "Hola, soy del
  // equipo, ya estoy aca" escrito por el simulador. Contestar por una persona de verdad, en su nombre,
  // sin que lo sepa, no se hace nunca.
  if (!(await esDuenoSimulado(businessId, telefonoDelDueno))) {
    console.log(`(el dueño de este negocio es un numero real: ${telefonoDelDueno}. No se contesta por el.)`);
    return 0;
  }

  let atendidas = 0;

  const preguntas = await prisma.pendingOwnerQuestion.findMany({
    where: { conversationId, resolvedAt: null },
    select: { id: true, wamid: true, kind: true },
  });
  for (const q of preguntas) {
    const respuesta = await respuestaPara(q.kind, businessId, conversationId);
    await fetch(`${URL_BASE}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpoDeWebhookDelDueno(credenciales.phoneNumberId, telefonoDelDueno, respuesta, q.wamid)),
    });
    atendidas++;
    await new Promise((r) => setTimeout(r, 4000));
  }

  // La confirmacion de venta: sin esto, un pedido prepago no llega a existir nunca.
  const esperandoConfirmacion = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { pendingConfirmationMessageId: true, pendingConfirmationAskedAt: true },
  });
  if (esperandoConfirmacion?.pendingConfirmationAskedAt && esperandoConfirmacion.pendingConfirmationMessageId) {
    await fetch(`${URL_BASE}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        cuerpoDeWebhookDelDueno(
          credenciales.phoneNumberId,
          telefonoDelDueno,
          // EXACTAMENTE "si": el servidor compara la respuesta entera contra CONFIRM_WORDS
          // (handleOwnerReply), asi que "si, ya me llego el pago" NO cuenta como confirmacion y deja la
          // venta esperando. Medido el 2026-09-18: la confirmacion salio y el pedido no se creo.
          "si",
          esperandoConfirmacion.pendingConfirmationMessageId,
        ),
      ),
    });
    atendidas++;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const conversacion = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { humanControl: true, intent: true, customer: { select: { phoneNumber: true } } },
  });
  if (conversacion?.humanControl) {
    const texto = RESPUESTA_POR_INTENT[conversacion.intent ?? ""] ?? RESPUESTA_POR_INTENT.SOLICITA_AGENTE;
    await sendToCustomer({
      businessId,
      conversationId,
      credentials: credenciales,
      to: conversacion.customer.phoneNumber,
      content: { kind: "text", text: texto },
      onWindowClosed: "fail",
      recordAs: { text: texto, humanAuthor: true },
    });
    // Devolverle el control al bot es lo que cierra el circuito: sin esto la conversacion queda muda
    // para siempre aunque la persona ya haya contestado.
    await setHumanControl(businessId, conversationId, false, "PANEL_MESSAGE");
    atendidas++;
    await new Promise((r) => setTimeout(r, 2500));
  }

  return atendidas;
}
