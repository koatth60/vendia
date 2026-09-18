import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { hashPassword } from "./service";
import { normalizarCorreo } from "./email";
import { verificarCredencialDePlataforma, hayCredencialDePlataforma } from "./platformPassword";
import {
  recordPlatformAction,
  estaBloqueadaPorIntentos,
  intentosFallidosRecientes,
  INTENTOS_ANTES_DE_BLOQUEAR,
  VENTANA_INTENTOS_MS,
} from "./platformAudit";

// E29 (2026-09-18). Una prueba por punto, que es lo que pide la etapa.
//
// Lo que se cierra aca: la consola de plataforma comparaba `password !== env.platformAdmin.password`
// -- texto plano en el entorno y una comparacion que corta en el primer caracter distinto -- sin limite
// de tasa, sin bloqueo por intentos y sin dejar rastro de nada.

const emailOriginal = env.platformAdmin.email;
const passOriginal = env.platformAdmin.password;
const hashOriginal = env.platformAdmin.passwordHash;

beforeEach(() => {
  env.platformAdmin.email = "zaqi@ejemplo.com";
  env.platformAdmin.password = "";
  env.platformAdmin.passwordHash = "";
});

afterEach(() => {
  env.platformAdmin.email = emailOriginal;
  env.platformAdmin.password = passOriginal;
  env.platformAdmin.passwordHash = hashOriginal;
});

test("con el hash puesto, la contrasena de texto plano del entorno se ignora por completo", async () => {
  env.platformAdmin.passwordHash = await hashPassword("la-correcta");
  env.platformAdmin.password = "la-vieja-en-texto-plano";

  assert.equal(await verificarCredencialDePlataforma("zaqi@ejemplo.com", "la-correcta"), true);
  // Este es el punto entero de la etapa: una vez migrado, la variable vieja deja de ser una llave. Si
  // esto pasara, borrarla del entorno no cambiaria nada y la migracion seria decorativa.
  assert.equal(await verificarCredencialDePlataforma("zaqi@ejemplo.com", "la-vieja-en-texto-plano"), false);
});

test("sin hash, la de texto plano sigue funcionando: migrar no puede dejar al dueno afuera de su consola", async () => {
  env.platformAdmin.password = "la-de-siempre";

  assert.equal(await verificarCredencialDePlataforma("zaqi@ejemplo.com", "la-de-siempre"), true);
  assert.equal(await verificarCredencialDePlataforma("zaqi@ejemplo.com", "otra"), false);
});

test("el correo de la consola no distingue mayusculas ni espacios, la contrasena si", async () => {
  env.platformAdmin.passwordHash = await hashPassword("la-correcta");

  assert.equal(await verificarCredencialDePlataforma("  ZAQI@Ejemplo.COM ", "la-correcta"), true);
  assert.equal(await verificarCredencialDePlataforma("zaqi@ejemplo.com", "LA-CORRECTA"), false);
});

test("sin ninguna credencial configurada no entra nadie, ni con la cadena vacia", async () => {
  env.platformAdmin.email = "";
  env.platformAdmin.password = "";
  env.platformAdmin.passwordHash = "";

  assert.equal(hayCredencialDePlataforma(), false);
  assert.equal(await verificarCredencialDePlataforma("", ""), false);
  assert.equal(await verificarCredencialDePlataforma("zaqi@ejemplo.com", ""), false);
});

test("un cuerpo sin strings no rompe ni entra", async () => {
  env.platformAdmin.passwordHash = await hashPassword("la-correcta");

  assert.equal(await verificarCredencialDePlataforma(undefined, undefined), false);
  assert.equal(await verificarCredencialDePlataforma({ toString: () => "zaqi@ejemplo.com" }, ["la-correcta"]), false);
});

test("el bloqueo por intentos se cuenta por IP y se lee de la base, no de memoria", async () => {
  const ip = `10.0.0.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`;
  const otraIp = `otra-${randomUUID()}`;

  assert.equal(await estaBloqueadaPorIntentos(ip), false);

  for (let i = 0; i < INTENTOS_ANTES_DE_BLOQUEAR - 1; i++) {
    await recordPlatformAction({ action: "LOGIN_FAILED", actorEmail: "quien@sea.com", ip });
  }
  assert.equal(await estaBloqueadaPorIntentos(ip), false, "uno menos que el limite todavia no bloquea");

  await recordPlatformAction({ action: "LOGIN_FAILED", actorEmail: "quien@sea.com", ip });
  assert.equal(await estaBloqueadaPorIntentos(ip), true);

  // El bloqueo es de esa IP y de nadie mas: si bloqueara a todos, diez intentos de un desconocido
  // dejarian al dueno afuera de su propia consola, que es como un limite se convierte en el ataque.
  assert.equal(await estaBloqueadaPorIntentos(otraIp), false);
  assert.equal(await estaBloqueadaPorIntentos(null), false, "sin IP no se bloquea a ciegas");
});

test("los intentos viejos no cuentan: el bloqueo se levanta solo al vencer la ventana", async () => {
  const ip = `vieja-${randomUUID()}`;
  const haceRato = new Date(Date.now() - VENTANA_INTENTOS_MS - 60_000);

  for (let i = 0; i < INTENTOS_ANTES_DE_BLOQUEAR + 5; i++) {
    await prisma.platformAuditLog.create({
      data: { action: "LOGIN_FAILED", ip, createdAt: haceRato },
    });
  }

  assert.equal(await intentosFallidosRecientes(ip), 0);
  assert.equal(await estaBloqueadaPorIntentos(ip), false);
});

test("solo los fallidos cuentan para el bloqueo: entrar bien no acerca a nadie al limite", async () => {
  const ip = `mixta-${randomUUID()}`;
  for (let i = 0; i < INTENTOS_ANTES_DE_BLOQUEAR + 3; i++) {
    await recordPlatformAction({ action: "LOGIN_OK", actorEmail: "zaqi@ejemplo.com", ip });
  }
  assert.equal(await estaBloqueadaPorIntentos(ip), false);
});

test("la auditoria guarda el correo tal como se intento, exista o no la cuenta", async () => {
  const ip = `auditoria-${randomUUID()}`;
  await recordPlatformAction({ action: "LOGIN_FAILED", actorEmail: "intruso@ejemplo.com", ip, detail: "prueba" });

  const fila = await prisma.platformAuditLog.findFirstOrThrow({ where: { ip } });
  assert.equal(fila.action, "LOGIN_FAILED");
  assert.equal(fila.actorEmail, "intruso@ejemplo.com");
  assert.equal(fila.detail, "prueba");
});

test("normalizarCorreo baja mayusculas y saca espacios, y no toca nada mas", () => {
  assert.equal(normalizarCorreo("  Milena@Gmail.COM "), "milena@gmail.com");
  // Los puntos de Gmail y el +etiqueta son direcciones distintas para otros proveedores: sacarlos seria
  // decidir por el cliente cual es su correo.
  assert.equal(normalizarCorreo("mi.lena+tienda@gmail.com"), "mi.lena+tienda@gmail.com");
  assert.equal(normalizarCorreo(undefined), "");
  assert.equal(normalizarCorreo(null), "");
});

test("la base no deja existir dos cuentas que solo difieren en mayusculas", async () => {
  const sufijo = randomUUID();
  const passwordHash = await hashPassword("x");
  const creado = await prisma.business.create({
    data: { name: "Uno", email: `mila-${sufijo}@ejemplo.com`, passwordHash },
  });

  try {
    // Esta es LA garantia de la etapa, y esta en el indice unico sobre lower("email"), no en el helper:
    // aunque una ruta futura se olvide de normalizar, la fila no entra.
    await assert.rejects(
      prisma.business.create({ data: { name: "Dos", email: `MILA-${sufijo}@Ejemplo.com`, passwordHash } }),
      "dos negocios con el mismo correo en distinta caja no pueden coexistir",
    );
  } finally {
    await prisma.business.delete({ where: { id: creado.id } });
  }
});

test("un TeamMember tampoco puede repetir el correo de otro en distinta caja", async () => {
  const sufijo = randomUUID();
  const passwordHash = await hashPassword("x");
  const negocio = await prisma.business.create({
    data: { name: "Con equipo", email: `duena-${sufijo}@ejemplo.com`, passwordHash },
  });

  try {
    await prisma.teamMember.create({
      data: { businessId: negocio.id, email: `emp-${sufijo}@ejemplo.com`, name: "Emp", passwordHash },
    });
    await assert.rejects(
      prisma.teamMember.create({
        data: { businessId: negocio.id, email: `EMP-${sufijo}@Ejemplo.com`, name: "Emp2", passwordHash },
      }),
    );
  } finally {
    await prisma.business.delete({ where: { id: negocio.id } });
  }
});
