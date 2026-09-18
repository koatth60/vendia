// Fase 7 del plan maestro (2026-09-15): hasta esa fase esta config no estaba versionada, asi que la
// suposicion "pm2 corre esto como un solo proceso fork" vivia solo en un comentario
// (src/routes/whatsapp.ts, cerca de conversationLocks).
//
// E07 de ONIX-PLAN.md (2026-09-17): esa suposicion DEJO DE SER LA GARANTIA. La exclusion por
// conversacion la da ahora un lock consultivo de Postgres (src/db/conversationLock.ts), que funciona
// entre procesos.
//
// E23 (2026-09-18): DOS PROCESOS SOBRE EL MISMO CODIGO.
//
//   web     - HTTP, WebSocket y el webhook de Meta. El webhook solo ENCOLA (E20): no manda nada.
//   worker  - el consumidor de la cola de entrada y todos los jobs. Todo lo que sale hacia un cliente
//             o hacia la duena sale de aca.
//
// Lo que cambia de verdad: escalar el HTTP ya no puede duplicar mensajes. `web` no tiene ningun job,
// asi que subir sus `instances` es seguro. Y lo que impide que dos `worker` hagan el mismo trabajo ya
// no es esta linea de configuracion: es la base (FOR UPDATE SKIP LOCKED en la cola de entrada, y el
// arriendo en JobLease para los jobs, ver src/jobs/arriendo.ts).
//
// `worker` queda en 1 instancia igual, porque hoy no hace falta mas -- pero ahora es una decision de
// capacidad, no la unica cosa que impide un desastre.
//
// El script se corre con `node --import tsx` sobre la fuente en TypeScript, no sobre `dist/` - `dist/`
// es salida de `npm run build` que produccion no usa (ver CLAUDE.md).
const comun = {
  script: "src/index.ts",
  interpreter: "node",
  interpreter_args: "--import tsx",
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  // El apagado ordenado (ver src/index.ts, SIGTERM/SIGINT) espera hasta 20s a que los turnos en
  // vuelo terminen antes de salir - kill_timeout tiene que darle a pm2 margen para no matarlo antes.
  kill_timeout: 25000,
};

module.exports = {
  apps: [
    {
      ...comun,
      // El nombre NO cambia: scripts/deploy.sh, scripts/rollback.sh y scripts/ci-deploy.sh lo usan, y
      // un rename silencioso dejaria al proceso viejo corriendo para siempre al lado del nuevo.
      name: "vendia",
      env: { NODE_ENV: "production", ONIX_ROL: "web" },
    },
    {
      ...comun,
      name: "vendia-worker",
      env: { NODE_ENV: "production", ONIX_ROL: "worker" },
    },
  ],
};
