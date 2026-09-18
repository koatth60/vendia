import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { env } from "../config/env";

// Extracted from src/index.ts so the exact same middleware instance can also run on Socket.IO's
// handshake request (io.engine.use(sessionMiddleware)) - same cookie, same session store, no separate
// auth scheme to maintain for realtime connections.

// Fase 8, punto 5 del plan maestro (2026-09-15): las sesiones vivian en la memoria del proceso (el
// MemoryStore por omision de express-session). Cada reinicio deslogueaba a todos los duenos y
// empleados a la vez - 103 reinicios en lo que va del registro - y el propio express-session avisa que
// ese store pierde memoria y no esta pensado para produccion. Ahora viven en Postgres, en la tabla
// `session` (ver prisma/schema.prisma y la migracion fase8_session_store).
//
// Pool chico y aparte del de Prisma a proposito: el store hace una consulta corta por request, no
// necesita las 20 conexiones del pool de la aplicacion, y no tiene por que competir con ella por
// conexiones cuando hay carga.
const PgSession = connectPgSimple(session);
const sessionPool = new Pool({ connectionString: env.databaseUrl, max: 4 });

export const sessionMiddleware = session({
  store: new PgSession({
    pool: sessionPool,
    tableName: "session",
    // La tabla la crea la migracion de Prisma, no el store: asi el esquema queda versionado con el
    // resto y `prisma migrate` no la reporta como drift.
    createTableIfMissing: false,
    // Barrido de sesiones vencidas. Sin esto la tabla crece para siempre.
    pruneSessionInterval: 60 * 60,
  }),
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  // LA SESION SE RENUEVA SOLA MIENTRAS SE USA (2026-09-18). `maxAge` ya eran 30 dias, pero sin `rolling`
  // se contaban desde el login y nunca mas: el dia 30 la sesion se caia aunque la persona hubiera estado
  // usando el panel todos los dias. Con `rolling`, cada request que pasa por aca vuelve a poner el reloj
  // en 30 dias, asi que la unica forma de que se cierre es no entrar durante un mes seguido. Es lo que
  // hace falta para la aplicacion instalada: nadie vuelve a escribir su clave porque paso un mes desde
  // que la instalo.
  //
  // El costo es un UPDATE por request sobre la fila de la sesion; por eso `store.touch` en un store de
  // Postgres existe y por eso el pool de este archivo es aparte del de Prisma.
  rolling: true,
  cookie: {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
});
