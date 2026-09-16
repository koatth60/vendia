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
