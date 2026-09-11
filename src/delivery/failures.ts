import { prisma } from "../db/client";
import { emitDeliveryFailure } from "../realtime/events";

export async function recordDeliveryFailure(
  businessId: string,
  data: { wamid: string; recipientPhone: string; errorCode: number | null; errorMessage: string; critical: boolean }
) {
  const failure = await prisma.deliveryFailure.create({
    data: { businessId, ...data },
  });
  emitDeliveryFailure(businessId, {
    id: failure.id,
    recipientPhone: failure.recipientPhone,
    errorMessage: failure.errorMessage,
    critical: failure.critical,
    createdAt: failure.createdAt,
  });
  return failure;
}

export async function listUnresolvedDeliveryFailures(businessId: string) {
  return prisma.deliveryFailure.findMany({
    where: { businessId, resolved: false },
    orderBy: { createdAt: "desc" },
  });
}

// Full history (resolved + unresolved) for the platform admin's conversation view - unlike
// listUnresolvedDeliveryFailures, this isn't scoped to "still needs attention".
export async function listDeliveryFailuresForBusiness(businessId: string, limit = 200) {
  return prisma.deliveryFailure.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function resolveDeliveryFailure(businessId: string, id: string): Promise<void> {
  const result = await prisma.deliveryFailure.updateMany({
    where: { id, businessId },
    data: { resolved: true },
  });
  if (result.count === 0) throw new Error("Fallo de entrega no encontrado");
}
