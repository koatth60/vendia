import { hostname } from "node:os";
import { prisma } from "../db/client";

// E23, segunda parte (2026-09-18). UN JOB LO CORRE UN SOLO PROCESO A LA VEZ.
//
// `sinSolape` protege contra que UN proceso se pise a si mismo. Esto protege contra el otro proceso: el
// arriendo vive en la base (tabla JobLease), asi que dos `worker` -- levantados por carga, o el viejo y
// el nuevo solapados durante un despliegue -- no pueden correr la misma pasada.
//
// El caso que duele: `saleConfirmationChaser` recorre conversaciones vencidas mandando WhatsApps. Dos
// procesos = dos confirmaciones del mismo pedido a la duena.
//
// POR QUE ARRIENDO Y NO UN LOCK CONSULTIVO como el de E07: un lock consultivo se suelta cuando la
// conexion se cae, y eso es exactamente lo que se quiere para una conversacion (que el siguiente turno
// pueda entrar enseguida). Para un job es al reves: si el proceso muere a la mitad de mandar mensajes,
// que otro proceso arranque la misma pasada un segundo despues es el mensaje duplicado otra vez. El
// arriendo con vencimiento le da tiempo a que el trabajo a medias se note.

/** Quien tomo el arriendo. Solo para mirar, nunca para decidir. */
const QUIEN = `${hostname()}:${process.pid}`;

/**
 * Toma el arriendo si esta libre o vencido. Devuelve false si lo tiene otro.
 *
 * Es UNA sentencia: el `WHERE` filtra y el `UPDATE` marca en la misma operacion atomica, asi que dos
 * procesos que entren en el mismo milisegundo no pueden ganar los dos. Leer-y-despues-escribir si
 * podria, y es el error que esta funcion existe para no cometer.
 *
 * El reloj sale de Node y no de `now()` de Postgres a proposito: las columnas son `timestamp` sin zona
 * y lo que Prisma escribe es UTC, asi que compararlas contra un `now()` que rinde la zona de la sesion
 * da cinco horas de diferencia en una base que no este en UTC (pasaba en la cola de entrada, ver
 * src/conversation/inboundEvents.ts).
 */
async function tomar(nombre: string, ttlMs: number): Promise<boolean> {
  const ahora = new Date();
  const hasta = new Date(ahora.getTime() + ttlMs);

  // La fila puede no existir todavia: el primer arranque de un job nuevo la crea. `ON CONFLICT` con la
  // misma condicion de vencimiento hace que crear y tomar sean la misma operacion.
  const tomadas = await prisma.$executeRaw`
    INSERT INTO "JobLease" ("name", "lockedUntil", "holder")
    VALUES (${nombre}, ${hasta}, ${QUIEN})
    ON CONFLICT ("name") DO UPDATE
      SET "lockedUntil" = ${hasta}, "holder" = ${QUIEN}
      WHERE "JobLease"."lockedUntil" IS NULL OR "JobLease"."lockedUntil" < ${ahora}
  `;
  return tomadas > 0;
}

/** Suelta el arriendo. Si ya vencio y lo tomo otro, no se le pisa. */
async function soltar(nombre: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "JobLease"
    SET "lockedUntil" = NULL, "lastRunAt" = ${new Date()}
    WHERE "name" = ${nombre} AND "holder" = ${QUIEN}
  `;
}

/** Cuantas pasadas se saltearon porque el job lo tenia otro proceso. */
const salteadasPorOtroProceso = new Map<string, number>();

export function arriendosSalteados(): { nombre: string; salteadas: number }[] {
  return [...salteadasPorOtroProceso.entries()].map(([nombre, salteadas]) => ({ nombre, salteadas }));
}

/** Solo para las pruebas: vuelve a cero los contadores. */
export function reiniciarContadoresDeArriendo(): void {
  salteadasPorOtroProceso.clear();
}

/**
 * Envuelve una tarea para que solo la corra el proceso que tenga el arriendo.
 *
 * `ttlMs` es cuanto vale el arriendo: tiene que ser MAS que lo que tarda una pasada lenta, o el segundo
 * proceso arranca encima del primero. Y menos que el tiempo que se esta dispuesto a esperar despues de
 * una caida, porque hasta que venza nadie mas lo toma.
 *
 * Un fallo NO deja el arriendo tomado: se suelta igual y el error sube al llamador, que es quien sabe
 * como registrarlo.
 */
export function conArriendo<T>(nombre: string, ttlMs: number, tarea: () => Promise<T>): () => Promise<T | undefined> {
  return async () => {
    if (!(await tomar(nombre, ttlMs))) {
      salteadasPorOtroProceso.set(nombre, (salteadasPorOtroProceso.get(nombre) ?? 0) + 1);
      return undefined;
    }
    try {
      return await tarea();
    } finally {
      await soltar(nombre).catch((error) => console.error(`No se pudo soltar el arriendo de ${nombre}:`, error));
    }
  };
}
