import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client";
import { atenderComoDueno } from "./dueno-simulado";

// UNA CLIENTA QUE CONTESTA, EN VEZ DE UN GUION QUE RECITA (2026-09-18).
//
// Las dos reglas que el dueño fijó hoy (ver la cabecera de guiones-de-prueba.ts y CLAUDE.md) no se
// pueden cumplir del todo con una lista fija de mensajes:
//
//   1. La clienta no sabe nada del sistema -- no dice "cierra el pedido" ni "registralo".
//   2. La clienta no se adelanta -- no entrega cédula ni barrio si nadie se los pidió.
//
// Un guion fijo no sabe qué le van a preguntar ni en qué orden, así que o se adelanta o falla. Acá la
// clienta es un modelo chico con una identidad y unos datos EN EL BOLSILLO: lee lo que el bot acaba de
// escribir y contesta eso, soltando un dato sólo cuando se lo piden.
//
// Lo que esto permite medir y el guion fijo no: si el bot sabe PEDIR lo que le falta, en qué orden, si
// se acuerda de lo que ya le dieron, y si cierra la venta sin que nadie le diga que la cierre.
//
//   NEGOCIO="Boutique Alondra" npx tsx scripts/cliente-reactivo.ts
//   PERSONAS=3 npx tsx scripts/cliente-reactivo.ts        # tres clientas distintas a la vez
//   INTENCION=cancelar npx tsx scripts/cliente-reactivo.ts
//
// COSTO: dos modelos por turno -- el bot (prompt grande) y la clienta (prompt corto). La clienta usa una
// llamada directa a DeepSeek, NO el cliente del servidor, para que su gasto no entre en AiUsageLog ni
// cuente contra el techo de gasto del negocio: no es consumo de ese negocio, es consumo de la prueba.

const URL_BASE = process.env.URL ?? "http://localhost:3000";
const NEGOCIO = process.env.NEGOCIO ?? "Boutique Alondra";
const PERSONAS = Number(process.env.PERSONAS ?? 1);
/**
 * Cuántas conversaciones correr en total, rotando las personas.
 *
 * Existe porque un hallazgo se CUENTA, no se ve una vez: esto es estocástico y dos corridas idénticas
 * dan resultados distintos. Con una sola no se sabe si un defecto ocurre el 50% de las veces o el 10%.
 */
const CONVERSACIONES = Number(process.env.CONVERSACIONES ?? PERSONAS);
/** Repetir SOLO a esta persona, por nombre o por un pedazo. Para reproducir un caso hasta que salga bien. */
const SOLO = (process.env.PERSONA ?? "").trim().toLowerCase();
/** El CASO a reproducir: una clienta escrita para llegar hasta un defecto concreto. Ver CASOS. */
const CASO = (process.env.CASO ?? "").trim();
const PARALELO = Number(process.env.PARALELO ?? 3);
const MAX_TURNOS = Number(process.env.MAX_TURNOS ?? 14);
const ESPERA_MAXIMA_MS = 90_000;

const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";

interface Persona {
  nombre: string;
  cedula: string;
  celular: string;
  direccion: string;
  barrio: string;
  ciudad: string;
  intencion: string;
}

const PERSONAS_POSIBLES: Persona[] = [
  { nombre: "Carolina Ruiz", cedula: "1018223344", celular: "3105558899", direccion: "Calle 53 #24-18", barrio: "Galerias", ciudad: "Bogota", intencion: "quiere un reloj inteligente para ella, no sabe cual" },
  { nombre: "Andres Molina", cedula: "79556677", celular: "3126667744", direccion: "Carrera 43 #12-30", barrio: "Poblado", ciudad: "Medellin", intencion: "quiere unos audifonos buenos y baratos" },
  { nombre: "Liliana Pardo", cedula: "52887744", celular: "3008889911", direccion: "Calle 9 #6-20", barrio: "San Antonio", ciudad: "Cali", intencion: "quiere un regalo para su mama, no sabe que" },
  { nombre: "Jorge Rincon", cedula: "80113355", celular: "3189994422", direccion: "Carrera 15 #93-40", barrio: "Chico", ciudad: "Bogota", intencion: "vio un combo y quiere saber que trae" },
  { nombre: "Marcela Nieto", cedula: "1093224466", celular: "3145557788", direccion: "Calle 72 #10-15", barrio: "Chapinero", ciudad: "Bogota", intencion: "quiere cancelar una compra que hizo, cambio de opinion" },
];


/**
 * Un CASO es una clienta escrita para llegar hasta UN defecto, con el criterio de cuando esa
 * conversacion se considera aprobada.
 *
 * Regla del dueño (2026-09-18): cuando aparece un error, se corren cinco conversaciones QUE LLEGUEN A
 * ESE ERROR -- no cinco al azar -- y no se sigue con otra cosa hasta que las cinco pasen. Cinco
 * conversaciones cualesquiera no sirven: si el defecto vive en el camino del comprobante, una clienta
 * que paga contraentrega nunca lo toca y "pasa" sin haber probado nada.
 */
interface Caso {
  persona: Persona;
  /** Que tiene que haber pasado para decir que esta conversacion salio bien. */
  aprueba: (r: { pedido: unknown; incidentes: { kind: string; detail: string }[]; textoDelBot: string }) => string | null;
}

const CASOS: Record<string, Caso> = {
  // Defecto: el bot decia "si veo, ya llego" sobre un comprobante que nadie miro, y el pedido prepago
  // no llegaba a existir porque nadie contestaba la confirmacion.
  comprobante: {
    persona: {
      nombre: "Paula Idarraga",
      cedula: "43778899",
      celular: "3117774455",
      direccion: "Calle 30 #18-22",
      barrio: "Belen",
      ciudad: "Medellin",
      intencion: "quiere comprar unos AIRPODS SERIE 4 y pagar TODO por adelantado por transferencia, no contraentrega",
    },
    aprueba: ({ pedido, textoDelBot }) => {
      if (!pedido) return "no quedo el pedido";
      if (/ya (me )?lleg[oó]|ya (lo )?(vi|recib[ií])|pago confirmado/i.test(textoDelBot)) {
        return "el bot dio el pago por recibido el solo";
      }
      return null;
    },
  },
  // Defecto: "estoy esperando que me confirmen el valor exacto del envio a Cali", con la tarifa de Cali
  // cargada en la tabla, y despues "ya me confirmaron" sin que nadie confirmara nada.
  "envio-ciudad": {
    persona: {
      nombre: "Rocio Bermudez",
      cedula: "31556677",
      celular: "3153338877",
      direccion: "Calle 9 #6-20",
      barrio: "San Antonio",
      ciudad: "Cali",
      intencion: "quiere un parlante y necesita saber cuanto le sale el envio hasta Cali antes de decidir",
    },
    aprueba: ({ pedido, incidentes, textoDelBot }) => {
      const prometio = incidentes.some((i) => i.detail.includes("prometio consultar"));
      if (prometio) return "prometio consultar algo que ya tenia";
      if (/esperando que me confirmen|ya me confirmaron/i.test(textoDelBot)) {
        return "dijo que estaba esperando o que ya le confirmaron, sin que nadie confirmara";
      }
      if (!pedido) return "no quedo el pedido";
      return null;
    },
  },
  // El camino completo de contraentrega, que es el que mas se usa.
  "compra-contraentrega": {
    persona: {
      nombre: "Hernan Calle",
      cedula: "71889900",
      celular: "3004445566",
      direccion: "Carrera 7 #45-12",
      barrio: "Chapinero",
      ciudad: "Bogota",
      intencion: "quiere un smartwatch y pagar todo cuando le llegue",
    },
    aprueba: ({ pedido }) => (pedido ? null : "no quedo el pedido"),
  },
};

/**
 * Lo que la clienta es y lo que NO hace.
 *
 * Las prohibiciones son las dos reglas del dueño, dichas en el idioma de una persona: no se nombra nada
 * del sistema, y no se da un dato que nadie pidió. La tercera -- contestar corto -- es para que se
 * parezca a WhatsApp y no a un formulario.
 */
function instruccionesDeLaClienta(p: Persona): string {
  return `Eres una persona real escribiendo por WhatsApp a una tienda. NO eres un asistente.

Quien eres (esto lo sabes tú, la tienda no):
- Te llamas ${p.nombre}
- Tu cedula es ${p.cedula}
- Tu celular es ${p.celular}
- Vives en ${p.direccion}, barrio ${p.barrio}, en ${p.ciudad}
- ${p.intencion}

Como escribes:
- Una o dos lineas, como en WhatsApp. Sin listas ni formato.
- Con la ortografia descuidada de alguien que escribe rapido desde el celular. Tildes opcionales.
- Una cosa a la vez.

Lo que NUNCA haces:
- NUNCA das un dato que no te pidieron. Si no te preguntaron la cedula, no la mandas. Si no te
  preguntaron el barrio, no lo mandas. Tu no sabes que datos necesita esta tienda.
- NUNCA usas palabras de sistema: "pedido" como cosa que se registra, "cerrar el pedido", "registralo",
  "confirmar el pedido", "modalidad", "contraentrega COD", "escalar", "herramienta", "estado". Hablas
  como la gente: "listo", "si", "dale", "cuanto vale", "cuando llega", "ya no lo quiero".
- NUNCA le dices a la tienda lo que tiene que hacer por dentro. Tu solo quieres tu producto.
- NUNCA te inventas datos que no estan arriba.

Si te piden una foto del comprobante de pago, respondes exactamente con esto y nada mas:
[[img:sim.comprobante:MONTO:NEQUI]]
reemplazando MONTO por el total que te dijeron, con puntos de miles (por ejemplo 94.000).

Cuando ya conseguiste lo que querias, o la tienda no te sirve, te despides y escribes [FIN] al final de
ese ultimo mensaje.

Responde SOLO con el mensaje que le escribirias a la tienda, tal cual lo enviarias. Nada de
explicaciones, ni acotaciones, ni notas sobre tu propio mensaje.`;
}

async function loQueDiriaLaClienta(p: Persona, historia: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const respuesta = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      max_tokens: 150,
      temperature: 1,
      messages: [{ role: "system", content: instruccionesDeLaClienta(p) }, ...historia],
    }),
  });
  if (!respuesta.ok) throw new Error(`La clienta no pudo pensar (${respuesta.status}): ${(await respuesta.text()).slice(0, 200)}`);
  const cuerpo = (await respuesta.json()) as { choices?: { message?: { content?: string } }[] };
  return limpiarAcotaciones((cuerpo.choices?.[0]?.message?.content ?? "").trim());
}

/**
 * Le saca al mensaje las acotaciones que la clienta se escribe a si misma.
 *
 * Visto en la Bandeja por el dueño: un mensaje que terminaba con "Mensaje corto." en su propio renglon
 * -- el modelo repitiendo su instruccion como si fuera parte de lo que le escribe a la tienda. Ensucia
 * la Bandeja y ademas le da al bot un texto que ninguna persona enviaria, asi que la prueba deja de
 * medir lo que dice medir.
 */
function limpiarAcotaciones(texto: string): string {
  const renglones = texto.split(String.fromCharCode(10));
  // Solo la acotacion sobre el propio mensaje. NO se tocan los corchetes en general: [[img:...]] es
  // como la clienta manda el comprobante, y borrarlo dejaria la prueba del pago sin foto.
  const esAcotacion = (r: string) =>
    /^\(?(mensaje|respuesta|nota|tono)\s*(corto|breve|informal|natural|de whatsapp)?\.?\)?$/i.test(r.trim());
  while (renglones.length > 1 && esAcotacion(renglones[renglones.length - 1])) renglones.pop();
  return renglones.join(String.fromCharCode(10)).trim();
}

function comoImagen(mensaje: string): { mediaId: string; pie: string } | null {
  const marca = mensaje.match(/\[\[img:([^\]]+)\]\]\s*(.*)$/s);
  return marca ? { mediaId: marca[1], pie: marca[2].trim() } : null;
}

function cuerpoDeWebhook(phoneNumberId: string, desde: string, texto: string) {
  const imagen = comoImagen(texto);
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "reactivo",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573000000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Clienta de prueba" }, wa_id: desde }],
              messages: [
                {
                  from: desde,
                  id: `wamid.REACTIVO.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...(imagen
                    ? { type: "image", image: { id: imagen.mediaId, mime_type: "image/png", ...(imagen.pie ? { caption: imagen.pie } : {}) } }
                    : { type: "text", text: { body: texto } }),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function limpiarCliente(customerId: string) {
  const conversaciones = (await prisma.conversation.findMany({ where: { customerId }, select: { id: true } })).map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customerId } } });
  await prisma.agentTurn.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.agentIncident.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.billableChat.deleteMany({ where: { customerId } });
  await prisma.saleState.deleteMany({ where: { conversation: { customerId } } });
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.update({
    where: { id: customerId },
    data: { name: null, whatsappProfileName: null, idNumber: null, deliveryPhone: null, address: null, stage: "NUEVO", tags: [] },
  });
}

async function conversar(
  persona: Persona,
  indice: number,
  negocio: { id: string; whatsappPhoneNumberId: string; whatsappAccessToken: string; contactPhone: string | null },
) {
  const telefono = `573000${String(900_000 + indice).padStart(6, "0")}`;
  const cliente = await prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId: negocio.id, phoneNumber: telefono } },
    create: { businessId: negocio.id, phoneNumber: telefono, simulated: true },
    update: { simulated: true },
    select: { id: true },
  });
  await limpiarCliente(cliente.id);

  const historia: { role: "user" | "assistant"; content: string }[] = [];
  let leidos = 0;

  for (let turno = 0; turno < MAX_TURNOS; turno++) {
    const mio = turno === 0 ? await loQueDiriaLaClienta(persona, [{ role: "user", content: "(abris el chat de la tienda)" }]) : await loQueDiriaLaClienta(persona, historia);
    const termina = mio.includes("[FIN]");
    const texto = mio.replace("[FIN]", "").trim();
    if (!texto) {
      // Un mensaje vacio de la clienta corta el bucle. Se dice, para no confundirlo con una conversacion
      // que el bot abandono: es del banco de pruebas.
      console.log(`  (${persona.nombre}: la clienta devolvio un mensaje vacio, se corta aca)`);
      break;
    }

    historia.push({ role: "assistant", content: mio });
    const antes = await prisma.message.count({ where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" } });
    await fetch(`${URL_BASE}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpoDeWebhook(negocio.whatsappPhoneNumberId, telefono, texto)),
    });

    const limite = Date.now() + ESPERA_MAXIMA_MS;
    while (Date.now() < limite) {
      const ahora = await prisma.message.count({ where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" } });
      if (ahora > antes) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 3500));

    const conversacionActual = (
      await prisma.conversation.findFirst({ where: { customerId: cliente.id }, orderBy: { updatedAt: "desc" }, select: { id: true } })
    )?.id;
    const nuevos = await prisma.message.findMany({
      where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" },
      orderBy: { createdAt: "asc" },
      skip: leidos,
      select: { content: true, mediaType: true },
    });
    leidos += nuevos.length;

    // EL DUEÑO CONTESTA EN EL MOMENTO, no al final de la corrida.
    //
    // Si el bot escalo algo -- una pregunta citable o la conversacion entera a manos de una persona --
    // se atiende aca mismo y la clienta ve la respuesta en su proximo turno. Sin esto se estaba midiendo
    // un flujo cortado por la mitad: la clienta esperaba una respuesta que en esa corrida no iba a
    // llegar nunca, y la conversacion se contaba como fallida por algo que en la realidad se resuelve.
    if (negocio.contactPhone) {
      const atendidas = await atenderComoDueno(
        negocio.id,
        conversacionActual ?? "",
        { phoneNumberId: negocio.whatsappPhoneNumberId, accessToken: negocio.whatsappAccessToken },
        negocio.contactPhone.replace(/[^0-9]/g, ""),
      );
      if (atendidas > 0) {
        const despues = await prisma.message.findMany({
          where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" },
          orderBy: { createdAt: "asc" },
          skip: leidos,
          select: { content: true, mediaType: true },
        });
        leidos += despues.length;
        nuevos.push(...despues);
      }
    }

    if (nuevos.length === 0) break;
    // La clienta ve la foto como foto, no como un texto raro: es lo que le llega al celular.
    historia.push({
      role: "user",
      content: nuevos.map((m) => (m.mediaType ? `(te mandan una foto) ${m.content ?? ""}`.trim() : m.content ?? "")).join("\n"),
    });
    if (termina) break;
  }

  // Por CLIENTE, no por la ultima conversacion: al cerrarse una venta la conversacion pasa a SOLD y se
  // abre una nueva, asi que mirar la mas reciente decia "no hubo pedido" con el pedido ya creado en la
  // anterior. Paso en la primera corrida.
  // SI LA CONVERSACION TERMINA CON ALGO ESPERANDO, SE ATIENDE IGUAL (2026-09-18).
  //
  // La clienta se despide y el bucle se acaba, pero la venta puede haber quedado esperando que el dueño
  // confirme el pago -- y en prepago el pedido NO EXISTE hasta ese si. Medido: Liliana Pardo se despidio,
  // la confirmacion quedo colgada, y la venta figuraba como perdida cuando en la realidad se resuelve en
  // un minuto. El dueño contesta aunque la clienta ya no escriba.
  if (negocio.contactPhone) {
    const ultima = await prisma.conversation.findFirst({ where: { customerId: cliente.id }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    if (ultima) {
      await atenderComoDueno(
        negocio.id,
        ultima.id,
        { phoneNumberId: negocio.whatsappPhoneNumberId, accessToken: negocio.whatsappAccessToken },
        negocio.contactPhone.replace(/[^0-9]/g, ""),
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const conversaciones = (await prisma.conversation.findMany({ where: { customerId: cliente.id }, select: { id: true } })).map((c) => c.id);
  const pedido = await prisma.order.findFirst({ where: { customerId: cliente.id }, select: { summary: true, totalAmount: true } });
  const incidentes = await prisma.agentIncident.findMany({ where: { conversationId: { in: conversaciones } }, select: { kind: true, detail: true } });
  const fichaFinal = await prisma.customer.findUnique({ where: { id: cliente.id }, select: { name: true, idNumber: true, address: true } });

  const dichoPorElBot = (
    await prisma.message.findMany({
      where: { conversationId: { in: conversaciones }, role: "ASSISTANT" },
      select: { content: true },
    })
  )
    .map((m) => m.content ?? "")
    .join("
");

  return { persona, telefono, pedido, incidentes, fichaFinal, mensajes: leidos, dichoPorElBot };
}

async function main() {
  if (!DEEPSEEK_KEY) {
    console.error("Falta DEEPSEEK_API_KEY: la clienta necesita pensar con un modelo.");
    process.exit(78);
  }

  const negocio = await prisma.business.findFirst({
    where: { name: NEGOCIO },
    select: { id: true, name: true, whatsappPhoneNumberId: true, whatsappAccessToken: true, contactPhone: true },
  });
  if (!negocio?.whatsappPhoneNumberId) {
    console.error(`No existe "${NEGOCIO}" o no tiene WhatsApp conectado.`);
    process.exit(65);
  }

  const cuantas = Math.max(1, CONVERSACIONES);
  const caso = CASO ? CASOS[CASO] : null;
  if (CASO && !caso) {
    console.error(`No hay ningun caso "${CASO}". Hay: ${Object.keys(CASOS).join(", ")}`);
    process.exit(64);
  }
  const disponibles = caso
    ? [caso.persona]
    : SOLO
      ? PERSONAS_POSIBLES.filter((p) => p.nombre.toLowerCase().includes(SOLO))
      : PERSONAS_POSIBLES;
  if (disponibles.length === 0) {
    console.error(`Ninguna persona coincide con "${SOLO}". Hay: ${PERSONAS_POSIBLES.map((p) => p.nombre).join(", ")}`);
    process.exit(64);
  }
  const elegidas = Array.from({ length: cuantas }, (_, i) => disponibles[i % disponibles.length]);
  console.log(`${negocio.name}: ${cuantas} conversacion(es), hasta ${MAX_TURNOS} turnos cada una, ${PARALELO} a la vez.
`);

  // Cada conversacion lleva su propio numero (el indice), asi que repetir la misma persona no se pisa.
  const resultados: Awaited<ReturnType<typeof conversar>>[] = [];
  for (let desde = 0; desde < elegidas.length; desde += PARALELO) {
    const tanda = elegidas.slice(desde, desde + PARALELO);
    const hechas = await Promise.all(
      tanda.map((p, i) => conversar(p, desde + i + 1, negocio as { id: string; whatsappPhoneNumberId: string; whatsappAccessToken: string; contactPhone: string | null })),
    );
    resultados.push(...hechas);
    console.log(`(${resultados.length}/${cuantas})`);
  }

  console.log("\n==================== RESUMEN ====================\n");
  for (const r of resultados) {
    console.log(`--- ${r.persona.nombre} (${r.telefono})`);
    console.log(`    queria:    ${r.persona.intencion}`);
    console.log(`    mensajes del bot: ${r.mensajes}`);
    console.log(`    pedido:    ${r.pedido ? `${r.pedido.summary.replace(/\n/g, " ").slice(0, 70)} ($${r.pedido.totalAmount})` : "NO"}`);
    console.log(`    ficha:     nombre=${JSON.stringify(r.fichaFinal?.name)} cedula=${JSON.stringify(r.fichaFinal?.idNumber)}`);
    for (const i of r.incidentes) console.log(`    INCIDENTE ${i.kind}: ${i.detail.replace(/\n/g, " ").slice(0, 110)}`);
    console.log();
  }
  if (caso) {
    const veredictos = resultados.map((r) =>
      caso.aprueba({ pedido: r.pedido, incidentes: r.incidentes, textoDelBot: r.dichoPorElBot }),
    );
    const pasaron = veredictos.filter((v) => v === null).length;
    console.log(`
==================== CASO "${CASO}" ====================`);
    veredictos.forEach((v, i) => console.log(`  ${i + 1}. ${v === null ? "PASA" : `FALLA -- ${v}`}`));
    console.log(`
${pasaron} de ${resultados.length} pasaron.`);
    if (pasaron < resultados.length) {
      console.log("NO se puede seguir con otra cosa hasta que pasen las cinco.");
    }
  }
  console.log(`${resultados.filter((r) => r.pedido).length} de ${resultados.length} terminaron en pedido.`);
  console.log(`Los hilos completos se leen en la Bandeja de ${negocio.name}.`);
  process.exit(0);
}

void main();
