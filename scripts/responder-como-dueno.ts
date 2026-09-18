import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client";
import { sendToCustomer } from "../src/whatsapp/outbound";
import { setHumanControl } from "../src/conversation/service";

// CONTESTAR COMO EL DUEÑO, PARA PROBAR EL CIRCUITO COMPLETO (2026-09-18).
//
// Pedido del dueño: "que las respuestas las des tú, no yo; no importa la información, lo importante es
// ver cómo funciona todo ese tema". Cuando el bot escala algo, la conversación queda esperando a una
// persona, y sin esa persona la mitad del recorrido nunca se prueba: el cliente se queda colgado y no
// se llega a ver si la respuesta del dueño vuelve bien, si resuelve contra el catálogo, si se despacha
// al cliente correcto ni si la conversación se destraba.
//
// Una respuesta del dueño se reconoce porque CITA el mensaje del bot: `context.id` con el `wamid` de la
// pregunta (ver handleOwnerReply en src/routes/whatsapp.ts). Eso es un webhook entrante, asi que se
// puede armar igual que el de un cliente -- y como entra, no le manda nada al dueño de verdad. Lo unico
// que sí le llega es el acuse corto del bot ("Listo, le avise al cliente").
//
//   NEGOCIO="Boutique Alondra" npx tsx scripts/responder-como-dueno.ts
//   LISTAR=1 npx tsx scripts/responder-como-dueno.ts     # ver que hay esperando, sin contestar nada

const URL_BASE = process.env.URL ?? "http://localhost:3000";
const NEGOCIO = process.env.NEGOCIO ?? "Boutique Alondra";
const ESPERA_MS = 20_000;

function cuerpoDeWebhook(phoneNumberId: string, desde: string, texto: string, citando: string) {
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
 * El contenido da igual con tal de que sea del tipo correcto: lo que se prueba es el circuito, no el
 * criterio comercial. Lo unico que importa es que cada tipo reciba una respuesta que el servidor pueda
 * procesar -- un producto real para PHOTO_PRODUCT, un numero valido para PRICE, prosa para TEXT.
 */
async function respuestaPara(kind: string, businessId: string, conversationId: string): Promise<string> {
  if (kind === "PHOTO_PRODUCT") {
    const p = await prisma.product.findFirst({
      where: { businessId, active: true, stock: { gt: 0 } },
      orderBy: { name: "asc" },
      select: { name: true },
    });
    return p?.name ?? "No lo tengo en el catalogo";
  }

  if (kind === "PRICE") {
    // Un numero por cada item del pedido, y cada uno menor o igual al precio de hoy: son las dos
    // validaciones en codigo que hace el servidor al recolectar precios acordados.
    const estado = await prisma.saleState.findFirst({ where: { conversationId }, select: { items: true } });
    const items = (estado?.items as { unitPrice?: number }[] | null) ?? [];
    if (items.length === 0) return "80000";
    return items.map((i) => Math.max(1000, Math.round((i.unitPrice ?? 80000) * 0.9))).join(" ");
  }

  return "Si, lo manejamos. Decile que si, que no hay problema y seguimos con el pedido.";
}

/**
 * Las conversaciones que `flag_conversation_intent` dejo en manos de una persona.
 *
 * Son el OTRO camino de escalacion, y no se pueden contestar citando por WhatsApp: ahi no hay ninguna
 * `PendingOwnerQuestion`, el bot simplemente se calla y espera a que alguien entre al panel. Medido el
 * 2026-09-18: de 24 conversaciones, 4 quedaron asi, y el cliente que habia preguntado "puedo devolverlo
 * si no me gusta?" no recibio una sola palabra mas.
 *
 * Esto hace lo que haria el dueño desde el panel: escribe la respuesta como persona (`humanAuthor`) y
 * le devuelve la conversacion al bot.
 */
async function atenderLasQueEsperanUnaPersona(businessId: string) {
  const enEspera = await prisma.conversation.findMany({
    where: { customer: { businessId, simulated: true }, humanControl: true },
    select: { id: true, intent: true, customer: { select: { phoneNumber: true } } },
  });
  if (enEspera.length === 0) {
    console.log("Ninguna conversacion esperando a una persona.");
    return;
  }

  console.log(`\n${enEspera.length} conversacion(es) esperando a una persona:\n`);
  // Las credenciales se arman igual que en admin/conversations.ts: salen del propio negocio, y el
  // cliente de Prisma las descifra al leerlas.
  const negocio = await prisma.business.findUnique({
    where: { id: businessId },
    select: { whatsappPhoneNumberId: true, whatsappAccessToken: true },
  });
  if (!negocio?.whatsappPhoneNumberId || !negocio.whatsappAccessToken) {
    console.error("Sin credenciales de WhatsApp no se puede contestar como persona.");
    return;
  }
  const credentials = { phoneNumberId: negocio.whatsappPhoneNumberId, accessToken: negocio.whatsappAccessToken };

  const RESPUESTA: Record<string, string> = {
    PQR: "Hola, soy del equipo. Ya revise tu caso: si el producto llego con algun problema te lo cambiamos sin costo. Contame que paso exactamente y lo resolvemos hoy mismo.",
    DEVOLUCION: "Hola, soy del equipo. Si tenes cambios de opinion, aceptamos cambios dentro de los 5 dias siguientes a la entrega, con el producto sin usar y en su empaque. Contame cual es el pedido y lo gestiono.",
    NO_RECIBIDO: "Hola, soy del equipo. Ya estoy revisando tu envio con la transportadora. Pasame por favor tu numero de cedula y te confirmo hoy mismo donde va.",
    SOLICITA_AGENTE: "Hola, soy del equipo, ya estoy aca. Contame en que te ayudo.",
  };

  for (const c of enEspera) {
    const texto = RESPUESTA[c.intent ?? ""] ?? RESPUESTA.SOLICITA_AGENTE;
    const enviado = await sendToCustomer({
      businessId,
      conversationId: c.id,
      credentials,
      to: c.customer.phoneNumber,
      content: { kind: "text", text: texto },
      onWindowClosed: "fail",
      recordAs: { text: texto, humanAuthor: true },
    });
    // Y se le devuelve la conversacion al bot, que es lo que cierra el circuito: sin esto queda muda
    // para siempre aunque la persona ya haya contestado.
    await setHumanControl(businessId, c.id, false, "PANEL_MESSAGE");
    console.log(`--- ${c.intent ?? "sin intent"} ${c.customer.phoneNumber}`);
    console.log(`    conteste como persona: ${enviado.delivered ? "SI" : "NO (" + (enviado.failure?.message ?? "sin detalle") + ")"}`);
    console.log(`    el bot vuelve a atender: SI\n`);
  }
}

async function main() {
  const negocio = await prisma.business.findFirst({
    where: { name: NEGOCIO },
    select: { id: true, name: true, whatsappPhoneNumberId: true, contactPhone: true },
  });
  if (!negocio?.whatsappPhoneNumberId || !negocio.contactPhone) {
    console.error(`"${NEGOCIO}" necesita linea de WhatsApp y telefono de dueno para esto.`);
    process.exit(65);
  }

  const abiertas = await prisma.pendingOwnerQuestion.findMany({
    where: { conversation: { customer: { businessId: negocio.id } }, resolvedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      wamid: true,
      kind: true,
      question: true,
      conversationId: true,
      conversation: { select: { customer: { select: { phoneNumber: true, simulated: true } } } },
    },
  });

  console.log(`${negocio.name}: ${abiertas.length} pregunta(s) esperando respuesta del dueno.\n`);
  // Sin preguntas citables todavia queda el otro camino, que es el que mas se usa: las conversaciones
  // que flag_conversation_intent dejo esperando a una persona. Salir aca las dejaba sin atender.
  if (abiertas.length === 0) {
    await atenderLasQueEsperanUnaPersona(negocio.id);
    process.exit(0);
  }

  if (process.env.LISTAR) {
    for (const q of abiertas) {
      console.log(`${q.kind.padEnd(14)} ${q.conversation.customer.phoneNumber} | ${q.question.replace(/\n/g, " ").slice(0, 90)}`);
    }
    process.exit(0);
  }

  const telefonoDelDueno = negocio.contactPhone.replace(/[^0-9]/g, "");
  let contestadas = 0;

  for (const q of abiertas) {
    // Solo conversaciones simuladas: contestar por el dueño en una conversación con una persona real
    // seria mandarle a esa persona una respuesta que nadie penso.
    if (!q.conversation.customer.simulated) {
      console.log(`SALTADA (cliente real): ${q.conversation.customer.phoneNumber}`);
      continue;
    }

    const respuesta = await respuestaPara(q.kind, negocio.id, q.conversationId);
    const antes = await prisma.message.count({
      where: { conversationId: q.conversationId, role: "ASSISTANT" },
    });

    await fetch(`${URL_BASE}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpoDeWebhook(negocio.whatsappPhoneNumberId, telefonoDelDueno, respuesta, q.wamid)),
    });

    const limite = Date.now() + ESPERA_MS;
    let llego = false;
    while (Date.now() < limite) {
      const ahora = await prisma.message.count({ where: { conversationId: q.conversationId, role: "ASSISTANT" } });
      if (ahora > antes) {
        llego = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 1500));

    const despues = await prisma.pendingOwnerQuestion.findUnique({ where: { id: q.id }, select: { resolvedAt: true } });
    const ultima = await prisma.message.findFirst({
      where: { conversationId: q.conversationId, role: "ASSISTANT" },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });

    contestadas++;
    console.log(`--- ${q.kind} ${q.conversation.customer.phoneNumber}`);
    console.log(`    pregunta:  ${q.question.replace(/\n/g, " ").slice(0, 90)}`);
    console.log(`    conteste:  ${respuesta.slice(0, 80)}`);
    console.log(`    resuelta:  ${despues?.resolvedAt ? "SI" : "NO"}`);
    console.log(`    al cliente le llego algo: ${llego ? "SI" : "NO"}`);
    console.log(`    ultima al cliente: ${(ultima?.content ?? "(nada)").replace(/\n+/g, " | ").slice(0, 140)}\n`);
  }

  await atenderLasQueEsperanUnaPersona(negocio.id);

  console.log(`${contestadas} pregunta(s) contestada(s).`);
  process.exit(0);
}

void main();
