import { sinSolape } from "./sinSolape";
import {
  reclamarEventos,
  marcarProcesado,
  anotarFallo,
  registrarDespertador,
} from "../conversation/inboundEvents";
import { procesarMensaje, procesarEstado } from "../routes/whatsapp";

// E21 (2026-09-18). EL CONSUMIDOR DE LA COLA DE ENTRADA.
//
// Vive en jobs/ y no en conversation/ porque es el unico que necesita conocer las dos mitades: la cola
// (conversation/inboundEvents.ts) y el procesamiento (routes/whatsapp.ts). Poniendo esta dependencia
// aca, la cola no sabe nada del webhook y el webhook no sabe nada del consumidor.

/**
 * Cada segundo. El mismo intervalo que el drenaje de rafagas, y por el mismo motivo: es la latencia que
 * ve la clienta entre que escribe y que el bot empieza a pensar. Mas espaciado se nota.
 */
export const INBOUND_EVENTS_INTERVAL_MS = 1000;

/**
 * SECUENCIAL A PROPOSITO, y esto no es una optimizacion pendiente.
 *
 * Dos mensajes seguidos de la misma clienta tienen que procesarse en el orden en que los escribio. Si
 * se procesaran en paralelo, "el azul" podria entrar antes que "quiero el reloj" y el pedido quedaria
 * armado al reves. El lock de conversacion serializa, pero serializa en el orden en que lleguen a
 * pedirlo -- que con Promise.all es el orden en que el planificador quiera.
 *
 * El costo es real: un mensaje lento retrasa a los que siguen. Se acepta porque un pedido mal armado le
 * cuesta plata a la duena y medio segundo de espera no.
 */
export async function drainInboundEvents(cuantos = 10): Promise<{ procesados: number; fallidos: number }> {
  const eventos = await reclamarEventos(cuantos);
  let procesados = 0;
  let fallidos = 0;

  for (const evento of eventos) {
    try {
      const payload = evento.payload as {
        value: unknown;
        message?: unknown;
        status?: unknown;
        incomingPhoneNumberId: string | null;
      };
      if (evento.kind === "MESSAGE") {
        if (!payload.incomingPhoneNumberId) throw new Error("Evento MESSAGE sin phoneNumberId");
        // receivedAt y no Date.now(): el turno se fecha por cuando la clienta escribio, no por cuando
        // el servidor se recupero. Un reproceso despues de un reinicio no puede mentir sobre eso -- hay
        // logica que descarta respuestas viejas (STALE_REPLY_MINUTES) y leeria mal la hora.
        await procesarMensaje(payload.value, payload.message, payload.incomingPhoneNumberId, evento.receivedAt.getTime());
      } else {
        await procesarEstado(payload.value, payload.status, payload.incomingPhoneNumberId ?? undefined);
      }
      await marcarProcesado(evento.id);
      procesados++;
    } catch (error) {
      // El evento NO se pierde: vuelve a la cola con mas espera, o queda en carta muerta con su payload
      // entero para poder reprocesarlo cuando se arregle la causa.
      await anotarFallo(evento.id, evento.attempts, error);
      fallidos++;
    }
  }

  return { procesados, fallidos };
}

export const inboundEventsGuard = sinSolape("cola de entrada", async () => {
  await drainInboundEvents();
});

export async function runInboundEventsJob(): Promise<void> {
  await inboundEventsGuard.correr();
}

// El webhook llama a despertarConsumidor() apenas encola, y termina aca. El guard de solape es el mismo
// que usa el job: si ya hay una pasada en curso, el despertar no arranca una segunda -- lo que encolo
// lo va a ver la pasada que ya esta corriendo, o la siguiente.
registrarDespertador(() => {
  void runInboundEventsJob().catch((error) => console.error("Error drenando la cola de entrada:", error));
});
