import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { securityHeaders } from "./headers";

// Fase 8, punto 8 del plan maestro (2026-09-15). La prueba cuida las dos mitades: que las cabeceras
// esten, y que la politica no rompa lo que el panel necesita de verdad (el SDK de Facebook, las
// fuentes de Google, los medios prefirmados de S3, el WebSocket del mismo origen).

let server: import("node:http").Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(securityHeaders);
  app.get("/cualquiera", (_req, res) => res.json({ ok: true }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function headers(): Promise<Headers> {
  return (await fetch(`${baseUrl}/cualquiera`)).headers;
}

test("las cabeceras de seguridad viajan en cada respuesta", async () => {
  const h = await headers();
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(h.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  assert.ok(h.get("strict-transport-security"), "falta HSTS");
  assert.ok(h.get("content-security-policy"), "falta la CSP");
});

test("la CSP cierra lo que tiene que cerrar", async () => {
  const csp = (await headers()).get("content-security-policy")!;
  assert.equal(csp.includes("default-src 'self'"), true);
  assert.equal(csp.includes("object-src 'none'"), true);
  assert.equal(csp.includes("base-uri 'self'"), true);
  assert.equal(csp.includes("form-action 'self'"), true);
  assert.equal(csp.includes("frame-ancestors 'self'"), true);
});

test("la CSP no rompe lo que el panel necesita", async () => {
  const csp = (await headers()).get("content-security-policy")!;
  // El SDK de Embedded Signup: sin esto el boton de conectar WhatsApp deja de funcionar.
  assert.equal(csp.includes("https://connect.facebook.net"), true);
  assert.equal(csp.includes("https://fonts.googleapis.com"), true);
  assert.equal(csp.includes("https://fonts.gstatic.com"), true);
  // Las fotos y videos se sirven con URLs prefirmadas de S3, no desde nuestro dominio.
  assert.equal(csp.includes("https://*.amazonaws.com"), true);
  // El panel tiene bloques <script> embebidos y manejadores onclick= en el marcado. Sacarlos es un
  // trabajo aparte; mientras esten, esta linea es lo que mantiene el panel usable. Si alguna vez se
  // eliminan, esta prueba es el recordatorio de que se puede endurecer la politica.
  assert.equal(csp.includes("'unsafe-inline'"), true);
});
