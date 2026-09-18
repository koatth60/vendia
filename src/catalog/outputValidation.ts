import { prisma } from "../db/client";
import { formatPrice } from "../config/money";
import { tokenize } from "../search/text";
import { startsAsNumberedItem, stripPresentationDecorations } from "./presenter";
import { canonicalColors } from "./attributeTaxonomy";
import { getAgreedPrices } from "../orders/agreedPrices";

// Pieza 5 del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md), EN MODO SOMBRA.
//
// Que hace: antes de que salga cualquier texto del bot, saca del texto los precios y los nombres de
// producto que estan en posicion de lista (numerada, con viñeta) o en negrita, y los compara contra el
// catalogo REAL de ese negocio, leido de la base.
//
// Que NO hace, y es deliberado: no modifica el texto, no lo bloquea, no agrega retractaciones. Solo
// devuelve lo que habria marcado. La activacion es un cambio aparte, despues de 48 horas de datos
// reales y con los numeros a la vista - mismo criterio que WEBHOOK_SIGNATURE_ENFORCE. Un falso positivo
// aca le llega al cliente; la enfermedad, medida, son 18 de 76 mensajes con precio.
//
// Por que es clase A/B y no clase D: la comparacion es contra un SELECT (los precios y los nombres que
// existen), no contra una lectura de la prosa para adivinar que quiso hacer el modelo. Lo unico que se
// lee del texto es su FORMA - una linea numerada, una viñeta, un tramo en negrita, un signo de peso
// seguido de digitos - que es estructura, no intencion.
//
// Regla del repositorio: cero expresiones regulares nuevas. Todo el barrido es caracter por caracter,
// igual que stripNumberedLines en presenter.ts, y la comparacion de nombres reusa tokenize.
//
// La Fase B ya se come la mayoria de los casos: cuando el servidor resuelve el alcance, la lista la
// compone el y la lista del modelo se borra. Lo que queda sin cubrir es el turno con alcance "none",
// donde el modelo sigue redactando libre.

export type CatalogFindingKind = "precio_inexistente" | "producto_inexistente" | "atributo_inexistente";

export interface CatalogFinding {
  kind: CatalogFindingKind;
  /** El precio o el nombre que no coincidio, tal cual estaba escrito. */
  value: string;
  /** La linea entera que lo traia, para poder mirar el caso sin reconstruirlo. */
  line: string;
}

/** Una linea que esta listando algo con precio: la unidad que esta pieza valida. */
export interface CatalogClaim {
  line: string;
  prices: { raw: string; digits: string }[];
  names: string[];
}

/** El catalogo real contra el que se compara, ya reducido a lo que hace falta para comparar. */
export interface CatalogFacts {
  /** Precios validos, en digitos puros: los del catalogo y los de las tarifas de envio configuradas. */
  priceDigits: Set<string>;
  /** Un set de tokens por producto activo, sacado de su nombre con tokenize. */
  productNameTokens: Set<string>[];
  /**
   * E11: los colores REALES de cada producto activo, en cubetas canonicas (ver canonicalColors). Salen de
   * tres lugares, porque en los tres el color es un dato de la base: las variantes del producto,
   * Product.color de los productos de un solo color, y el nombre del producto - el servidor mismo escribe
   * "Smartwatch hello plum (Negro)", asi que ese negro es tan real como el de la columna.
   */
  productColors: { nameTokens: Set<string>; colors: Set<string> }[];
  /** La union de todos los colores del negocio. Es contra lo que se compara una linea que no nombra ningun producto. */
  allColors: Set<string>;
}

/**
 * Tope de hallazgos que se guardan por turno. Un mensaje desbocado no puede escribir una fila enorme;
 * para medir la tasa de deteccion alcanza con saber que el turno marco, y con ver los primeros casos.
 */
const MAX_FINDINGS_PER_TURN = 10;

/**
 * Un nombre reclamado de UNA sola palabra no se evalua como producto. "*Total:* $150.000",
 * "*Envío:* $12.000", "*Abono:* $50.000" son etiquetas, no listados, y son justo lo que el modelo
 * escribe en un cierre de venta. Un producto inventado de una sola palabra igual queda cubierto por el
 * chequeo de precio, que es independiente de este.
 */
const MIN_NAME_TOKENS = 2;

// El separador de lineas como constante y no como literal: este archivo se edita con herramientas que
// pelean con el escape dentro de una cadena, y una barra invertida perdida acá rompe el modulo entero.
const SALTO_DE_LINEA = String.fromCharCode(10);

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/** Separadores que pueden aparecer DENTRO de una cifra ("60.000", "1,234.50"). El espacio no: partiria mal "$60.000 3 disponibles". */
function isInnerSeparator(char: string): boolean {
  return char === "." || char === "," || char === "'";
}

function digitsOf(text: string): string {
  let out = "";
  for (const char of text) if (isDigit(char)) out += char;
  return out;
}

/**
 * Las cifras precedidas por un signo de peso. El signo es lo que las hace un precio: sin el es un
 * numero de la redaccion (una cantidad, un modelo, un año) y esta pieza no valida prosa libre.
 */
export function extractPrices(line: string): { raw: string; digits: string }[] {
  const found: { raw: string; digits: string }[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "$") continue;
    let j = i + 1;
    while (j < line.length && line[j] === " ") j++;
    if (j >= line.length || !isDigit(line[j])) continue;
    const start = j;
    while (j < line.length) {
      if (isDigit(line[j])) {
        j++;
        continue;
      }
      if (isInnerSeparator(line[j]) && j + 1 < line.length && isDigit(line[j + 1])) {
        j++;
        continue;
      }
      break;
    }
    const raw = line.slice(start, j);
    found.push({ raw, digits: digitsOf(raw) });
    i = j - 1;
  }
  return found;
}

/** Los tramos entre asteriscos (negrita de WhatsApp). Un asterisco sin cierre en la misma linea no es negrita. */
export function boldSegments(line: string): string[] {
  const segments: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "*") {
      i++;
      continue;
    }
    const close = line.indexOf("*", i + 1);
    if (close === -1) break;
    const inner = line.slice(i + 1, close).trim();
    if (inner.length > 0) segments.push(inner);
    i = close + 1;
  }
  return segments;
}

/**
 * Largo del prefijo de lista de una linea, 0 si no es un item de lista. La forma numerada la decide
 * startsAsNumberedItem, la misma funcion que usa presenter.ts para borrar la lista del modelo - una
 * sola definicion de "esto es un item numerado" para las dos piezas.
 */
function listPrefixLength(line: string): number {
  if (startsAsNumberedItem(line)) {
    let i = 0;
    while (i < line.length && isDigit(line[i])) i++;
    return i + 2; // el "." o ")" mas el espacio
  }
  if ((line[0] === "-" || line[0] === "•" || line[0] === "*") && line[1] === " ") return 2;
  return 0;
}

/**
 * Los nombres de producto que reclama una linea. La negrita gana cuando la hay (es lo que el modelo
 * usa para el nombre); si no, el nombre es lo que va entre el prefijo de lista y el precio.
 */
function claimedNames(line: string): string[] {
  const bold = boldSegments(line).filter((segment) => extractPrices(segment).length === 0);
  if (bold.length > 0) return bold;

  const prefix = listPrefixLength(line);
  if (prefix === 0) return [];
  const dollar = line.indexOf("$");
  const name = line.slice(prefix, dollar === -1 ? line.length : dollar).trim();
  return name.length > 0 ? [name] : [];
}

/**
 * Las lineas de un texto que estan listando algo con precio. Una linea entra solo si cumple LAS DOS
 * cosas: esta en posicion de lista o trae negrita, Y trae un precio. Ese "y" es lo que deja afuera la
 * prosa - un precio mencionado de pasada dentro de una frase no es el objetivo de esta pieza - y
 * tambien el bloque de resumen de pedido, cuyas lineas ("2x AIRPODS PRO 2 — $110.000", "Total: $150.000")
 * no son ni items de lista ni negrita, y traen totales que por definicion no son precios del catalogo.
 *
 * `everyPrice` amplia el barrido de PRECIOS a toda linea que traiga uno, no solo a las que estan en
 * posicion de lista o negrita. Lo pide el camino de UN SOLO AUTOR (2026-09-16): ahi el mensaje entero lo
 * escribe el agente con los datos que le dio el servidor, asi que toda cifra con "$" que escriba es una
 * afirmacion sobre el catalogo, este o no dentro de una lista. El disparador de ese modo es el ALCANCE
 * que resolvio el codigo, nunca una lectura de la prosa.
 *
 * Los NOMBRES no se amplian, y es deliberado: un nombre se reclama solo donde la FORMA lo delimita
 * (negrita o item de lista). Sacar nombres de prosa libre seria adivinar que quiso decir el modelo, que
 * es la clase de guard que este proyecto no admite. Una cifra, en cambio, viene marcada con "$".
 */
export interface ClaimOptions {
  everyPrice?: boolean;
  /**
   * E11: tambien comparar los colores que nombra el texto contra los del catalogo. Va aparte del resto
   * porque su activacion es aparte: se mide en sombra primero y se enciende por negocio, ya que un color
   * legitimo marcado por error le llega al cliente.
   */
  attributes?: boolean;
}

export function collectCatalogClaims(text: string, opts: ClaimOptions = {}): CatalogClaim[] {
  const claims: CatalogClaim[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const prices = extractPrices(line);
    if (prices.length === 0) continue;
    const names = claimedNames(line);
    const isListPositioned = listPrefixLength(line) > 0 || boldSegments(line).length > 0;
    if (!isListPositioned && !opts.everyPrice) continue;
    claims.push({ line, prices, names });
  }
  return claims;
}

/**
 * True cuando el nombre reclamado cabe dentro del nombre de algun producto real. La direccion importa:
 * el modelo abrevia ("*Audífonos Bluetooth*" por "Audífonos Bluetooth con parlante integrado") y eso es
 * correcto, mientras que agregar palabras ("Cargador iPhone" donde el catalogo solo tiene un cargador)
 * es inventar. Por eso se exige que los tokens del nombre escrito esten TODOS en el nombre real.
 */
function nameExists(name: string, facts: CatalogFacts): boolean {
  // Antes de comparar se le sacan las decoraciones que el propio servidor le pone al nombre al
  // escribirlo en un bloque (ver stripPresentationDecorations en presenter.ts). Sin esto el validador
  // marcaba como inexistentes productos que SI existen, porque comparaba "5. Reloj Inteligente
  // Smartwatch Serie 11 Mini" o "Smartwatch hello plum (Negro)" contra el nombre pelado de la base.
  // Medido en produccion el 2026-09-16: 4 turnos de 56 en 24 horas, los cuatro sobre lineas que habia
  // compuesto renderCatalog leyendo la base. Un nombre inventado sigue marcando igual: sacarle "5. " o
  // "(Negro)" a algo que no existe deja algo que sigue sin existir.
  const tokens = tokenize(stripPresentationDecorations(name));
  if (tokens.length < MIN_NAME_TOKENS) return true;
  return facts.productNameTokens.some((real) => tokens.every((token) => real.has(token)));
}

/**
 * E11: los colores que nombra una linea y que el negocio NO tiene.
 *
 * Como se decide contra que se compara: si la linea nombra un producto real, contra los colores de ESE
 * producto ("el Serie 12 Ultra 3 en naranja" se compara contra los colores del Serie 12 Ultra 3). Si no
 * nombra ninguno, contra todos los colores del negocio, que es el lado conservador: un color que el
 * negocio si maneja en otro producto no se marca. Una venta no se frena por una duda nuestra.
 *
 * Cero expresiones regulares: canonicalColors tokeniza y busca en un diccionario de colores fijo, el
 * mismo que ya usa la busqueda por atributos para entenderle al cliente. Si una palabra no esta en ese
 * diccionario, no es un color para nadie en este repositorio.
 *
 * LAS TALLAS NO ENTRAN. No existe taxonomia de tallas y escribir una seria exactamente el error contra el
 * que advierte attributeTaxonomy.ts: un vocabulario fijo que solo le sirve a una vertical. Queda anotado
 * en E11 como lo que falta.
 */
function colorFindings(line: string, facts: CatalogFacts): CatalogFinding[] {
  const mencionados = canonicalColors(line);
  if (mencionados.length === 0) return [];

  const nombreEscrito = claimedNames(line).find((name) => productOf(name, facts) !== null);
  const producto = nombreEscrito ? productOf(nombreEscrito, facts) : null;
  const reales = producto ? producto.colors : facts.allColors;
  // Un producto real sin ningun color cargado no tiene contra que comparar: no se marca nada. Decir "lo
  // tenemos en negro" de un producto al que nadie le cargo colores es un hueco de catalogo, no una
  // invencion comprobable.
  if (reales.size === 0) return [];

  return mencionados
    .filter((color) => !reales.has(color))
    .map((color) => ({ kind: "atributo_inexistente" as const, value: color, line }));
}

/** El producto real al que corresponde un nombre escrito, o null. Misma comparacion que nameExists. */
function productOf(name: string, facts: CatalogFacts): { nameTokens: Set<string>; colors: Set<string> } | null {
  const tokens = tokenize(stripPresentationDecorations(name));
  if (tokens.length < MIN_NAME_TOKENS) return null;
  return facts.productColors.find((real) => tokens.every((token) => real.nameTokens.has(token))) ?? null;
}

/** El nucleo PURO: mismos textos, mismo catalogo en memoria, mismos hallazgos. Sin base, sin red, sin modelo. */
export function validateAgainstCatalog(
  texts: readonly string[],
  facts: CatalogFacts,
  opts: ClaimOptions = {}
): CatalogFinding[] {
  const findings: CatalogFinding[] = [];
  const seen = new Set<string>();
  const add = (finding: CatalogFinding) => {
    const key = `${finding.kind}|${finding.value}|${finding.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const text of texts) {
    for (const claim of collectCatalogClaims(text, opts)) {
      for (const price of claim.prices) {
        if (!facts.priceDigits.has(price.digits)) {
          add({ kind: "precio_inexistente", value: `$${price.raw}`, line: claim.line });
        }
      }
      for (const name of claim.names) {
        if (!nameExists(name, facts)) {
          add({ kind: "producto_inexistente", value: name, line: claim.line });
        }
      }
    }

    // Los colores se buscan en TODAS las lineas, no solo en las que llevan precio: "si, lo tenemos en
    // naranja" no lleva ninguna cifra y es justo la frase del caso historico. Es una pasada mas sobre el
    // mismo texto, sin ninguna consulta extra.
    if (opts.attributes) {
      for (const raw of text.split(SALTO_DE_LINEA)) {
        const line = raw.trim();
        if (line.length === 0) continue;
        for (const finding of colorFindings(line, facts)) add(finding);
      }
    }
  }

  return findings.slice(0, MAX_FINDINGS_PER_TURN);
}

/**
 * El catalogo real de un negocio, reducido a lo comparable. Los precios entran en las dos formas que el
 * modelo puede escribir: con los decimales que corresponden a la moneda ("1,234.50") y solo la parte
 * entera ("1,234"), porque en una lista el modelo redondea y eso no es inventar. En COP las dos formas
 * coinciden y el set queda igual de chico.
 *
 * Las tarifas de envio configuradas tambien son precios validos: no son del catalogo, pero son datos
 * reales del negocio y aparecen en lineas con negrita ("*Envío a Bogotá* $12.000"). Marcarlas seria un
 * falso positivo puro.
 */
export async function loadCatalogFacts(
  businessId: string,
  locale: string,
  currency: string,
  // EL PRECIO ACORDADO (2026-09-16). Un descuento que la duena autorizo es un dato REAL del negocio, tan
  // leido de la base como el precio de catalogo - pero no esta en Product.price, asi que sin esto la
  // verificacion de 7efb9f0 marcaba "$70.000" como precio inexistente y un turno legitimo caia al
  // fallback. Se pasa la conversacion, no una lista de numeros: los precios acordados son de ESTA venta
  // y no valen para otra.
  conversationId?: string
): Promise<CatalogFacts> {
  const [products, shippingRates] = await Promise.all([
    prisma.product.findMany({
      where: { businessId, active: true },
      select: {
        name: true,
        price: true,
        currency: true,
        // E11: el color vive en tres lugares y los tres son la base. Un producto de un solo color lo lleva
        // en su propia columna; uno con variantes, en cada variante; y el nombre muchas veces ya lo dice.
        color: true,
        variants: { where: { active: true }, select: { color: true } },
      },
    }),
    prisma.shippingRate.findMany({ where: { businessId }, select: { cost: true } }),
  ]);

  const priceDigits = new Set<string>();
  const addPrice = (amount: number | { toString(): string }, priceCurrency: string) => {
    const value = Number(amount.toString());
    if (!Number.isFinite(value)) return;
    priceDigits.add(digitsOf(formatPrice(value, priceCurrency, locale)));
    // La forma sin decimales. Los separadores de miles se caen solos al quedarse con los digitos, asi
    // que la parte entera tal cual ya es la version redondeada que el modelo escribe en una lista.
    priceDigits.add(digitsOf(String(Math.trunc(value))));
  };

  for (const product of products) addPrice(product.price, product.currency || currency);
  for (const rate of shippingRates) addPrice(rate.cost, currency);
  if (conversationId) {
    for (const agreed of (await getAgreedPrices(conversationId)).values()) addPrice(agreed.unitPrice, agreed.currency || currency);
  }

  const productColors = products.map((product) => {
    const colors = new Set<string>([
      ...canonicalColors(product.name),
      ...canonicalColors(product.color ?? ""),
      ...product.variants.flatMap((variant) => canonicalColors(variant.color ?? "")),
    ]);
    return { nameTokens: new Set(tokenize(product.name)), colors };
  });

  return {
    priceDigits,
    productNameTokens: products.map((product) => new Set(tokenize(product.name))),
    productColors,
    allColors: new Set(productColors.flatMap((product) => [...product.colors])),
  };
}

/**
 * Lo que llama el agente. Devuelve hallazgos y NADA MAS: no recibe una forma de cambiar el texto ni la
 * tiene. Esa es la garantia de modo sombra, y es de tipo, no de disciplina.
 *
 * Si no hay ni una linea candidata (el caso normal: una respuesta sin listas ni precios), sale sin
 * tocar la base. Un turno de conversacion comun no paga ninguna consulta por esta pieza.
 */
export async function findShadowCatalogFindings(
  businessId: string,
  texts: readonly string[],
  opts: { locale: string; currency: string; conversationId?: string }
): Promise<CatalogFinding[]> {
  try {
    if (!texts.some((text) => collectCatalogClaims(text).length > 0)) return [];
    const facts = await loadCatalogFacts(businessId, opts.locale, opts.currency, opts.conversationId);
    // La comparacion de colores va SIEMPRE en sombra, sin bandera: es justamente el dato que hace falta
    // para decidir si se puede encender (E11).
    return validateAgainstCatalog(texts, facts, { attributes: true });
  } catch (error) {
    // Best-effort igual que recordAgentTurn: en modo sombra esta pieza no puede romper un turno que ya
    // esta respondido. Un turno sin auditar es un problema de observabilidad; un turno sin respuesta es
    // un problema del cliente.
    console.error("No se pudo validar la salida contra el catalogo (no bloqueante):", error);
    return [];
  }
}

/**
 * EL CAMINO ACTIVO (2026-09-16), y por ahora el unico: el turno de UN SOLO AUTOR, donde el agente
 * escribe el mensaje entero con los datos estructurados que le dio el servidor. Ahi la verificacion si
 * decide: lo que no se puede verificar contra la base no sale (ver la escalera en agent.ts).
 *
 * Devuelve `verificado: false` cuando la consulta al catalogo fallo. No es lo mismo que "no hay
 * hallazgos": no poder verificar es motivo suficiente para caer al fallback, porque la garantia de esta
 * fase es "sale lo que existe en la base, o no sale". Un catalogo que no se pudo leer no respalda nada.
 */
export async function verifyAgainstCatalog(
  businessId: string,
  texts: readonly string[],
  // `attributes` es Business.attributeCheckEnabled: con la bandera apagada, un color inventado se sigue
  // registrando en sombra pero no frena el mensaje (E11).
  opts: { locale: string; currency: string; conversationId?: string; attributes?: boolean }
): Promise<{ verificado: boolean; findings: CatalogFinding[] }> {
  try {
    // Un texto sin una sola cifra con "$" no afirma ningun precio y no tiene nombre en posicion de
    // lista: no hay nada que comparar, asi que tampoco se paga la consulta.
    // Con la verificacion de color encendida, un texto sin ninguna cifra tambien puede afirmar algo
    // comprobable ("si, lo tenemos en naranja"), asi que ahi no se puede salir temprano.
    if (!opts.attributes && !texts.some((text) => collectCatalogClaims(text, { everyPrice: true }).length > 0)) {
      return { verificado: true, findings: [] };
    }
    const facts = await loadCatalogFacts(businessId, opts.locale, opts.currency, opts.conversationId);
    return { verificado: true, findings: validateAgainstCatalog(texts, facts, { everyPrice: true, attributes: opts.attributes }) };
  } catch (error) {
    console.error("No se pudo verificar la salida contra el catalogo:", error);
    return { verificado: false, findings: [] };
  }
}

/** Como se guarda cada hallazgo en AgentTurn.shadowFindings, y como lo lee el panel. */
export function serializeFinding(finding: CatalogFinding): string {
  return JSON.stringify(finding);
}

export function parseFinding(raw: string): CatalogFinding | null {
  try {
    const parsed = JSON.parse(raw) as CatalogFinding;
    if (!parsed || typeof parsed.kind !== "string" || typeof parsed.value !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
