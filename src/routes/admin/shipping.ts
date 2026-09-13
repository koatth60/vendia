import { Router } from "express";
import {
  listShippingRates,
  createShippingRate,
  updateShippingRate,
  deleteShippingRate,
  listShippingCityRules,
  createShippingCityRule,
  deleteShippingCityRule,
} from "../../catalog/shippingRates";
import { requireOwner } from "../../auth/requireOwner";
import { businessIdOf } from "./shared";

// Fase 4 (ver ONIX-CRM-REORG-PLAN.md): interfaz para ShippingRate/ShippingCityRule, la deuda de P8
// del diagnostico original - el agente ya consultaba estas tablas con get_shipping_rates y
// get_shipping_rate_for_city, pero solo se podian cargar con scripts/seed-magimp-shipping.ts.
export const shippingRouter = Router();

shippingRouter.get("/api/shipping-rates", async (req, res) => {
  res.json(await listShippingRates(businessIdOf(req)));
});

shippingRouter.post("/api/shipping-rates", requireOwner, async (req, res) => {
  const label = String(req.body?.label ?? "").trim();
  const cost = Number(req.body?.cost);
  if (!label || !Number.isFinite(cost) || cost < 0) {
    res.status(400).json({ error: "Falta el nombre de la tarifa o el costo no es válido" });
    return;
  }
  const rate = await createShippingRate(businessIdOf(req), {
    label,
    cost,
    sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : undefined,
  });
  res.status(201).json(rate);
});

shippingRouter.put("/api/shipping-rates/:id", requireOwner, async (req, res) => {
  try {
    const rate = await updateShippingRate(businessIdOf(req), String(req.params.id), {
      label: req.body?.label !== undefined ? String(req.body.label).trim() : undefined,
      cost: req.body?.cost !== undefined ? Number(req.body.cost) : undefined,
      sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : undefined,
    });
    res.json(rate);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo actualizar la tarifa" });
  }
});

shippingRouter.delete("/api/shipping-rates/:id", requireOwner, async (req, res) => {
  try {
    await deleteShippingRate(businessIdOf(req), String(req.params.id));
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo eliminar la tarifa" });
  }
});

shippingRouter.get("/api/shipping-city-rules", async (req, res) => {
  res.json(await listShippingCityRules(businessIdOf(req)));
});

shippingRouter.post("/api/shipping-city-rules", requireOwner, async (req, res) => {
  const city = String(req.body?.city ?? "").trim();
  const label = String(req.body?.label ?? "").trim();
  if (!city || !label) {
    res.status(400).json({ error: "Falta la ciudad o la tarifa a la que apunta" });
    return;
  }
  try {
    const rule = await createShippingCityRule(businessIdOf(req), { city, label });
    res.status(201).json(rule);
  } catch (error) {
    // Choque del unique (businessId, normalizedCity) - la misma ciudad no puede apuntar a dos tarifas.
    res.status(400).json({ error: "Esa ciudad ya tiene una regla configurada" });
  }
});

shippingRouter.delete("/api/shipping-city-rules/:id", requireOwner, async (req, res) => {
  try {
    await deleteShippingCityRule(businessIdOf(req), String(req.params.id));
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo eliminar la regla" });
  }
});
