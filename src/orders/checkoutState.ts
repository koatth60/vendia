// Estado de pedido: la fuente de verdad sobre QUE se sabe y QUE falta para poder despachar.
//
// Por que existe (2026-09-15): hoy el modelo lleva la cuenta de memoria, releyendo la conversacion en
// cada turno. De ahi salen los dos sintomas que mas se ven - la preguntaderaz (a una clienta se le pidio
// el barrio cinco veces en veinte minutos, y el apellido recien despues del resumen) y las afirmaciones
// falsas ("ya tengo el nombre y la cédula" con los dos campos vacios en la base). Son el mismo defecto:
// un recuerdo no es un estado. Esto se calcula de la base, asi que no puede desincronizarse.
//
// Fuentes de los campos obligatorios:
//  - Las instrucciones configuradas del negocio, que son la verdad operativa (la cedula solo se pide
//    fuera de Bogota/Soacha).
//  - Lo que una transportadora pide para emitir la guia: nombre completo y contacto del destinatario,
//    direccion exacta con referencias, y del paquete su contenido, peso y valor declarado.
//    Ver https://coordinadora.com/blog/como-generar-guias-de-envio/ - ese articulo es material
//    divulgativo, no una norma, y NO menciona la cedula, asi que se usa solo para sumar campos de guia,
//    nunca para reemplazar lo que el negocio ya exige.
//
// Pensado core desde el principio: los requisitos viven por pais (ver REQUISITOS_POR_PAIS), no cableados
// a Colombia, porque la intencion es vender tambien en Mexico.

export type CountryCode = "CO" | "MX";

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
  /** Pais de destino del envio. Hoy siempre CO; el dia que se venda en Mexico llega "MX" desde la ciudad. */
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
// apartamento, piso). "Cra 17 # 23-03" sin barrio deja al mensajero a medio camino.
// En Colombia la via se abrevia fuerte y muchas veces va pegada al numero ("Cr143#143b-42", "Cl 57 sur").
// Por eso el patron no puede exigir un limite de palabra despues de la abreviatura: pide la abreviatura
// seguida (con o sin espacio, con o sin #) de un numero, que es lo que de verdad la identifica.
const VIA_PATTERN =
  /(^|\s)(cra?|carrera|cll?|calle|kra?|av|avenida|diag(onal)?|trans(versal)?|tv|dg|mz|manzana|lote|lt|autopista|v[ií]a|vereda|circular)\.?\s*#?\s*\d/i;
const DETALLE_PATTERN = /\b(barrio|conjunto|torre|apto|apartamento|casa|piso|bloque|interior|oficina|local|urbanizaci[oó]n)\b/i;

export function direccionEsDespachable(direccion: string | null): boolean {
  if (!direccion) return false;
  return VIA_PATTERN.test(direccion) && /\d/.test(direccion) && DETALLE_PATTERN.test(direccion);
}

interface RequisitoPais {
  /** Zonas donde el documento de identidad NO se pide. Fuera de esas, si. */
  zonasSinDocumento: string[];
  etiquetaDocumento: string;
  pedir: Record<FieldKey, string>;
}

// Solo CO esta poblado con reglas reales y verificadas contra el negocio. MX queda declarado a proposito
// pero sin dar por ciertos sus requisitos: cuando se venda alla hay que confirmarlos con la
// transportadora de ese pais antes de usarlo, igual que se hizo aca.
const REQUISITOS_POR_PAIS: Record<CountryCode, RequisitoPais> = {
  CO: {
    zonasSinDocumento: ["bogota", "soacha"],
    etiquetaDocumento: "número de cédula",
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
  },
  MX: {
    // Pendiente de confirmar con la transportadora mexicana antes de vender alla.
    zonasSinDocumento: [],
    etiquetaDocumento: "identificación",
    pedir: {
      productos: "qué producto quieres y cuántas unidades",
      variante: "el color",
      nombre: "tu nombre y apellido",
      documento: "tu identificación",
      telefono: "tu teléfono de contacto",
      ciudad: "tu ciudad y estado",
      direccion: "tu colonia, calle y número, y el código postal",
      formaPago: "cómo prefieres pagar",
    },
  },
};

function documentoRequerido(pais: CountryCode, zonaEnvio: string | null): boolean {
  const reglas = REQUISITOS_POR_PAIS[pais];
  if (!zonaEnvio) return false; // Sin zona resuelta todavia no se sabe: no se pide de mas.
  const zona = zonaEnvio
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return !reglas.zonasSinDocumento.some((z) => zona.includes(z));
}

export function computeCheckoutState(facts: CheckoutFacts): CheckoutState {
  const reglas = REQUISITOS_POR_PAIS[facts.pais];
  const docRequerido = documentoRequerido(facts.pais, facts.zonaEnvio);

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
      ok: direccionEsDespachable(facts.direccion),
      pedir: null,
    },
    { key: "formaPago", requerido: true, valor: facts.formaPago, ok: Boolean(facts.formaPago), pedir: null },
  ];

  for (const campo of campos) {
    campo.pedir = campo.requerido && !campo.ok ? reglas.pedir[campo.key] : null;
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
