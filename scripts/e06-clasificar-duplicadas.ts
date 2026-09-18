import { prisma } from "../src/db/client";
import { HEALTH_FINDING_PREFIX } from "../src/jobs/conversationHealth";
import { splitLongMessage } from "../src/whatsapp/outbound";

// E06 de ONIX-PLAN.md: de donde sale la "respuesta duplicada".
//
// El detector (src/jobs/conversationHealth.ts) marca RESPUESTA_DUPLICADA cuando encuentra DOS filas
// ASSISTANT seguidas, sin media y sin ninguna fila del cliente en el medio, con menos de 12 segundos
// de diferencia. Eso es una FIRMA, no una causa: la lectura del codigo (ver la ficha de E06 en el
// plan) encontro cuatro maneras distintas de producir esa firma, y tres de ellas son un solo turno
// que le manda varios mensajes al cliente a proposito. Este script separa cual es cual sobre los
// casos reales, que es lo unico que E06 pide.
//
// SOLO LEE. Ni un INSERT, ni un UPDATE, ni un mensaje enviado. Se puede correr en produccion con el
// bot andando.
//
//   npx tsx scripts/e06-clasificar-duplicadas.ts          # ultimos 7 dias
//   npx tsx scripts/e06-clasificar-duplicadas.ts 14       # ultimos 14 dias
//
// Las clases que devuelve:
//
//   TROZOS          Un solo mensaje del bot de mas de 700 caracteres, partido por splitLongMessage
//                   en dos envios con 600 ms de pausa (outbound.ts). El cliente recibio lo que tenia
//                   que recibir. Falso positivo del detector.
//   BLOQUE_CATALOGO La frase del modelo y el bloque que compuso el SERVIDOR salieron como dos
//                   mensajes (catalogBlocks.ts, 900 ms entre bloques). Se confirma contra
//                   AgentTurn.blocks, que guarda el texto exacto del bloque. Falso positivo.
//   DOS_TURNOS      Hay dos filas de AgentTurn en la ventana: dos llamadas a generateReply de verdad.
//                   Este es el duplicado real, el que las etapas E07/E08 vienen a arreglar.
//   OTRO_AUTOR      Ninguna fila de AgentTurn: la segunda respuesta no la escribio el bot. Es la
//                   respuesta del dueno relevada al cliente, un mensaje del panel, una plantilla de
//                   un job o el drenaje de la cola - ninguno de esos caminos pide el lock por
//                   conversacion. Duplicado real para el cliente, pero de otra causa que E07/E08.
//   COLA            Caso particular de OTRO_AUTOR que se pudo atribuir a QueuedOutboundMessage.
//   UN_TURNO_OTRO   Un solo turno y ninguna de las firmas de arriba. Hay que mirarlo a mano; el
//                   script imprime el texto recortado para eso.
//
// Los reinicios de pm2 no estan en la base, asi que no se pueden cruzar desde aca. Para eso:
//   grep -iE "restart|starting" ~/.pm2/pm2.log | tail -40
// y comparar con las marcas de hora que imprime este script (columna `cuando`).

const DIAS = Number(process.argv[2] ?? "7");
// El mismo umbral del detector. Si cambia alla, tiene que cambiar aca.
const GAP_MS = 12_000;
// Margen hacia atras para buscar el AgentTurn del par: la fila del turno se escribe al final de
// generateReply, ANTES del retraso de tipeo y del envio, asi que queda unos segundos antes de la
// primera fila del par. Dos minutos cubren un turno lento sin barrer el turno anterior.
const VENTANA_TURNO_ANTES_MS = 120_000;
const VENTANA_TURNO_DESPUES_MS = 60_000;

type Clase = "TROZOS" | "BLOQUE_CATALOGO" | "DOS_TURNOS" | "OTRO_AUTOR" | "COLA" | "UN_TURNO_OTRO";

interface Fila {
  id: string;
  content: string;
  mediaType: string | null;
  role: string;
  createdAt: Date;
}

interface Par {
  conversationId: string;
  businessId: string;
  a: Fila;
  b: Fila;
  gapMs: number;
  turnos: number;
  clase: Clase;
}

function recorte(texto: string, largo = 60): string {
  const plano = texto.split("\n").join(" ").trim();
  return plano.length > largo ? `${plano.slice(0, largo)}...` : plano;
}

function fecha(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ¿Son los dos pedazos de un mismo mensaje largo? Se reconstruye el original pegandolos y se vuelve a
// partir con la MISMA funcion que uso el servidor: si el corte cae en el mismo lugar, eran trozos.
// Se prueban los tres separadores que sobreviven al trimEnd/trimStart de splitLongMessage.
function parecenTrozos(a: string, b: string): boolean {
  for (const separador of ["\n\n", "\n", " "]) {
    const partes = splitLongMessage(`${a}${separador}${b}`);
    if (partes.length >= 2 && partes[0] === a && partes[1] === b) return true;
  }
  return false;
}

// ¿Alguna de las dos filas es, textualmente, un bloque compuesto por el servidor en ese turno?
// AgentTurn.blocks guarda el texto exacto, asi que esto no deduce nada: compara.
function esBloqueDelServidor(blocks: string[], ...textos: string[]): boolean {
  for (const bloque of blocks) {
    const limpio = bloque.trim();
    if (!limpio) continue;
    for (const texto of textos) {
      if (texto.trim() === limpio) return true;
    }
  }
  return false;
}

async function clasificarPar(
  conversationId: string,
  businessId: string,
  a: Fila,
  b: Fila
): Promise<Par> {
  const turnos = await prisma.agentTurn.findMany({
    where: {
      conversationId,
      createdAt: {
        gte: new Date(a.createdAt.getTime() - VENTANA_TURNO_ANTES_MS),
        lte: new Date(b.createdAt.getTime() + VENTANA_TURNO_DESPUES_MS),
      },
    },
    select: { id: true, blocks: true, catalogInlined: true, catalogAuthor: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const base = {
    conversationId,
    businessId,
    a,
    b,
    gapMs: b.createdAt.getTime() - a.createdAt.getTime(),
    turnos: turnos.length,
  };

  // Primero las dos explicaciones de "un turno, varios mensajes": valen aunque en la ventana haya
  // quedado tambien el turno anterior de la conversacion.
  for (const turno of turnos) {
    if (esBloqueDelServidor(turno.blocks, a.content, b.content)) {
      return { ...base, clase: "BLOQUE_CATALOGO" };
    }
  }
  if (parecenTrozos(a.content, b.content)) return { ...base, clase: "TROZOS" };

  if (turnos.length >= 2) return { ...base, clase: "DOS_TURNOS" };
  if (turnos.length === 1) return { ...base, clase: "UN_TURNO_OTRO" };

  // Sin ningun turno: el segundo mensaje no lo escribio el bot. Se intenta atribuirlo a la cola, que
  // es el unico otro autor que deja una fila propia con el texto exacto.
  const enCola = await prisma.queuedOutboundMessage.findFirst({
    where: {
      conversationId,
      sentAt: {
        gte: new Date(a.createdAt.getTime() - VENTANA_TURNO_ANTES_MS),
        lte: new Date(b.createdAt.getTime() + VENTANA_TURNO_DESPUES_MS),
      },
      OR: [{ body: a.content }, { body: b.content }],
    },
    select: { id: true },
  });
  return { ...base, clase: enCola ? "COLA" : "OTRO_AUTOR" };
}

async function main(): Promise<void> {
  const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000);

  const incidentes = await prisma.agentIncident.findMany({
    where: {
      createdAt: { gte: desde },
      detail: { startsWith: `${HEALTH_FINDING_PREFIX} RESPUESTA_DUPLICADA` },
    },
    select: { businessId: true, conversationId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Incidentes RESPUESTA_DUPLICADA en los ultimos ${DIAS} dias: ${incidentes.length}`);
  if (incidentes.length === 0) return;

  const porConversacion = new Map<string, string>();
  for (const incidente of incidentes) {
    if (incidente.conversationId) porConversacion.set(incidente.conversationId, incidente.businessId);
  }
  console.log(`Conversaciones involucradas: ${porConversacion.size}`);

  const pares: Par[] = [];
  for (const [conversationId, businessId] of porConversacion) {
    // Una hora de margen hacia atras: el incidente se registra hasta 45 minutos despues del par (la
    // ventana del job), asi que el par puede ser anterior a `desde`.
    const mensajes = (await prisma.message.findMany({
      where: { conversationId, createdAt: { gte: new Date(desde.getTime() - 60 * 60 * 1000) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, mediaType: true, createdAt: true },
    })) as Fila[];

    // La MISMA regla del detector, sin cambiarle nada: dos ASSISTANT seguidas, ninguna con media.
    // Cualquier fila del cliente en el medio rompe el par, porque rompe la adyacencia.
    for (let i = 1; i < mensajes.length; i++) {
      const a = mensajes[i - 1];
      const b = mensajes[i];
      if (a.role !== "ASSISTANT" || b.role !== "ASSISTANT" || a.mediaType || b.mediaType) continue;
      if (b.createdAt.getTime() - a.createdAt.getTime() >= GAP_MS) continue;
      pares.push(await clasificarPar(conversationId, businessId, a, b));
    }
  }

  const conteo = new Map<Clase, number>();
  for (const par of pares) conteo.set(par.clase, (conteo.get(par.clase) ?? 0) + 1);

  console.log(`\nPares reconstruidos desde Message: ${pares.length}\n`);
  console.log("clase            casos   % de los pares");
  for (const [clase, casos] of [...conteo.entries()].sort((x, y) => y[1] - x[1])) {
    const porcentaje = ((casos / pares.length) * 100).toFixed(0);
    console.log(`${clase.padEnd(16)} ${String(casos).padStart(5)}   ${porcentaje.padStart(3)}%`);
  }

  console.log("\nDetalle (cuando | gap | turnos | clase | conversacion | primer mensaje | segundo mensaje)");
  for (const par of pares.sort((x, y) => x.a.createdAt.getTime() - y.a.createdAt.getTime())) {
    console.log(
      [
        fecha(par.a.createdAt),
        `${(par.gapMs / 1000).toFixed(1)}s`,
        `t=${par.turnos}`,
        par.clase.padEnd(15),
        par.conversationId,
        `[${par.a.content.length}] ${recorte(par.a.content)}`,
        `[${par.b.content.length}] ${recorte(par.b.content)}`,
      ].join(" | ")
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
