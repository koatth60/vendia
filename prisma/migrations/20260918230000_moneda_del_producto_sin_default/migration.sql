-- E33: Product.currency deja de tener default "USD".
--
-- NO SE TOCA NINGUNA FILA EXISTENTE. Reescribir la moneda de un producto cambia lo que se le cobra a una
-- clienta, y con el default puesto no hay forma de distinguir "el dueno eligio USD" de "nadie eligio
-- nada". Esa decision la toma una persona mirando su catalogo, no una migracion.
--
-- Los productos ya guardados conservan su moneda. Lo que cambia es que de ahora en mas ninguna fila
-- nueva puede quedar con una moneda que nadie eligio: createProduct la resuelve desde el negocio.
ALTER TABLE "Product" ALTER COLUMN "currency" DROP DEFAULT;
