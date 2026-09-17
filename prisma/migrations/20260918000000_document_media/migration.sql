-- El panel ahora puede mandarle documentos al cliente (PDF, DOCX, XLSX, PPTX), no solo foto y video.
-- El nombre del archivo se guarda porque WhatsApp lo muestra en la burbuja del documento y el panel
-- tiene que mostrar lo mismo: sin el, un pedido llega como "documento" y nadie sabe cual era.
ALTER TYPE "MediaType" ADD VALUE 'DOCUMENT';
ALTER TABLE "Message" ADD COLUMN "mediaFilename" TEXT;
