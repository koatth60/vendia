-- Pieza 5 del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md), en MODO SOMBRA. Migracion
-- aditiva: una columna nueva con default, ninguna columna existente cambia, toda fila anterior queda
-- valida tal cual (las de antes de este cambio quedan con el array vacio, que significa exactamente lo
-- mismo que significaria si la validacion hubiera corrido y no hubiera marcado nada).

-- Lo que la validacion contra el catalogo real HABRIA marcado en el texto de ese turno: un JSON por
-- hallazgo, {kind, value, line}. En modo sombra esto es lo unico que la validacion produce - no cambia
-- ni un byte de lo que recibe el cliente.
ALTER TABLE "AgentTurn" ADD COLUMN "shadowFindings" TEXT[] DEFAULT ARRAY[]::TEXT[];
