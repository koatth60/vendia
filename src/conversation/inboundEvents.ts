import { prisma } from "../db/client";

/**
 * La forma del lote, escrita aca y no importada de routes/whatsapp a proposito: whatsapp.ts importa
 * ESTE modulo para guardar el lote, y traer el tipo de vuelta cerraria un ciclo de importacion. Un tipo
 * estructural de tres campos no vale un ciclo.
 */
export interface LoteDeMeta {
  statuses: { value: unknown; status: { id?: string; status?: string } | null; incomingPhoneNumberId?: string }[];
  messages: { value: unknown; message: { id?: string } | null; incomingPhoneNumberId: string }[];
}

// E20 / E21 (2026-09-18). LA COLA DE ENTRADA.
//
// E20 es el productor: el webhook inserta el lote y responde 200, y nada mas.
// E21 es el consumidor: toma lo pendiente, lo procesa, reintenta con espera creciente y manda a carta
// muerta lo que no se pudo.
//
// Van juntos a proposito. E20 sin E21 es una tabla que acumula y un bot mudo -- la apariencia de una
// cola sin la cola. Partirlos en dos despliegues habria dejado una ventana donde el sistema esta peor
// que antes, y eso no es media garantia: es cero garantia con mejor apariencia.

/** Cuantos intentos antes de la carta muerta. Mismo numero que la cola de salida. */
export const MAX_INTENTOS = 5;

/**
 * Espera creciente entre intentos, en minutos. Misma escala que QueuedOutboundMessage: el primer
 * reintento es casi inmediato (un hipo de red) y el ultimo da cuatro horas (Meta caida, S3 caido).
 */
export const ESPERA_MINUTOS = [1, 5, 15, 60, 240];

/** Cuanto se reserva un evento al tomarlo. Si el proceso muere, vence solo y otro lo toma. */
export const RESERVA_MS = 5 * 60 * 1000;

/**
 * La clave que hace la idempotencia, y ocurre ANTES de gastar.
 *
 * No es el wamid pelado: Meta manda VARIOS estados para el mismo mensaje saliente (sent, delivered,
 * read) y los tres traen el mismo id. Con el wamid como clave unica solo entraria el primero y los
 * otros dos se perderian -- el panel diria "enviado" de algo que la clienta ya leyo.
 */
export function claveDeDeduplicacion(kind: "MESSAGE" | "STATUS", wamid: string, estado?: string): string {
  return kind === "MESSAGE" ? `msg:${wamid}` : `st:${wamid}:${estado ?? "?"}`;
}

export interface EventoParaGuardar {
  dedupeKey: string;
  kind: string;
  wamid: string;
  phoneNumberId: string | null;
  payload: unknown;
}

/**
 * Convierte el lote de Meta en filas. Funcion PURA: no toca la base ni la red, igual que
 * collectWebhookBatch, para que el camino del webhook se pueda probar entero sin levantar nada.
 *
 * Los estados van primero y los mensajes despues, en el mismo orden en que vinieron: asi el acuse de
 * un mensaje anterior se aplica antes de que el turno nuevo lo pise.
 */
export function eventosDelLote(lote: LoteDeMeta): EventoParaGuardar[] {
  const filas: EventoParaGuardar[] = [];

  for (const { value, status, incomingPhoneNumberId } of lote.statuses) {
    const wamid = String(status?.id ?? "");
    // Sin id no hay como deduplicar, y un estado sin id tampoco se puede aplicar a nada: se descarta
    // aca en vez de ensuciar la cola con filas que el consumidor no podria usar.
    if (!wamid) continue;
    filas.push({
      dedupeKey: claveDeDeduplicacion("STATUS", wamid, String(status?.status ?? "?")),
      kind: "STATUS",
      wamid,
      phoneNumberId: incomingPhoneNumberId ?? null,
      payload: { value, status, incomingPhoneNumberId: incomingPhoneNumberId ?? null },
    });
  }

  for (const { value, message, incomingPhoneNumberId } of lote.messages) {
    const wamid = String(message?.id ?? "");
    if (!wamid) continue;
    filas.push({
      dedupeKey: claveDeDeduplicacion("MESSAGE", wamid),
      kind: "MESSAGE",
      wamid,
      phoneNumberId: incomingPhoneNumberId ?? null,
      payload: { value, message, incomingPhoneNumberId },
    });
  }

  return filas;
}

/**
 * Guarda el lote. `skipDuplicates` es la idempotencia: un reintento de Meta con los mismos wamid no
 * inserta nada y por lo tanto no dispara ninguna descarga, ninguna subida a S3, ninguna llamada de
 * vision y ningun chat facturable de mas.
 *
 * Devuelve cuantas filas nuevas entraron, que es lo que decide si vale la pena despertar al consumidor.
 */
export async function guardarEventosEntrantes(filas: EventoParaGuardar[]): Promise<number> {
  if (filas.length === 0) return 0;
  const { count } = await prisma.inboundEvent.createMany({
    data: filas.map((f) => ({
      dedupeKey: f.dedupeKey,
      kind: f.kind,
      wamid: f.wamid,
      phoneNumberId: f.phoneNumberId,
      payload: f.payload as never,
    })),
    skipDuplicates: true,
  });
  return count;
}

// EL DESPERTADOR, Y POR QUE EXISTE.
//
// El webhook quiere despertar al consumidor apenas encola, para no hacerle esperar a la clienta el
// segundo que tarda el job en pasar. Pero importar el job desde routes/whatsapp.ts cerraria un ciclo:
// el job importa procesarMensaje, que vive en routes/whatsapp.ts. Los ciclos en CommonJS "suelen"
// funcionar cuando el uso es diferido, y "suele funcionar" no es una garantia -- en este mismo
// repositorio ya se pago caro un modulo que se rompia al importar (el cliente de Groq, ver
// src/ai/transcription.ts).
//
// Asi que el job se registra aca al cargarse, y el webhook llama a esta funcion sin saber quien atiende.
// Si nadie se registro -- por ejemplo en una prueba que no levanta los jobs -- no pasa nada.
let despertador: (() => void) | null = null;

export function registrarDespertador(cb: () => void): void {
  despertador = cb;
}

export function despertarConsumidor(): void {
  despertador?.();
}

export interface EventoReclamado {
  id: string;
  kind: string;
  wamid: string;
  payload: unknown;
  attempts: number;
  receivedAt: Date;
}

/**
 * Toma hasta `cuantos` eventos pendientes, con FOR UPDATE SKIP LOCKED.
 *
 * POR QUE SQL CRUDO Y NO updateMany: SKIP LOCKED es lo que permite que DOS procesos worker corran a la
 * vez sin que los dos tomen la misma fila. Sin el, o se pisan (el cliente recibe dos respuestas) o hay
 * que volver a `instances: 1`, que es justamente lo que E23 viene a sacar. Prisma no lo expone.
 *
 * ORDER BY receivedAt: el orden importa. Dos mensajes seguidos de la misma clienta tienen que procesarse
 * en el orden en que los escribio, no al reves.
 */
export async function reclamarEventos(cuantos = 10): Promise<EventoReclamado[]> {
  const hasta = new Date(Date.now() + RESERVA_MS);
  const reclamados = await prisma.$queryRaw<EventoReclamado[]>`
    UPDATE "InboundEvent"
    SET "lockedUntil" = ${hasta}, "attempts" = "attempts" + 1
    WHERE id IN (
      SELECT id FROM "InboundEvent"
      WHERE "processedAt" IS NULL
        AND "failedAt" IS NULL
        AND "nextAttemptAt" <= now()
        AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
      ORDER BY "receivedAt" ASC
      LIMIT ${cuantos}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, wamid, payload, attempts, "receivedAt"
  `;

  // EL ORDER BY DE ARRIBA NO ORDENA ESTO, y la diferencia importa.
  //
  // En un `UPDATE ... WHERE id IN (SELECT ... ORDER BY ... FOR UPDATE SKIP LOCKED)`, el ORDER BY decide
  // CUALES filas se toman, no en que orden las devuelve RETURNING: Postgres las devuelve en el orden que
  // le resulte. Lo encontro la prueba "el orden de la cola es el orden en que escribio la clienta", que
  // fallo contra la primera version de esta funcion.
  //
  // Sin esta linea, dos mensajes seguidos de la misma clienta podian procesarse al reves y el pedido
  // quedaba armado mal: "el azul" aplicado antes de "quiero el reloj".
  return reclamados.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

export async function marcarProcesado(id: string): Promise<void> {
  await prisma.inboundEvent.update({
    where: { id },
    data: { processedAt: new Date(), lockedUntil: null, lastError: null },
  });
}

/**
 * Anota el fallo y decide: otra vuelta con mas espera, o carta muerta.
 *
 * La carta muerta NO borra la fila. El payload queda, asi que un evento que murio por un defecto
 * nuestro se puede reprocesar despues de arreglarlo -- que es la diferencia entre un mensaje perdido y
 * un mensaje pendiente.
 */
export async function anotarFallo(id: string, intentos: number, error: unknown): Promise<"REINTENTA" | "MUERTO"> {
  const detalle = error instanceof Error ? error.message : String(error);
  if (intentos >= MAX_INTENTOS) {
    await prisma.inboundEvent.update({
      where: { id },
      data: { failedAt: new Date(), lastError: detalle.slice(0, 500), lockedUntil: null },
    });
    console.error(`[ZAQI ALERT] Un mensaje entrante se agoto tras ${intentos} intentos y quedo sin atender: ${detalle}`);
    return "MUERTO";
  }
  const minutos = ESPERA_MINUTOS[Math.min(intentos, ESPERA_MINUTOS.length) - 1] ?? 1;
  await prisma.inboundEvent.update({
    where: { id },
    data: {
      nextAttemptAt: new Date(Date.now() + minutos * 60 * 1000),
      lastError: detalle.slice(0, 500),
      lockedUntil: null,
    },
  });
  return "REINTENTA";
}

/**
 * Los que murieron, para que el panel pueda mostrarlos en vez de que se pierdan en silencio.
 *
 * `phoneNumberId` ES OBLIGATORIO y no tiene default. InboundEvent no tiene businessId -- el negocio se
 * resuelve recien en el consumidor -- asi que la unica forma de saber de quien es un evento es su numero
 * de entrada. Sin este parametro, la ruta del panel le mostraria a una duena los mensajes fallidos de
 * OTRO negocio, que es el IDOR que E27 viene a cerrar. Se deja obligatorio para que no se pueda llamar
 * mal por olvido.
 */
export async function eventosEnCartaMuerta(phoneNumberId: string, limite = 50) {
  // Sin numero conectado no hay eventos suyos, y devolver "todos" seria exactamente el error.
  if (!phoneNumberId) return [];
  return prisma.inboundEvent.findMany({
    where: { failedAt: { not: null }, phoneNumberId },
    orderBy: { failedAt: "desc" },
    take: limite,
    select: { id: true, kind: true, wamid: true, phoneNumberId: true, attempts: true, lastError: true, failedAt: true, receivedAt: true },
  });
}
