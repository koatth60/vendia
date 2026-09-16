import { prisma } from "../db/client";

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
  /** Ids de producto cuyos medios salieron con esos bloques. */
  mediaProductIds: string[];
}

export async function recordAgentTurn(turn: AgentTurnRecord): Promise<void> {
  try {
    await prisma.agentTurn.create({ data: turn });
  } catch (error) {
    console.error("No se pudo registrar un AgentTurn (no bloqueante):", error);
  }
}
