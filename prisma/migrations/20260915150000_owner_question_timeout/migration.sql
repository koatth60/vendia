-- Correccion Fase 4 del plan maestro (2026-09-15): escape para blockedBy cuando el dueno nunca responde
-- una pregunta escalada (PendingOwnerQuestion). Configurable por negocio, default 24h.
ALTER TABLE "Business" ADD COLUMN     "ownerQuestionTimeoutHours" INTEGER NOT NULL DEFAULT 24;

-- Nuevo tipo de incidente: el timeout se cumplio y la conversacion paso a control humano sin que el
-- dueno respondiera.
ALTER TYPE "AgentIncidentKind" ADD VALUE 'OWNER_QUESTION_TIMEOUT';
