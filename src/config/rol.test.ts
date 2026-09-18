import { test } from "node:test";
import assert from "node:assert/strict";
import { parsearRol, correWeb, correTrabajos } from "./rol";

// E23 (2026-09-18). El rol decide QUE hace el proceso. Es la pieza que hace que levantar un segundo
// `web` no pueda mandarle dos mensajes a la misma clienta.

test("sin variable, el proceso hace las dos cosas: es el comportamiento de siempre", () => {
  assert.equal(parsearRol(undefined), "todo");
  assert.equal(parsearRol(""), "todo");
  assert.equal(parsearRol("   "), "todo");
  assert.ok(correWeb("todo"));
  assert.ok(correTrabajos("todo"));
});

test("web no corre jobs y worker no escucha en el puerto", () => {
  assert.ok(correWeb("web"));
  assert.equal(correTrabajos("web"), false, "un `web` con jobs es el mensaje duplicado que E23 viene a impedir");

  assert.ok(correTrabajos("worker"));
  assert.equal(correWeb("worker"), false, "dos procesos escuchando el mismo puerto es EADDRINUSE y reinicio eterno");
});

test("un valor escrito mal revienta al arrancar, no cae en el default", () => {
  // Si "Worker" cayera en "todo", el servidor terminaria con DOS procesos corriendo todos los jobs y
  // nadie se enteraria hasta que a un cliente le lleguen dos respuestas.
  assert.throws(() => parsearRol("Worker"), /ONIX_ROL invalido/);
  assert.throws(() => parsearRol("web,worker"), /ONIX_ROL invalido/);
  assert.throws(() => parsearRol("jobs"), /ONIX_ROL invalido/);
});
