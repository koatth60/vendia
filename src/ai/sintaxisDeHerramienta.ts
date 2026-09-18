// LA SINTAXIS DE UNA HERRAMIENTA NUNCA LLEGA AL CLIENTE (2026-09-18).
//
// Dos veces medido en conversaciones de prueba, y una de ellas la vio el dueño en su propio panel: el
// modelo escribió la llamada a la herramienta como TEXTO, en vez de emitirla, y ese texto salió tal cual
// al chat de la clienta:
//
//   <｜｜DSML｜｜ calls>
//   <｜｜DSML｜｜ invoke name="set_shipping_modality">
//   <｜｜DSML｜｜ parameter name="modality" string="true">Contra entrega total (producto + envío)</...
//
// Son dos problemas y sólo uno es nuestro. Que el modelo lo genere se ataca cambiando de modelo -- es la
// firma de uno flojo en llamadas a herramientas, y pasa siempre en el mismo punto, cuando tiene que
// encadenar varias seguidas. Que el servidor se lo MANDE al cliente es nuestro, y se arregla acá, con
// cualquier modelo.
//
// Es la misma familia que los bloques fijos sin respaldo: un pedazo de texto que el cliente no tiene por
// qué ver se borra antes de enviar, y queda registrado como incidente.
//
// No se intenta "entender" la llamada ni ejecutarla. Una llamada mal formada no es una intención que se
// pueda rescatar: es ruido. Lo único que se hace es sacarla.

/**
 * Los envoltorios que los modelos usan para las llamadas a herramientas cuando se les escapan como
 * texto. Van con `｜` (U+FF5C, la barra ancha) porque es el caracter que usan de verdad, no `|`.
 */
const BLOQUES = [
  // El bloque ENTERO, de la apertura al cierre. Va primero y es el que importa: quitando solo las
  // etiquetas quedaba suelto el valor del argumento -- "Contra entrega total (producto + envio)" --
  // que es un dato interno, no un mensaje para el cliente.
  /<[\s｜|]*DSML[\s｜|]*calls>[\s\S]*?<\/[\s｜|]*DSML[\s｜|]*calls>/g,
  // Y despues las etiquetas sueltas, para un bloque que quedo sin cerrar.
  /<\/?[\s｜|]*DSML[\s｜|]*[^>]*>/g,
  // <｜tool▁calls▁begin｜>, <｜tool▁call▁end｜> y familia
  /<[\s]*[｜|][^>]*tool[^>]*[｜|][\s]*>/g,
];

/** Renglones que quedan sueltos cuando el envoltorio ya se fue: `invoke name="x"`, `parameter ...`. */
const RESIDUO = /^\s*<?\/?\s*(invoke|parameter|function|tool_call)\b[^>]*>?\s*$/i;

/**
 * Devuelve el texto sin la sintaxis de herramienta, y si había algo que sacar.
 *
 * `limpio` puede quedar vacío: eso significa que el turno entero era una llamada mal formada y no hay
 * mensaje que enviar. Quien llama decide qué hacer con eso -- lo que NO puede hacer es mandarlo.
 */
export function quitarSintaxisDeHerramienta(texto: string): { limpio: string; habia: boolean } {
  let salida = texto;
  for (const patron of BLOQUES) salida = salida.replace(patron, "");

  const renglones = salida.split(String.fromCharCode(10)).filter((r) => !RESIDUO.test(r));
  salida = renglones
    .join(String.fromCharCode(10))
    .replace(/\n{3,}/g, String.fromCharCode(10, 10))
    .trim();

  return { limpio: salida, habia: salida !== texto.trim() };
}
