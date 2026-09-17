import { Router } from "express";
import type { ShippingPaymentModality } from "@prisma/client";
import {
  listShippingRates,
  createShippingRate,
  updateShippingRate,
  deleteShippingRate,
  listShippingCityRulesPage,
  createShippingCityRule,
  deleteShippingCityRule,
} from "../../catalog/shippingRates";
import { requireOwner } from "../../auth/requireOwner";
import { businessIdOf } from "./shared";

// Fase 4 (ver ONIX-CRM-REORG-PLAN.md): interfaz para ShippingRate/ShippingCityRule, la deuda de P8
// del diagnostico original - el agente ya consultaba estas tablas con get_shipping_rates y
// get_shipping_rate_for_city, pero solo se podian cargar con scripts/seed-magimp-shipping.ts.
export const shippingRouter = Router();

// Las modalidades de pago del envio que aplican en una zona. Un valor que no sea uno de los tres se
// descarta en vez de guardarse: la columna es un enum y un formulario a medias no puede dejar una tarifa
// con una modalidad que el codigo no sabe leer. `undefined` (el campo no vino) deja la lista como esta.
const MODALIDADES = ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"];

function modalidadesValidas(valor: unknown): ShippingPaymentModality[] | undefined {
  if (!Array.isArray(valor)) return undefined;
  return valor.map((v) => String(v)).filter((v): v is ShippingPaymentModality => MODALIDADES.includes(v));
}

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
    paymentModalities: modalidadesValidas(req.body?.paymentModalities),
  });
  res.status(201).json(rate);
});

shippingRouter.put("/api/shipping-rates/:id", requireOwner, async (req, res) => {
  try {
    const rate = await updateShippingRate(businessIdOf(req), String(req.params.id), {
      label: req.body?.label !== undefined ? String(req.body.label).trim() : undefined,
      cost: req.body?.cost !== undefined ? Number(req.body.cost) : undefined,
      sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : undefined,
      paymentModalities: modalidadesValidas(req.body?.paymentModalities),
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

// Paginado (feedback del dueño, 2026-09-13: una sola ciudad ambigua puede llevar a cientos de
// reglas). page/pageSize en vez de cursor: a diferencia de Clientes, acá no hay un campo de
// "actividad reciente" con el que ordenar de forma estable - createdAt asc alcanza, y con
// pageSize fijo no hace falta el manejo de cursor-repetido-por-insert que Clientes sí necesitaba.
const SHIPPING_CITY_RULES_PAGE_SIZE = 20;

shippingRouter.get("/api/shipping-city-rules", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
  const { items, total } = await listShippingCityRulesPage(
    businessIdOf(req),
    (page - 1) * SHIPPING_CITY_RULES_PAGE_SIZE,
    SHIPPING_CITY_RULES_PAGE_SIZE,
    q
  );
  res.json({ items, total, page, pageSize: SHIPPING_CITY_RULES_PAGE_SIZE });
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
