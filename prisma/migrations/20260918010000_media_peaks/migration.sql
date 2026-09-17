-- La forma de onda de cada nota de voz, calculada por el servidor con ffmpeg al guardar el mensaje
-- (44 valores de 0 a 99 separados por comas, ver extractPeaks en src/media/voiceNote.ts).
--
-- El panel sabe calcularla solo, pero para eso tiene que descargarse el audio con fetch, y los audios se
-- sirven con una URL firmada de S3: sin CORS habilitado en el bucket ese fetch no se puede hacer y la
-- onda no aparece nunca. Guardada, viaja con el mensaje y no depende de como este configurado el bucket.
ALTER TABLE "Message" ADD COLUMN "mediaPeaks" TEXT;
