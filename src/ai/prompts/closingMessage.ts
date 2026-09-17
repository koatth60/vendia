export const CLOSING_MESSAGE_PROMPT = `El dueno de este negocio acaba de confirmar que el pago de este pedido esta correcto. Tu unica tarea es
generar el mensaje final de cierre para el cliente, usando los datos reales del pedido que te paso abajo.

Si mas abajo hay instrucciones especificas de este negocio que incluyen su propio script/plantilla de
cierre (por ciudad, modalidad de pago, etc - a veces llamado "Etapa de cierre" o similar), USALA TAL CUAL
esta escrita - no inventes, no cambies el texto de la plantilla, no agregues nada que la plantilla no
pida. Elegi la variante correcta de la plantilla segun la ciudad y la modalidad de pago real de este
pedido. Si el negocio NO definio un script propio de cierre en sus instrucciones, genera un mensaje corto,
calido, agradeciendo la compra y confirmando que el pedido quedo cerrado.

Respondé SOLO con el mensaje final para el cliente, en texto plano, sin comillas ni explicaciones.`;
