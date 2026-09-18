-- La ficha visual de cada foto del catalogo (2026-09-18, etapa E12b paso 2).
--
-- Caso real del 2026-09-18 01:59 UTC: una clienta manda la captura de un reloj REDONDO y compacto. La
-- vision corrio y escalo a claude-sonnet-5, describio bien la foto ("pantalla redonda"), y aun asi el
-- bot le mando cinco archivos de dos relojes deportivos de 49 mm.
--
-- El motivo, leido del codigo: la descripcion de la vision se comparaba contra el NOMBRE de los
-- productos ("Serie 12 Ultra 3 (Edicion Deportiva / Robusta)"). La palabra que distinguia al producto
-- -redondo- no esta en ningun nombre del catalogo, asi que el dato que decidia nunca participo de la
-- comparacion.
--
-- Con estas columnas, cada foto del catalogo guarda lo que el mismo modelo de vision VE en ella, con el
-- mismo vocabulario que usa al mirar la foto del cliente. El emparejamiento pasa a ser descripcion
-- contra descripcion.
--
-- Aditivas y nullable: una foto sin indexar no participa del emparejamiento y el sistema se comporta
-- como antes. Reversible sin perder nada: son cache reconstruible con
-- `npx tsx scripts/index-catalog-photos.ts`.
ALTER TABLE "ProductMedia" ADD COLUMN "visionDescription" TEXT;
ALTER TABLE "ProductMedia" ADD COLUMN "visionDescriptionAt" TIMESTAMP(3);
