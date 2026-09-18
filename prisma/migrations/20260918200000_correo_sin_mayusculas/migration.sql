-- E29: el correo deja de distinguir mayusculas, y la garantia vive en la base y no en las rutas.
--
-- Primero se normalizan los datos que ya estan. Si dos filas colisionan al pasarlas a minusculas, este
-- UPDATE falla y la migracion no se aplica: es a proposito. Dos cuentas con el mismo correo escrito
-- distinto son un conflicto que tiene que resolver una persona, decidiendo cual se queda -- no algo que
-- una migracion deba resolver sola borrando una.
UPDATE "Business" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));
UPDATE "TeamMember" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));

-- Y despues la garantia. Con estos indices, dos cuentas que solo difieren en mayusculas NO PUEDEN
-- EXISTIR, aunque una ruta futura se olvide de normalizar. El helper normalizarCorreo() es para que el
-- error salga como un 400 claro; esto es lo que lo hace imposible.
CREATE UNIQUE INDEX "Business_email_lower_key" ON "Business" (lower("email"));
CREATE UNIQUE INDEX "TeamMember_email_lower_key" ON "TeamMember" (lower("email"));
