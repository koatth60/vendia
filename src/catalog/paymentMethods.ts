import { prisma } from "../db/client";

export async function listPaymentMethods(businessId: string) {
  return prisma.paymentMethod.findMany({
    where: { businessId },
    orderBy: { createdAt: "asc" },
  });
}

export async function listActivePaymentMethods(businessId: string) {
  return prisma.paymentMethod.findMany({
    where: { businessId, active: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createPaymentMethod(
  businessId: string,
  data: { type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO"; label: string; details: string }
) {
  return prisma.paymentMethod.create({ data: { ...data, businessId } });
}

export async function deletePaymentMethod(businessId: string, id: string) {
  const method = await prisma.paymentMethod.findFirst({ where: { id, businessId } });
  if (!method) throw new Error("Metodo de pago no encontrado");
  return prisma.paymentMethod.delete({ where: { id } });
}

export async function togglePaymentMethod(businessId: string, id: string, active: boolean) {
  const method = await prisma.paymentMethod.findFirst({ where: { id, businessId } });
  if (!method) throw new Error("Metodo de pago no encontrado");
  return prisma.paymentMethod.update({ where: { id }, data: { active } });
}

export async function updatePaymentMethod(
  businessId: string,
  id: string,
  data: Partial<{ type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO"; label: string; details: string; active: boolean }>
) {
  const method = await prisma.paymentMethod.findFirst({ where: { id, businessId } });
  if (!method) throw new Error("Metodo de pago no encontrado");
  return prisma.paymentMethod.update({ where: { id }, data });
}
