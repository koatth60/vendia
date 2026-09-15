import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import type { AddressInfo } from "node:net";
import { env } from "../config/env";

// Fase 8, punto 5 del plan maestro (2026-09-15). Dos cosas distintas:
//   1. Sin SESSION_SECRET el proceso no arranca. Antes caia a "dev-secret-change-me", un valor que
//      esta en el repositorio: con el, cualquiera firma una cookie de sesion valida para cualquier
//      negocio.
//   2. La sesion sobrevive a un reinicio. Vivia en la memoria del proceso, asi que cada `pm2 restart`
//      deslogueaba a todo el mundo.

test("el proceso no arranca sin SESSION_SECRET", () => {
  const withoutSecret = { ...process.env };
  delete withoutSecret.SESSION_SECRET;

  assert.throws(
    () => {
      execFileSync(process.execPath, ["--import", "tsx", "-e", 'import("./src/config/env.ts")'], {
        env: { ...withoutSecret, DOTENV_CONFIG_PATH: "/dev/null/no-existe" },
        stdio: "pipe",
      });
    },
    (error: Error & { stderr?: Buffer }) => {
      // dotenv rellena SESSION_SECRET desde el .env local del desarrollador, por eso se lo apunta a un
      // archivo que no existe: lo que se prueba es la variable ausente, no el .env de esta maquina.
      assert.equal(String(error.stderr).includes("Missing required env var: SESSION_SECRET"), true);
      return true;
    }
  );
});

const pool = new Pool({ connectionString: env.databaseUrl, max: 2 });
after(async () => {
  await pool.end();
});

// Cada "proceso" de la prueba es un store nuevo sobre la misma tabla: es lo mismo que pasa despues de
// un reinicio, donde nada de la memoria anterior sobrevive.
function appWithFreshStore(): express.Express {
  const PgSession = connectPgSimple(session);
  const app = express();
  app.use(
    session({
      store: new PgSession({ pool, tableName: "session", createTableIfMissing: false }),
      secret: "secreto-de-prueba",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, maxAge: 60 * 1000 },
    })
  );
  app.get("/entrar", (req, res) => {
    (req.session as unknown as { businessId: string }).businessId = "negocio-de-prueba";
    res.json({ ok: true });
  });
  app.get("/quien-soy", (req, res) => {
    res.json({ businessId: (req.session as unknown as { businessId?: string }).businessId ?? null });
  });
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("la sesion sobrevive a un reinicio: vive en Postgres, no en la memoria del proceso", async () => {
  const antes = await listen(appWithFreshStore());
  const login = await fetch(`${antes.url}/entrar`);
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0];
  assert.ok(cookie, "la ruta tiene que dejar una cookie de sesion");

  // La sesion quedo escrita en Postgres, no solo en la memoria del proceso.
  const sid = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"))).slice(2).split(".")[0];
  const stored = await pool.query('SELECT sess FROM "session" WHERE sid = $1', [sid]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].sess.businessId, "negocio-de-prueba");

  // Se apaga el proceso y se levanta otro, con un store nuevo: la sesion sigue ahi.
  await antes.close();
  const despues = await listen(appWithFreshStore());
  try {
    const response = await fetch(`${despues.url}/quien-soy`, { headers: { cookie } });
    const body = (await response.json()) as { businessId: string | null };
    assert.equal(body.businessId, "negocio-de-prueba", "el reinicio no puede desloguear a nadie");
  } finally {
    await despues.close();
    await pool.query('DELETE FROM "session" WHERE sid = $1', [sid]);
  }
});
