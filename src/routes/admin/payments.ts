import { Router } from "express";
import {
  listPaymentMethods,
  createPaymentMethod,
  deletePaymentMethod,
  togglePaymentMethod,
  updatePaymentMethod,
} from "../../catalog/paymentMethods";
import { requireOwner } from "../../auth/requireOwner";
import { businessIdOf } from "./shared";

export const paymentsRouter = Router();

paymentsRouter.get("/api/payment-methods", async (req, res) => {
  const methods = await listPaymentMethods(businessIdOf(req));
  res.json(methods);
});

paymentsRouter.post("/api/payment-methods", requireOwner, async (req, res) => {
  const { type, label, details } = req.body;
  if (!type || !label || !details) {
    res.status(400).json({ error: "Faltan campos obligatorios" });
    return;
  }
  const method = await createPaymentMethod(businessIdOf(req), { type, label, details });
  res.status(201).json(method);
});

paymentsRouter.put("/api/payment-methods/:id", requireOwner, async (req, res) => {
  const { type, label, details, active } = req.body;
  if (type === undefined && label === undefined && details === undefined) {
    const method = await togglePaymentMethod(businessIdOf(req), String(req.params.id), Boolean(active));
    res.json(method);
    return;
  }
  const method = await updatePaymentMethod(businessIdOf(req), String(req.params.id), { type, label, details, active });
  res.json(method);
});

paymentsRouter.delete("/api/payment-methods/:id", requireOwner, async (req, res) => {
  await deletePaymentMethod(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

