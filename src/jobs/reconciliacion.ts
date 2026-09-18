import { prisma } from "../db/client";
import { enqueuePendingBurst } from "../conversation/pendingBursts";

// E22 (2026-09-18). UN TURNO PERDIDO DEJA DE SER INVISIBLE.
//
// E20 y E21 hacen que el mensaje entrante no se pierda: queda en InboundEvent, se reintenta, y si no se
// puede queda en carta muerta. Pero eso solo cubre los fallos que la cola VE.
//
// Lo que nadie detecta hoy es una AUSENCIA. La clienta escribio, el mensaje se registro, y la respuesta
// nunca salio -- porque la rafaga se perdio en un reinicio anterior a E08, porque el turno murio en un
// camino que no tira excepcion, porque se quedo esperando algo que no llego. `conversationHealth`
// detecta respuestas duplicadas y promesas incumplidas; el silencio no lo detecta nada.
//
// El numero que hay ("2 mensajes sin respuesta en siete dias") salio de una consulta escrita a mano para
// el plan, no de ninguna alerta. O sea que hoy la unica forma de enterarse es que alguien lo busque.

/** Cada cuanto se revisa. No hace falta mas seguido: lo que esto busca ya lleva minutos sin respuesta. */
export const RECONCILIACION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Cuanto se espera antes de considerar que un mensaje quedo sin respuesta.
 *
 * Tiene que ser mas que la ventana de rafaga (8 s) mas el reintento mas lento de la cola de entrada
 * (ver ESPERA_MINUTOS en conversation/inboundEvents.ts) que todavia vale la pena esperar. Con 15 minutos
 * un turno que se esta reintentando solo todavia tiene margen para resolverse sin que esto lo toque.
 */
export const MINUTOS_SIN_RESPUESTA = 15;

/**
 * Y el tope: mas viejo que esto no se contesta, solo se anota.
 *
 * Es la parte que la etapa pide explicitamente ("arranca con una ventana amplia, para no contestar algo
 * de hace horas como si fuera nuevo"). Contestarle a alguien que escribio anoche como si acabara de
 * escribir es peor que no contestarle: la conversacion ya siguio por otro lado, o la clienta ya compro
 * en otro lugar, y el bot aparece hablando solo.
 */
export const HORAS_PARA_CONTESTAR = 6;

export interface TurnoPerdido {
  conversationId: string;
  businessId: string;
  customerId: string;
  customerPhone: string;
  ultimoTexto: string;
  customerSentAt: Date;
  /** "REENCOLADO" si se pidio el turno de nuevo; "SOLO_ANOTADO" si era demasiado viejo para contestar. */
  accion: "REENCOLADO" | "SOLO_ANOTADO";
}

/**
 * Las conversaciones cuyo ULTIMO mensaje es del cliente y lleva demasiado tiempo sin respuesta.
 *
 * "Ultimo mensaje" y no "algun mensaje sin respuesta despues": un turno donde la clienta escribio tres
 * veces y el bot contesto una sola vez al final esta bien atendido. Lo que es un turno perdido es que la
 * ULTIMA palabra sea de ella.
 */
export async function buscarTurnosPerdidos(limite = 50, soloNegocio?: string): Promise<TurnoPerdido[]> {
  const corte = new Date(Date.now() - MINUTOS_SIN_RESPUESTA * 60 * 1000);
  const tope = new Date(Date.now() - HORAS_PARA_CONTESTAR * 60 * 60 * 1000);

  // SQL crudo: es una consulta de "ultimo mensaje por conversacion" con condicion sobre ese ultimo, y
  // con el ORM saldrian N+1 consultas o traer todos los mensajes a memoria.
  //
  // Las exclusiones no son opcionales, cada una evita un mensaje de mas a una clienta real:
  //   humanControl  -> la duena esta atendiendo a mano; el bot no puede meterse en el medio
  //   PendingBurst  -> el turno YA esta encolado y a punto de salir
  //   InboundEvent  -> la cola de entrada todavia lo esta reintentando sola. Atado POR WAMID al ultimo
  //                    mensaje, no por negocio: la primera version excluia cualquier conversacion de un
  //                    negocio que tuviera algun evento pendiente, o sea que en un negocio con trafico
  //                    la reconciliacion no habria corrido nunca.
  //   business.active -> un negocio apagado no manda nada
  const filas = await prisma.$queryRaw<
    { conversationId: string; businessId: string; customerId: string; customerPhone: string; ultimoTexto: string; customerSentAt: Date }[]
  >`
    SELECT c.id              AS "conversationId",
           cu."businessId"   AS "businessId",
           cu.id             AS "customerId",
           cu."phoneNumber"  AS "customerPhone",
           m.content         AS "ultimoTexto",
           m."createdAt"     AS "customerSentAt"
    FROM "Conversation" c
    JOIN "Customer" cu ON cu.id = c."customerId"
    JOIN "Business" b  ON b.id = cu."businessId"
    JOIN LATERAL (
      SELECT mm.role, mm.content, mm."createdAt", mm."whatsappMessageId"
      FROM "Message" mm
      WHERE mm."conversationId" = c.id
      ORDER BY mm."createdAt" DESC
      LIMIT 1
    ) m ON true
    WHERE m.role = 'CUSTOMER'
      AND m."createdAt" <= ${corte}
      AND c."humanControl" = false
      AND b.active = true
      AND NOT EXISTS (SELECT 1 FROM "PendingBurst" pb WHERE pb."conversationId" = c.id)
      AND NOT EXISTS (
        SELECT 1 FROM "InboundEvent" ie
        WHERE ie."processedAt" IS NULL
          AND ie."failedAt" IS NULL
          AND ie.wamid = m."whatsappMessageId"
      )
      AND (${soloNegocio ?? null}::text IS NULL OR cu."businessId" = ${soloNegocio ?? null})
    ORDER BY m."createdAt" ASC
    LIMIT ${limite}
  `;

  return filas.map((f) => ({
    ...f,
    accion: f.customerSentAt <= tope ? ("SOLO_ANOTADO" as const) : ("REENCOLADO" as const),
  }));
}

/**
 * Busca, reencola lo que todavia vale la pena contestar, y anota TODO -- incluido lo que no se contesta.
 *
 * `soloNegocio` acota la pasada a un negocio. El job lo llama SIN el, que es el caso normal. Existe por
 * dos motivos concretos: permite reconciliar un negocio puntual a mano cuando se sabe que tuvo un
 * problema, y hace que una prueba no encole rafagas para conversaciones que dejo otro archivo -- esto
 * ultimo no es un detalle de prueba, es la misma propiedad: un trabajo que barre TODA la base sin poder
 * acotarse es un trabajo que no se puede ejercitar sin efectos de mas.
 *
 * Lo que no se contesta es justamente lo que hay que ver: son las conversaciones donde una clienta se
 * quedo hablando sola y nadie se entero. Que el numero exista es la mitad de esta etapa.
 */
export async function runReconciliacionJob(soloNegocio?: string): Promise<{ reencolados: number; soloAnotados: number }> {
  const perdidos = await buscarTurnosPerdidos(50, soloNegocio);
  let reencolados = 0;
  let soloAnotados = 0;

  for (const turno of perdidos) {
    if (turno.accion === "SOLO_ANOTADO") {
      soloAnotados++;
      console.error(
        `[ZAQI ALERT] Turno sin responder y demasiado viejo para contestarlo (${HORAS_PARA_CONTESTAR}h+): ` +
          `conversacion ${turno.conversationId}, negocio ${turno.businessId}, del ${turno.customerSentAt.toISOString()}`,
      );
      continue;
    }

    try {
      // Se reencola la RAFAGA, no el evento entrante: el mensaje ya esta en Message (reprocesar el
      // InboundEvent lo deduplicaria ahi y no pasaria nada). Lo que falta es el turno, y el turno lo
      // produce el drenaje de rafagas.
      await enqueuePendingBurst({
        conversationId: turno.conversationId,
        businessId: turno.businessId,
        customerId: turno.customerId,
        customerPhone: turno.customerPhone,
        rawText: turno.ultimoTexto,
        customerSentAt: turno.customerSentAt,
      });
      reencolados++;
      console.error(
        `[ZAQI ALERT] Turno sin responder reencolado: conversacion ${turno.conversationId}, ` +
          `negocio ${turno.businessId}, del ${turno.customerSentAt.toISOString()}`,
      );
    } catch (error) {
      // Un reencolado que falla no puede llevarse los otros: cada conversacion va sola.
      console.error(`[ZAQI ALERT] No se pudo reencolar la conversacion ${turno.conversationId}:`, error);
    }
  }

  return { reencolados, soloAnotados };
}
