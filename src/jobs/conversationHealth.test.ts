import { test } from "node:test";
import assert from "node:assert/strict";
import { findHealthIssues } from "./conversationHealth";

// Fase 0 del plan: hasta ahora el unico detector de fallos era una persona leyendo conversaciones. Cada
// caso de abajo es uno REAL de la auditoria del 14-15 de septiembre, escrito tal como quedo en la base.

const since = new Date("2026-09-15T03:00:00Z");
const at = (hhmmss: string) => new Date(`2026-09-15T${hhmmss}Z`);

function msg(role: "CUSTOMER" | "ASSISTANT", content: string, time: string, mediaType: string | null = null) {
  return { role, content, mediaType, createdAt: at(time) };
}

const sinDatos = { idNumber: null, deliveryPhone: null };

test('detecta "ya tengo la cedula" con la ficha vacia', () => {
  const found = findHealthIssues({
    conversationId: "c1",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("CUSTOMER", "Sebastián montealegre sotelo        CC: 1004074880", "03:02:41"),
      msg("ASSISTANT", "¡Gracias, Diana! 😊 Ya tengo el nombre y la cédula.", "03:02:45"),
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "DATO_NO_GUARDADO");
  assert.match(found[0].detail, /cedula/);
});

test("no se queja cuando el dato si quedo guardado", () => {
  const found = findHealthIssues({
    conversationId: "c1",
    since,
    customer: { idNumber: "1004074880", deliveryPhone: null },
    hasOrder: true,
    messages: [msg("ASSISTANT", "¡Gracias! Ya tengo el nombre y la cédula.", "03:02:45")],
  });
  assert.equal(found.length, 0);
});

test("detecta fotos prometidas que nunca salieron", () => {
  const found = findHealthIssues({
    conversationId: "c2",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("CUSTOMER", "Si", "03:01:00"),
      msg("ASSISTANT", "¡Claro que sí! 📸 Aquí te van las fotos del reloj.", "03:01:05"),
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "FOTO_PROMETIDA_SIN_ENVIAR");
});

test("no se queja si las fotos si salieron", () => {
  const found = findHealthIssues({
    conversationId: "c2",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("ASSISTANT", "[Foto de Serie 11 Mini]", "03:01:03", "IMAGE"),
      msg("ASSISTANT", "¡Claro que sí! 📸 Aquí te van las fotos del reloj.", "03:01:05"),
    ],
  });
  assert.equal(found.length, 0);
});

test("no confunde la foto de la guia con fotos del catalogo", () => {
  // La regresion del 15 de septiembre: una respuesta de envio correcta tomada por promesa incumplida.
  const found = findHealthIssues({
    conversationId: "c3",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("ASSISTANT", "te paso la foto de la guía apenas se realice el envío 📦", "03:15:50"),
    ],
  });
  assert.equal(found.length, 0);
});

test("detecta dos respuestas del bot en paralelo", () => {
  const found = findHealthIssues({
    conversationId: "c4",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("CUSTOMER", "Negro", "03:05:00"),
      msg("ASSISTANT", "¡Perfecto! Tenemos el Serie 11 Mini...", "03:05:05"),
      msg("ASSISTANT", "Ese modelo viene en una sola presentación...", "03:05:09"),
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "RESPUESTA_DUPLICADA");
});

test("detecta una venta cerrada que no quedo registrada", () => {
  const found = findHealthIssues({
    conversationId: "c5",
    since,
    customer: sinDatos,
    hasOrder: false,
    messages: [msg("ASSISTANT", "¡Listo! Te dejo el resumen: Producto... Total a pagar: $154.000", "03:33:44")],
  });
  assert.ok(found.some((f) => f.kind === "VENTA_SIN_PEDIDO"));
});

test("detecta fugas de estado interno y nombres de herramienta", () => {
  const conFuga = findHealthIssues({
    conversationId: "c6",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("ASSISTANT", "tu pedido aún no aparece registrado en el sistema", "03:27:11"),
      msg("ASSISTANT", "Aquí van las fotos 📸 [send_product_media: Combo Pareja]", "03:28:00", null),
    ],
  });
  const tipos = conFuga.map((f) => f.kind);
  assert.equal(tipos.filter((t) => t === "FUGA_INTERNA").length, 2);
});

test("ignora lo que pasó antes de la ventana de revision", () => {
  const found = findHealthIssues({
    conversationId: "c7",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [msg("ASSISTANT", "Aquí te van las fotos del reloj 📸", "02:00:00")],
  });
  assert.equal(found.length, 0);
});
