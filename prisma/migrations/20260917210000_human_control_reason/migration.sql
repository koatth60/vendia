-- POR QUE una conversacion quedo en manos de una persona. Diez caminos ponen humanControl en true y seis
-- de ellos no los dispara ningun clic; sin esta columna, cual fue solo se puede inferir del horario de
-- los mensajes. Nullable a proposito: las conversaciones que ya estaban en control humano antes de esta
-- migracion no tienen forma de saberlo, y inventarles un motivo seria peor que dejarlo vacio.
CREATE TYPE "HumanControlReason" AS ENUM (
  'PANEL_TOGGLE',
  'PANEL_MESSAGE',
  'PANEL_TEMPLATE',
  'PANEL_QUEUE',
  'INTENT_ESCALATION',
  'PHOTO_ESCALATION',
  'OWNER_QUESTION_TIMEOUT',
  'SALE_CONFIRMATION_TIMEOUT',
  'STALE_REPLY',
  'REQUIRED_EFFECT'
);

ALTER TABLE "Conversation" ADD COLUMN "humanControlReason" "HumanControlReason";
