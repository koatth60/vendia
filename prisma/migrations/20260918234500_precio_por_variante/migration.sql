-- E36: una talla XL puede costar mas que una S.
--
-- NULL significa "el precio del producto", no "gratis". Con un default de 0, cada catalogo existente
-- pasaria a tener todas sus variantes a cero y el bot venderia regalado hasta que alguien lo viera.
-- Con null, los catalogos de hoy se comportan exactamente igual que antes.
ALTER TABLE "ProductVariant" ADD COLUMN "price" DECIMAL(12,2);
