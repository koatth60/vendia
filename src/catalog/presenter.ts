import { formatPrice } from "../config/money";
import { normalizeForMatch } from "../search/text";
import type { ProductScope, ScopeMedia, ScopeProduct, ScopeVariant } from "./scope";
import { totalStock } from "./stock";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, pieza 2).
//
// Funciones PURAS: sin base de datos, sin red, sin modelo. Entran los productos ya acotados por
// resolveProductScope y sale la lista ordenada de mensajes que el servidor va a enviar tal cual. El
// modelo no escribe ni un nombre ni un precio de estos bloques: solo la frase que los introduce.

/** Fotos/videos que viajan pegados a un bloque, ya resueltos por el alcance. */
export interface CatalogBlockMedia {
  productId: string;
  /** Etiqueta con la que se graba cada envio (`[Foto de X]`), variante incluida cuando la hay. */
  productName: string;
  items: ScopeMedia[];
}

/** Un bloque = un mensaje de WhatsApp. Sale literal: nadie lo reescribe despues. */
export interface CatalogBlock {
  text: string;
  /**
   * Lo mismo que `text` pero SIN recortar la descripcion: es la version que ve el MODELO en su contexto,
   * nunca la que sale al cliente. Asi el cliente lee un extracto corto y el modelo igual contesta
   * "¿tiene ritmo cardiaco?" con el dato real, sin que nadie tenga que guardar que quedo una
   * continuacion pendiente. Fuera de la ficha de un producto puntual es identico a `text`.
   */
  modelText: string;
  media: CatalogBlockMedia[];
  /** Ids de producto que este bloque nombra, en el orden en que aparecen numerados. */
  productIds: string[];
  /**
   * Las mismas opciones de este bloque, listas para una lista interactiva de WhatsApp: el cliente toca una
   * fila y vuelve el id del producto, sin que nadie tenga que leer "el 5" de su prosa. Solo las llevan los
   * bloques de LISTA (group/all); una ficha de producto no es una eleccion.
   *
   * Que se use o no lo decide el llamador (ver Business.interactiveListsEnabled): el texto numerado sigue
   * existiendo y es lo que sale cuando la lista interactiva no aplica.
   */
  rows?: { id: string; title: string; description: string }[];
}

export interface RenderCatalogOptions {
  currency: string;
  locale: string;
  /**
   * Orden de categorias preferido (nombre tal cual esta en Product.category, sin normalizar). Las
   * categorias que no figuren salen despues, en el orden en que aparecen los productos de entrada.
   */
  categoryOrder?: string[];
  /** Encabezado para los productos sin categoria cargada. */
  uncategorizedLabel?: string;
  /**
   * Los productos que el servidor YA presento entero en esta conversacion (ficha + medios). Sale de
   * `Conversation.mediaSentProductIds`, el mismo registro que ya consultaba el auto-envio de
   * get_product_details; aca no se crea ninguno nuevo.
   *
   * Incidente real 2026-09-16 (conversacion cmu4gniqe000se82kdrhvrw6d): el cliente pregunto por un
   * producto, despues por otro, y volvio al primero. Recibio 4 fotos y 2 videos del mismo producto y 2
   * fotos del otro, porque este presentador adjuntaba los medios SIEMPRE, sin mirar el registro. Con
   * esta lista, los medios de un producto salen una sola vez por conversacion y la segunda ficha sale
   * corta. Un reenvio que el cliente pida explicitamente sigue siendo de send_product_media, que no pasa
   * por aca.
   */
  alreadyPresentedProductIds?: string[];
}

/**
 * El umbral de "pocos productos": con esta cantidad o menos las fotos salen SOLAS, en el mismo turno.
 * Con mas, la lista va numerada y se ofrece elegir. Vive aca, en un solo lugar, a proposito.
 */
export const FEW_PRODUCTS_MAX = 2;

/**
 * Tope de lineas por mensaje. El corte natural es la categoria (por eso el catalogo completo sale como
 * un mensaje por categoria y no partido a los 700 caracteres), pero una categoria con decenas de
 * productos igual necesita un corte: se parte en mensajes de continuacion CONSERVANDO la numeracion,
 * nunca reiniciandola.
 */
const MAX_LINES_PER_BLOCK = 12;

// MAX_DESCRIPTION_LINES (5) y MORE_DESCRIPTION_LINE se ELIMINARON el 2026-09-16, con el camino de un
// solo autor. Cortaban CINCO LINEAS, no cinco caracteristicas, y no hay forma de calibrar ese numero:
// medido en produccion ese mismo dia, la descripcion de "Smartwatch serie 12 mini" tiene 34 lineas y
// arranca con dos de presentacion y una de titulo ("Características:"), asi que al cliente le llegaban
// DOS caracteristicas de 31 y despues "¿Te cuento el resto?". Parecia una respuesta rota.
//
// Cualquier arreglo del corte (subir el numero, saltear encabezados, detectar eslogans) es calibrar una
// guillotina que no deberia existir. La descripcion ahora va ENTERA: al agente como dato estructurado
// (ver productFacts, que la separa en presentacion y caracteristicas), y a la ficha de respaldo tal
// cual esta cargada. Cuantas caracteristicas nombrar y cuales es decision de conversacion, y esa es la
// categoria donde este proyecto no fuerza nada.

const PHOTO_OFFER_LINE = "¿De cuál te gustaría ver fotos?";

const DEFAULT_UNCATEGORIZED_LABEL = "Otros productos";

function priceLine(product: ScopeProduct, opts: RenderCatalogOptions): string {
  return `$${formatPrice(product.price, product.currency || opts.currency, opts.locale)}`;
}

function stockSuffix(stock: number): string {
  if (stock <= 0) return " (sin stock)";
  // "1 disponibles" (2026-09-16): la concordancia tambien es parte de que no suene a maquina.
  return ` (${stock} disponible${stock === 1 ? "" : "s"})`;
}

function variantLabel(variant: ScopeVariant): string | null {
  const parts = [variant.color, variant.size].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * Los medios de un producto en alcance. Con variante elegida (el cliente nombro un color), solo los de
 * esa variante, cayendo a los generales si esa variante no tiene propios - nunca a los de OTRA variante,
 * que seria mandarle el color equivocado. Sin color nombrado se conserva el criterio actual de
 * send_product_media: los generales MAS los de todas las variantes.
 */
export function mediaForProduct(product: ScopeProduct, variant: ScopeVariant | null): ScopeMedia[] {
  if (variant) {
    return variant.media.length > 0 ? variant.media : product.media;
  }
  if (product.variants.length > 0) {
    return [...product.media, ...product.variants.flatMap((v) => v.media)];
  }
  return product.media;
}

function mediaBlockFor(product: ScopeProduct, variant: ScopeVariant | null): CatalogBlockMedia[] {
  const items = mediaForProduct(product, variant);
  if (items.length === 0) return [];
  const label = variant ? variantLabel(variant) : null;
  return [{ productId: product.id, productName: label ? `${product.name} (${label})` : product.name, items }];
}

/**
 * Las variantes activas del producto, nombradas con su stock real. Sin esta linea el bloque no dice de
 * que colores hay, y ese hueco lo rellenaba el modelo inventando: caso real del 2026-09-16, dijo "Negro
 * Matte y Titanio Plateado" (lo que decia la descripcion cargada a mano) cuando las variantes de la base
 * son `negro` y `gris`. El dato correcto SALE; no hay que pedirle nada al modelo ni validarlo despues.
 */
function variantsLine(product: ScopeProduct): string | null {
  const parts = product.variants
    // Sin stock no se nombra: nombrarla es ofrecerle al cliente un color que no le podemos vender.
    // Caso real 2026-09-16: el bloque escribio "verde camuflado (sin stock)" en el mismo turno en el que
    // el modelo, por su cuenta, habia listado solo los dos colores que si habia.
    .filter((v) => v.active && v.stock > 0)
    .map((v) => {
      const label = variantLabel(v);
      return label ? `${label}${stockSuffix(v.stock)}` : null;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? `Disponible en: ${parts.join(", ")}` : null;
}

/** Las lineas con contenido de la descripcion, sin las vacias: son las unidades del corte. */
function descriptionLines(product: ScopeProduct): string[] {
  return product.description
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * La ficha de un producto puntual: sin numerar, porque no hay nada entre que elegir.
 *
 * `alreadyPresented` es la segunda vez: el cliente ya leyo la descripcion y ya recibio las fotos, asi que
 * la ficha se reduce a lo que puede haber cambiado o que el cliente vuelve a necesitar - nombre, precio y
 * stock (con el stock por color cuando hay variantes). Sin descripcion y sin medios.
 * El modelo escribe encima lo suyo ("listo, el Ultra 3 entonces, ¿seguimos?").
 *
 * `modelText` sigue trayendo la descripcion ENTERA tambien en la version corta: el cliente no la ve de
 * nuevo, pero una pregunta puntual sobre una caracteristica se contesta con el dato real aunque la ficha
 * original ya se haya salido de la ventana de historial.
 */
function renderSingle(
  product: ScopeProduct,
  variant: ScopeVariant | null,
  opts: RenderCatalogOptions,
  alreadyPresented: boolean
): CatalogBlock {
  const label = variant ? variantLabel(variant) : null;
  const title = label ? `*${product.name}* (${label})` : `*${product.name}*`;
  const stock = variant ? variant.stock : totalStock(product);
  // Con una variante ya elegida el titulo ya dice cual es y con cuanto stock: listar las demas seria
  // ofrecerle colores que no pidio.
  const variants = variant ? null : variantsLine(product);

  const head = [`${title} — ${priceLine(product, opts)}${stockSuffix(stock)}`];
  if (variants) head.push(variants);

  const description = descriptionLines(product);
  if (alreadyPresented) {
    return {
      text: head.join("\n"),
      modelText: [...head, ...description].join("\n"),
      media: [],
      productIds: [product.id],
    };
  }

  // Sin corte: la descripcion sale tal cual esta cargada. Ver la nota de MAX_DESCRIPTION_LINES arriba.
  return {
    text: [...head, ...description].join("\n"),
    modelText: [...head, ...description].join("\n"),
    media: mediaBlockFor(product, variant),
    productIds: [product.id],
  };
}

function groupByCategory(products: ScopeProduct[], opts: RenderCatalogOptions): { category: string | null; products: ScopeProduct[] }[] {
  const groups = new Map<string, { category: string | null; products: ScopeProduct[] }>();
  for (const product of products) {
    const key = product.category ?? "";
    const existing = groups.get(key);
    if (existing) existing.products.push(product);
    else groups.set(key, { category: product.category, products: [product] });
  }

  const preferred = opts.categoryOrder ?? [];
  const ordered = [...groups.values()];
  // Orden estable: primero las categorias declaradas en categoryOrder, en ESE orden; despues el resto
  // en el orden en que aparecieron los productos de entrada (que ya viene ordenado por la consulta).
  ordered.sort((a, b) => {
    const ia = a.category ? preferred.indexOf(a.category) : -1;
    const ib = b.category ? preferred.indexOf(b.category) : -1;
    if (ia === ib) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return ordered;
}

/**
 * Una lista numerada, partida en mensajes de a lo sumo MAX_LINES_PER_BLOCK lineas. `startNumber` es lo
 * que hace que la numeracion sea continua A TRAVES de los grupos: la directiva SELECCION POR NUMERO del
 * prompt depende de que el ultimo mensaje del bot sea una lista numerada, y si cada categoria
 * reiniciara en 1, "el 3" dejaria de resolver a un producto real.
 */
function renderNumberedGroup(
  heading: string | null,
  products: ScopeProduct[],
  startNumber: number,
  opts: RenderCatalogOptions
): CatalogBlock[] {
  const blocks: CatalogBlock[] = [];
  for (let offset = 0; offset < products.length; offset += MAX_LINES_PER_BLOCK) {
    const chunk = products.slice(offset, offset + MAX_LINES_PER_BLOCK);
    const lines = chunk.map(
      (product, i) => `${startNumber + offset + i}. *${product.name}* — ${priceLine(product, opts)}${stockSuffix(totalStock(product))}`
    );
    const text = heading && offset === 0 ? `*${heading}*\n${lines.join("\n")}` : lines.join("\n");
    blocks.push({
      text,
      modelText: text,
      media: [],
      productIds: chunk.map((p) => p.id),
      // El titulo de fila lo recorta el cliente de WhatsApp (24 caracteres, limite de Meta); el precio y
      // el stock van en la descripcion, que admite 72.
      rows: chunk.map((product) => ({
        id: product.id,
        title: product.name,
        description: `${priceLine(product, opts)}${stockSuffix(totalStock(product))}`.trim(),
      })),
    });
  }
  return blocks;
}

/**
 * Convierte un alcance ya resuelto en los mensajes exactos que se envian. Nunca emite un producto que no
 * venga en la entrada, y las fotos se deciden por el alcance, no por el criterio del modelo:
 *
 *   one / few  -> los medios salen JUNTO con el mensaje, mismo turno. No se ofrece, no se pregunta.
 *   group/all  -> no se mandan medios. Lista numerada y se ofrece elegir.
 */
export function renderCatalog(scope: ProductScope, opts: RenderCatalogOptions): CatalogBlock[] {
  if (scope.kind === "none") return [];

  // Lo ya presentado en esta conversacion: decide, producto por producto, si va la ficha entera con sus
  // medios o la version corta sin medios. Una lista numerada nunca manda medios, asi que no la toca.
  const alreadyPresented = new Set(opts.alreadyPresentedProductIds ?? []);

  if (scope.kind === "one") {
    return [renderSingle(scope.product, scope.variant ?? null, opts, alreadyPresented.has(scope.product.id))];
  }

  if (scope.kind === "few") {
    // Hasta FEW_PRODUCTS_MAX productos: una ficha por producto, cada una con sus fotos. No se numeran
    // ni se ofrece elegir - ya los tiene todos delante.
    return scope.products.map((product) => renderSingle(product, null, opts, alreadyPresented.has(product.id)));
  }

  const groups =
    scope.kind === "group"
      ? [{ category: scope.category, products: scope.products }]
      : groupByCategory(scope.products, opts);

  const blocks: CatalogBlock[] = [];
  let next = 1;
  for (const group of groups) {
    // Con una sola categoria el encabezado repetiria lo que el cliente acaba de preguntar; con varias
    // es lo que separa un mensaje del siguiente.
    const heading = groups.length > 1 ? group.category ?? (opts.uncategorizedLabel ?? DEFAULT_UNCATEGORIZED_LABEL) : null;
    const rendered = renderNumberedGroup(heading, group.products, next, opts);
    next += group.products.length;
    blocks.push(...rendered);
  }

  if (blocks.length > 0) {
    // El ofrecimiento va UNA vez, pegado al ultimo mensaje: es la pregunta con la que termina el turno.
    const last = blocks[blocks.length - 1];
    const withOffer = `${last.text}\n\n${PHOTO_OFFER_LINE}`;
    blocks[blocks.length - 1] = { ...last, text: withOffer, modelText: withOffer };
  }

  return blocks;
}

/** Los ids que el cliente realmente vio, en orden: es contra esto que se resuelve "el 3" del proximo turno. */
export function presentedProductIds(blocks: CatalogBlock[]): string[] {
  return blocks.flatMap((b) => b.productIds);
}

/**
 * Le quita a la frase del modelo cualquier linea que sea una lista numerada. Cuando el servidor ya
 * compuso los bloques, una lista en la introduccion es, en el mejor caso, la misma informacion dos
 * veces, y en el peor la version inventada de la lista real que sale abajo.
 *
 * Sin expresion regular (regla del repositorio): se mira caracter por caracter si la linea arranca con
 * digitos seguidos de "." o ")" y un espacio, que es la forma exacta que produce renderCatalog.
 */
export function stripNumberedLines(text: string): string {
  const kept = text.split("\n").filter((line) => !startsAsNumberedItem(line.trim()));
  return kept.join("\n").trim();
}

/**
 * Clave de comparacion de una linea: minusculas y sin acentos (normalizeForMatch), y de ahi solo letras
 * y digitos separados por un espacio. Asi "*Serie 12* — $140.000" y "Serie 12 - $140.000" son la misma
 * linea, que es lo que hace falta: el modelo reescribe asteriscos, guiones y espacios al copiar la ficha.
 *
 * Sin expresion regular (regla del repositorio): se recorre caracter por caracter.
 */
function lineKey(line: string): string {
  const normalized = normalizeForMatch(line);
  const parts: string[] = [];
  let current = "";
  for (const ch of normalized) {
    const keep = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (keep) current += ch;
    else if (current) {
      parts.push(current);
      current = "";
    }
  }
  if (current) parts.push(current);
  return parts.join(" ");
}

/**
 * Le quita a la frase del modelo toda linea que el servidor ya va a mandar en sus propios bloques.
 *
 * Incidente real 2026-09-16 (conversacion cmu4e3q9l001ozi2ka2x1t1b1): el cliente escribio "3" y recibio
 * SEIS mensajes - el modelo habia escrito la ficha entera con vinetas y el servidor mando la misma ficha
 * debajo. El prompt ya le pide al modelo que escriba solo una frase de introduccion; esto es lo que lo
 * garantiza sin depender de que obedezca.
 *
 * Si al sacarle las duplicadas no queda ni una letra ni un digito, devuelve "" - el que llama no manda
 * un mensaje vacio y el turno arranca directo en los bloques.
 */
export function stripLinesAlreadyInBlocks(text: string, blocks: CatalogBlock[]): string {
  const alreadySent = new Set<string>();
  for (const block of blocks) {
    for (const line of block.text.split("\n")) {
      const key = lineKey(line);
      if (key) alreadySent.add(key);
    }
  }
  if (alreadySent.size === 0) return text;

  const kept = text.split("\n").filter((line) => {
    const key = lineKey(line);
    return key === "" || !alreadySent.has(key);
  });
  const result = kept.join("\n").trim();
  return lineKey(result) ? result : "";
}

/**
 * Le saca a un nombre las decoraciones que le pone ESTE archivo al escribirlo adentro de un bloque: el
 * prefijo de numeracion que arma renderNumberedGroup ("5. ") y el sufijo de variante entre parentesis
 * que arman renderSingle y mediaBlockFor con variantLabel ("(Negro)"). Lo que queda es el nombre como
 * esta en la base, que es lo unico contra lo que tiene sentido comparar.
 *
 * Vive aca, al lado de las funciones que ponen esas decoraciones, por la misma razon que
 * startsAsNumberedItem: una sola definicion de cada forma, compartida con quien despues la tiene que
 * deshacer (src/catalog/outputValidation.ts).
 *
 * Sin expresion regular (regla del repositorio): se recorre caracter por caracter.
 */
export function stripPresentationDecorations(name: string): string {
  let out = name.trim();
  if (startsAsNumberedItem(out)) {
    let i = 0;
    while (i < out.length && out[i] >= "0" && out[i] <= "9") i++;
    out = out.slice(i + 2).trim(); // el "." o ")" mas el espacio
  }
  // Solo el ULTIMO parentesis y solo si cierra el nombre: un producto cuyo nombre real lleva parentesis
  // adentro ("Serie 11 Mini (Edición Compacta) negro") no se queda sin su parte util.
  if (out.endsWith(")")) {
    const open = out.lastIndexOf("(");
    if (open > 0) out = out.slice(0, open).trim();
  }
  return out;
}

export function startsAsNumberedItem(line: string): boolean {
  let i = 0;
  while (i < line.length && line[i] >= "0" && line[i] <= "9") i++;
  if (i === 0) return false;
  if (line[i] !== "." && line[i] !== ")") return false;
  return line[i + 1] === " ";
}

/**
 * UN SOLO AUTOR (2026-09-16). Los mismos datos que renderSingle escribe en prosa, pero SIN redactar:
 * nombre, precio, stock, variantes con stock, descripcion y moneda, tal como salieron del `SELECT`.
 *
 * Existe porque la ficha compuesta por el servidor y la frase del modelo eran dos autores escribiendole
 * al cliente en el mismo turno, y el codigo los coordinaba pidiendoselo por prompt. Con estos datos en
 * el contexto el agente escribe el mensaje entero con su voz, y lo que escribe se verifica despues
 * contra el catalogo (src/catalog/outputValidation.ts). El bloque de renderSingle sigue existiendo, pero
 * como FALLBACK: es lo que sale si la verificacion falla dos veces.
 *
 * Vive al lado de renderSingle a proposito: son la misma lectura del producto: si una cambia y la otra
 * no, el fallback dejaria de decir lo mismo que el agente.
 */
export interface ProductFacts {
  nombre: string;
  /** Ya formateado con la moneda y el locale del negocio ("$120.000"): es la forma exacta que valida. */
  precio: string;
  moneda: string;
  /** El de la variante elegida cuando el cliente nombro un color; si no, el total del producto. */
  stock: number;
  /** El color/talle que el cliente nombro, si nombro alguno. */
  varianteElegida: string | null;
  /**
   * Las variantes activas CON stock, con su stock real. Vacio cuando el cliente ya eligio una: nombrar
   * las demas seria ofrecerle colores que no pidio (mismo criterio que renderSingle).
   */
  variantes: { nombre: string; stock: number }[];
  /**
   * La descripcion ENTERA, sin ningun corte, separada en sus dos partes. Cuantas caracteristicas
   * nombrarle al cliente y cuales lo decide el agente segun lo que le preguntaron: no hay ningun numero
   * fijo que calibrar, que es lo que hacia MAX_DESCRIPTION_LINES (ver la nota arriba).
   */
  descripcion: { presentacion: string[]; caracteristicas: string[] };
}

/**
 * Un titulo dentro de la descripcion es una linea que TERMINA en ":" ("Características:"). Se lee la
 * FORMA de la linea, no su significado - mismo criterio que startsAsNumberedItem: la puntuacion es
 * estructura, no intencion, y no hace falta ninguna lista de palabras ni ningun vocabulario por rubro.
 *
 * Sin ningun titulo, todo va a `presentacion`: no sabemos donde empieza la lista, y decir que la
 * descripcion entera son "caracteristicas" seria inventar una estructura que el negocio no cargo. El
 * agente recibe las dos partes y las dos estan completas, asi que en ningun caso se pierde una linea.
 */
function splitDescription(lines: string[]): { presentacion: string[]; caracteristicas: string[] } {
  const heading = lines.findIndex((line) => line.length > 1 && line.endsWith(":"));
  if (heading === -1) return { presentacion: lines, caracteristicas: [] };
  return { presentacion: lines.slice(0, heading), caracteristicas: lines.slice(heading + 1) };
}

export function productFacts(
  product: ScopeProduct,
  variant: ScopeVariant | null,
  opts: RenderCatalogOptions
): ProductFacts {
  const variantes = variant
    ? []
    : product.variants
        .filter((v) => v.active && v.stock > 0)
        .map((v) => ({ nombre: variantLabel(v), stock: v.stock }))
        .filter((v): v is { nombre: string; stock: number } => v.nombre !== null);

  return {
    nombre: product.name,
    precio: priceLine(product, opts),
    moneda: product.currency || opts.currency,
    stock: variant ? variant.stock : totalStock(product),
    varianteElegida: variant ? variantLabel(variant) : null,
    variantes,
    descripcion: splitDescription(descriptionLines(product)),
  };
}
