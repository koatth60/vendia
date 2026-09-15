// Fase 11 del plan maestro (2026-09-15), causa raiz C5: todo lo que era "Colombia" cableado en el codigo
// vive aca, una entrada por pais, y el negocio elige cual con Business.countryCode.
//
// Antes de esta fase habia cuatro lugares distintos que asumian Colombia sin decirlo: la lista de zonas
// sin cedula (orders/checkoutState.ts), el formateo de precios en es-CO (catalog/products.ts), la
// heuristica que separaba cedula de celular por "10 digitos que arrancan en 3" (ai/agent.ts) y el patron
// de via colombiana (orders/checkoutState.ts). Un celular mexicano caia en la rama de cedula y se
// guardaba como documento; una direccion con colonia y codigo postal nunca daba por despachable.
//
// Regla de este archivo: las expresiones regulares de CO son las MISMAS que ya existian, movidas tal
// cual - no se "mejoraron" de paso. Las de MX son su contraparte, escritas una por una contra las de CO.
// Cualquier pais nuevo se agrega aca y en ninguna otra parte.

import type { FieldKey } from "../orders/checkoutState";

export type CountryCode = "CO" | "MX";

/** Que es una corrida de digitos SIN etiqueta al lado, mirando solo su forma. */
export type DigitShape = "phone" | "document" | null;

export interface CountryConfig {
  code: CountryCode;
  /** Como se muestra en el panel. */
  label: string;
  defaultCurrency: string;
  defaultTimezone: string;
  /** Para Intl.NumberFormat / toLocaleDateString. */
  locale: string;
  /** Como se llama el documento de identidad aca ("cedula", "identificacion"), en boca del cliente. */
  documentLabel: string;
  /** Si por defecto este pais pide documento de identidad para despachar. */
  requiresIdDocumentByDefault: boolean;
  /** Etiquetas escritas junto a un numero que lo declaran documento o telefono. Ganan sobre la forma. */
  idLabelPattern: RegExp;
  phoneLabelPattern: RegExp;
  /** Como se identifica una via en una direccion de este pais, y el detalle de llegada. */
  viaPattern: RegExp;
  detallePattern: RegExp;
  /** Las mismas palabras de via, pero para ubicar la direccion dentro de una respuesta combinada. */
  streetWordPattern: RegExp;
  // Como suena, en ESTE pais, que el bot haya pedido el documento, el telefono, o los datos de entrega
  // enteros. Se leen contra el turno anterior del propio bot (ver agent.ts): cuando el cliente contesta
  // un numero pelado, sin etiqueta, la pregunta es mas confiable que la forma para decidir que es.
  askIdPattern: RegExp;
  askPhonePattern: RegExp;
  askDeliveryDataPattern: RegExp;
  pedir: Record<FieldKey, string>;
  classifyDigits(digits: string): DigitShape;
}

// Colombia: todo movido literal desde donde estaba.
//  - viaPattern / detallePattern: orders/checkoutState.ts (VIA_PATTERN / DETALLE_PATTERN).
//  - streetWordPattern: ai/agent.ts (STREET_WORD_PATTERN).
//  - idLabelPattern / phoneLabelPattern: ai/agent.ts (ID_LABEL_PATTERN / PHONE_LABEL_PATTERN).
//  - classifyDigits: la heuristica de ai/agent.ts, "celular = 10 digitos que arrancan en 3;
//    cedula = 6 a 10 digitos que no arrancan en 3".
const COLOMBIA: CountryConfig = {
  code: "CO",
  label: "Colombia",
  defaultCurrency: "COP",
  defaultTimezone: "America/Bogota",
  locale: "es-CO",
  documentLabel: "número de cédula",
  requiresIdDocumentByDefault: true,
  idLabelPattern: /\b(c\.?c\.?|c[eé]dula|documento|identificaci[oó]n|nit|ti)\b/i,
  phoneLabelPattern: /\b(celular|cel|tel[eé]fono|tel|whatsapp|wpp|movil|m[oó]vil|contacto)\b/i,
  viaPattern:
    /(^|\s)(cra?|carrera|cll?|calle|kra?|av|avenida|diag(onal)?|trans(versal)?|tv|dg|mz|manzana|lote|lt|autopista|v[ií]a|vereda|circular)\.?\s*#?\s*\d/i,
  detallePattern: /\b(barrio|conjunto|torre|apto|apartamento|casa|piso|bloque|interior|oficina|local|urbanizaci[oó]n)\b/i,
  streetWordPattern:
    /\b(cra|carrera|cll|calle|kr|kra|av|avenida|diagonal|diag|transversal|trans|tv|manzana|mz|lote|lt|autopista|via|vereda|conjunto|torre|apto|apartamento|casa|piso|barrio|bloque|interior|urbanizaci[oó]n)\b/i,
  askIdPattern: /\b(numero de (identificaci[oó]n|c[eé]dula)|tu c[eé]dula|c[eé]dula,? por favor)\b/i,
  askPhonePattern: /\b(numero de celular|tu celular|celular de contacto|celular,? por favor)\b/i,
  askDeliveryDataPattern:
    /\b(datos de (entrega|env[ií]o)|nombre y apellido|nombre completo)\b|\bc[eé]dula\b|\bcelular\b|\bidentificaci[oó]n\b/i,
  pedir: {
    productos: "qué producto quieres y cuántas unidades",
    variante: "el color",
    nombre: "tu nombre y apellido",
    documento: "tu número de cédula",
    telefono: "tu celular de contacto",
    ciudad: "tu ciudad",
    direccion: "tu barrio, la dirección exacta, y si es casa o apartamento con piso",
    formaPago: "cómo prefieres pagar",
  },
  classifyDigits(digits) {
    if (digits.length === 10 && digits.startsWith("3")) return "phone";
    if (digits.length >= 6 && digits.length <= 10) return "document";
    return null;
  },
};

// Mexico. Contraparte de cada patron de CO, no una copia:
//  - El celular mexicano son 10 digitos SIN prefijo fijo (55, 33, 81, 998... son lada, no una marca como
//    el 3 colombiano). Por eso 10 digitos = telefono y punto: es justo el caso que hoy se guarda mal.
//  - El documento mexicano de uso corriente (CURP, RFC, INE) es alfanumerico, no una corrida de digitos,
//    asi que ninguna forma numerica sola se clasifica como documento: sin etiqueta explicita, null. Y la
//    paqueteria mexicana no lo pide para despachar, de ahi requiresIdDocumentByDefault:false.
//  - La direccion mexicana se identifica por calle + numero exterior y se completa con colonia y C.P.,
//    no con barrio/apto.
const MEXICO: CountryConfig = {
  code: "MX",
  label: "México",
  defaultCurrency: "MXN",
  defaultTimezone: "America/Mexico_City",
  locale: "es-MX",
  documentLabel: "identificación",
  requiresIdDocumentByDefault: false,
  idLabelPattern: /\b(ine|curp|rfc|identificaci[oó]n|credencial|documento|pasaporte)\b/i,
  phoneLabelPattern: /\b(celular|cel|tel[eé]fono|tel|whatsapp|wpp|movil|m[oó]vil|contacto|lada)\b/i,
  viaPattern:
    /(^|\s)(calle|c\.|av|avenida|blvd|boulevard|bulevar|calz|calzada|priv|privada|cerrada|and(ador)?|prol(ongaci[oó]n)?|carr(etera)?|eje|circuito|retorno)\.?\s*#?\s*[\wÁÉÍÓÚÑáéíóúñ]/i,
  detallePattern: /\b(col(onia)?|fracc(ionamiento)?|unidad|manzana|mz|lote|lt|interior|int|depto|departamento|edificio|piso|c\.?p\.?|c[oó]digo postal)\b/i,
  streetWordPattern:
    /\b(calle|av|avenida|blvd|boulevard|bulevar|calzada|calz|privada|priv|cerrada|andador|prolongacion|carretera|carr|eje|circuito|retorno|colonia|col|fraccionamiento|fracc|unidad|manzana|mz|lote|lt|interior|int|depto|departamento|edificio|piso)\b/i,
  askIdPattern: /\b(tu (ine|curp|rfc|identificaci[oó]n)|numero de identificaci[oó]n|identificaci[oó]n,? por favor)\b/i,
  askPhonePattern: /\b(numero de (tel[eé]fono|celular)|tu (tel[eé]fono|celular)|tel[eé]fono de contacto|tel[eé]fono,? por favor)\b/i,
  askDeliveryDataPattern:
    /\b(datos de (entrega|env[ií]o)|nombre y apellido|nombre completo)\b|\bine\b|\bcurp\b|\btel[eé]fono\b|\bcelular\b|\bidentificaci[oó]n\b/i,
  pedir: {
    productos: "qué producto quieres y cuántas unidades",
    variante: "el color",
    nombre: "tu nombre y apellido",
    documento: "tu identificación",
    telefono: "tu teléfono de contacto",
    ciudad: "tu ciudad y estado",
    direccion: "tu calle y número, la colonia y el código postal",
    formaPago: "cómo prefieres pagar",
  },
  classifyDigits(digits) {
    if (digits.length === 10) return "phone";
    return null;
  },
};

export const COUNTRIES: Record<CountryCode, CountryConfig> = { CO: COLOMBIA, MX: MEXICO };

export const COUNTRY_CODES: CountryCode[] = ["CO", "MX"];

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === "string" && value in COUNTRIES;
}

// Un countryCode invalido en la base (dato viejo, typo cargado a mano) NO puede tumbar una conversacion:
// cae en Colombia, que es lo que todo negocio existente ya era antes de esta fase.
export function countryConfig(code: string | null | undefined): CountryConfig {
  return isCountryCode(code) ? COUNTRIES[code] : COLOMBIA;
}
