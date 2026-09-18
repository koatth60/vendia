import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client";

// MUCHAS CONVERSACIONES DE PRUEBA, DE TIPOS DISTINTOS, EN UNA CORRIDA (2026-09-18).
//
// Pedido del dueño: "quiero cien conversaciones, con diferentes preguntas, diferentes situaciones --
// que cancelo, que no quiero seguir, que sí compro, cuándo me llega". Esto es eso.
//
// Cada conversación es una clienta distinta, con su propio número simulado. Un cliente `simulated` se
// procesa igual que uno real -- mismo webhook, mismo generateReply, mismas herramientas, mismo catálogo,
// pedidos de verdad -- y sólo cambia el último milímetro: la respuesta se guarda en vez de entregársela
// a Meta (ver esClienteSimulado en src/whatsapp/outbound.ts). Por eso no hay límite de números ni se
// gasta un solo mensaje de WhatsApp.
//
// Cada tipo tiene VARIANTES: distinta redacción, distinto producto, distinta ciudad. Cien conversaciones
// no son cien copias de doce.
//
//   npx tsx scripts/guiones-de-prueba.ts                      # una de cada tipo
//   CANTIDAD=100 npx tsx scripts/guiones-de-prueba.ts         # cien, repartidas entre los tipos
//   CANTIDAD=100 PARALELO=6 npx tsx scripts/guiones-de-prueba.ts
//   GUION=cancelar CANTIDAD=10 npx tsx scripts/guiones-de-prueba.ts
//   CLIENTA=573150496302 DUENO_AVISADO=1 npx tsx scripts/guiones-de-prueba.ts   # desde un telefono real
//   LISTAR=1 npx tsx scripts/guiones-de-prueba.ts             # ver los tipos sin correr nada
//
// COSTO: cada mensaje es un turno real contra DeepSeek. CANTIDAD=100 son unos 400 turnos.

const URL_BASE = process.env.URL ?? "http://localhost:3000";
const NEGOCIO = process.env.NEGOCIO ?? "[PRUEBAS] MAGByLizN";
/** Los números simulados son 573000 + seis dígitos: formato colombiano válido, imposible de confundir. */
const PREFIJO_SIMULADO = "573000";
/** Cuánto se espera a que el bot conteste antes de mandar el mensaje siguiente. */
const ESPERA_MAXIMA_MS = 75_000;
/** Cuántas conversaciones corren a la vez. Cada una es secuencial por dentro. */
const PARALELO = Number(process.env.PARALELO ?? 4);

interface Guion {
  nombre: string;
  /** Qué se está probando. Va en el reporte para poder leerlo sin abrir el archivo. */
  busca: string;
  /** Cada variante es una conversación entera, dicha de otra manera. Se van rotando. */
  variantes: string[][];
  /** Manda todos los mensajes de golpe, sin esperar respuesta: prueba la cola de entrada (E20/E21). */
  rafaga?: boolean;
}

// Los tipos salen de lo que de verdad pasa en producción: las preguntas más comunes, y los casos que ya
// rompieron alguna vez (el número de pago que no salía, la vitrina que no aparecía, la ciudad sin
// tarifa, la cancelación que cancelaba en el mismo turno).
const GUIONES: Guion[] = [
  {
    nombre: "saludo",
    busca: "que salude, pregunte el nombre y no invente nada",
    variantes: [
      ["hola", "soy Ana"],
      ["buenas tardes", "me llamo Marcela Rios"],
      ["hola buenas", "Jorge"],
      ["holaaa", "mi nombre es Luisa Fernanda"],
    ],
  },
  {
    nombre: "catalogo",
    busca: "que mande el catálogo real por categorías, sin inventar productos",
    variantes: [
      ["hola", "que tienen?"],
      ["buenas", "me muestras el catalogo por favor"],
      ["hola", "que productos manejan?"],
      ["hola", "que es lo que venden ustedes"],
    ],
  },
  {
    nombre: "categoria",
    busca: "la vitrina de categoría: lista numerada MÁS una foto por producto",
    variantes: [
      ["hola", "que parlantes tienen?"],
      ["hola", "muestrame los relojes"],
      ["buenas", "tienen audifonos?"],
      ["hola", "quiero ver los smartwatch"],
    ],
  },
  {
    nombre: "precio",
    busca: "que el precio salga del catálogo y no de la memoria del modelo",
    variantes: [
      ["hola", "cuanto vale el smartwatch mas barato?"],
      ["hola", "que precio tiene el parlante?"],
      ["buenas", "cuanto cuestan los audifonos"],
      ["hola", "cual es el mas economico que tienes y a como"],
    ],
  },
  {
    nombre: "pago",
    busca: "el bloque de pago: el número tiene que salir, no un hueco",
    variantes: [
      ["hola", "como te puedo pagar?", "regalame el numero por favor"],
      ["hola", "aceptan nequi?", "pasame el numero"],
      ["buenas", "que formas de pago tienen", "y a que cuenta consigno"],
      ["hola", "puedo pagar con transferencia?", "dame los datos"],
    ],
  },
  {
    nombre: "envio-ciudad-con-tarifa",
    busca: "que cotice el envío con la tarifa configurada de esa ciudad",
    variantes: [
      ["hola", "cuanto vale el envio a Bogota?"],
      ["hola", "hacen envios a Medellin? cuanto sale"],
      ["buenas", "el domicilio a Cali cuanto cuesta"],
      ["hola", "envian a Barranquilla? valor del envio"],
    ],
  },
  {
    nombre: "envio-ciudad-sin-tarifa",
    busca: "una ciudad sin regla: NO puede quedar 'el envío vale COP' sin cifra",
    variantes: [
      ["hola", "me llega a Piedecuesta? cuanto sale el envio?"],
      ["hola", "envian a Yopal?"],
      ["buenas", "llega hasta Quibdo el pedido?"],
      ["hola", "vivo en Leticia, me pueden enviar?"],
    ],
  },
  {
    nombre: "cuando-llega",
    busca: "el tiempo de entrega: días reales de la tarifa, no una promesa inventada",
    variantes: [
      ["hola", "si compro hoy cuando me llega?"],
      ["hola", "cuanto se demora el envio a Bogota?"],
      ["buenas", "en cuantos dias lo tengo en Medellin"],
      ["hola", "llega antes del viernes?"],
    ],
  },
  {
    nombre: "compra",
    busca: "el cierre completo: producto, dirección, pago y que quede el pedido",
    variantes: [
      [
        "hola, quiero comprar",
        "quiero un smartwatch",
        "el mas economico esta bien",
        "soy Carlos Perez, cedula 1020304050, celular 3001112233, vivo en la Calle 10 #5-20 en Bogota",
        "pago contraentrega",
        "si, confirmo",
      ],
      [
        "buenas, me interesa un parlante",
        "el que tenga mejor bateria",
        "listo ese quiero",
        "Maria Gomez, CC 52889900, tel 3155556677, Carrera 45 #23-11, Medellin",
        "transferencia",
        "confirmo el pedido",
      ],
      [
        "hola quiero pedir algo",
        "unos audifonos",
        "ese esta bien, lo llevo",
        "mi nombre es Andres Quintero, cedula 79554433, numero 3209998877, Calle 80 #12-45 apto 302, Bogota",
        "contraentrega por favor",
        "si, confirmo",
      ],
    ],
  },
  {
    nombre: "varios-productos",
    busca: "el total de varias líneas: tiene que salir del catálogo, sumado por el servidor",
    variantes: [
      ["hola", "quiero un reloj y unos audifonos", "cuanto me sale todo junto?"],
      ["hola", "me llevo dos parlantes", "cuanto seria el total con envio a Bogota"],
      ["buenas", "quiero un smartwatch y un parlante", "cual es el total"],
    ],
  },
  {
    nombre: "cancelar",
    busca: "cancelar tiene que pedir confirmación y NO cancelar en el mismo turno",
    variantes: [
      ["hola", "quiero cancelar mi pedido", "si, confirmo que lo quiero cancelar"],
      ["hola", "necesito cancelar la compra que hice", "si por favor cancelalo"],
      ["buenas", "cancela mi pedido", "si, seguro"],
    ],
  },
  {
    nombre: "cancela-y-se-arrepiente",
    busca: "que diga que va a cancelar y se eche para atrás: NO puede quedar cancelado",
    variantes: [
      ["hola", "quiero cancelar mi pedido", "no espera, mejor no, dejalo asi"],
      ["hola", "cancelame la compra", "ay no, mentiras, si lo quiero"],
      ["buenas", "quiero cancelar", "no, olvidalo, sigo con el pedido"],
    ],
  },
  {
    nombre: "ya-no-quiero-seguir",
    busca: "que se retire a mitad del cierre: sin datos completos NO puede quedar pedido",
    variantes: [
      ["hola", "quiero un smartwatch", "ya no, gracias", "chao"],
      ["buenas, me interesa un parlante", "cuanto vale?", "uy no, esta muy caro, dejalo asi"],
      ["hola quiero comprar audifonos", "espera, lo pienso y te escribo", "gracias"],
    ],
  },
  {
    nombre: "cambia-de-opinion",
    busca: "que cambie de producto a mitad: el pedido tiene que quedar con el ÚLTIMO",
    variantes: [
      ["hola", "quiero un smartwatch", "no espera, mejor el parlante", "cuanto vale ese?"],
      ["hola", "me interesan los audifonos", "cambie de idea, mejor un reloj", "cual me recomiendas"],
    ],
  },
  {
    nombre: "pide-foto",
    busca: "que mande la foto real del producto, no una descripción de la foto",
    variantes: [
      ["hola", "me mandas una foto del reloj?"],
      ["hola", "tienes fotos del parlante"],
      ["buenas", "quiero ver como se ve el smartwatch"],
    ],
  },
  {
    nombre: "talla-color",
    busca: "colores y variantes reales del catálogo, sin inventar los que no hay",
    variantes: [
      ["hola", "el reloj en que colores viene?"],
      ["hola", "lo tienes en negro?"],
      ["buenas", "que colores manejan del parlante"],
    ],
  },
  {
    nombre: "stock",
    busca: "que consulte el stock real en vez de prometer disponibilidad",
    variantes: [
      ["hola", "todavia tienes el smartwatch?"],
      ["hola", "hay disponibilidad del parlante?"],
      ["buenas", "quedan audifonos?"],
    ],
  },
  {
    nombre: "regateo",
    busca: "que no invente un descuento que nadie autorizó",
    variantes: [
      ["hola", "me haces un descuento en el reloj?", "dale 20 mil menos y lo llevo"],
      ["hola", "cual es tu ultimo precio?", "si me lo dejas en 80 mil lo compro ya"],
      ["buenas", "no tienes promocion?", "hazme un descuentico y llevo dos"],
    ],
  },
  {
    nombre: "producto-que-no-existe",
    busca: "que diga que no lo tiene en vez de inventarlo",
    variantes: [
      ["hola", "tienes iphone 15 pro max?"],
      ["hola", "venden neveras?"],
      ["buenas", "manejan repuestos de moto?"],
    ],
  },
  {
    nombre: "fuera-de-tema",
    busca: "que conteste como persona y vuelva a lo suyo, sin romperse",
    variantes: [
      ["hola", "cuando ganó Colombia la copa america?"],
      ["hola", "que hora es alla?"],
      ["buenas", "eres un robot o una persona?"],
    ],
  },
  {
    nombre: "direccion-incompleta",
    busca: "que pida lo que falta en vez de crear el pedido con datos a medias",
    variantes: [
      ["hola quiero comprar un reloj", "mandalo a mi casa", "en Bogota"],
      ["hola", "quiero un parlante, envialo a la calle 50", "si, esa"],
    ],
  },
  {
    nombre: "saluda-y-desaparece",
    busca: "un solo mensaje: la conversación NO puede quedarse muerta sin respuesta",
    variantes: [["hola"], ["buenas"], ["hola, informacion por favor"]],
  },
  {
    nombre: "faq-ubicacion",
    busca: "la respuesta está en la FAQ: NO puede prometer consultar con el equipo (E13)",
    variantes: [
      ["hola", "donde se ubican?"],
      ["buenas", "tienen local fisico?"],
      ["hola", "de que ciudad son ustedes"],
    ],
  },
  {
    nombre: "horario",
    busca: "el horario sale de businessHours, no de una promesa",
    variantes: [
      ["hola", "a que hora atienden?"],
      ["buenas", "estan abiertos ahorita?"],
      ["hola", "atienden los domingos?"],
    ],
  },
  {
    nombre: "garantia",
    busca: "que conteste con la garantía cargada, o diga que no la tiene cargada",
    variantes: [
      ["hola", "el reloj tiene garantia?"],
      ["hola", "si se daña que pasa?"],
      ["buenas", "cuanto tiempo de garantia manejan"],
    ],
  },
  {
    nombre: "devolucion",
    busca: "PQR: tiene que marcar la conversación, no improvisar una política",
    variantes: [
      ["hola", "puedo devolverlo si no me gusta?"],
      ["hola", "aceptan cambios?"],
      ["buenas", "cual es la politica de devoluciones"],
    ],
  },
  {
    nombre: "quiere-humano",
    busca: "pedido explícito de una persona: flag_conversation_intent SOLICITA_AGENTE",
    variantes: [
      ["hola", "quiero hablar con una persona"],
      ["buenas", "me pueden comunicar con alguien real?"],
      ["hola", "no quiero hablar con un bot"],
    ],
  },
  {
    nombre: "estado-del-pedido",
    busca: "que consulte el pedido real en vez de inventar un estado",
    variantes: [
      ["hola", "ya enviaron mi pedido?"],
      ["hola", "tienes la guia de mi envio?"],
      ["buenas", "en que va mi compra"],
    ],
  },
  {
    nombre: "reclamo",
    busca: "un producto dañado es PQR, no una venta: que escale y no siga vendiendo",
    variantes: [
      ["hola", "me llego el reloj dañado"],
      ["buenas", "el parlante no prende"],
      ["hola", "me mandaron el color equivocado"],
    ],
  },
  {
    nombre: "no-recibido",
    busca: "pagó y no le llegó: escala, y NO promete una fecha que no sabe",
    variantes: [
      ["hola", "pague hace una semana y no me ha llegado nada"],
      ["buenas", "hice la transferencia y no se nada del pedido"],
    ],
  },
  {
    nombre: "mayorista",
    busca: "cantidad grande: que no invente un precio por mayor que nadie autorizó",
    variantes: [
      ["hola", "cuanto me sale si llevo 20 relojes?"],
      ["buenas", "manejan precios al por mayor?"],
      ["hola", "quiero comprar para revender, que descuento hay"],
    ],
  },
  {
    nombre: "es-original",
    busca: "pregunta espinosa: que conteste con lo que dice el catálogo y no afirme de más",
    variantes: [
      ["hola", "el reloj es original?"],
      ["buenas", "eso es replica o original?"],
      ["hola", "es marca original o generico"],
    ],
  },
  {
    nombre: "factura",
    busca: "que no prometa una factura electrónica que el negocio no tiene cargada",
    variantes: [
      ["hola", "me dan factura?"],
      ["buenas", "manejan factura electronica con IVA?"],
    ],
  },
  {
    nombre: "envio-internacional",
    busca: "fuera del país: que diga que no, sin inventar una tarifa",
    variantes: [
      ["hola", "envian a España?"],
      ["buenas", "hacen envios a Estados Unidos?"],
      ["hola", "llega hasta Mexico?"],
    ],
  },
  {
    nombre: "agotado",
    busca: "stock en cero: que lo diga, y NO lo venda igual",
    variantes: [
      ["hola", "quiero el que ya no tienen", "el que esta agotado"],
      ["hola", "me llevo 50 unidades del reloj mas caro"],
    ],
  },
  {
    nombre: "insiste-misma-pregunta",
    busca: "la misma pregunta tres veces: NO puede dar tres respuestas distintas",
    variantes: [
      ["hola", "cuanto vale el reloj?", "pero cuanto vale?", "digame el precio"],
      ["buenas", "hacen envio a Bogota?", "si o no?", "entonces cuanto vale el envio"],
    ],
  },
  {
    nombre: "solo-emoji",
    busca: "un mensaje sin palabras: la conversación NO puede quedarse muda",
    variantes: [["👍"], ["hola", "😂😂😂"], ["🙋‍♀️"]],
  },
  {
    nombre: "mensaje-larguisimo",
    busca: "una parrafada: que conteste lo que se preguntó y no se pierda",
    variantes: [
      [
        "hola buenas tardes mire le cuento que estoy buscando un regalo para mi mama que cumple años el sabado y ella siempre ha querido un reloj de esos inteligentes que miden los pasos y el ritmo cardiaco pero no se cual comprar porque he visto muchos y no entiendo las diferencias, ademas necesito que llegue antes del sabado a Bogota y quisiera saber si puedo pagar contra entrega porque no manejo transferencias, ah y tambien me gustaria saber si tienen envoltura de regalo",
      ],
    ],
  },
  {
    nombre: "otro-idioma",
    busca: "en inglés: que responda sin romperse y siga vendiendo",
    variantes: [
      ["hello", "do you ship to Bogota?"],
      ["hi", "how much is the smartwatch?"],
    ],
  },
  {
    nombre: "datos-por-partes",
    busca: "los datos llegan de a uno: el pedido tiene que juntarlos, no perderlos",
    variantes: [
      [
        "hola quiero un reloj",
        "el mas barato",
        "Camila Torres",
        "cedula 1098765432",
        "celular 3112223344",
        "Calle 100 #15-30, Bogota",
        "contraentrega",
        "si, confirmo",
      ],
    ],
  },
  {
    nombre: "precio-y-se-va",
    busca: "pregunta y desaparece: la conversación no puede quedar esperando para siempre",
    variantes: [["cuanto vale el reloj"], ["precio del parlante?"]],
  },
  {
    nombre: "pago-ya-hecho",
    busca: "dice que pagó sin comprobante: NO puede darlo por confirmado solo porque lo dijo",
    variantes: [
      ["hola", "ya te hice la transferencia", "ya la mande, revisa"],
      ["buenas", "ya pague por nequi", "si, ya esta hecho"],
    ],
  },
  {
    nombre: "rafaga",
    busca: "cuatro mensajes de golpe: la cola de entrada tiene que contestarlos como uno",
    rafaga: true,
    variantes: [
      ["hola", "que tienen?", "cuanto vale el reloj", "y hacen envios a Bogota?"],
      ["buenas", "precio del parlante", "tienen negro?", "cuanto demora el envio"],
    ],
  },
];

async function esperarRespuesta(customerId: string, desde: number): Promise<void> {
  const limite = Date.now() + ESPERA_MAXIMA_MS;
  while (Date.now() < limite) {
    const cuantos = await prisma.message.count({
      where: { conversation: { customerId }, role: "ASSISTANT" },
    });
    if (cuantos > desde) {
      // Un respiro: el turno puede mandar varios mensajes (el bloque del catálogo sale aparte).
      await new Promise((r) => setTimeout(r, 3500));
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function cuerpoDeWebhook(phoneNumberId: string, desde: string, texto: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "guion",
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
                  id: `wamid.GUION.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: texto },
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
 * Borra lo que dejó una corrida anterior de ESE número simulado.
 *
 * Sin esto, la segunda corrida le sigue la conversación a la primera y el resultado no se puede leer:
 * el bot ya tiene el pedido de antes en contexto. Sólo toca clientes `simulated`, que no se pueden
 * marcar desde el panel. El orden es el de las llaves foráneas, igual que en borrar-simulados.ts.
 */
async function limpiarCliente(customerId: string) {
  const conversaciones = (
    await prisma.conversation.findMany({ where: { customerId }, select: { id: true } })
  ).map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customerId } } });
  await prisma.agentTurn.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.agentIncident.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.billableChat.deleteMany({ where: { customerId } });
  await prisma.saleState.deleteMany({ where: { conversation: { customerId } } });
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
}

interface Corrida {
  guion: Guion;
  variante: number;
  indice: number;
}

async function correrGuion(
  corrida: Corrida,
  negocio: { id: string; whatsappPhoneNumberId: string },
  clientaReal?: string,
) {
  const { guion, variante, indice } = corrida;
  const mensajes = guion.variantes[variante];
  // Con CLIENTA, los guiones hablan desde un telefono DE VERDAD: el bot le contesta por WhatsApp y se
  // puede leer la conversacion en el celular, no solo en la base. Sin CLIENTA, cada conversacion usa su
  // propio numero simulado y nada sale hacia Meta.
  const telefono = clientaReal ?? `${PREFIJO_SIMULADO}${String(indice).padStart(6, "0")}`;
  const cliente = await prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId: negocio.id, phoneNumber: telefono } },
    create: { businessId: negocio.id, phoneNumber: telefono, simulated: !clientaReal, name: null },
    update: { simulated: !clientaReal },
    select: { id: true },
  });
  if (!clientaReal) await limpiarCliente(cliente.id);

  const enviar = (texto: string) =>
    fetch(`${URL_BASE}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpoDeWebhook(negocio.whatsappPhoneNumberId, telefono, texto)),
    });

  if (guion.rafaga) {
    // A propósito sin esperar: los cuatro entran antes de que el bot conteste el primero.
    for (const texto of mensajes) await enviar(texto);
    await esperarRespuesta(cliente.id, 0);
  } else {
    for (const texto of mensajes) {
      const antes = await prisma.message.count({
        where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" },
      });
      await enviar(texto);
      await esperarRespuesta(cliente.id, antes);
    }
  }

  const conversacion = await prisma.conversation.findFirst({
    where: { customerId: cliente.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true },
  });
  if (!conversacion) return { guion, variante, telefono, error: "no se creo la conversacion" as const };

  const [turnos, incidentes, pedido, respuestas] = await Promise.all([
    prisma.agentTurn.findMany({
      where: { conversationId: conversacion.id },
      orderBy: { createdAt: "asc" },
      select: { scope: true, toolsCalled: true, mediaProductIds: true, effectAuthor: true },
    }),
    prisma.agentIncident.findMany({
      where: { conversationId: conversacion.id },
      select: { kind: true, detail: true },
    }),
    prisma.order.findFirst({
      where: { conversationId: conversacion.id },
      select: { summary: true, totalAmount: true, fulfillmentStatus: true },
    }),
    prisma.message.findMany({
      where: { conversationId: conversacion.id, role: "ASSISTANT" },
      orderBy: { createdAt: "asc" },
      select: { content: true },
    }),
  ]);

  return { guion, variante, telefono, conversacion, turnos, incidentes, pedido, respuestas };
}

type Resultado = Awaited<ReturnType<typeof correrGuion>>;

/** Corre `tareas` de a `cuantas` a la vez. Cada conversación sigue siendo secuencial por dentro. */
async function enTandas<T>(tareas: (() => Promise<T>)[], cuantas: number): Promise<T[]> {
  const salida: T[] = new Array(tareas.length);
  let siguiente = 0;
  const obreros = Array.from({ length: Math.min(cuantas, tareas.length) }, async () => {
    for (;;) {
      const mio = siguiente++;
      if (mio >= tareas.length) return;
      salida[mio] = await tareas[mio]();
    }
  });
  await Promise.all(obreros);
  return salida;
}

async function main() {
  if (process.env.LISTAR) {
    for (const g of GUIONES) console.log(`${g.nombre.padEnd(26)} ${g.variantes.length} variantes  ${g.busca}`);
    console.log(`\n${GUIONES.length} tipos, ${GUIONES.reduce((n, g) => n + g.variantes.length, 0)} variantes en total.`);
    process.exit(0);
  }

  const negocio = await prisma.business.findFirst({
    where: { name: NEGOCIO },
    select: { id: true, name: true, whatsappPhoneNumberId: true, contactPhone: true },
  });
  if (!negocio?.whatsappPhoneNumberId) {
    console.error(`No existe "${NEGOCIO}" o no tiene WhatsApp conectado. Corre antes:`);
    console.error("  npx tsx scripts/clonar-negocio-de-pruebas.ts");
    process.exit(65);
  }
  if (negocio.contactPhone && !process.env.DUENO_AVISADO) {
    // La red de seguridad: con telefono de dueno, un guion de compra le manda la confirmacion de venta a
    // una persona de verdad. Se puede saltar A PROPOSITO cuando ese telefono es el de uno mismo -- que es
    // justamente el montaje que pidio el dueno: su numero como dueno del negocio de pruebas.
    console.error(`"${negocio.name}" tiene telefono de dueno: ${negocio.contactPhone}`);
    console.error("Los guiones le van a mandar alertas de venta a ESE numero por WhatsApp.");
    console.error(`Si ese numero es tuyo y lo queres: DUENO_AVISADO=1 npx tsx scripts/guiones-de-prueba.ts`);
    process.exit(65);
  }

  // Con línea real, las clientas de los guiones tienen que ser números que puedan recibir: el número de
  // prueba de Meta solo le escribe a los destinatarios verificados en su pantalla de configuración.
  const telefonoDeLaClienta = process.env.CLIENTA;
  if (telefonoDeLaClienta && !/^\d{10,15}$/.test(telefonoDeLaClienta)) {
    console.error(`CLIENTA tiene que ser un numero sin + ni espacios, por ejemplo 573150496302.`);
    process.exit(64);
  }

  const tipos = process.env.GUION ? GUIONES.filter((g) => g.nombre === process.env.GUION) : GUIONES;
  if (tipos.length === 0) {
    console.error(`No hay ningun guion llamado "${process.env.GUION}". Con LISTAR=1 se ven todos.`);
    process.exit(64);
  }

  // Sin CANTIDAD, una conversación de cada tipo. Con CANTIDAD, se reparten en ronda entre los tipos y se
  // van rotando las variantes: así cien conversaciones son cien redacciones distintas, no cien copias.
  const cuantas = Number(process.env.CANTIDAD ?? tipos.length);
  if (!Number.isInteger(cuantas) || cuantas < 1) {
    console.error(`CANTIDAD tiene que ser un entero mayor que 0.`);
    process.exit(64);
  }
  if (telefonoDeLaClienta && cuantas > 1) {
    console.error(`Con CLIENTA todas las conversaciones serian del MISMO numero y se pisarian entre si.`);
    console.error(`Usa CANTIDAD=1 y GUION=<tipo>, o saca CLIENTA para que cada una tenga su numero.`);
    process.exit(64);
  }

  const corridas: Corrida[] = [];
  for (let i = 0; i < cuantas; i++) {
    const guion = tipos[i % tipos.length];
    const vuelta = Math.floor(i / tipos.length);
    corridas.push({ guion, variante: vuelta % guion.variantes.length, indice: i + 1 });
  }
  const mensajesTotales = corridas.reduce((n, c) => n + c.guion.variantes[c.variante].length, 0);

  console.log(`Negocio:        ${negocio.name}`);
  console.log(`Conversaciones: ${corridas.length} de ${tipos.length} tipos, ${mensajesTotales} mensajes en total`);
  console.log(`En paralelo:    ${PARALELO}\n`);

  let hechas = 0;
  const resultados = await enTandas(
    corridas.map((corrida) => async () => {
      const resultado = await correrGuion(
        corrida,
        negocio as { id: string; whatsappPhoneNumberId: string },
        telefonoDeLaClienta,
      );
      hechas++;
      process.stdout.write(`\r[${hechas}/${corridas.length}] ${corrida.guion.nombre.padEnd(26)}`);
      return resultado;
    }),
    PARALELO,
  );
  console.log("\n");

  // El reporte se agrupa POR TIPO. Con cien conversaciones, cien bloques no se leen: lo que se busca es
  // "de las seis veces que probé cancelar, cuántas salieron mal".
  const porTipo = new Map<string, Resultado[]>();
  for (const r of resultados) {
    const lista = porTipo.get(r.guion.nombre) ?? [];
    lista.push(r);
    porTipo.set(r.guion.nombre, lista);
  }

  console.log("==================== RESUMEN ====================\n");
  const incidentesTotales = new Map<string, number>();
  let mudas = 0;
  let conPedido = 0;

  for (const [nombre, lista] of porTipo) {
    const busca = lista[0].guion.busca;
    const sinRespuesta = lista.filter((r) => !("error" in r) && r.respuestas.length === 0);
    const pedidos = lista.filter((r) => !("error" in r) && r.pedido);
    mudas += sinRespuesta.length;
    conPedido += pedidos.length;

    console.log(`--- ${nombre}  (${lista.length} conversacion(es))`);
    console.log(`    busca:       ${busca}`);
    console.log(`    pedidos:     ${pedidos.length}`);
    if (sinRespuesta.length > 0) {
      console.log(`    SIN RESPUESTA: ${sinRespuesta.length} -> ${sinRespuesta.map((r) => r.telefono).join(", ")}`);
    }

    for (const r of lista) {
      if ("error" in r) {
        console.log(`    ERROR (${r.telefono}): ${r.error}`);
        continue;
      }
      for (const i of r.incidentes) {
        incidentesTotales.set(i.kind, (incidentesTotales.get(i.kind) ?? 0) + 1);
        console.log(`    INCIDENTE (${r.telefono}) ${i.kind}: ${i.detail.replace(/\n/g, " ").slice(0, 100)}`);
      }
    }

    // Una muestra para leer con los ojos: la última respuesta de la primera conversación del tipo.
    const muestra = lista.find((r) => !("error" in r) && r.respuestas.length > 0);
    if (muestra && !("error" in muestra)) {
      const ultima = muestra.respuestas[muestra.respuestas.length - 1];
      console.log(`    ejemplo:     ${ultima.content.replace(/\n/g, " | ").slice(0, 130)}`);
    }
    console.log();
  }

  console.log("==================== TOTALES ====================");
  console.log(`  conversaciones:  ${resultados.length}`);
  console.log(`  pedidos creados: ${conPedido}`);
  console.log(`  sin respuesta:   ${mudas}`);
  if (incidentesTotales.size === 0) {
    console.log(`  incidentes:      ninguno`);
  } else {
    for (const [kind, n] of [...incidentesTotales].sort((a, b) => b[1] - a[1])) {
      console.log(`  incidente ${kind}: ${n}`);
    }
  }
  console.log(`\nEl hilo completo de cada una se ve en la Bandeja del panel de ${negocio.name}.`);
  console.log(`Para borrarlas todas: npx tsx scripts/borrar-simulados.ts`);
  process.exit(0);
}

void main();
