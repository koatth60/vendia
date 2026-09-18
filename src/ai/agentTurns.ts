import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../db/client";
import { parseFinding, type CatalogFinding } from "../catalog/outputValidation";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, pieza 7).
//
// Una fila por turno del agente. Best-effort a proposito, igual que recordAgentIncident: si registrar
// falla, se loguea y el turno sigue. Un turno que respondio bien pero no se pudo auditar es un problema
// de observabilidad; un turno que no responde porque la auditoria fallo es un problema del cliente.

export interface AgentTurnRecord {
  businessId: string;
  conversationId: string;
  iterations: number;
  /** Herramientas llamadas en orden, repetidas incluidas. */
  toolsCalled: string[];
  /** Herramienta forzada por tool_choice en la primera llamada, si hubo. */
  forcedTool: string | null;
  /** Alcance resuelto por el servidor (ver describeScope en src/catalog/scope.ts). */
  scope: string;
  /** Texto exacto de cada bloque enviado, en orden. */
  blocks: string[];
  /**
   * true = el modelo puso la marca {{BLOQUE_CATALOGO}} y el bloque viajo adentro de su mensaje; false =
   * salio como mensaje aparte, o no hubo bloque. Sin esto la tasa de omision de la marca no se puede
   * consultar, y es el numero con el que se sabe si el cambio del 2026-09-16 sirvio.
   */
  catalogInlined: boolean;
  /**
   * UN SOLO AUTOR (2026-09-16): "modelo" cuando el agente escribio el mensaje entero con los datos
   * estructurados del servidor y la verificacion contra el catalogo lo aprobo, "servidor" cuando la
   * verificacion fallo dos veces y salio el bloque compuesto desde la base. null cuando el turno no
   * paso por ese camino. Es el denominador de la tasa de caida al fallback.
   */
  catalogAuthor: "modelo" | "servidor" | null;
  /**
   * E76 (2026-09-18): quien resolvio el efecto requerido de este turno. Mismo criterio que
   * catalogAuthor, para el otro camino donde el servidor puede terminar escribiendo el mensaje.
   *
   * "servidor" y "escalado" son turnos donde el texto lo escribio el codigo, no el modelo. Esa tasa,
   * sobre los turnos que exigian algun efecto, es la que dice si el agente esta mejorando o si el
   * servidor solo aprendio a taparlo mejor - y es la que la medida del norte (lineas del prompt) no ve.
   */
  effectAuthor: "modelo" | "reintento" | "servidor" | "escalado" | null;
  /** Ids de producto cuyos medios salieron con esos bloques. */
  mediaProductIds: string[];
  /**
   * Pieza 5, MODO SOMBRA: lo que la validacion contra el catalogo HABRIA marcado en el texto de este
   * turno, serializado (ver serializeFinding en src/catalog/outputValidation.ts). Vacio en el caso
   * normal. Registrar no es actuar: el cliente ya recibio el texto sin tocar.
   */
  shadowFindings: string[];
}

export async function recordAgentTurn(turn: AgentTurnRecord): Promise<void> {
  try {
    await prisma.agentTurn.create({ data: turn });
  } catch (error) {
    console.error("No se pudo registrar un AgentTurn (no bloqueante):", error);
  }
}

// E76 (2026-09-18): EL DENOMINADOR DEL AGENTE.
//
// La medida del norte que fijo el dueno es "las lineas de systemPrompt.ts tienen que ir BAJANDO
// mientras los errores se mantienen en cero". Esa medida sola se puede cumplir con Onix funcionando
// como chatbot: cada vez que el fallback por codigo resuelve el efecto, el cliente recibe TEXTO FIJO
// escrito por nosotros. El prompt baja, los errores quedan en cero, y el agente escribio menos.
//
// Por eso este numero va AL LADO de las lineas del prompt, no en otra pantalla: el prompt bajando con
// la tasa de servidor subiendo no es progreso, es el servidor tapandolo mejor.
//
// Hasta ahora esto solo existia en `requiredEffectStats`, un contador en memoria que se pierde en cada
// reinicio - y el 2026-09-17 hubo trece despliegues en un dia. Una metrica que se borra trece veces por
// dia no permite comparar dos semanas.

const PROMPT_PATH = join(__dirname, "prompts", "systemPrompt.ts");
let promptLinesCache: number | null | undefined;

/**
 * Lineas de systemPrompt.ts, la mitad que ya se venia midiendo a mano. Se lee del disco una sola vez:
 * el archivo no cambia sin reiniciar el proceso. null si no se pudo leer - es un numero informativo y
 * no vale hacer fallar la pantalla de metricas por el.
 */
export function promptLineCount(): number | null {
  if (promptLinesCache !== undefined) return promptLinesCache;
  try {
    promptLinesCache = readFileSync(PROMPT_PATH, "utf8").split("\n").length;
  } catch {
    promptLinesCache = null;
  }
  return promptLinesCache;
}

export interface AgentAuthorshipSummary {
  days: number;
  /**
   * Turnos que EXIGIERON algun efecto. Es el denominador, y por eso esta primero: "12 turnos con
   * fallback" no dice nada sin saber sobre cuantos.
   *
   * Los turnos sin efectos requeridos no entran (guardan null). Los turnos anteriores a la migracion
   * del 2026-09-18 tambien guardan null, asi que tampoco entran: la serie arranca vacia a proposito en
   * vez de mezclar turnos sin dato con turnos que el modelo resolvio.
   */
  turnsWithRequiredEffects: number;
  byAuthor: { modelo: number; reintento: number; servidor: number; escalado: number };
  /**
   * (servidor + escalado) / turnos. LA TASA QUE IMPORTA: la proporcion de turnos donde el mensaje lo
   * escribio el codigo y no el agente. null cuando no hubo ningun turno con efectos en la ventana -
   * null es "no se sabe", que no es lo mismo que 0.
   */
  serverWroteRate: number | null;
  /** modelo / turnos: lo hizo solo, a la primera, sin que nadie lo empujara. */
  modelSolvedRate: number | null;
  /** Lineas de systemPrompt.ts. Va en la misma respuesta para que los dos numeros se lean juntos. */
  promptLines: number | null;
}

const AUTORES = ["modelo", "reintento", "servidor", "escalado"] as const;

export async function getAgentAuthorshipSummary(businessId: string, days = 7): Promise<AgentAuthorshipSummary> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const filas = await prisma.agentTurn.groupBy({
    by: ["effectAuthor"],
    where: { businessId, createdAt: { gte: since }, effectAuthor: { not: null } },
    _count: { _all: true },
  });

  const byAuthor = { modelo: 0, reintento: 0, servidor: 0, escalado: 0 };
  for (const fila of filas) {
    const autor = fila.effectAuthor;
    // Un valor que no este en la lista seria un dato viejo o corrupto: se ignora en vez de romper la
    // pantalla, pero no se suma al denominador, porque no se sabe que es.
    if (autor && (AUTORES as readonly string[]).includes(autor)) {
      byAuthor[autor as (typeof AUTORES)[number]] = fila._count._all;
    }
  }

  const turnsWithRequiredEffects = byAuthor.modelo + byAuthor.reintento + byAuthor.servidor + byAuthor.escalado;
  const tasa = (n: number) => (turnsWithRequiredEffects === 0 ? null : n / turnsWithRequiredEffects);

  return {
    days,
    turnsWithRequiredEffects,
    byAuthor,
    serverWroteRate: tasa(byAuthor.servidor + byAuthor.escalado),
    modelSolvedRate: tasa(byAuthor.modelo),
    promptLines: promptLineCount(),
  };
}

// Pieza 5 del plan de catalogo y medios, MODO SOMBRA: lo que la validacion contra el catalogo HABRIA
// marcado en la ventana. Es el numero con el que se decide si se activa o no - sin el, activar seria
// apostar. Ver src/catalog/outputValidation.ts.

export interface ShadowValidationDetection {
  conversationId: string;
  customerId: string | null;
  customerName: string | null;
  createdAt: Date;
  /** "none", "all:16", etc. Un hallazgo con alcance resuelto seria un defecto del validador. */
  scope: string;
  /** Cuantas herramientas llamo ese turno. Cero es el caso que esta pieza vino a cubrir. */
  toolsCalled: number;
  findings: CatalogFinding[];
}

export interface ShadowValidationSummary {
  days: number;
  /** Turnos registrados en la ventana. El denominador: sin el, "8 detecciones" no dice nada. */
  turns: number;
  /** Turnos con al menos un hallazgo. */
  flaggedTurns: number;
  /**
   * Hallazgos sumados SOBRE LA MUESTRA que se devuelve, no sobre la ventana entera: un turno puede
   * traer varios, y contarlos todos obligaria a traer el texto de cada fila marcada. El numero de la
   * ventana es flaggedTurns.
   */
  findingsInSample: number;
  /** Los ultimos casos, para poder mirarlos: que texto, que precio o nombre, en que conversacion. */
  detections: ShadowValidationDetection[];
}

export async function getShadowValidationSummary(
  businessId: string,
  days = 7,
  sampleSize = 20
): Promise<ShadowValidationSummary> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = { businessId, createdAt: { gte: since } };

  const [turns, flaggedTurns, flagged] = await Promise.all([
    prisma.agentTurn.count({ where }),
    prisma.agentTurn.count({ where: { ...where, shadowFindings: { isEmpty: false } } }),
    prisma.agentTurn.findMany({
      where: { ...where, shadowFindings: { isEmpty: false } },
      orderBy: { createdAt: "desc" },
      take: sampleSize,
      select: { conversationId: true, createdAt: true, scope: true, toolsCalled: true, shadowFindings: true },
    }),
  ]);

  // AgentTurn.conversationId es una columna suelta (no hay relacion declarada), asi que el nombre del
  // cliente se resuelve en una segunda consulta acotada a las conversaciones de la muestra.
  const conversations = await prisma.conversation.findMany({
    where: { id: { in: flagged.map((t) => t.conversationId) } },
    select: { id: true, customerId: true, customer: { select: { name: true } } },
  });
  const byConversation = new Map(conversations.map((c) => [c.id, c]));

  let findingsInSample = 0;
  const detections: ShadowValidationDetection[] = flagged.map((turn) => {
    const parsed = turn.shadowFindings.map(parseFinding).filter((f): f is CatalogFinding => f !== null);
    findingsInSample += parsed.length;
    const conversation = byConversation.get(turn.conversationId);
    return {
      conversationId: turn.conversationId,
      customerId: conversation?.customerId ?? null,
      customerName: conversation?.customer.name ?? null,
      createdAt: turn.createdAt,
      scope: turn.scope,
      toolsCalled: turn.toolsCalled.length,
      findings: parsed,
    };
  });

  return { days, turns, flaggedTurns, findingsInSample, detections };
}
