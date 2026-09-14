// Prompt compartido por DeepSeek (src/ai/vision.ts) y la escalacion a Anthropic
// (src/ai/visionEscalation.ts) - mismo formato de respuesta (COMPROBANTE:/PRODUCTO:/
// PRODUCTO_POCO_CLARO:/OTRO:) para que el caller pueda tratar ambas fuentes igual.
export function buildVisionPrompt(catalogHint: string): string {
  const catalogSection = catalogHint
    ? `\n\nCONTEXTO DEL NEGOCIO: este negocio vende: ${catalogHint}. Buscá activamente si alguno de
estos productos aparece en la imagen, aunque lo principal que se vea sea una persona (puesto,
sostenido, de fondo, parcialmente visible) - NO la clasifiques como "OTRO" solo porque hay una
persona en la foto. Es muy comun que un cliente mande una captura de un live o video mostrando el
producto puesto o en la mano.`
    : "";

  return `Estas mirando una imagen que un cliente mando por WhatsApp a un negocio de ventas.${catalogSection}

Primero decidi que tipo de imagen es:

1. COMPROBANTE DE PAGO (transferencia bancaria, Nequi, Daviplata, etc): describi en 1-2 frases el monto,
el metodo/banco y la fecha si se alcanzan a leer. Si el monto o los datos no se leen bien, decilo
explicitamente.

2. PRODUCTO, imagen CLARA (foto de un producto, captura de un live/video, captura de otro chat o red
social mostrando un articulo, un producto puesto/sostenido por una persona, etc, donde SI se distinguen
bien los detalles): el cliente probablemente esta preguntando "es este el que tienen?" sin saber el
nombre exacto. Describi el articulo en detalle visual util para buscarlo en un catalogo: tipo de
producto, color(es), forma, material aparente, y cualquier texto/marca/modelo visible en la imagen. Se
especifico (ej: "reloj inteligente negro, pantalla rectangular, correa de silicona" en vez de "un
reloj").

3. PRODUCTO que NO PODES IDENTIFICAR, por cualquiera de estas dos razones: (a) la imagen no lo deja ver
- borrosa, muy oscura, muy lejos, cortada, con movimiento; o (b) se ve nitida, pero no hay marca, modelo
ni detalle distintivo legible que permita decir CUAL producto es (empaque generico, varios articulos
sueltos dentro de una caja). Decilo explicitamente y en que consiste el problema. Nunca adivines el tipo
de articulo para llenar el hueco: si no podes confirmar que es, "no se identifica" es la respuesta
correcta, y una descripcion inventada es peor que ninguna - manda a buscar el producto equivocado.

4. OTRA COSA (persona sin ningun producto relacionado al negocio, paisaje, meme, etc): decilo en una
frase corta.

Empeza la respuesta con "COMPROBANTE:", "PRODUCTO:", "PRODUCTO_POCO_CLARO:" o "OTRO:" segun corresponda,
seguido de la descripcion. No agregues nada mas.`;
}
