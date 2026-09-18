import { Router } from "express";
import {
  listCustomerThreadsForBusiness,
  decodeInboxCursor,
  getCustomerThreadForBusiness,
  setCustomerTags,
  saveCustomerName,
} from "../../conversation/service";
import {
  listCustomersForBusiness,
  getCustomerProfile,
  updateCustomerProfile,
  getCustomerTimeline,
  addCustomerNote,
  deleteCustomerNote,
  listCustomerTags,
  createCustomerTag,
  deleteCustomerTag,
} from "../../crm/customers";
import { requireOwner } from "../../auth/requireOwner";
import { businessIdOf } from "./shared";

export const customersRouter = Router();

customersRouter.put("/api/customers/:id/tags", async (req, res) => {
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [];
  const customer = await setCustomerTags(businessIdOf(req), String(req.params.id), tags);
  if (!customer) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json({ id: customer.id, tags: customer.tags });
});

customersRouter.put("/api/customers/:id/name", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const customer = await saveCustomerName(businessIdOf(req), String(req.params.id), name || null);
  if (!customer) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json({ id: customer.id, name: customer.name });
});


// Grouped-by-customer view of the Conversaciones list (see ONIX-CONVERSATIONS-GROUPING-PLAN.md) - one
// row per customer instead of one per Conversation, so a customer whose last sale already closed
// doesn't reappear as a second, unrelated-looking row the next time they write in. The underlying data
// model is untouched: /api/conversations/:id and everything under it still operate on a single
// Conversation id (the customer row's activeConversationId).
// PAGINADA (2026-09-18). Traia TODOS los clientes del negocio de una: 72 conversaciones el dia que se
// midio, con la ultima linea de cada uno, en la primera pantalla. La respuesta cambia de forma - de un
// array a `{ items, nextCursor }` - a proposito: un endpoint que devuelve un array no tiene donde decir
// "hay mas", y ese es justamente el dato que faltaba.
customersRouter.get("/api/customers", async (req, res) => {
  const limit = Number(req.query.limit) || undefined;
  const cursor = decodeInboxCursor(typeof req.query.cursor === "string" ? req.query.cursor : undefined);
  const page = await listCustomerThreadsForBusiness(businessIdOf(req), { limit, cursor });
  res.json(page);
});

customersRouter.get("/api/customers/:id/thread", async (req, res) => {
  const before = typeof req.query.before === "string" ? req.query.before : undefined;
  const thread = await getCustomerThreadForBusiness(businessIdOf(req), String(req.params.id), before);
  if (!thread) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json(thread);
});


// ---------------------------------------------------------------------------------------------
// CRM (Fase 2, ver ONIX-CRM-REORG-PLAN.md). Prefijo /api/crm/ a proposito: /api/customers ya existe
// y lo consume la Bandeja (vista agrupada por cliente de las conversaciones). Son dos lecturas
// distintas del mismo dato y cambiar la forma de la vieja habria roto la Bandeja.
// ---------------------------------------------------------------------------------------------

customersRouter.get("/api/crm/customers", async (req, res) => {
  const result = await listCustomersForBusiness(businessIdOf(req), {
    q: typeof req.query.q === "string" ? req.query.q : undefined,
    stage: typeof req.query.stage === "string" ? req.query.stage : undefined,
    tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
    cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json(result);
});

customersRouter.get("/api/crm/customers/:id", async (req, res) => {
  const profile = await getCustomerProfile(businessIdOf(req), String(req.params.id));
  if (!profile) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json(profile);
});

customersRouter.put("/api/crm/customers/:id", async (req, res) => {
  const updated = await updateCustomerProfile(businessIdOf(req), String(req.params.id), {
    name: req.body?.name,
    email: req.body?.email,
    address: req.body?.address,
    idNumber: req.body?.idNumber,
    deliveryPhone: req.body?.deliveryPhone,
    source: req.body?.source,
    stage: req.body?.stage,
    tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
  });
  if (!updated) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json({ id: updated.id });
});

customersRouter.get("/api/crm/customers/:id/timeline", async (req, res) => {
  const timeline = await getCustomerTimeline(businessIdOf(req), String(req.params.id));
  if (!timeline) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.json(timeline);
});

customersRouter.post("/api/crm/customers/:id/notes", async (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) {
    res.status(400).json({ error: "La nota no puede estar vacia" });
    return;
  }
  // El autor se resuelve desde la sesion, no desde el body: quien escribio la nota no es algo que el
  // cliente del navegador deba poder elegir.
  const authorName = req.session.role === "EMPLOYEE" ? req.session.email ?? "Empleado" : "Dueño";
  const note = await addCustomerNote(businessIdOf(req), String(req.params.id), body, authorName);
  if (!note) {
    res.status(404).json({ error: "Cliente no encontrado" });
    return;
  }
  res.status(201).json(note);
});

customersRouter.delete("/api/crm/notes/:id", async (req, res) => {
  const deleted = await deleteCustomerNote(businessIdOf(req), String(req.params.id));
  if (!deleted) {
    res.status(404).json({ error: "Nota no encontrada" });
    return;
  }
  res.status(204).send();
});

customersRouter.get("/api/crm/tags", async (req, res) => {
  res.json(await listCustomerTags(businessIdOf(req)));
});

customersRouter.post("/api/crm/tags", requireOwner, async (req, res) => {
  const label = String(req.body?.label ?? "").trim();
  if (!label) {
    res.status(400).json({ error: "Falta el nombre de la etiqueta" });
    return;
  }
  const tag = await createCustomerTag(businessIdOf(req), label, req.body?.color ? String(req.body.color) : undefined);
  res.status(201).json(tag);
});

customersRouter.delete("/api/crm/tags/:id", requireOwner, async (req, res) => {
  const deleted = await deleteCustomerTag(businessIdOf(req), String(req.params.id));
  if (!deleted) {
    res.status(404).json({ error: "Etiqueta no encontrada" });
    return;
  }
  res.status(204).send();
});
