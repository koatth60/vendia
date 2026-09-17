import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCheckoutState, tieneNombreCompleto, type CheckoutFacts } from "./checkoutState";

// El campo "nombre" del estado de pedido es lo que decide si el backstop de nombres de agent.ts puede
// correr (etapa 2 del estado de pedido, 2026-09-17). Estas pruebas fijan las dos propiedades de las que
// depende ese gate: cuando esta abierto, y que no dependa de que haya productos en el pedido.

const NEGOCIO = { requiresIdDocument: true, idDocumentExemptZones: ["bogota"] };

function facts(over: Partial<CheckoutFacts> = {}): CheckoutFacts {
  return {
    pais: "CO",
    productos: [],
    varianteFaltante: false,
    nombre: null,
    documento: null,
    telefono: null,
    ciudad: null,
    direccion: null,
    formaPago: null,
    zonaEnvio: null,
    ...over,
  };
}

function campoNombre(over: Partial<CheckoutFacts> = {}) {
  const estado = computeCheckoutState(facts(over), NEGOCIO);
  const campo = estado.campos.find((c) => c.key === "nombre");
  assert.ok(campo, "el estado siempre tiene el campo nombre");
  return campo;
}

test("sin nombre guardado, el campo esta abierto", () => {
  assert.equal(campoNombre().ok, false);
});

test("un nombre a medias deja el campo abierto: no alcanza para despachar", () => {
  assert.equal(campoNombre({ nombre: "Diana" }).ok, false);
  assert.equal(tieneNombreCompleto("Diana"), false);
});

test("con nombre y apellido el campo queda cerrado", () => {
  assert.equal(campoNombre({ nombre: "Diana Perez" }).ok, true);
  assert.equal(campoNombre({ nombre: "  Katiuska   Peña  " }).ok, true);
});

test("el campo nombre no depende de que haya productos", () => {
  // Es lo que hace que el gate del backstop valga tambien en el saludo, donde todavia no hay pedido:
  // "hola soy David" tiene que seguir guardandose igual que antes de esta etapa.
  const sinProductos = campoNombre({ nombre: null, productos: [] });
  const conProductos = campoNombre({ nombre: null, productos: [{ nombre: "Reloj", cantidad: 1, variante: null }] });
  assert.equal(sinProductos.ok, false);
  assert.equal(conProductos.ok, false);
  assert.equal(sinProductos.requerido, true);
});

test("nombre completo no cierra el pedido entero: los demas campos siguen faltando", () => {
  const estado = computeCheckoutState(facts({ nombre: "Diana Perez" }), NEGOCIO);
  assert.equal(estado.completo, false);
  assert.ok(estado.faltan.length > 0);
});
