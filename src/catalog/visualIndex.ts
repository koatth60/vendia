import { tokenize } from "../search/text";

// EL CATALOGO SE MIRA, NO SE LEE (E12b paso 2, 2026-09-18).
//
// Caso real: una clienta manda la captura de un reloj REDONDO y compacto. La vision corrio, escalo a
// claude-sonnet-5, y describio bien lo que veia. Aun asi el bot le mando cinco archivos de dos relojes
// deportivos de 49 mm. El motivo no fue el modelo: la descripcion se comparaba contra el NOMBRE de los
// productos, y "redondo" no aparece en ningun nombre del catalogo. El dato que distinguia al producto
// nunca participo de la comparacion.
//
// Este modulo pone las dos puntas en el mismo idioma: cada foto del catalogo guarda lo que el MISMO
// modelo de vision ve en ella, y la foto del cliente se compara contra eso. "Redondo" contra "redondo".
//
// Todo lo de aca adentro es PURO: recibe descripciones ya hechas y devuelve un puntaje. Sin base, sin
// red, sin modelo - para poder probar el emparejamiento con casos reales escritos a mano.

/**
 * Las palabras que NO distinguen nada dentro de una descripcion visual. No es una lista de "stopwords
 * del español": son las palabras que aparecen en casi toda ficha visual de casi todo producto, asi que
 * contarlas premia al producto con la descripcion mas larga en vez de al que se parece.
 */
const RUIDO = new Set([
  "producto", "foto", "imagen", "captura", "aparece", "aparecen", "ve", "una", "un", "unos", "unas",
  "con", "sin", "sobre", "del", "las", "los", "para", "que", "mas", "muy", "parece", "tipo", "color",
  "colores", "marca", "modelo", "texto", "visible", "fondo", "mano", "persona", "pantalla",
]);

/** Los tokens que de verdad distinguen una descripcion visual de otra. */
export function visualTokens(description: string): Set<string> {
  return new Set(tokenize(description).filter((t) => t.length > 2 && !RUIDO.has(t)));
}

export interface VisualCandidate {
  productId: string;
  productName: string;
  /** La ficha visual guardada de una foto de ese producto. */
  description: string;
}

export interface VisualMatch {
  productId: string;
  productName: string;
  /** Cuantos tokens distintivos comparte con la foto del cliente, sobre los que tiene la foto del cliente. */
  score: number;
}

/**
 * Cuanto se parece la descripcion de la foto del cliente a la ficha visual de una foto del catalogo.
 *
 * Se divide por los tokens de la FOTO DEL CLIENTE, no por la union: lo que se pregunta es "cuanto de lo
 * que la clienta muestra esta en este producto", y asi una ficha de catalogo muy larga no gana por
 * tener mas palabras. Es la misma direccion que ya usa nameExists en outputValidation.ts.
 */
export function visualScore(clienteTokens: Set<string>, candidato: string): number {
  if (clienteTokens.size === 0) return 0;
  const suyos = visualTokens(candidato);
  let compartidos = 0;
  for (const token of clienteTokens) if (suyos.has(token)) compartidos++;
  return compartidos / clienteTokens.size;
}

/** Puntaje minimo para considerar siquiera que una foto del catalogo tiene que ver con la del cliente. */
export const VISUAL_MIN_SCORE = 0.34;

/**
 * Cuanto tiene que sacarle el primero al segundo para decir que es ESE y no el otro. Sin esta distancia,
 * dos relojes negros casi identicos se resolverian a cara o cruz, que es exactamente lo que hizo el bot
 * el 2026-09-18 cuando mando "los dos modelos que mas se parecen".
 */
export const VISUAL_MIN_MARGIN = 0.15;

export interface VisualMatchResult {
  /** El unico producto que la foto puede ser. null cuando no hay ninguno claro. */
  match: VisualMatch | null;
  /** Los que quedaron arriba del piso, en orden. Con dos o mas y sin margen, esto es la duda. */
  candidates: VisualMatch[];
  /** Hay parecidos pero ninguno gana: hay que preguntarle a la duena, no elegir por nosotros. */
  ambiguous: boolean;
}

/**
 * El producto del catalogo que muestra la foto del cliente, o la duda explicita.
 *
 * Nunca devuelve "el mejor de los malos": o hay uno que pasa el piso Y le saca margen al segundo, o el
 * resultado es `ambiguous` y quien llama tiene que preguntar en vez de adivinar. Un producto por el que
 * nadie pregunto es peor que una pregunta de mas.
 */
export function bestVisualMatch(customerDescription: string, candidatos: VisualCandidate[]): VisualMatchResult {
  const clienteTokens = visualTokens(customerDescription);
  if (clienteTokens.size === 0 || candidatos.length === 0) return { match: null, candidates: [], ambiguous: false };

  // Un producto puede tener varias fotos: se queda con su mejor foto, no con la suma, para que tener
  // cinco fotos cargadas no sea una ventaja sobre tener una.
  const porProducto = new Map<string, VisualMatch>();
  for (const candidato of candidatos) {
    const score = visualScore(clienteTokens, candidato.description);
    const previo = porProducto.get(candidato.productId);
    if (!previo || score > previo.score) {
      porProducto.set(candidato.productId, { productId: candidato.productId, productName: candidato.productName, score });
    }
  }

  const ordenados = [...porProducto.values()]
    .filter((m) => m.score >= VISUAL_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.productId.localeCompare(b.productId));

  if (ordenados.length === 0) return { match: null, candidates: [], ambiguous: false };
  const [primero, segundo] = ordenados;
  if (segundo && primero.score - segundo.score < VISUAL_MIN_MARGIN) {
    return { match: null, candidates: ordenados, ambiguous: true };
  }
  return { match: primero, candidates: ordenados, ambiguous: false };
}
