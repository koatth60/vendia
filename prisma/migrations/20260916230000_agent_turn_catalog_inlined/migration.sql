-- Contador de la marca {{BLOQUE_CATALOGO}} (2026-09-16). AgentTurn ya guardaba el bloque compuesto por
-- el servidor, pero no si ese bloque salio como mensaje aparte o viajo adentro del mensaje del modelo,
-- asi que la tasa de omision de la marca - el numero con el que se sabe si el cambio sirvio - no se
-- podia consultar.

-- Migracion aditiva: una columna nueva con default, ninguna columna existente cambia. Las filas
-- anteriores quedan en false, que para ellas es el valor correcto: son de antes de que la marca
-- existiera, asi que ninguna viajo adentro del mensaje.
ALTER TABLE "AgentTurn" ADD COLUMN "catalogInlined" BOOLEAN NOT NULL DEFAULT false;
