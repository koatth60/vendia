// Estado de pedido: la fuente de verdad sobre QUE se sabe y QUE falta para poder despachar.
//
// Por que existe (2026-09-15): hoy el modelo lleva la cuenta de memoria, releyendo la conversacion en
// cada turno. De ahi salen los dos sintomas que mas se ven - la preguntaderaz (a una clienta se le pidio
// el barrio cinco veces en veinte minutos, y el apellido recien despues del resumen) y las afirmaciones
// falsas ("ya tengo el nombre y la cédula" con los dos campos vacios en la base). Son el mismo defecto:
// un recuerdo no es un estado. Esto se calcula de la base, asi que no puede desincronizarse.
//
// Fuentes de los campos obligatorios:
//  - Las instrucciones configuradas del negocio, que son la verdad operativa.
//  - Lo que una transportadora pide para emitir la guia: nombre completo y contacto del destinatario,
//    direccion exacta con referencias, y del paquete su contenido, peso y valor declarado.
//    Ver https://coordinadora.com/blog/como-generar-guias-de-envio/ - ese articulo es material
//    divulgativo, no una norma, y NO menciona la cedula, asi que se usa solo para sumar campos de guia,
//    nunca para reemplazar lo que el negocio ya exige.
//
// Fase 11 del plan maestro (2026-09-15): lo que este archivo sabia de Colombia ya no vive aca. La forma
// de una direccion y las palabras con que se pide cada dato salen de src/config/countries.ts segun el
// pais del negocio; QUE zonas no piden documento sale del propio negocio (BusinessRequirements), no de
// una constante del producto. Este archivo quedo puro: recibe hechos y reglas, devuelve estado.

import { COUNTRIES, type CountryCode } from "../config/countries";

export type { CountryCode };

export type FieldKey =
  | "productos"
  | "variante"
  | "nombre"
  | "documento"
  | "telefono"
  | "ciudad"
  | "direccion"
  | "formaPago";

export interface CheckoutFacts {
  /** Pais del negocio, de Business.countryCode - decide validadores, etiquetas y como se pide cada dato. */
  pais: CountryCode;
  productos: { nombre: string; cantidad: number; variante: string | null }[];
  /** true si alguno de los productos pedidos tiene variantes y todavia no se eligio cual. */
  varianteFaltante: boolean;
  nombre: string | null;
  documento: string | null;
  telefono: string | null;
  ciudad: string | null;
  direccion: string | null;
  formaPago: string | null;
  /** Zona de envio ya resuelta contra las tarifas del negocio ("Bogota", "Soacha", "Nacional", ...). */
  zonaEnvio: string | null;
}

export interface FieldState {
  key: FieldKey;
  /** Como pedirselo al cliente, en sus palabras. Null cuando ya esta resuelto. */
  pedir: string | null;
  valor: string | null;
  requerido: boolean;
  ok: boolean;
}

/** Lo que el NEGOCIO decidio sobre el documento de identidad, leido de Business (no del pais). */
export interface BusinessRequirements {
  /** Business.requiresIdDocument. false = este negocio nunca pide documento, sea cual sea la zona. */
  requiresIdDocument: boolean;
  /** Business.idDocumentExemptZones: zonas donde NO se pide, comparadas sin tildes ni mayusculas. */
  idDocumentExemptZones: string[];
}

export interface CheckoutState {
  pais: CountryCode;
  campos: FieldState[];
  /** Lo que hay que pedirle al cliente ahora, ya resuelto: el modelo solo tiene que redactarlo. */
  faltan: string[];
  completo: boolean;
}

// Un nombre de guia necesita nombre Y apellido. "Diana" sola no alcanza para despachar, y es exactamente
// el caso que obligo al dueno a pedir el apellido a mano despues de haber mostrado el resumen.
export function tieneNombreCompleto(nombre: string | null): boolean {
  if (!nombre) return false;
  return nombre.trim().split(/\s+/).filter((w) => w.length >= 2).length >= 2;
}

// Una direccion sirve para despachar cuando trae, ademas de la via, el detalle de llegada (barrio, casa o
// apartamento, piso en Colombia; colonia y codigo postal en Mexico). "Cra 17 # 23-03" sin barrio deja al
// mensajero a medio camino, igual que "Av. Insurgentes 300" sin colonia.
// Los dos patrones son los del pais (countries.ts): los de CO son exactamente los que estaban aca antes
// de la Fase 11, movidos sin tocarlos.
export function direccionEsDespachable(direccion: string | null, pais: CountryCode): boolean {
  if (!direccion) return false;
  const reglas = COUNTRIES[pais];
  return reglas.viaPattern.test(direccion) && /\d/.test(direccion) && reglas.detallePattern.test(direccion);
}

// El documento se pide cuando el NEGOCIO lo exige y la zona resuelta no esta entre sus exentas. Antes de
// la Fase 11 la lista de exentas era ["bogota","soacha"] cableada aca para todos los negocios del
// producto; la migracion la copio a cada negocio colombiano que ya existia.
function documentoRequerido(reglas: BusinessRequirements, zonaEnvio: string | null): boolean {
  if (!reglas.requiresIdDocument) return false;
  if (!zonaEnvio) return false; // Sin zona resuelta todavia no se sabe: no se pide de mas.
  const zona = normalizeZona(zonaEnvio);
  return !reglas.idDocumentExemptZones.some((z) => zona.includes(normalizeZona(z)));
}

function normalizeZona(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function computeCheckoutState(facts: CheckoutFacts, negocio: BusinessRequirements): CheckoutState {
  const pedir = COUNTRIES[facts.pais].pedir;
  const docRequerido = documentoRequerido(negocio, facts.zonaEnvio);

  const campos: FieldState[] = [
    {
      key: "productos",
      requerido: true,
      valor: facts.productos.length > 0 ? facts.productos.map((p) => `${p.cantidad}x ${p.nombre}`).join(", ") : null,
      ok: facts.productos.length > 0,
      pedir: null,
    },
    {
      key: "variante",
      requerido: facts.varianteFaltante,
      valor: facts.productos.map((p) => p.variante).filter(Boolean).join(", ") || null,
      ok: !facts.varianteFaltante,
      pedir: null,
    },
    {
      key: "nombre",
      requerido: true,
      valor: facts.nombre,
      ok: tieneNombreCompleto(facts.nombre),
      pedir: null,
    },
    {
      key: "documento",
      requerido: docRequerido,
      valor: facts.documento,
      ok: !docRequerido || Boolean(facts.documento),
      pedir: null,
    },
    { key: "telefono", requerido: true, valor: facts.telefono, ok: Boolean(facts.telefono), pedir: null },
    { key: "ciudad", requerido: true, valor: facts.ciudad, ok: Boolean(facts.ciudad), pedir: null },
    {
      key: "direccion",
      requerido: true,
      valor: facts.direccion,
      ok: direccionEsDespachable(facts.direccion, facts.pais),
      pedir: null,
    },
    { key: "formaPago", requerido: true, valor: facts.formaPago, ok: Boolean(facts.formaPago), pedir: null },
  ];

  for (const campo of campos) {
    campo.pedir = campo.requerido && !campo.ok ? pedir[campo.key] : null;
  }

  const faltan = campos.map((c) => c.pedir).filter((p): p is string => p !== null);
  return { pais: facts.pais, campos, faltan, completo: faltan.length === 0 };
}

// Para el paquete, la transportadora ademas pide contenido, peso y valor declarado. Contenido y valor
// salen solos de los items y del total; el PESO no existe en el catalogo (Product no tiene ese campo),
// asi que hoy no se puede emitir una guia completa sin ponerlo a mano. Se reporta como hueco de datos en
// vez de inventarlo - ver el plan de estabilizacion.
export function datosDePaqueteFaltantes(): string[] {
  return ["peso del producto (no existe en el catálogo)"];
}
