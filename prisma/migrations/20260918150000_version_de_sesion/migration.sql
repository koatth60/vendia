-- E28: version de sesion, para poder cortar sesiones vivas.
--
-- Escrita a mano y sin DROP de nada, por la deriva de esquema del 2026-09-17
-- (Conversation_pendingConfirmationNextAttemptAt_idx). Ninguna migracion de este plan borra nada.
ALTER TABLE "Business" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TeamMember" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
