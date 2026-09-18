import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { platformAdminRouter } from "./platformAdmin";

// Conectarle el WhatsApp a un negocio desde la consola de plataforma tiene que dejarlo activo.
// El 2026-09-18 no lo dejaba, y el negocio quedaba en un estado que no deberia existir: con numero
// y token puestos, con el cartel de "tu cuenta todavia no esta activada" en su panel, y con el bot
// mudo, porque el webhook descarta los mensajes entrantes de un negocio con active=false.
//
// Se levanta el router real: lo que hay que probar es lo que escribe el handler en la base, no una
// copia de su logica.

let server: Server;
let baseUrl: string;
let businessId: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false }));
  // La consola exige sesion de admin de plataforma; aca se da por sentada, porque lo que se prueba
  // es el efecto del handler y no el login.
  app.use((req, _res, next) => {
    req.session.platformAdmin = true;
    next();
  });
  app.use("/zaqi-admin", platformAdminRouter);

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no se pudo abrir el puerto");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const business = await prisma.business.create({
    data: {
      name: `Test activacion ${randomUUID()}`,
      email: `activacion-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: false,
    },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: businessId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("conectarle el WhatsApp desde la consola deja el negocio activo", async () => {
  const res = await fetch(`${baseUrl}/zaqi-admin/businesses/${businessId}/whatsapp`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phoneNumberId: `pn-${randomUUID()}`,
      phoneNumber: "+573001112233",
      accessToken: "token-de-prueba",
    }),
  });

  assert.equal(res.status, 200);

  const stored = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  assert.equal(stored.active, true, "un negocio con el numero conectado no puede quedar inactivo");
  assert.ok(stored.whatsappPhoneNumberId, "y el numero tiene que haber quedado escrito");
});
