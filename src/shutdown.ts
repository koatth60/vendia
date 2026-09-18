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
  // Fase 10, eje 19, reescrito por E08 (2026-09-17): un mensaje que llego y quedo esperando su
  // ventana de agrupacion de rafaga ya no se pierde en un reinicio -- espera como fila de
  // PendingBurst, y el job de src/jobs/pendingBursts.ts la drena al arrancar. Asi que aca ya NO se
  // arrancan turnos nuevos (arrancarlos justo antes de morir era como se quedaban a medias): lo
  // unico que se hace es adelantar el reloj de lo que estaba esperando, para que la rafaga no tenga
  // que terminar de esperar una ventana que empezo antes del reinicio.
  flushPendingBursts: () => Promise<void>;
  getPendingBurstCount: () => number | Promise<number>;
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

    const pendingBursts = await deps.getPendingBurstCount();
    if (pendingBursts > 0) {
      deps.log(`Adelantando el reloj de ${pendingBursts} rafaga(s) pendiente(s) para que se drenen al volver...`);
    }
    // No se espera: es un UPDATE corto y, si fallara, la rafaga sigue guardada y se drena igual
    // cuando venza su ventana original. Nada de esto arranca turnos nuevos.
    deps.flushPendingBursts().catch((error) => deps.logError(`Error adelantando las rafagas pendientes en el apagado: ${error}`));

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
