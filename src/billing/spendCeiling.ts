import { prisma } from "../db/client";
import { getChatCap, periodStartOf } from "./chats";

// EL FRENO DE GASTO.
//
// Hasta el 2026-09-17 el unico limite del sistema era el tope de mensajes del plan: pasarlo apagaba la
// respuesta automatica hasta el mes siguiente. Ese tope se fue cuando los planes pasaron a venderse por
// chats con excedente facturable (src/billing/chats.ts), y con el se fue lo unico que frenaba un gasto
// anomalo. Esto lo reemplaza, pero NO es lo mismo:
//
//   - El tope de chats es comercial. El cliente compro esos chats; pasarlos se factura, no se corta.
//   - Este techo es un cortacircuitos. Se cruza cuando algo anda mal, no cuando al negocio le va bien.
//
// Por eso el numero lo pone Zaqi en el panel de plataforma y no el dueno en el suyo, y por eso cuando
// se cruza el bot si deja de responder: a esa altura lo barato es un cliente esperando a una persona, y
// lo caro es seguir llamando al modelo sin saber por que.
//
// Se mide contra AiUsageLog, que ya registra el costo en USD de cada llamada. Es el mismo periodo
// calendario que los chats, para que el panel no tenga dos "este mes" distintos.

// Cuanto se le permite gastar a un negocio por cada chat que su plan le vende, antes de que esto salte.
//
// Medido en produccion el 2026-09-17, sobre el unico negocio con trafico real (MAGByLizN, plan
// EMPRENDEDOR): USD 1,0847 en 2.321 llamadas a la IA, con 62 clientes distintos en el mes. Eso da
// ~USD 0,0175 por interaccion. El default esta puesto en mas del TRIPLE de eso a proposito: tiene que
// aguantar un negocio caro (catalogo grande, muchas fotos) sin saltar nunca, y saltar igual mucho antes
// de que un bucle nos cueste algo que duela.
export const DEFAULT_CEILING_USD_PER_CHAT = 0.06;

/** El techo que le corresponde a un negocio que no tiene uno propio cargado. */
export function defaultCeilingUsd(planTier: string): number {
  return Math.round(getChatCap(planTier) * DEFAULT_CEILING_USD_PER_CHAT * 100) / 100;
}

export interface SpendStatus {
  planTier: string;
  /** El techo vigente, salga del campo del negocio o del default de su plan. */
  ceilingUsd: number;
  /** true si sale del default del plan (nadie le cargo uno propio a este negocio). */
  ceilingIsDefault: boolean;
  spentUsd: number;
  usagePercent: number;
  exceeded: boolean;
  periodStart: Date;
}

export async function getSpendStatus(businessId: string, now = new Date()): Promise<SpendStatus> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { planTier: true, aiSpendCeilingUsd: true },
  });
  const planTier = business?.planTier ?? "BASICO";
  const ceilingIsDefault = business?.aiSpendCeilingUsd == null;
  const ceilingUsd = ceilingIsDefault ? defaultCeilingUsd(planTier) : business!.aiSpendCeilingUsd!;
  const periodStart = periodStartOf(now);

  const aggregate = await prisma.aiUsageLog.aggregate({
    where: { businessId, createdAt: { gte: periodStart } },
    _sum: { costUsd: true },
  });
  const spentUsd = aggregate._sum.costUsd ?? 0;

  return {
    planTier,
    ceilingUsd,
    ceilingIsDefault,
    spentUsd,
    usagePercent: ceilingUsd <= 0 ? 0 : Math.round((spentUsd / ceilingUsd) * 1000) / 10,
    exceeded: ceilingUsd > 0 && spentUsd >= ceilingUsd,
    periodStart,
  };
}

/**
 * Lo mismo, mas si es la PRIMERA vez que se cruza en este periodo - lo unico que decide si hay que
 * avisar. Se llama en el camino del mensaje entrante, asi que el aviso sale una vez y no en cada turno.
 */
export async function checkSpendCeiling(
  businessId: string
): Promise<SpendStatus & { justCrossed: boolean }> {
  const status = await getSpendStatus(businessId);
  if (!status.exceeded) return { ...status, justCrossed: false };

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { spendCeilingNotifiedAt: true },
  });
  const justCrossed =
    !business?.spendCeilingNotifiedAt || business.spendCeilingNotifiedAt < status.periodStart;
  if (justCrossed) {
    await prisma.business.update({
      where: { id: businessId },
      data: { spendCeilingNotifiedAt: new Date() },
    });
  }

  return { ...status, justCrossed };
}
