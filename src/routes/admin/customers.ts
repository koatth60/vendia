import { Router } from "express";
import {
  listCustomerThreadsForBusiness,
  getCustomerThreadForBusiness,
  setCustomerTags,
  saveCustomerName,
} from "../../conversation/service";
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
customersRouter.get("/api/customers", async (req, res) => {
  const customers = await listCustomerThreadsForBusiness(businessIdOf(req));
  res.json(customers);
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

