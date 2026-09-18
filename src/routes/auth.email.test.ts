import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { authRouter } from "./auth";
import { platformAdminRouter } from "./platformAdmin";
import { hashPassword } from "../auth/service";
import { INTENTOS_ANTES_DE_BLOQUEAR, recordPlatformAction } from "../auth/platformAudit";

// E29 (2026-09-18), la mitad de rutas. Lo de src/auth/platformSecurity.test.ts prueba las piezas; esto
// prueba que esten cableadas, que es donde se pierden los arreglos de seguridad.

let server: Server;
let base: string;
const creados: string[] = [];

/**
 * Sesion falsa con lo que usan estas rutas. `regenerate` y `save` de express-session son callbacks, no
 * promesas: si el doble no los llama, el login queda colgado para siempre en vez de fallar, y el test
 * moriria por timeout sin decir por que.
 */
function sesionFalsa() {
  const datos: Record<string, unknown> = {};
  return {
    ...datos,
    regenerate(cb: (e?: unknown) => void) {
      cb();
    },
    save(cb: (e?: unknown) => void) {
      cb();
    },
    destroy(cb: (e?: unknown) => void) {
      cb();
    },
  };
}

before(async () => {
  const app = express();
  // Igual que produccion (src/index.ts): sin esto req.ip es la IP del socket y no la del cliente detras
  // del proxy -- o sea que el bloqueo por intentos contaria a TODOS como la misma IP y diez fallos de un
  // desconocido dejarian al dueno afuera. El test tiene que correr con la misma configuracion.
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    // @ts-expect-error doble de sesion, mismo patron que el resto de las pruebas de rutas.
    req.session = sesionFalsa();
    next();
  });
  app.use("/auth", authRouter);
  app.use("/zaqi-admin/api", platformAdminRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  for (const id of creados) await prisma.business.delete({ where: { id } }).catch(() => undefined);
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * La auditoria de cambios es best-effort A PROPOSITO: se dispara en `res.on("finish")` sin esperarla,
 * para que registrar no demore la respuesta al administrador. O sea que la fila aparece "un rato
 * despues", y cuanto es ese rato depende de la carga de la maquina.
 *
 * Por eso se espera a la CONDICION y no a un tick. La primera version de esta prueba usaba un
 * setImmediate: pasaba sola y fallaba en la suite completa, que es la peor forma de fallar -- la que
 * hace pensar que el defecto esta en el codigo.
 *
 * (El contador del bloqueo por intentos es otra cosa y si se espera en la ruta: ver platformAdmin.ts.)
 */
async function esperarFila<T>(buscar: () => Promise<T | null>, queEsperaba: string): Promise<T> {
  for (let intento = 0; intento < 60; intento++) {
    const fila = await buscar();
    if (fila) return fila;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Nunca aparecio ${queEsperaba} (3 s)`);
}

async function post(ruta: string, cuerpo: unknown, ip?: string) {
  return fetch(`${base}${ruta}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify(cuerpo),
  });
}

test("el alta guarda el correo en minusculas y se puede entrar escribiendolo de cualquier forma", async () => {
  const correo = `Mila-${randomUUID()}@Ejemplo.COM`;
  const alta = await post("/auth/signup", { businessName: "Tienda Mila", email: correo, password: "clave-larga-1" });
  assert.equal(alta.status, 201, await alta.text());
  const business = await prisma.business.findFirstOrThrow({ where: { email: correo.toLowerCase() } });
  creados.push(business.id);
  assert.equal(business.email, correo.toLowerCase(), "se guarda normalizado, no como lo escribio");

  // El defecto que esto cierra: quien se registraba con mayusculas recibia "Credenciales inválidas" al
  // entrar en minusculas. La contrasena era correcta; el mensaje era mentira.
  const login = await post("/auth/login", { email: correo.toLowerCase(), password: "clave-larga-1" });
  assert.equal(login.status, 200);
  const otra = await post("/auth/login", { email: correo.toUpperCase(), password: "clave-larga-1" });
  assert.equal(otra.status, 200);
});

test("no se puede registrar un negocio con el correo de un miembro de equipo existente", async () => {
  const sufijo = randomUUID();
  const passwordHash = await hashPassword("clave-larga-1");
  const negocio = await prisma.business.create({
    data: { name: "Con equipo", email: `duena-${sufijo}@ejemplo.com`, passwordHash },
  });
  creados.push(negocio.id);
  const correoEmpleada = `empleada-${sufijo}@ejemplo.com`;
  await prisma.teamMember.create({
    data: { businessId: negocio.id, email: correoEmpleada, name: "Empleada", passwordHash },
  });

  // Antes esto CREABA el negocio. Despues, el login busca Business primero, encuentra el nuevo, y la
  // empleada no podia volver a entrar a su equipo nunca mas -- sin ningun mensaje que lo explicara.
  const alta = await post("/auth/signup", {
    businessName: "Negocio nuevo",
    email: correoEmpleada.toUpperCase(),
    password: "otra-clave-larga",
  });
  assert.equal(alta.status, 400);
  assert.equal(await prisma.business.count({ where: { email: correoEmpleada } }), 0);

  const entra = await post("/auth/login", { email: correoEmpleada, password: "clave-larga-1" });
  assert.equal(entra.status, 200, "la empleada sigue entrando a su equipo");
});

test("el login de la consola de plataforma no acepta la contrasena de texto plano cuando hay hash", async () => {
  const email = env.platformAdmin.email;
  const pass = env.platformAdmin.password;
  const hash = env.platformAdmin.passwordHash;
  env.platformAdmin.email = "zaqi@ejemplo.com";
  env.platformAdmin.password = "la-vieja";
  env.platformAdmin.passwordHash = await hashPassword("la-nueva");
  try {
    const ip = `9.9.9.${Math.floor(Math.random() * 200) + 1}`;
    const mala = await post("/zaqi-admin/api/login", { email: "zaqi@ejemplo.com", password: "la-vieja" }, ip);
    assert.equal(mala.status, 401);
    const buena = await post("/zaqi-admin/api/login", { email: "ZAQI@ejemplo.com", password: "la-nueva" }, ip);
    assert.equal(buena.status, 200);

    // Y el mismo agujero por la otra puerta: /auth/login tenia su propia copia de la comparacion.
    const porAuth = await post("/auth/login", { email: "zaqi@ejemplo.com", password: "la-vieja" });
    assert.equal(porAuth.status, 401);
  } finally {
    env.platformAdmin.email = email;
    env.platformAdmin.password = pass;
    env.platformAdmin.passwordHash = hash;
  }
});

test("con la IP ya bloqueada por intentos, ni la contrasena correcta entra", async () => {
  const email = env.platformAdmin.email;
  const hash = env.platformAdmin.passwordHash;
  const pass = env.platformAdmin.password;
  env.platformAdmin.email = "zaqi@ejemplo.com";
  env.platformAdmin.password = "";
  env.platformAdmin.passwordHash = await hashPassword("la-nueva");
  const ip = `7.7.7.${Math.floor(Math.random() * 200) + 1}-${randomUUID()}`;
  try {
    for (let i = 0; i < INTENTOS_ANTES_DE_BLOQUEAR; i++) {
      await recordPlatformAction({ action: "LOGIN_FAILED", ip });
    }

    const res = await post("/zaqi-admin/api/login", { email: "zaqi@ejemplo.com", password: "la-nueva" }, ip);
    assert.equal(res.status, 429, "la credencial correcta tampoco pasa mientras el bloqueo esta puesto");
    assert.ok(
      await prisma.platformAuditLog.findFirst({ where: { ip, action: "LOGIN_BLOCKED" } }),
      "el bloqueo tiene que quedar registrado, no solo devolver 429",
    );
  } finally {
    env.platformAdmin.email = email;
    env.platformAdmin.password = pass;
    env.platformAdmin.passwordHash = hash;
  }
});

test("todo cambio hecho desde la consola queda auditado, y el cuerpo NO se guarda", async () => {
  const passwordHash = await hashPassword("clave-larga-1");
  const negocio = await prisma.business.create({
    data: { name: "Auditado", email: `auditado-${randomUUID()}@ejemplo.com`, passwordHash },
  });
  creados.push(negocio.id);

  // App aparte con la sesion ya autenticada: lo que se prueba es el middleware de auditoria, no el login.
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    // @ts-expect-error doble de sesion autenticada como consola de plataforma.
    req.session = { ...sesionFalsa(), platformAdmin: true };
    next();
  });
  app.use("/zaqi-admin/api", platformAdminRouter);
  const srv = app.listen(0);
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const puerto = (srv.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${puerto}/zaqi-admin/api/businesses/${negocio.id}/spend-ceiling`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiSpendCeilingUsd: 42 }),
    });
    assert.equal(res.status, 200);

    const fila = await esperarFila(
      () => prisma.platformAuditLog.findFirst({ where: { businessId: negocio.id, action: "BUSINESS_UPDATED" } }),
      "la fila de auditoria del cambio",
    );
    assert.match(fila.detail ?? "", /^PATCH .*spend-ceiling$/);
    // El cuerpo NO viaja a la tabla, y esto no es un detalle: PATCH /businesses/:id/whatsapp recibe el
    // token de acceso de Meta. Una auditoria que copie el cuerpo es una tabla llena de credenciales.
    assert.doesNotMatch(fila.detail ?? "", /42/);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("una peticion que falla no ensucia la auditoria", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // @ts-expect-error doble de sesion autenticada.
    req.session = { ...sesionFalsa(), platformAdmin: true };
    next();
  });
  app.use("/zaqi-admin/api", platformAdminRouter);
  const srv = app.listen(0);
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const puerto = (srv.address() as { port: number }).port;
  const inexistente = `no-existe-${randomUUID()}`;

  try {
    const res = await fetch(`http://127.0.0.1:${puerto}/zaqi-admin/api/businesses/${inexistente}/spend-ceiling`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiSpendCeilingUsd: 42 }),
    });
    assert.equal(res.status, 404);
    // Aca no se puede esperar a que aparezca algo: lo que se prueba es que NO aparece. Se le da el mismo
    // margen que el positivo tarda en el peor caso, y recien despues se comprueba -- si no, la prueba
    // pasaria simplemente por mirar demasiado temprano.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await prisma.platformAuditLog.count({ where: { businessId: inexistente } }), 0);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
