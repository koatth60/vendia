// Fase 7 del plan maestro (2026-09-15): hasta esta fase esta config no estaba versionada, asi que la
// suposicion "pm2 corre esto como un solo proceso fork" vivia solo en un comentario
// (src/routes/whatsapp.ts, cerca de conversationLocks) - de esa suposicion depende que el lock por
// conversacion en memoria funcione. `instances: 1` + `exec_mode: "fork"` la dejan escrita en codigo: con
// mas de una instancia o modo cluster, dos procesos pueden tomar la misma conversacion a la vez sin que
// el lock se entere, porque el lock vive en la memoria de UN SOLO proceso.
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
