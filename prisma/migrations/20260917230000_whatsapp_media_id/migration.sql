-- Id de medio de Meta cacheado por foto/video de catalogo. Evita darle a Meta una URL de S3 para que la
-- descargue - la causa del error 131053 "Downloading media from weblink failed with http code 500", que
-- hacia que la foto nunca llegara sin que nadie se enterara hasta horas despues.
ALTER TABLE "ProductMedia" ADD COLUMN "whatsappMediaId" TEXT;
ALTER TABLE "ProductMedia" ADD COLUMN "whatsappMediaAt" TIMESTAMP(3);
ALTER TABLE "ProductMedia" ADD COLUMN "whatsappMediaPhoneId" TEXT;
