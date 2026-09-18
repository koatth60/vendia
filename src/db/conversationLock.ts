import { Pool } from "pg";
import { env } from "../config/env";

// E07 de ONIX-PLAN.md: el lock por conversacion deja de vivir en la memoria del proceso.
//
// QUE QUITA. Hasta ahora, lo unico que impedia que dos instancias del servidor le contestaran dos
// veces al mismo cliente era una linea en `ecosystem.config.js` (`instances: 1`). Escalar el proceso
// -- o correr el worker de E23 al lado del web -- era una decision que el operador tenia que
// acordarse de no tomar. Con el lock en la base, esa responsabilidad desaparece del operador: el
// codigo la garantiza, corran uno o cinco procesos.
//
// POR QUE NO ES `pg_advisory_xact_lock`, QUE ES LO QUE DECIA LA FICHA DE E07. Un lock de transaccion
// se suelta cuando la transaccion termina, asi que exige tener una transaccion ABIERTA durante toda
// la seccion critica. Y la seccion critica de un turno es `generateReply` + el envio: segundos,
// a veces minutos (STALE_REPLY_MINUTES son 10). Eso significaria una transaccion abierta e inactiva
// por minutos y por conversacion -- una conexion tomada, el horizonte de `xmin` congelado y VACUUM
// frenado mientras tanto -- y, peor, las transacciones interactivas de Prisma tienen un `timeout`
// propio: al vencerse hacen rollback y SUELTAN EL LOCK mientras nuestro turno sigue corriendo, sin
// que nadie se entere. Un lock que se suelta solo a mitad de la seccion critica es peor que no
// tener lock, porque parece que protege. Se usa entonces el lock de SESION
// (`pg_advisory_lock` / `pg_advisory_unlock`), que da la misma garantia entre procesos, no necesita
// Redis, y tambien se libera solo si el proceso muere -- porque al morir se cae la conexion.
//
// POR QUE SIGUE HABIENDO UNA CADENA EN MEMORIA ENCIMA (ver `withConversationLock` en
// routes/whatsapp.ts). No son dos mecanismos para lo mismo; cada uno garantiza algo que el otro no
// puede:
//   - la cadena de promesas en memoria garantiza el ORDEN DE LLEGADA dentro de este proceso. El lock
//     de Postgres no puede: dos llamadas simultaneas piden una conexion al pool y no hay nada que
//     garantice cual de las dos la consigue primero, asi que dos mensajes del mismo cliente podrian
//     grabarse al reves.
//   - el lock de Postgres garantiza la EXCLUSION ENTRE PROCESOS. La cadena en memoria no puede,
//     porque cada proceso tiene su propio `Map`.
//
// REENTRANCIA. Pedir el lock de una conversacion DENTRO de una seccion critica de la misma
// conversacion se cuelga (la cadena en memoria ya se colgaba igual, asi que hoy no hay ningun
// camino que lo haga). Si alguna vez hace falta, se pasa el mismo cliente hacia adentro; no se
// anida.

// Los locks consultivos de Postgres viven en un espacio global de dos enteros. El primero es el
// espacio de nombres, para no chocar con cualquier otro uso de locks consultivos en la misma base:
// 0x4F4E4958 son las letras "ONIX" en ASCII.
const ESPACIO_ONIX = 0x4f4e4958;

// Cuanto se espera a que el otro proceso suelte la conversacion antes de darse por vencido. Sin
// tope, un turno colgado del otro lado deja a este esperando para siempre con una conexion tomada.
// Con tope, falla ruidoso y la conexion vuelve al pool. 10 minutos es STALE_REPLY_MINUTES: pasado
// ese punto la respuesta se descartaria igual por vieja.
const ESPERA_MAXIMA_MS = Number(process.env.CONVERSATION_LOCK_TIMEOUT_MS ?? "") || 10 * 60 * 1000;

// Una conexion por seccion critica EN CURSO, que es una por conversacion viva -- la cadena en
// memoria ya impide que la misma conversacion tenga dos a la vez. Mismo tamaño que el pool de
// Prisma (src/db/client.ts) por el mismo motivo: varios negocios atendiendo a la vez.
const TAMANO_POOL = Number(process.env.CONVERSATION_LOCK_POOL_MAX ?? "") || 20;

export interface ConversationLocker {
  /** Corre `fn` con la conversacion tomada. Propaga lo que tire `fn`, soltando el lock igual. */
  run(conversationId: string, fn: () => Promise<void>): Promise<void>;
  /** Cierra el pool. Lo usa el apagado ordenado y las pruebas. */
  close(): Promise<void>;
}

// Fabrica en vez de un solo objeto global para que la prueba pueda crear DOS lockers con pools
// distintos -- que es exactamente lo que son dos procesos distintos -- y comprobar la garantia de
// verdad, en vez de comprobar que un `Map` funciona.
export function createConversationLocker(options: { connectionString?: string; max?: number } = {}): ConversationLocker {
  const pool = new Pool({
    connectionString: options.connectionString ?? env.databaseUrl,
    max: options.max ?? TAMANO_POOL,
    // Se ve en `pg_stat_activity` cuando haya que averiguar quien tiene tomada una conversacion.
    application_name: "onix-conversation-lock",
    // Una conexion ociosa de este pool no tiene por que mantener vivo al proceso: sin esto, un
    // apagado (o una corrida de pruebas) se queda esperando los 10 s de `idleTimeoutMillis` por
    // nada. No afecta a una conexion EN USO, que es la unica que importa: esa tiene un turno
    // corriendo encima.
    allowExitOnIdle: true,
  });

  return {
    async run(conversationId: string, fn: () => Promise<void>): Promise<void> {
      const client = await pool.connect();
      let tomado = false;
      try {
        // `lock_timeout` aplica a la espera de un lock consultivo igual que a la de una fila. Se
        // pone por conexion, antes de pedirlo.
        await client.query(`SET lock_timeout = ${Math.max(1, Math.round(ESPERA_MAXIMA_MS))}`);
        await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [ESPACIO_ONIX, conversationId]);
        tomado = true;
        await fn();
      } finally {
        if (tomado) {
          try {
            await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [ESPACIO_ONIX, conversationId]);
            client.release();
          } catch {
            // Si el unlock no se pudo confirmar, esta conexion puede seguir teniendo el lock puesto:
            // devolverla al pool dejaria la conversacion trabada hasta que el proceso muera.
            // Destruirla cierra la sesion, y Postgres suelta sus locks al cerrarse.
            client.release(true);
          }
        } else {
          client.release();
        }
      }
    },
    close(): Promise<void> {
      return pool.end();
    },
  };
}

export const conversationLocker = createConversationLocker();
