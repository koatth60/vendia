import { Router } from "express";
import { listFaqEntries, createFaqEntry, updateFaqEntry, deleteFaqEntry } from "../../catalog/faq";
import { listPendingCandidates, approveCandidate, discardCandidate } from "../../catalog/learnedFaq";
import { requireOwner } from "../../auth/requireOwner";
import { businessIdOf } from "./shared";

export const faqRouter = Router();

faqRouter.get("/api/faq", async (req, res) => {
  const entries = await listFaqEntries(businessIdOf(req));
  res.json(entries);
});

faqRouter.post("/api/faq", requireOwner, async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    res.status(400).json({ error: "Faltan la pregunta o la respuesta" });
    return;
  }
  const entry = await createFaqEntry(businessIdOf(req), { question, answer });
  res.status(201).json(entry);
});

faqRouter.put("/api/faq/:id", requireOwner, async (req, res) => {
  const { question, answer, active } = req.body;
  const entry = await updateFaqEntry(businessIdOf(req), String(req.params.id), { question, answer, active });
  res.json(entry);
});

faqRouter.delete("/api/faq/:id", requireOwner, async (req, res) => {
  await deleteFaqEntry(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});


faqRouter.get("/api/faq-candidates", async (req, res) => {
  const candidates = await listPendingCandidates(businessIdOf(req));
  res.json(candidates);
});

faqRouter.post("/api/faq-candidates/:id/approve", requireOwner, async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    res.status(400).json({ error: "Faltan la pregunta o la respuesta" });
    return;
  }
  try {
    const entry = await approveCandidate(businessIdOf(req), String(req.params.id), { question, answer });
    res.status(201).json(entry);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo aprobar la sugerencia" });
  }
});

faqRouter.post("/api/faq-candidates/:id/discard", requireOwner, async (req, res) => {
  try {
    await discardCandidate(businessIdOf(req), String(req.params.id));
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "No se pudo descartar la sugerencia" });
  }
});

