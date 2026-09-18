// Fase 7 del plan maestro (2026-09-15): hasta esa fase esta config no estaba versionada, asi que la
// suposicion "pm2 corre esto como un solo proceso fork" vivia solo en un comentario
// (src/routes/whatsapp.ts, cerca de conversationLocks).
//
// E07 de ONIX-PLAN.md (2026-09-17): esa suposicion DEJO DE SER LA GARANTIA. La exclusion por
// conversacion la da ahora un lock consultivo de Postgres (src/db/conversationLock.ts), que funciona
// entre procesos; `instances: 1` + `exec_mode: "fork"` quedan como estan porque nada pide todavia mas
// de un proceso, no porque correr dos duplique respuestas. El dia que E23 separe `web` y `worker`,
// esto se cambia sin tener que arreglar nada mas antes.
//
// El script se corre con `node --import tsx` sobre la fuente en TypeScript, no sobre `dist/` - `dist/`
// es salida de `npm run build` que produccion no usa (ver CLAUDE.md).
module.exports = {
  apps: [
    {
      name: "vendia",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // El apagado ordenado (ver src/index.ts, SIGTERM/SIGINT) espera hasta 20s a que los turnos en
      // vuelo terminen antes de salir - kill_timeout tiene que darle a pm2 margen para no matarlo antes.
      kill_timeout: 25000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
