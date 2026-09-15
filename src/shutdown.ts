// Apagado ordenado (Fase 7 del plan maestro, extendido en la Fase 10). Separado de src/index.ts a
// proposito: importar index.ts levanta el servidor HTTP real (app.listen) y conecta a la base -
// justo lo que CLAUDE.md advierte que rompe `--test src` en Node 22 (EADDRINUSE :3000). Con la
// logica aca, en un modulo sin efectos de carga, se puede probar con dependencias falsas.
//
// index.ts le pasa sus dependencias reales (server.close, getActiveTurnCount, el buffer de
// rafaga de whatsapp.ts); las pruebas le pasan fakes.

export interface OrderedShutdownDeps {
  closeServer: () => void;
  getActiveTurnCount: () => number;
  // Fase 10, eje 19: un mensaje que llego y quedo esperando su ventana de agrupacion de rafaga
  // (replyBurstBuffer en src/routes/whatsapp.ts) ya esta grabado en la base y Meta ya recibio el
  // 200 - si el proceso se reinicia antes de que el timer normal dispare, nadie lo vuelve a
  // intentar. flushPendingBursts fuerza esa descarga YA (entra a withConversationLock de
  // inmediato, lo que incrementa getActiveTurnCount() de forma sincronica), asi que el bucle de
  // espera de abajo, que ya existia para los turnos normales, tambien las cubre.
  flushPendingBursts: () => Promise<void>;
  getPendingBurstCount: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  logError: (message: string) => void;
  exit: (code: number) => void;
  graceMs?: number;
  pollMs?: number;
}

export type ShutdownFn = (signal: string) => Promise<void>;

export function createOrderedShutdown(deps: OrderedShutdownDeps): ShutdownFn {
  const graceMs = deps.graceMs ?? 20_000;
  const pollMs = deps.pollMs ?? 250;
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log(`${signal} recibido: cerrando ordenadamente (esperando turnos en vuelo, tope ${graceMs}ms)...`);

    deps.closeServer();

    const pendingBursts = deps.getPendingBurstCount();
    if (pendingBursts > 0) {
      deps.log(
        `Forzando la descarga de ${pendingBursts} rafaga(s) agrupada(s) pendiente(s) antes de esperar los turnos en vuelo...`
      );
    }
    // No se espera aca: podria tardar lo que tarde generateReply, y ya alcanza con que arranque -
    // withConversationLock incrementa getActiveTurnCount() de inmediato (ver la nota en el tipo de
    // arriba), asi que el bucle de espera que sigue ya la cubre dentro del mismo tope. Si de todos
    // modos revienta, ya quedo reportado adentro (ver flushAll en burstBuffer.ts); esto es una red
    // de seguridad extra.
    deps.flushPendingBursts().catch((error) => deps.logError(`Error vaciando el buffer de rafaga en el apagado: ${error}`));

    const deadline = deps.now() + graceMs;
    while (deps.getActiveTurnCount() > 0 && deps.now() < deadline) {
      await deps.sleep(pollMs);
    }

    const stillActive = deps.getActiveTurnCount();
    if (stillActive > 0) {
      deps.logError(`Apagado con ${stillActive} turno(s) en vuelo sin terminar (se agoto el tope de ${graceMs}ms)`);
    } else {
      deps.log("Todos los turnos en vuelo terminaron, apagado limpio");
    }
    deps.exit(0);
  };
}
