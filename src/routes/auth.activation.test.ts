import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { authRouter } from "./auth";

// El alta dejo de exigir clave de activacion el 2026-09-17: quien la tiene entra activado, quien no,
// entra igual y espera a que Zaqi lo active. Estas pruebas levantan el router real contra la base
// real, porque lo que hay que probar es justo lo que decide el handler (que active salga false, que
// la clave mala no cree nada, que un inactivo SI pueda entrar), no una copia de su logica.

let server: Server;
let baseUrl: string;
const createdBusinessIds: string[] = [];
const createdKeyIds: string[] = [];

function api(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false }));
  app.use("/auth", authRouter);

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no se pudo abrir el puerto");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: { in: createdBusinessIds } } });
  await prisma.activationKey.deleteMany({ where: { id: { in: createdKeyIds } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("sin clave de activacion la cuenta se crea, pero inactiva", async () => {
  const email = `sin-clave-${randomUUID()}@example.com`;
  const res = await api("/auth/signup", {
    businessName: "Negocio sin clave",
    email,
    password: "unaClaveLarga123",
    contactPhone: "+573001112233",
    planTier: "EMPRENDEDOR",
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  createdBusinessIds.push(body.id);

  assert.equal(body.active, false);
  // El plan que pidio queda registrado como propuesta: es lo que Zaqi confirma al activar.
  assert.equal(body.planTier, "EMPRENDEDOR");

  const stored = await prisma.business.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(stored.active, false);
});

test("una clave que no existe no crea la cuenta a medias", async () => {
  const email = `clave-mala-${randomUUID()}@example.com`;
  const res = await api("/auth/signup", {
    businessName: "Negocio con clave mala",
    email,
    password: "unaClaveLarga123",
    activationKey: `NO-EXISTE-${randomUUID()}`,
  });

  assert.equal(res.status, 400);
  // Lo que importa no es el mensaje: es que no quede una cuenta suelta con esa direccion.
  const stored = await prisma.business.findUnique({ where: { email } });
  assert.equal(stored, null);
});

test("con una clave valida la cuenta entra activada y la clave queda usada", async () => {
  const key = await prisma.activationKey.create({
    data: { code: `TEST-${randomUUID()}`.toUpperCase(), planTier: "NEGOCIO" },
  });
  createdKeyIds.push(key.id);

  const res = await api("/auth/signup", {
    businessName: "Negocio con clave",
    email: `con-clave-${randomUUID()}@example.com`,
    password: "unaClaveLarga123",
    // Pide BASICO a proposito: manda el plan de la clave, que es el que Zaqi ya cobro.
    planTier: "BASICO",
    activationKey: key.code,
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  createdBusinessIds.push(body.id);

  assert.equal(body.active, true);
  assert.equal(body.planTier, "NEGOCIO");

  const usedKey = await prisma.activationKey.findUniqueOrThrow({ where: { id: key.id } });
  assert.equal(usedKey.used, true);
  assert.equal(usedKey.usedByBusinessId, body.id);
});

test("una cuenta sin activar entra a su panel, con la contrasena correcta", async () => {
  const email = `login-inactivo-${randomUUID()}@example.com`;
  const password = "unaClaveLarga123";

  const signup = await api("/auth/signup", { businessName: "Negocio en espera", email, password });
  assert.equal(signup.status, 201);
  createdBusinessIds.push((await signup.json()).id);

  const login = await api("/auth/login", { email, password });
  // Antes devolvia 401 "Credenciales inválidas", que era mentira: la contrasena si era la suya.
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.equal(body.active, false);
});

test("la contrasena equivocada sigue sin entrar, activa o no la cuenta", async () => {
  const email = `login-malo-${randomUUID()}@example.com`;
  const signup = await api("/auth/signup", {
    businessName: "Negocio en espera 2",
    email,
    password: "unaClaveLarga123",
  });
  assert.equal(signup.status, 201);
  createdBusinessIds.push((await signup.json()).id);

  const login = await api("/auth/login", { email, password: "otraCosa999" });
  assert.equal(login.status, 401);
});
