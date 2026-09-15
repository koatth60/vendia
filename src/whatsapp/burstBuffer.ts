// Fase 10 del plan maestro (2026-09-15), eje 19: capa [1] INGESTA del diagrama de arquitectura
// (ONIX-PLAN-MAESTRO.md). Antes, dos o tres mensajes seguidos del mismo cliente (llegan como
// webhooks separados de Meta, con segundos de diferencia) disparaban cada uno su propio turno
// completo: tres llamadas a generateReply, cada una leyendo el mismo historial de arranque sin
// ver lo que la otra iba a contestar, y el cliente recibia varias respuestas a veces
// contradictorias entre si.
//
// Este modulo no sabe nada de WhatsApp, generateReply ni Prisma - es el primitivo generico de
// "agrupar por clave con una ventana de silencio", deliberadamente puro (nada de I/O, nada de
// setTimeout escondido detras de una libreria) para poder probarlo sin tocar la base ni la red.
// src/routes/whatsapp.ts lo usa con conversationId como clave.
//
// Debounce puro: cada item nuevo de la MISMA clave reinicia la ventana. Solo se descarga (flush)
// cuando esa clave lleva `windowMs` en silencio - asi el bot espera a que el cliente termine de
// escribir en vez de cortarlo a la mitad de una frase partida en varios mensajes.
// `maxWaitMs` es la salvedad: un cliente que nunca deja pasar `windowMs` entre mensajes (los manda
// mas rapido que eso) nunca dispararia el flush por silencio, asi que se fuerza una descarga al
// llegar a ese tope, para no dejarlo sin respuesta indefinidamente.

export interface BurstBufferOptions {
  windowMs?: number;
  maxWaitMs?: number;
  onError?: (key: string, error: unknown) => void;
}

const DEFAULT_WINDOW_MS = 8000;
const DEFAULT_MAX_WAIT_MS = 20000;

interface PendingBurst<TItem> {
  items: TItem[];
  timer: ReturnType<typeof setTimeout>;
  firstArrivedAt: number;
}

export interface BurstBuffer<TItem> {
  // Agrega un item a la rafaga en curso para `key` (o arranca una nueva). Reinicia la ventana de
  // silencio, salvo que ya se haya llegado a `maxWaitMs` desde el primer item, en cuyo caso
  // descarga de inmediato.
  add(key: string, item: TItem): void;
  // Cuantas rafagas estan esperando ahora mismo (solo para pruebas/diagnostico, y para el apagado
  // ordenado - ver flushAll).
  pendingCount(): number;
  // Fuerza la descarga inmediata de TODAS las rafagas pendientes, sin esperar el resto de su
  // ventana de silencio. Lo usa el apagado ordenado (src/shutdown.ts): un item que quedo esperando
  // su ventana ya esta grabado en la base y Meta ya recibio el 200 - si el proceso se reinicia
  // antes de que el timer normal dispare, se pierde en silencio. Resuelve cuando todas las
  // descargas forzadas terminaron (nunca rechaza: un flush que revienta ya se reporta via
  // onError/console.error, igual que en una descarga normal).
  flushAll(): Promise<void>;
}

export function createBurstBuffer<TItem>(
  flush: (key: string, items: TItem[]) => Promise<void>,
  options: BurstBufferOptions = {}
): BurstBuffer<TItem> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pending = new Map<string, PendingBurst<TItem>>();

  // Descarga `key` ya mismo (cancela su timer si tenia uno pendiente) y devuelve una promesa que
  // nunca rechaza - un flush que revienta ya se reporta via onError/console.error, no hace falta
  // que el llamador (add, ni flushAll) tambien lo maneje.
  function flushKey(key: string): Promise<void> {
    const entry = pending.get(key);
    if (!entry) return Promise.resolve();
    clearTimeout(entry.timer);
    pending.delete(key);
    return flush(key, entry.items).catch((error) => {
      if (options.onError) options.onError(key, error);
      else console.error(`Error procesando rafaga agrupada de ${key}:`, error);
    });
  }

  function add(key: string, item: TItem): void {
    const now = Date.now();
    const existing = pending.get(key);

    if (!existing) {
      pending.set(key, {
        items: [item],
        firstArrivedAt: now,
        timer: setTimeout(() => void flushKey(key), windowMs),
      });
      return;
    }

    existing.items.push(item);
    clearTimeout(existing.timer);

    const elapsed = now - existing.firstArrivedAt;
    const remainingBeforeCap = maxWaitMs - elapsed;
    if (remainingBeforeCap <= 0) {
      // Ya se llego al tope de espera: descargar ahora, no tiene sentido programar otro timer que
      // solo agregaria demora sin agrupar nada mas.
      void flushKey(key);
      return;
    }

    existing.timer = setTimeout(() => void flushKey(key), Math.min(windowMs, remainingBeforeCap));
  }

  function flushAll(): Promise<void> {
    const keys = [...pending.keys()];
    return Promise.all(keys.map((key) => flushKey(key))).then(() => undefined);
  }

  return {
    add,
    pendingCount: () => pending.size,
    flushAll,
  };
}
