-- E76: quien resolvio el efecto requerido de cada turno - el modelo, el reintento, el servidor
-- (fallback) o la escalacion. Es el denominador que falta para saber si el agente mejora o si el
-- servidor solo aprendio a taparlo mejor.
--
-- Aditiva, escrita a mano y sin DROP de nada, por la deriva de esquema del 2026-09-17.
ALTER TABLE "AgentTurn" ADD COLUMN "effectAuthor" TEXT;
