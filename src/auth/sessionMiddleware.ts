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
  cookie: {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
});
