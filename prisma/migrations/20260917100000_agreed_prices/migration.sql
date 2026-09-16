-- EL PRECIO ACORDADO (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 12). Migracion ADITIVA: una tabla nueva,
-- un valor nuevo en un enum existente y dos columnas nullables. Ninguna columna existente cambia de tipo
-- ni de nulabilidad, asi que toda fila anterior queda valida tal cual y el codigo viejo sigue leyendo lo
-- mismo que leia.

-- De donde salio la autorizacion del precio. Las dos son la duena: por WhatsApp (confirmando la pregunta
-- que le mando el agente) o a mano desde el panel. No hay un valor para "lo dijo el cliente".
CREATE TYPE "AgreedPriceSource" AS ENUM ('OWNER_REPLY', 'ADMIN_PANEL');

-- Un precio que la duena autorizo para este cliente y este producto, distinto del de catalogo. Mientras
-- exista esta fila, ESE es el precio del item; el catalogo pasa a ser el valor por defecto.
CREATE TABLE "AgreedPrice" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    -- El variantId, o '' cuando la linea no tiene variante: dos NULL no chocan en un indice unico de
    -- Postgres, asi que una columna nullable no impediria dos filas para el mismo producto sin variante.
    "variantKey" TEXT NOT NULL DEFAULT '',
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "source" "AgreedPriceSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgreedPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgreedPrice_conversationId_productId_variantKey_key"
    ON "AgreedPrice"("conversationId", "productId", "variantKey");

CREATE INDEX "AgreedPrice_conversationId_idx" ON "AgreedPrice"("conversationId");

ALTER TABLE "AgreedPrice" ADD CONSTRAINT "AgreedPrice_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- La pregunta de precio que el agente le manda a la duena. El valor nuevo no cambia ninguna fila
-- existente: todas siguen siendo TEXT o PHOTO_PRODUCT.
ALTER TYPE "PendingOwnerQuestionKind" ADD VALUE 'PRICE';

-- Las ranuras que el servidor espera llenar con la respuesta de la duena (los items exactos y sus
-- precios actuales), mas la propuesta que el servidor entendio y todavia no escribio. NULL para las
-- preguntas de texto y de foto, que es lo que era toda fila anterior a esta columna.
ALTER TABLE "PendingOwnerQuestion" ADD COLUMN "payload" JSONB;

-- El precio efectivamente cobrado por una linea de pedido cuando NO es el del catalogo. NULL = se cobro
-- el de catalogo, que es lo que significaba toda fila anterior. "unitPrice" sigue trayendo el precio
-- cobrado en las dos formas, asi que ningun total ya guardado cambia.
ALTER TABLE "OrderItem" ADD COLUMN "agreedUnitPrice" DECIMAL(12,2);
