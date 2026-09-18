-- E06: quien escribio un mensaje ASSISTANT, el bot o una persona desde el panel.
ALTER TABLE "Message" ADD COLUMN "humanAuthor" BOOLEAN NOT NULL DEFAULT false;
