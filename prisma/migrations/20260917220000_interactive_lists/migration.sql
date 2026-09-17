-- Listas interactivas de WhatsApp para presentar una categoria. Off por defecto: cambia la forma de un
-- mensaje que ve el cliente, y eso se enciende negocio por negocio despues de mirar una conversacion
-- real. Apagada, sale exactamente el texto numerado de hoy.
ALTER TABLE "Business" ADD COLUMN "interactiveListsEnabled" BOOLEAN NOT NULL DEFAULT false;
