-- UN SOLO AUTOR (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 11). Migracion aditiva: una columna nueva
-- nullable, ninguna columna existente cambia, toda fila anterior queda valida tal cual (las de antes de
-- este cambio quedan en NULL, que significa exactamente lo que significa hoy: ese turno no paso por el
-- camino de un solo autor, porque todavia no existia).

-- Quien escribio el mensaje de catalogo que recibio el cliente: "modelo" cuando el agente lo escribio
-- entero con los datos estructurados del servidor y la verificacion contra el catalogo lo aprobo,
-- "servidor" cuando la verificacion fallo dos veces y salio el bloque compuesto desde la base. Es el
-- denominador de la tasa de caida al fallback; el incidente solo da el numerador.
ALTER TABLE "AgentTurn" ADD COLUMN "catalogAuthor" TEXT;
