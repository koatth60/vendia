-- E30: marca de "el secreto de este negocio no se pudo descifrar".
--
-- Escrita a mano, con UNA sola sentencia y sin DROP de nada. `prisma migrate dev` propondria ademas
-- borrar el indice Conversation_pendingConfirmationNextAttemptAt_idx, que existe en la base y ya no
-- esta declarado en schema.prisma (deriva encontrada el 2026-09-17). Ninguna migracion de este plan
-- borra nada: ese indice se decide aparte.
ALTER TABLE "Business" ADD COLUMN "secretsBroken" BOOLEAN NOT NULL DEFAULT false;
