import type OpenAI from "openai";
import { deepseek, DEEPSEEK_MODEL } from "./client";
import { catalogTools, runCatalogTool, SHIPPING_MODALITY_LABELS, type ToolContext } from "./tools";
import { getRecentHistory } from "../conversation/service";
import { logAiUsage } from "./usage";
import { prisma } from "../db/client";
import { listActiveProducts } from "../catalog/products";
import { tokenize } from "../search/text";

const BASE_SYSTEM_PROMPT = `Eres un asistente de ventas por WhatsApp para un negocio.

ESTILO: se breve, cálido y natural, como una persona real chateando por WhatsApp, no como un formulario.
Usa emojis con naturalidad (no en cada linea, pero si donde ayuden a que suene humano). Cuando pidas datos
para un pedido, pregunta de a UN dato a la vez y espera la respuesta antes de pedir el siguiente - nunca
tires una lista numerada de 3 preguntas juntas.

{{IDIOMA}}

IDIOMA DEL CLIENTE: la directiva de arriba es el español por default de este negocio, pero si el cliente
te escribe en otro idioma (ingles, portugues, etc.), respondele en ESE idioma, no en español - mantene el
mismo tono calido y breve. Si mezcla idiomas o volves a un mensaje en español, volves vos tambien al
español configurado. Nunca le digas al cliente que no entendes su idioma.

ORTOGRAFIA: escribe siempre con tildes y ortografia correcta en español (catálogo, información, teléfono,
cómo, qué, envío, garantía, política, etc). Nunca omitas una tilde por escribir rápido.

CATALOGO: responde preguntas sobre productos (precio, stock, caracteristicas) usando siempre las
herramientas para consultar el catalogo real. Nunca inventes precios, stock ni caracteristicas.
search_products busca por palabra clave, pero si no encuentra coincidencia exacta te devuelve el
catalogo completo igual - revisalo por significado antes de decidir, el cliente puede describir el
producto con otras palabras que las del catalogo (ej. "algo para hacer ejercicio" por un smartwatch
deportivo). Solo despues de revisar esa lista completa, si de verdad no hay nada que coincida, decile
directamente que no lo manejan - la ausencia en el catalogo YA es la respuesta real, no hace falta
escalar con ask_owner para eso. Si preguntan por una talla, color u otra variante especifica de un
producto y no aparece mencionada en su descripcion, nunca inventes ni asumas que existe o que no existe -
usa ask_owner para confirmarlo.

SELECCION POR NUMERO: esto aplica SOLO cuando tu ULTIMO mensaje fue una lista numerada (1, 2, 3...) DE
PRODUCTOS o variantes, y el cliente responde solo con un numero de esa lista. En ese caso puntual, ese
numero es la POSICION en TU lista, nunca un ID ni una palabra de busqueda - resolvelo vos mismo contra tu
propio mensaje anterior y usa el NOMBRE REAL del producto en esa posicion al llamar cualquier herramienta
(search_products, get_product_details, send_product_media). Nunca pases el numero solo. Si no podes ubicar
con certeza a que item de tu lista corresponde ese numero, preguntale al cliente cual nombre prefiere en vez
de adivinar o de decir que "no cargo" el producto. Esta regla NO aplica si tu ultimo mensaje pedia cedula,
celular, cantidad, confirmacion de un total u otro dato del pedido - un numero en esas respuestas es el dato
real que pediste (cedula, celular, cantidad), tratalo como tal, nunca como posicion de una lista.

BUSQUEDA POR CATEGORIA Y/O COLOR: si el cliente pide un producto por categoria y/o color (ej. "reloj
negro", "el rosadito", "audifonos rojos"), usa find_products_by_attributes en vez de search_products - te
devuelve solo lo que existe en ese color/categoria real, nunca menciones ni mandes fotos de otro color o
categoria que no pidio. Si el color existe en varias categorias distintas y no especifico cual, te llega
agrupado por categoria: mostraselo asi y pregunta cual es, ANTES de mandar ninguna foto.

VARIANTES DEL MISMO PRODUCTO: mismo principio para un producto YA identificado con varias variantes
(color, material, tamaño, modelo) - si el cliente muestra interes sin especificar cual, nunca le preguntes
"cual te interesa" o pidas mas datos a ciegas: consulta el catalogo real y mostrale las opciones que de
verdad existen en ESE mismo mensaje, preguntando cual prefiere. Si el producto no tiene variantes, no
preguntes nada, segui directo con el detalle.

COMPARACION DE PRODUCTOS: si el cliente pide comparar dos o mas productos ("cual es mejor", "cual me
conviene", "diferencia entre X y Y"), compara solo con los datos reales que te devolvieron las
herramientas (precio, stock, categoria, descripcion). Si pregunta por un atributo puntual que no aparece
en la descripcion de ninguno de los productos que estas comparando (ej. resistencia al agua, duracion de
bateria, material), no inventes ni asumas cual es mejor en ese punto especifico - decilo con honestidad o
usa ask_owner si es un dato clave para que decida.

PREGUNTAS FRECUENTES: si el cliente pregunta algo sobre politicas del negocio (envios, garantia,
cambios, horarios, promociones, descuentos, etc) que no sea un producto especifico ni una forma de pago,
usa get_faq antes de responder - te trae la lista completa, revisala por significado (el cliente puede
preguntar lo mismo con otras palabras que las que usa la FAQ). Una entrada relacionada puede NO responder
especificamente lo que el cliente pregunto (por ejemplo, el costo normal de envio no responde si hay
envio GRATIS). Si ninguna entrada confirma explicitamente lo que el cliente pregunta, NO uses la lista
para inferir ni para negar nada.

CUANDO NO SABES ALGO: esto aplica SOLO cuando el cliente hace una pregunta real que necesita un dato
concreto del negocio (producto, precio, stock, politica, forma de pago, envio, etc). Un mensaje social o
de charla comun - un saludo, una disculpa por tardar en responder, un "gracias", contar que estuvo
ocupado/dormido, despedirse - NO es una pregunta y NUNCA amerita ask_owner: respondele vos mismo, breve y
natural, como responderia cualquier persona ("no hay problema, cuando quieras seguimos" o similar), sin
llamar ninguna herramienta para eso. Recien cuando SI hay una pregunta real y, despues de revisar
catalogo, get_faq, formas de pago Y las instrucciones especificas de este negocio (mas abajo en este
mismo prompt - muchas veces ahi esta la respuesta, por ejemplo politicas de envio, tiempos de entrega o
tarifas por zona) segun corresponda, no tenes una respuesta que confirme explicitamente lo que el cliente
pregunto, usa ask_owner con la pregunta exacta en vez de inventar, adivinar, o negar algo que no esta
explicitamente en la informacion que tenes. Si las instrucciones del negocio SI tienen la respuesta pero
dependen de un dato que todavia no sabes (por ejemplo la ciudad de envio), pedile ese dato al cliente
primero - eso no es "no saber", es simplemente que falta preguntar, no amerita ask_owner. Frases como "no
tengo registro de eso", "no contamos con eso", "por ahora no hay" tambien cuentan como inventar si no
salen textualmente de una herramienta o de las instrucciones del negocio - esta prohibido decirlas por tu
cuenta, escala con ask_owner en vez de eso. No uses ask_owner para preguntas de catalogo, FAQ, pagos o
politicas del negocio que si podes responder con lo que ya te devolvieron las otras herramientas o con las
instrucciones especificas de este negocio - solo cuando de verdad no tenes esa informacion en ningun
lado.

CRITICO en general: decir "dejame consultarlo", "un momento que pregunto", "voy a confirmar con el
equipo", "dame un momento que reviso con el equipo", "dejame revisar el catalogo para confirmarte bien",
"dejame confirmar en el catalogo", "te comparto las opciones", "te paso los datos", "aca
tenes" o cualquier frase similar que promete mostrar o mandar algo NO ES hacer nada por si sola - es solo
texto, el cliente no se entera de nada real. Cada vez que digas una frase asi, en ESE MISMO turno tiene
que estar el resultado real: o ya llamaste la herramienta que corresponde (ask_owner para preguntas sin
respuesta, close_conversation para pedidos, get_payment_methods para formas de pago, get_faq, etc) Y
pegaste su resultado en tu respuesta, o directamente no digas la frase. Prohibido anunciar que vas a
mostrar algo y despues no mostrarlo en ese mismo mensaje - eso deja al cliente sin nada y tenes que
esperar a que insista para recien ahi mandarlo.

{{FOTOS}}

PAGOS: cuando el cliente quiera confirmar una compra, pregunte como pagar, o pregunte el costo del envio
(el valor del envio contraentrega suele estar en los detalles del metodo de pago correspondiente), usa
get_payment_methods para saber las formas de pago reales de este negocio y listale esas opciones EN ESE
MISMO MENSAJE - nunca digas "te comparto las opciones" o "estas son las opciones disponibles" y despues no
las listes, aunque sea la primera vez que preguntas cual prefiere: el listado y la pregunta van juntos en
un solo mensaje, no en dos. Volvé a
llamar get_payment_methods cada vez que necesites repetir o confirmar un numero/llave/cuenta de pago,
aunque ya lo hayas visto antes en esta misma conversacion - copia el numero, la llave y el nombre del
titular EXACTAMENTE como los devuelve la herramienta en ESE momento, nunca de memoria ni parafraseando lo
que recordas de mensajes anteriores (un digito mal recordado es plata real perdida). El titular de un
metodo de pago es siempre una persona (el nombre que puso el negocio en los detalles del metodo), nunca el
nombre del negocio ni el tuyo - si la herramienta no menciona explicitamente un titular, no inventes uno.
Nunca inventes metodos de pago ni costos de envio.
Nunca puedes mandar un mensaje despues de este - cada respuesta es tu unica oportunidad de decir algo en
este turno. Por eso nunca digas "te mando los datos en un mensaje aparte" ni "en breve te confirmo" sin
haberlo hecho ya: si el cliente elige una forma de pago, incluye el numero/llave o link real en ese mismo
mensaje.

TARIFAS DE ENVIO POR CATEGORIA: si las instrucciones especificas de este negocio (mas abajo en este prompt)
describen distintas tarifas de envio segun ciudad, zona o categoria, esa tabla en prosa es solo la
referencia de COMO decidir la categoria - antes de decirle un valor de envio al cliente, llama siempre
get_shipping_rates para confirmar el numero real configurado, nunca copies la cifra de la prosa de memoria
(igual que con los pagos, un digito mal recordado es plata real mal cobrada). Si get_shipping_rates devuelve
una lista vacia, este negocio no tiene tarifas cargadas asi - segui usando el texto de sus instrucciones tal
cual esta escrito. La categoria/ciudad que le corresponde al cliente segui decidiéndola vos con las
instrucciones del negocio; la herramienta solo confirma el numero exacto de la categoria que ya elegiste.

{{COMPROBANTES}}

Si el cliente muestra intencion de compra, guialo hacia confirmar el pedido pidiendo los datos que falten
(nombre, cantidad, direccion de envio, forma de pago) de a uno por vez. El nombre es un dato obligatorio
mas, igual que la direccion o la forma de pago - si todavia no lo sabes, pedilo explicitamente ("¿a
nombre de quien hago el pedido?" o similar) antes de cerrar, no asumas que no hace falta. La forma de pago
tiene que salir de las palabras del cliente EN ESTE pedido - si la conversacion se desvia a otro tema
despues de que la eligio y despues vuelve a la compra, no des por sentado que sigue siendo la misma,
confirmala de nuevo antes de seguir. Si preguntan algo que no tiene que ver con el negocio, respondelo
brevemente y redirigi la conversacion hacia el catalogo.

RESUMEN Y TOTAL ANTES DE PEDIR EL PAGO: esto es el flujo generico que aplica cuando el negocio NO definio
su propio paso a paso para confirmar el pedido/pago en sus INSTRUCCIONES ESPECIFICAS DE ESTE NEGOCIO (mas
abajo en este prompt) - si ese negocio SI tiene su propio flujo de resumen/confirmacion escrito ahi, segui
ESE en su lugar y no este. Cuando aplica (negocio sin flujo propio para esto), nunca te lo saltees por mas
simple que parezca el pedido. Apenas tengas los
datos completos (producto(s) y cantidad, direccion, forma de pago Y nombre), y ANTES de pedirle el
comprobante o cualquier confirmacion de pago, mostrale al cliente un resumen claro por escrito: cada
producto con su cantidad, el costo de envio (aclarando si es gratis), y el TOTAL final que va a pagar
(la suma de todo) - y pregunta explicitamente algo como "¿esta correcto tu pedido?" o "¿confirmas estos
datos?". Segui recien despues de que el cliente confirme ese resumen. Nunca le digas a un cliente que su
pedido "quedo confirmado" sin haber mostrado ese resumen con el total y haber recibido una confirmacion
explicita suya sobre el - si en algun momento no estas seguro de si ya se lo mostraste y confirmo en esta
misma conversacion, mostraselo de nuevo antes de cerrar, no asumas.

NOMBRE Y AVANCE: apenas sepas el nombre del cliente (porque se presento, lo diste vos al pedirlo, o lo dio
para el envio), usa save_customer_name una vez.

CEDULA Y CELULAR DE CONTACTO: si este negocio pide numero de identificacion (cedula) o un celular de
contacto para el envio (revisa las instrucciones especificas del negocio), y el cliente lo da, usa
save_customer_contact_info apenas lo tengas - no hace falta esperar a tener ambos datos, guarda cada uno
en cuanto lo sepas.

A medida que la conversacion avanza, usa
update_conversation_status para
reflejar el momento real: INTERESTED apenas muestre interes concreto en un producto, QUOTED cuando ya le
diste precio, NEGOTIATING si esta comparando o decidiendo antes de confirmar. No hace falta anunciarle
nada de esto al cliente, es solo para el seguimiento interno del negocio.

PQR/DEVOLUCIONES/PEDIDOS NO RECIBIDOS/PIDE UN AGENTE: si el cliente trae una queja, reclamo, solicitud de
devolucion, dice que no le llego su pedido, O pide explicitamente hablar con una persona real, un asesor,
un agente o un humano (no con vos), usa flag_conversation_intent UNA SOLA VEZ con el tipo correspondiente
(PQR, DEVOLUCION, NO_RECIBIDO o SOLICITA_AGENTE). Esto escala la conversacion a un humano del negocio -
el dueno puede seguir la conversacion desde el panel de Onix y tomar el control el mismo. Despues de
usarla, decile al cliente algo breve como "ya le avise a nuestro equipo, en un momento te van a atender
directamente" - no intentes resolverlo vos mismo ni sigas usando otras herramientas en ese mismo tema.
Si el mensaje del cliente mezcla una pregunta que si podes responder con las herramientas normales Y un
pedido de hablar con una persona, primero resolve la parte que si podes responder (o usa la herramienta
que corresponda) y RECIEN DESPUES, en ese mismo turno, llama flag_conversation_intent - nunca uses
ask_owner como sustituto de un pedido explicito de hablar con un humano, para eso siempre es
flag_conversation_intent con SOLICITA_AGENTE.

CONSULTAR O CANCELAR UN PEDIDO YA HECHO: si el cliente pregunta como va su pedido, si ya se lo enviaron,
pide la factura, el numero de guia, o pregunta por algo que compro antes, usa SIEMPRE get_order_status
primero - nunca respondas de memoria del historial del chat ni inventes un estado, aunque te parezca que
te acordas de la conversacion. Si el cliente pide cancelar su pedido, primero pregunta en texto plano
"¿confirmas que queres cancelar tu pedido?" y esperá su sí/no en un mensaje aparte - nunca llames
cancel_order en el mismo turno en que recien lo pide. Solo despues de que confirme que si, usa
cancel_order. Si la herramienta devuelve reason:"already_shipped", no insistas ni la vuelvas a llamar -
decile al cliente que ese pedido ya salio y que necesitas confirmar con el equipo, y usa ask_owner.

CIERRE: justo despues de que el cliente mande un comprobante que parezca valido para su pedido final (ya
con producto, cantidad, direccion, forma de pago Y NOMBRE decididos - el nombre es obligatorio, si todavia
no lo tenes pedilo antes de cerrar, no cierres sin el, y ya le mostraste el resumen con el total y te lo
confirmo segun la seccion de arriba), usa la herramienta close_conversation con
outcome=SOLD, incluyendo: el campo summary con el resumen del pedido (producto y cantidad, direccion,
forma de pago, y nombre de contacto); el campo items con cada producto y su
cantidad (nombre exacto del catalogo, para que quede guardado como una orden real); shippingAddress si el
cliente dio direccion; paymentMethodLabel con la forma de pago que eligio; y shippingCost con el costo de
envio que le confirmaste (0 si no aplica o es gratis) - el total del pedido se calcula sumando esto, no
lo dejes en blanco si cobraste envio o el cliente pago mas que solo el producto. Revisa el resultado de la
herramienta: si
dice pending:true, el dueno del negocio todavia tiene que confirmar el pago de su lado - en ese caso NO le
digas al cliente que su compra quedo confirmada, decile algo como "dame un momento, estoy confirmando tu
pago con el equipo y te aviso apenas este listo". Si dice closed:true, ahi si confirmale al cliente que su
pedido quedo cerrado. Si el cliente dice explicitamente que no le interesa o no va a comprar, usa
close_conversation con outcome=LOST. No la uses en ningun otro momento de la conversacion.`;

const TONE_DIRECTIVES: Record<string, string> = {
  cercano: "Tono cercano y casual, como chateando con un amigo, emojis con naturalidad.",
  formal: "Tono formal y profesional. Sin diminutivos, sin emojis, trato respetuoso y directo.",
  juvenil: "Tono juvenil, dinámico y entusiasta, con emojis frecuentes y lenguaje relajado.",
  profesional: "Tono profesional pero amable, corporativo sin ser frío, pocos emojis.",
};

const LANGUAGE_DIRECTIVES: Record<string, string> = {
  neutro: `IDIOMA: usa español neutro latinoamericano. Trata al cliente de "tú", nunca de "vos". No uses
vocabulario ni conjugaciones argentinas (nunca "sos", "querés", "tenés", "decime", "contame", "che", "vos").
Usa formas neutras: "eres", "quieres", "tienes", "dime", "cuéntame".`,
  mexico: `IDIOMA: usa español de México. Trata al cliente de "tú". Modismos mexicanos naturales con
moderación (ej: "¿qué tal?", "con gusto", "órale" solo si encaja), nunca fuerces jerga que no venga al caso.`,
  argentina: `IDIOMA: usa español rioplatense (Argentina). Trata al cliente de "vos" (sos, querés, tenés,
decime, contame), tono cercano y directo.`,
  colombia: `IDIOMA: usa español colombiano. Trata al cliente de "tú", expresiones naturales como "listo",
"con gusto", "de una", sin exagerar el acento regional.`,
  chile: `IDIOMA: usa español chileno. Trata al cliente de "tú", modismos chilenos con moderación (ej:
"bacán", "al tiro"), sin forzarlos si no vienen al caso.`,
};

const PHOTO_DIRECTIVE_AUTO = `FOTOS Y VIDEOS: cuando uses get_product_details, si es la primera vez que se piden los detalles de ese
producto en esta conversacion, el sistema ya le manda la foto/video al cliente automaticamente (mira el
campo "mediaJustSent" en la respuesta de la herramienta) - no llames send_product_media para eso, no hace
falta. Si el cliente pide ver fotos, imagenes o video de nuevo despues (otro angulo, video, o simplemente
lo vuelve a pedir), ahi si usa send_product_media - pasando productId si ya lo obtuviste en este turno con
search_products o get_product_details (mas confiable), o el nombre del producto DEL QUE SE ESTA HABLANDO
AHORA MISMO si solo tenes el nombre. No describas la foto en texto ni pongas la URL en el mensaje, la
herramienta ya envia el archivo real. Si send_product_media devuelve error o sent:false, nunca digas que ya la mandaste.
Nunca escribas vos mismo un texto tipo "[Foto de PRODUCTO]" o "[Video de PRODUCTO]" simulando que mandaste
algo - ese formato entre corchetes lo genera el sistema SOLO cuando send_product_media realmente se ejecuto
y funciono. Si queres mandar una foto, llama la herramienta de verdad; copiar ese formato en tu respuesta
sin llamarla deja al cliente sin nada.
Si el mensaje del cliente empieza con "[El cliente esta respondiendo a la foto/video de: NOMBRE]", el
cliente citó/respondió esa foto puntual - ya sabes de que producto habla, no le preguntes "¿cual de los
dos?" ni cosas asi, respondé directo sobre ese producto. Nunca repitas ese texto entre corchetes al cliente.`;

const PHOTO_DIRECTIVE_REACTIVE = `FOTOS Y VIDEOS: si el cliente pide ver fotos, imagenes o video de un producto, usa send_product_media -
pasando productId si ya lo obtuviste en este turno con search_products o get_product_details (mas
confiable, evita mandar la foto de otro producto), o el nombre del producto DEL QUE SE ESTA HABLANDO AHORA
MISMO (no uno mencionado antes en la conversacion) si solo tenes el nombre. No describas la foto en texto
ni pongas la URL en el mensaje, la herramienta ya envia el archivo real. Revisa el campo "product" que
devuelve la herramienta: si no coincide con lo pedido, decilo honestamente. Si la herramienta devuelve
error o sent:false, nunca digas que ya la mandaste.
Nunca escribas vos mismo un texto tipo "[Foto de PRODUCTO]" o "[Video de PRODUCTO]" simulando que mandaste
algo - ese formato entre corchetes lo genera el sistema SOLO cuando send_product_media realmente se ejecuto
y funciono. Si queres mandar una foto, llama la herramienta de verdad; copiar ese formato en tu respuesta
sin llamarla deja al cliente sin nada.
Si el mensaje del cliente empieza con "[El cliente esta respondiendo a la foto/video de: NOMBRE]", el
cliente citó/respondió esa foto puntual - ya sabes de que producto habla, no le preguntes "¿cual de los
dos?" ni cosas asi, respondé directo sobre ese producto. Nunca repitas ese texto entre corchetes al cliente.`;

const COMPROBANTE_DIRECTIVE_REQUIRED = `COMPROBANTES: si el cliente manda una foto (por ejemplo un comprobante de pago o transferencia), el
mensaje va a incluir una nota "[Analisis de imagen adjunta]" con lo que se ve en la foto - usa esa
descripcion como si tu mismo hubieras mirado la imagen. Si dice que parece un comprobante valido y el
monto coincide con lo que debia pagar, confirmaselo y segui con el cierre del pedido. Si la nota dice que
no se ve como un comprobante, que el monto no coincide, o que no se pudo leer bien, decile especificamente
que no lograste confirmarlo y pedile que reenvie una foto mas clara o que confirme el monto por texto.
Nunca digas que no puedes ver imagenes. Si el cliente dice "ya pague", "ya hice la transferencia", "ya
confirme el pago" o similar SIN haber mandado ninguna foto todavia (por texto o por audio, da igual),
NO uses close_conversation todavia - no tenes nada real que verificar. Pedile la foto del comprobante
primero, con algo como "para confirmarlo necesito que me mandes la foto del comprobante, por favor".`;

const COMPROBANTE_DIRECTIVE_OPTIONAL = `COMPROBANTES: este negocio no exige ver la foto del comprobante para cerrar un pedido - confia en la
palabra del cliente. Si dice "ya pague", "ya hice la transferencia", "ya confirme el pago" o similar,
podes seguir con el cierre del pedido sin pedirle la foto. Si igual te manda una foto de comprobante, el
mensaje va a incluir una nota "[Analisis de imagen adjunta]" - usala como confirmacion adicional, pero no
es obligatoria para cerrar.`;

const PRODUCT_IMAGE_DIRECTIVE = `IMAGEN DE PRODUCTO: si el cliente manda una foto que no es un comprobante de pago - por ejemplo una
captura de un live, un video, otra conversacion, o red social mostrando un articulo - el mensaje va a
incluir una nota "[Analisis de imagen adjunta]" con uno de estos prefijos:

- "PRODUCTO:" seguido de una descripcion visual clara (tipo, color, forma, marca/texto visible). Usa esa
descripcion como termino de busqueda en search_products para ver si coincide con algo del catalogo - no
le pidas al cliente que describa el producto con palabras, ya tenes una descripcion de la imagen para
buscar. Si la descripcion menciona VARIOS articulos distintos en la imagen (ej: gafas y un reloj), buscá
cada uno pero en tu respuesta al cliente NO menciones ni comentes los articulos que este negocio no
vende - ni para aclarar que no los tenes. Respondele solo sobre el/los articulo(s) que SI coinciden con
el catalogo, como si no hubieras notado el resto. Revisa los resultados por significado (color, tipo,
forma), no solo por palabra exacta:
  - Si UN SOLO producto coincide claramente, preguntale "¿te refieres a este?" o similar, y mandale la
  foto real del catalogo con send_product_media pasando el productId EXACTO de ese producto (el campo
  "id" que te devolvio search_products) - nunca vuelvas a pasar solo la descripcion de la imagen como
  productName ahi, porque una busqueda de texto nueva puede coincidir con un producto distinto al que le
  estas por confirmar al cliente. Decile el nombre.
  - Si HAY 2 O 3 productos que podrian ser (mismo tipo de articulo, colores/rasgos parecidos, ninguno
  claramente el unico), NO le pidas el nombre al cliente ni te rindas - mandale la foto de hasta 2 de
  esos candidatos (una llamada a send_product_media por cada uno, pasando su productId) y pregunta algo
  como "veo que buscas [tipo de producto], ¿es alguno de estos?" mencionando brevemente que los distingue
  (color, tamaño). Esto es mucho mas util para el cliente que pedirle que describa lo que ya te mando en
  una foto.
  - Solo si search_products no devuelve absolutamente nada relacionado por significado (ni remotamente
  el mismo tipo de articulo), decile que no identificaste ese producto en el catalogo y preguntale el
  nombre o mostrale el catalogo - no llames send_product_media sin un productId concreto en ese caso.

- "PRODUCTO_POCO_CLARO:" seguido del motivo (borrosa, muy oscura, muy lejos, etc) - ni la imagen ni una
segunda revision lograron describirla con confianza. NO llames search_products con una descripcion
adivinada. Primero decile al cliente que la foto no se ve lo suficientemente clara para identificar el
producto, y pedile una foto mas clara/cercana o el nombre/referencia del producto - dale la oportunidad de
resolverlo el mismo antes de escalar. Solo si el cliente ya no tiene una foto mejor Y no sabe el
nombre/referencia (insiste, dice que no sabe, o vuelve a mandar otra foto igual de confusa), usa
ask_owner_about_photo UNA SOLA VEZ para esa imagen - le reenvia la foto real al dueno para que la
identifique el mismo, mejor que seguir pidiendole datos al cliente que no los tiene. No la uses de
entrada, es el ultimo recurso despues de intentar resolverlo vos mismo con el cliente.

- "OTRO:" (no es ni comprobante ni producto) - respondele naturalmente sin inventar que es un producto o
un pago.`;

const CATEGORY_LABELS: Record<string, string> = {
  ropa: "moda y ropa",
  electronica: "electrónica y tecnología",
  comida: "restaurante y comida",
  servicios: "servicios (belleza, salud u otros servicios agendables)",
  joyeria: "joyería y accesorios",
};

export interface BotPersonality {
  assistantName?: string | null;
  tone?: string | null;
  dialect?: string | null;
  greeting?: string | null;
  neverSay?: string | null;
  customInstructions?: string | null;
  autoSendPhotoOnQuote?: boolean;
  requirePaymentProof?: boolean;
  category?: string | null;
  // Opt-in, off by default - see Business.genderedAddressEnabled in schema.prisma for why this stays
  // per-business config instead of a hardcoded core behavior.
  genderedAddressEnabled?: boolean;
  femaleAddressTerm?: string | null;
  maleAddressTerm?: string | null;
  // Empty/undefined = this business doesn't use the concept, generic payment flow unaffected. See
  // ShippingPaymentModality in schema.prisma.
  shippingPaymentModalities?: ("PREPAID_ALL" | "PREPAID_PRODUCT_COD_SHIPPING" | "COD_ALL")[];
}

export function buildSystemPrompt(personality?: BotPersonality | null): string {
  const languageDirective =
    (personality?.dialect && LANGUAGE_DIRECTIVES[personality.dialect]) || LANGUAGE_DIRECTIVES.neutro;
  const photoDirective = personality?.autoSendPhotoOnQuote === false ? PHOTO_DIRECTIVE_REACTIVE : PHOTO_DIRECTIVE_AUTO;
  const comprobanteDirective =
    personality?.requirePaymentProof === false ? COMPROBANTE_DIRECTIVE_OPTIONAL : COMPROBANTE_DIRECTIVE_REQUIRED;
  const parts: string[] = [
    BASE_SYSTEM_PROMPT.replace("{{IDIOMA}}", languageDirective)
      .replace("{{FOTOS}}", photoDirective)
      .replace("{{COMPROBANTES}}", comprobanteDirective),
    PRODUCT_IMAGE_DIRECTIVE,
  ];

  const categoryLabel = personality?.category ? CATEGORY_LABELS[personality.category] : undefined;
  if (categoryLabel) {
    parts.push(`RUBRO DEL NEGOCIO: este negocio es de ${categoryLabel}. Ten esto en cuenta para el tipo de preguntas que hacés y cómo describís los productos.`);
  }

  if (personality?.assistantName?.trim()) {
    parts.push(
      `TU NOMBRE: te llamas "${personality.assistantName.trim()}". Preséntate con ese nombre cuando corresponda.`
    );
  }

  const toneDirective = personality?.tone ? TONE_DIRECTIVES[personality.tone] : undefined;
  if (toneDirective) {
    parts.push(`TONO DE ESTE NEGOCIO: ${toneDirective}`);
  }

  if (personality?.greeting?.trim()) {
    parts.push(
      `SALUDO: al iniciar una conversación nueva, saluda basándote en esto (adaptándolo naturalmente, no lo repitas literal siempre): "${personality.greeting.trim()}"`
    );
  }

  if (personality?.neverSay?.trim()) {
    parts.push(`NUNCA digas ni hagas esto: ${personality.neverSay.trim()}`);
  }

  if (personality?.genderedAddressEnabled && (personality.femaleAddressTerm?.trim() || personality.maleAddressTerm?.trim())) {
    const femaleTerm = personality.femaleAddressTerm?.trim();
    const maleTerm = personality.maleAddressTerm?.trim();
    parts.push(
      `TRATO SEGUN GENERO: este negocio pidio un trato personalizado. Identifica el genero del cliente por su
nombre.${femaleTerm ? ` Si es mujer, alterna su nombre con "${femaleTerm}" a lo largo de la conversacion.` : ""}${
        maleTerm ? ` Si es hombre, alterna su nombre con "${maleTerm}".` : ""
      } Si el cliente corrige tu suposicion de genero, pide disculpas breve y amablemente, ajusta el trato de
inmediato al genero indicado y segui asi el resto de la conversacion.`
    );
  }

  if (personality?.shippingPaymentModalities && personality.shippingPaymentModalities.length > 0) {
    const options = personality.shippingPaymentModalities
      .map((m) => SHIPPING_MODALITY_LABELS[m])
      .filter(Boolean)
      .join("; ");
    parts.push(
      `MODALIDAD DE PAGO DEL ENVIO: este negocio ofrece estas modalidades reales: ${options}. Cuando el
cliente este por confirmar una compra, usa get_shipping_payment_modalities para mostrarle EXACTAMENTE esas
opciones (nunca inventes ni asumas cual eligio) y espera su respuesta explicita antes de seguir. Esto es
distinto del canal de pago (Nequi, tarjeta, etc, ver get_payment_methods) - son dos preguntas separadas.`
    );
  }

  if (personality?.customInstructions?.trim()) {
    parts.push(
      `INSTRUCCIONES ESPECIFICAS DE ESTE NEGOCIO - PRIORIDAD ALTA: revisa esto ANTES de decidir como pedir
datos, calcular tarifas de envio, o confirmar un pago. Si el negocio ya definio aca su propio flujo paso a
paso para algo (validar ciudad, calcular costo de envio, pedir datos de entrega, confirmar el pago antes
de cerrar, etc), seguí ESE flujo tal cual esta escrito aca, en su propio orden y con sus propias palabras -
no lo reemplaces por las secciones genericas de mas arriba de este prompt ni lo mezcles con ellas.

Esto es SOLO sobre el guion/orden de la conversacion (que preguntar, en que orden, como redactarlo) - NUNCA
reemplaza la obligacion de conseguir datos reales con las herramientas. Aunque el texto de aca abajo diga
en prosa "muestra las opciones de pago" o "confirma el precio" sin mencionar ninguna herramienta (el
negocio lo escribio como guion humano, no como instruccion tecnica), vos igual tenes que llamar
get_payment_methods, search_products, get_faq, etc, CADA VEZ que el flujo de este negocio te lleve a
mostrar ese dato - la herramienta no es parte de "las secciones genericas que no seguís", es como conseguís
la info real para poder seguir este flujo sin inventar nada. Las reglas de arriba sobre precios, stock,
metodos de pago y fotos reales siguen aplicando siempre exactamente igual, herramienta incluida. Para todo
lo demas, si esta definido aca abajo, esto manda:
${personality.customInstructions.trim()}`
    );
  }

  return parts.join("\n\n");
}

function toOpenAiRole(role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"): "user" | "assistant" {
  return role === "ASSISTANT" ? "assistant" : "user";
}

function messageText(m: { content: string; imageAnalysis: string | null }): string {
  if (!m.imageAnalysis) return m.content;
  const caption = m.content.trim();
  return `${caption ? `${caption}\n\n` : ""}[Analisis de imagen adjunta]: ${m.imageAnalysis}`;
}

// getRecentHistory only sends the last RECENT_WINDOW messages to the model - a long conversation would
// otherwise lose everything said before that. Instead of re-summarizing the whole older-messages history
// from scratch each time (which grows unbounded), this only feeds the newly-aged-out slice through the
// model to fold into the existing summary, so each refresh stays cheap regardless of how long the
// conversation eventually gets.
const CONTEXT_SUMMARY_WINDOW = 20;
const CONTEXT_SUMMARY_REFRESH_EVERY = 10;

export async function getOrRefreshContextSummary(conversationId: string, businessId: string): Promise<string | null> {
  const total = await prisma.message.count({ where: { conversationId } });
  if (total <= CONTEXT_SUMMARY_WINDOW) return null;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contextSummary: true, contextSummarizedUpTo: true },
  });

  const olderCount = total - CONTEXT_SUMMARY_WINDOW;
  const lastUpTo = conversation?.contextSummarizedUpTo ?? 0;

  if (conversation?.contextSummary && olderCount - lastUpTo < CONTEXT_SUMMARY_REFRESH_EVERY) {
    return conversation.contextSummary;
  }

  const newlyAgedMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    skip: lastUpTo,
    take: olderCount - lastUpTo,
  });
  if (newlyAgedMessages.length === 0) return conversation?.contextSummary ?? null;

  const roleLabel = { CUSTOMER: "Cliente", ASSISTANT: "Bot", SYSTEM: "Sistema" } as const;
  const transcript = newlyAgedMessages.map((m) => `${roleLabel[m.role]}: ${m.content}`).join("\n");

  try {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content:
            "Actualiza el resumen de esta conversacion de ventas por WhatsApp combinando el resumen " +
            "anterior con los mensajes nuevos. 3-4 frases cortas en español: que producto(s) le " +
            "interesaron al cliente, que datos ya dio (nombre, direccion, forma de pago), en que quedo " +
            "la conversacion. Sin relleno, sin saludos.",
        },
        {
          role: "user",
          content: `Resumen anterior: ${conversation?.contextSummary || "(ninguno todavia)"}\n\nMensajes nuevos:\n${transcript}`,
        },
      ],
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types.
      thinking: { type: "disabled" },
    });

    await logAiUsage({
      businessId,
      conversationId,
      kind: "CHAT",
      model: DEEPSEEK_MODEL,
      usage: response.usage,
    });

    const summary = response.choices[0]?.message?.content?.trim();
    if (!summary) return conversation?.contextSummary ?? null;

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { contextSummary: summary, contextSummarizedUpTo: olderCount },
    });
    return summary;
  } catch (error) {
    console.error("No se pudo actualizar el resumen de contexto de la conversacion:", error);
    return conversation?.contextSummary ?? null;
  }
}

// Safety net for when the model claims "ya te la mande" without actually calling the tool - fires
// only if nothing was sent this turn AND either the customer explicitly asked for media, or the
// model's own reply text claims to have sent some, so it never overrides or duplicates what the model
// already did on its own.
export const PHOTO_REQUEST_PATTERN =
  /\b(foto|fotos|imagen|imagenes|imágenes|video|videos|muestra|muéstrame|muestrame|enseñ|ense[nñ]a|mandame|mándame|manda la|envia la|envía la|pasame|pásame|regal[aá]me|regala la)\b/i;
// Broadened beyond "te mand.." to also catch phrasings without "te" ("ya la mande", "ahi la envio") and
// "aca"/"aqui esta(n)" - a real conversation slipped through the narrower pattern with "ya se la mande".
export const PHOTO_CLAIM_PATTERN =
  /\b(te (mand|envi|pas)|ya (te |se la |la |lo )?(mand|envi|pas)\w*|aqu[ií] (te|va|van|est[aá])|ac[aá] (te|va|van|est[aá])|ah[ií] (te|va|van))/i;
// "te (mand|envi|pas)" above also matches a conditional offer inside a still-open clarifying question
// ("Dime el número o el nombre y te paso fotos y detalles, ¿cuál prefieres?") - that's a promise
// contingent on the customer's answer, not a claim that photos already went out. Real production bug
// (2026-09-12): bot listed 4 options with that exact phrasing on the FIRST turn (nothing asked yet by
// the customer), the claim pattern fired anyway, and the media backstop below matched all 4 option
// names present in the bot's own reply text - sending 4 unrequested photos, several not even matching
// what the customer asked for, before the customer had picked one.
export const OPEN_CLARIFYING_QUESTION_PATTERN =
  /\bcu[aá]l\b.{0,30}\b(prefer|interes|te (gust|llam))|\bdime\b.{0,20}\b(n[uú]mero|nombre)\b/i;
// The model sometimes fabricates the exact "[Foto de X]"/"[Video de X]" caption that recordMessage
// writes for a REAL send, without ever calling send_product_media - a copy-the-pattern hallucination,
// not a natural-language claim, so it doesn't match PHOTO_CLAIM_PATTERN above. Catch it directly.
const FAKE_MEDIA_TAG_PATTERN = /\[(?:foto|video)s? de /i;

// Shared guard for the three claim-patterns below: each was built to catch a dropped-promise bug (model
// says it'll do something, never calls the real tool), but the same claim wording also shows up inside a
// conditional OFFER still awaiting the customer's go-ahead ("¿Quieres que consulte con el equipo?", "Si
// prefieres te comparto las opciones de pago", "...en cuanto confirmes el pedido") - not a claim that the
// action already happened. Confirmed same bug class as PHOTO_CLAIM_PATTERN/OPEN_CLARIFYING_QUESTION_PATTERN
// above (2026-09-12 photo regression): without this, ask_owner/get_payment_methods/search_products fire on
// an unresolved offer, before the customer agreed to it - worst case is ESCALATION, which pings the real
// owner with no customer consent. Verified against both the offer phrasings above and the original
// dropped-promise phrasings each pattern was built for (see agent.claimBackstopGuards.test.ts) - the guard
// doesn't suppress the real cases, only the conditional-offer ones.
export const OFFER_OR_PENDING_CONFIRMATION_PATTERN =
  /\b(si (quieres|prefieres|gustas|deseas)|(quieres|prefieres|gustar[ií]as?|gustas|deseas)\b.{0,15}\bque\b|en cuanto (confirmes|me digas|decidas|me cuentes))/i;

// Same failure mode as the photo claim above, for escalation: the model says "ya consulto con el
// equipo" / "dejame confirmar con el equipo" without actually calling ask_owner - confirmed against a
// real conversation where a customer's shipping-cost question got this exact non-answer and the owner
// never received anything, because no tool call ever fired. The system prompt already tells it not to
// do this (see CRITICO en general) - this is the code-level backstop for when that's not enough.
export const ESCALATION_CLAIM_PATTERN =
  /\b(equipo|due[ñn][oa]s?)\b.{0,25}\b(consult|confirm|pregunt|revis)|\b(consult|confirm|pregunt|revis)\w*\b.{0,25}\b(equipo|due[ñn][oa]s?)\b/i;

// Same failure mode once more, this time for get_payment_methods: the bot asks "que medio prefieres
// usar? te comparto las opciones disponibles" and ends the turn right there without ever calling the
// tool or listing anything - confirmed against a real conversation where the customer had to ask
// "opciones de pago" again before getting an actual answer. No digit run at all in the text is the tell
// that nothing real was attached (a message that actually lists payment methods always has numbers in
// it).
export const PAYMENT_OPTIONS_CLAIM_PATTERN = /\b(te comparto|te paso|aqu[ií] (est[aá]n|tenes)|estas son)\b.{0,20}\bopciones\b/i;

// Same dropped-promise family, for shipping-PAYMENT-MODALITY (who pays shipping and when - see
// Business.shippingPaymentModalities in schema.prisma) - a different axis from PAYMENT_OPTIONS_CLAIM_PATTERN
// above (which channel: Nequi/tarjeta/etc). Only relevant for businesses that configured this concept at
// all - gated separately in finalizeTurn, not by this pattern alone.
export const SHIPPING_MODALITY_CLAIM_PATTERN =
  /\b(anticipado|contraentrega|contra entrega)\b.{0,25}\b(opciones|modalidad(es)?|prefer[ií]s?|prefier(es|e)?|elegir)\b|\b(opciones|modalidad(es)?)\b.{0,25}\b(anticipado|contraentrega|contra entrega)\b/i;

// Same failure mode once more, this time for the catalog: the bot says "dejame revisar el catalogo para
// confirmarte bien" (or similar) and stops there without ever calling search_products/list_all_products -
// confirmed against a real conversation where the customer had no idea the bot was waiting on anything and
// the owner had to take over manually just to get the bot to continue. Fires only when no catalog tool ran
// this turn - re-runs search_products with the customer's own message as the query (search_products
// already falls back to the full catalog on no keyword match, see CATALOGO above) and appends a plain list
// so the customer gets something real instead of a dropped promise.
export const CATALOG_CHECK_CLAIM_PATTERN =
  /\bcat[aá]logo\b.{0,25}\b(revis|confirm|consult|chequ|mir[ao])|\b(revis|confirm|consult|chequ|mir[ao])\w*\b.{0,25}\bcat[aá]logo\b/i;

// Same failure mode again, this time for save_customer_name: the bot asks "a nombre de quien hago el
// pedido?", the customer answers with just their name, and the bot's next reply acknowledges it
// ("Perfecto, David!") without ever having called save_customer_name - confirmed against a real
// conversation where the owner had to add the name by hand afterward. Only fires when the bot's PRIOR
// turn actually asked for the name (so a random two-word customer message elsewhere never gets
// mistaken for one) and the customer's answer is shaped like a name, not a sentence.
const ASK_NAME_PATTERN =
  /\b(a nombre de qui[eé]n|tu nombre completo|nombre completo|c[oó]mo te llamas|cu[aá]l es tu nombre|tu nombre,? por favor)\b/i;

// Same failure mode once more, for the case the prior fix didn't cover: the customer volunteers their
// name unprompted ("Hola soy David", "mi nombre es Maria Jose") instead of answering a question that
// asked for it - ASK_NAME_PATTERN never matches because the bot never asked, so the tool call depended
// entirely on the model remembering to do it on its own. That's the gap behind the recurring "the bot
// isn't saving the name automatically anymore, we've had to add it by hand" complaint.
const SELF_INTRO_NAME_PATTERN = /\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,3})/i;
const NOT_A_NAME = new Set([
  "si", "sí", "no", "ok", "listo", "gracias", "hola", "buenas", "dale", "vale", "hey", "chao", "claro",
  "ala", "parce", "parcero", "oiga", "uy", "bacano", "hermano", "ey",
]);

// Explicit request for a human agent - the most unambiguous of the PQR/queja signals, kept narrow on
// purpose (general complaint/sentiment detection stays with the model, too fuzzy for a regex to avoid
// false positives like "necesito ayuda con la talla"). Code-level backstop for when the model reads a
// clear "quiero hablar con una persona" and just keeps chatting instead of calling
// flag_conversation_intent.
const HUMAN_REQUEST_PATTERN =
  /hablar con (una persona|alguien real|un humano|un asesor|un agente)|(pas|comunic)\w* con (un asesor|un agente|una persona|un humano)|quiero (un humano|hablar con alguien)|no quiero (hablar con )?(un )?bot/i;

export function customerRequestsHuman(text: string): boolean {
  return HUMAN_REQUEST_PATTERN.test(text);
}

// Fallback for the order-closed confirmation when there's no customInstructions to follow, or the
// one-shot closing generation below fails/returns nothing - dialect doesn't change this particular
// sentence (no "tenés"/"tienes" style conjugation in it), only tone (formality/emoji) and sign-off vary.
export function buildOrderClosedMessage(business: { botTone?: string | null; assistantName?: string | null }): string {
  const formal = business.botTone === "formal" || business.botTone === "profesional";
  const signOff = business.assistantName?.trim() ? ` - ${business.assistantName.trim()}` : "";
  return formal
    ? `Tu pago quedo confirmado y tu pedido esta cerrado. Gracias por tu compra.${signOff}`
    : `¡Listo! Tu pago quedo confirmado y tu pedido esta cerrado. Gracias por tu compra 🎉${signOff}`;
}

const CLOSING_MESSAGE_PROMPT = `El dueno de este negocio acaba de confirmar que el pago de este pedido esta correcto. Tu unica tarea es
generar el mensaje final de cierre para el cliente, usando los datos reales del pedido que te paso abajo.

Si mas abajo hay instrucciones especificas de este negocio que incluyen su propio script/plantilla de
cierre (por ciudad, modalidad de pago, etc - a veces llamado "Etapa de cierre" o similar), USALA TAL CUAL
esta escrita, reemplazando cada placeholder (nombre del cliente, precios, etc) con los datos reales del
pedido de abajo - no inventes, no cambies el texto de la plantilla, no agregues nada que la plantilla no
pida. Elegi la variante correcta de la plantilla segun la ciudad y la modalidad de pago real de este
pedido. Si el negocio NO definio un script propio de cierre en sus instrucciones, generá un mensaje corto,
calido, agradeciendo la compra y confirmando que el pedido quedo cerrado.

Respondé SOLO con el mensaje final para el cliente, en texto plano, sin comillas ni explicaciones.`;

export interface ClosingOrderFacts {
  customerName: string | null;
  summary: string;
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shippingCost: number | null;
  totalAmount: number;
  currency: string;
}

// One-shot completion (no tools, no agent loop) - deliberately NOT routed through generateReply/the
// tool-calling agent, since this fires from the deterministic owner-confirms-payment code path where
// re-running the full agent could re-trigger close_conversation or other tools and double up the order.
export async function generateClosingMessage(
  businessId: string,
  conversationId: string,
  business: { customInstructions?: string | null; botTone?: string | null; assistantName?: string | null },
  order: ClosingOrderFacts
): Promise<string> {
  if (!business.customInstructions?.trim()) return buildOrderClosedMessage(business);

  const orderFacts = `Instrucciones especificas de este negocio:
${business.customInstructions.trim()}

Datos reales de este pedido:
- Cliente: ${order.customerName ?? "(sin nombre registrado)"}
- Resumen: ${order.summary}
- Direccion de envio: ${order.shippingAddress ?? "(no registrada)"}
- Forma de pago: ${order.paymentMethodLabel ?? "(no registrada)"}
- Costo de envio: ${order.shippingCost != null ? order.shippingCost : "(no registrado)"}
- Total: ${order.totalAmount} ${order.currency}`;

  try {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 400,
      messages: [
        { role: "system", content: CLOSING_MESSAGE_PROMPT },
        { role: "user", content: orderFacts },
      ],
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning tokens
      // leave message.content empty for a short generation task like this one.
      thinking: { type: "disabled" },
    });
    await logAiUsage({ businessId, conversationId, kind: "CHAT", model: DEEPSEEK_MODEL, usage: response.usage });
    const text = response.choices[0]?.message?.content?.trim();
    return text || buildOrderClosedMessage(business);
  } catch (error) {
    console.error("No se pudo generar el mensaje de cierre personalizado, usando el generico:", error);
    return buildOrderClosedMessage(business);
  }
}

function looksLikePersonName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  if (!words.every((w) => /^[A-Za-zÀ-ÿ'-]+$/.test(w))) return false;
  return !NOT_A_NAME.has(trimmed.toLowerCase());
}

// "soy"/"mi nombre es"/"me llamo" also introduce non-name words in ordinary Spanish ("soy de Bogota",
// "soy yo", "soy nuevo por aca") - looksLikePersonName alone doesn't catch these since they're still
// 1-4 alphabetic words. Reject when the word right after the trigger is one of these common cases
// instead of a name.
const SELF_INTRO_STOPWORDS = new Set([
  "de", "yo", "nuevo", "nueva", "quien", "quién", "asi", "así", "cliente", "el", "la", "los", "las",
  "un", "una", "aqui", "aquí", "aca", "acá", "alli", "allí", "ahi", "ahí", "bien", "mal", "nadie", "alguien",
]);

// Pulls a name out of an unprompted self-introduction ("Hola soy David Gomez"), independent of whatever
// the bot last said. Exported for a cheap pure-function regression test - no need to hit the real LLM
// just to check this extraction.
export function extractSelfIntroducedName(customerText: string): string | null {
  const match = customerText.match(SELF_INTRO_NAME_PATTERN);
  if (!match) return null;
  const candidate = match[1].trim();
  const firstWord = candidate.split(/\s+/)[0].toLowerCase();
  if (SELF_INTRO_STOPWORDS.has(firstWord)) return null;
  return looksLikePersonName(candidate) ? candidate : null;
}

// Same pattern once more, for cedula/celular de contacto - split into two separate patterns since a
// business can ask for both in the same message ("cedula y celular"), and a single numeric reply in
// that case is ambiguous about which one it answers, so the net only fires when the prior turn asked
// for exactly one of the two (safer to miss it than to save a phone number as a cedula or vice versa).
const ASK_ID_PATTERN = /\b(numero de (identificaci[oó]n|c[eé]dula)|tu c[eé]dula|c[eé]dula,? por favor)\b/i;
const ASK_PHONE_PATTERN = /\b(numero de celular|tu celular|celular de contacto|celular,? por favor)\b/i;

const PAYMENT_MENTION_PATTERN = /nequi|bancolombia|daviplata|titular|transferencia|llave/i;

// Prompt instructions alone weren't enough to stop the model from occasionally fabricating an entire
// fake account number + titular for a real payment method (seen in production: a completely invented
// Nequi number and name, not even close to the real configured one - real money risk). This is the hard
// backstop: if the reply mentions payment details but contains a 7+ digit run that isn't in ANY of the
// real configured methods, don't trust the model's text at all - replace it with the real data verbatim.
export function guardAgainstPaymentHallucination(
  text: string,
  paymentMethods: { label: string; details: string }[] | null
): string {
  if (!paymentMethods?.length || !PAYMENT_MENTION_PATTERN.test(text)) return text;
  const knownDigits = paymentMethods.map((m) => m.details.replace(/\D/g, "")).join("|");
  const digitRuns = text.match(/\d{7,}/g) ?? [];
  const hasUnverifiedNumber = digitRuns.some((run) => !knownDigits.includes(run));
  if (!hasUnverifiedNumber) return text;

  console.error("Dato de pago inventado por el modelo, reemplazado por los datos reales configurados:", {
    modelText: text,
    realMethods: paymentMethods,
  });
  return [
    "¡Perfecto! Estos son los datos reales para el pago:",
    ...paymentMethods.map((m) => `*${m.label}*\n${m.details}`),
  ].join("\n\n");
}

const SHIPPING_MENTION_PATTERN = /env[ií]o/i;

// Detection-only, unlike guardAgainstPaymentHallucination above: a shipping cost is usually one clause
// inside a longer message (order summary, product price alongside it), so blindly discarding the whole
// reply the way the payment guard does would also nuke unrelated real content. And with several
// configured tiers (see ShippingRate/get_shipping_rates), there's no single "the real number" to
// auto-substitute the way the full payment-methods list works as a fallback - so this only logs for
// visibility instead of rewriting the customer-facing text, closing half the gap (a real number source
// now exists via the tool) without risking a worse mutation on the other half.
export function guardAgainstShippingCostHallucination(
  text: string,
  shippingRates: { label: string; cost: string }[] | null
): void {
  if (!shippingRates?.length || !SHIPPING_MENTION_PATTERN.test(text)) return;
  // Parse-and-round rather than stripping non-digits like the reply-text side does below: a Decimal's
  // toString() can carry a real fractional part ("9000.00", or worse with no @db.Decimal scale set,
  // "9000.000000000000000000000000") - stripping the "." there concatenates the fraction's zeros onto the
  // integer part instead of discarding them, corrupting every comparison. Colombian peso amounts in the
  // reply text, by contrast, only ever use "." as a thousands separator with no real fraction, so stripping
  // non-digits there is correct.
  const knownCosts = new Set(shippingRates.map((r) => String(Math.round(parseFloat(r.cost)))));
  // [ \t]? (not \s?) between the number and "envio" - \s also matches newline, which let an unrelated
  // number on the PREVIOUS bullet line (e.g. the product price, "$145.000\n- Envio: ...") get treated as
  // "near" the word envio just because a line break and a bullet character separated them. Found by the
  // regression suite: every real, correctly-quoted shipping cost was flagged as a false positive because
  // the chunk it grabbed was actually the product price line above it, not the real shipping line.
  //
  // Forward direction only (envio, THEN the number) - a reverse "number, then envio within 15 chars"
  // branch used to also fire on "producto ($46.000) + el envio" and "$145.000) y el envio", grabbing the
  // PRODUCT price sitting right before the word envio instead of an actual shipping figure. The real
  // phrasing this bot uses always states envio's own cost after the word, never before it.
  //
  // Digit run capped at 4-6 (not 4-9): every real configured tier tops out at 6 digits (88.900), while a
  // cedula or celular runs 7-10 - capping here also stops the fake anonymized placeholder digits
  // ("00000000"/"3000000000") from a nearby "datos de entrega" block being mistaken for a cost.
  const nearbyChunks = text.match(/env[ií]o[^.\n]{0,40}?\$?[ \t]?[\d.,]{4,6}\b/gi) ?? [];
  for (const chunk of nearbyChunks) {
    const digits = (chunk.match(/[\d.,]{4,6}/) ?? [""])[0].replace(/\D/g, "");
    if (digits.length >= 4 && digits.length <= 6 && !knownCosts.has(digits)) {
      console.error("Costo de envio mencionado no coincide con ninguna tarifa real configurada - revisar:", {
        modelText: text,
        realRates: shippingRates,
      });
      return;
    }
  }
}

function looksLikeIdOrPhone(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[\d\s-]{6,15}$/.test(trimmed)) return false;
  return /\d{6,}/.test(trimmed.replace(/\D/g, ""));
}

// Strips numbered-list markers ("1. ", "2) ", "3- ") at the start of a line before tokenizing - a real
// production bug (2026-09-12): the bot's own numbered option list ("1. Serie 11 Mini... 4. Smartwatch
// V20 Caballero") left a bare "4" token in the haystack, which then coincidentally matched the literal
// "4" in an unrelated product's actual name ("AIRPODS SERIE 4") - combined with "Serie" being a shared
// brand word across both categories in this catalog, that unrelated product crossed the 0.6 overlap
// threshold and got its photo sent alongside the real watches. List numbering was never meant to carry
// matching evidence; the product's real name text (what follows the marker) still does.
const LIST_MARKER_PATTERN = /^\s*\d+[.):]\s*/gm;

// Token-overlap match (not exact substring - the model paraphrases names constantly, e.g. "Boombox 4
// LED" for "Parlante Bluetooth Portatil Boombox 4 LED") against a haystack that should already include
// the customer's message, the bot's current reply, AND the bot's prior turn (see the photo-claim
// backstop in finalizeTurn for why the prior turn matters). Exported as a pure function for a cheap
// regression test - no DB/LLM needed to verify the matching decision itself.
export function findMentionedProductsForMediaBackstop<T extends { name: string; media: unknown[]; category?: string | null }>(
  products: T[],
  haystack: string
): T[] {
  const haystackTokens = new Set(tokenize(haystack.replace(LIST_MARKER_PATTERN, " ")));
  const matched = products.filter((p) => {
    if (p.media.length === 0) return false;
    const nameTokens = tokenize(p.name);
    if (nameTokens.length === 0) return false;
    const hits = nameTokens.filter((t) => haystackTokens.has(t)).length;
    return hits / nameTokens.length >= 0.6;
  });

  // Defense in depth beyond the list-marker fix above: once the matches clearly settle on ONE dominant
  // category, drop any minority-category outlier - a shared generic word or any other future token
  // collision can drag in a product from a totally different category, and the real intent behind "show
  // me photos of the ones you just listed" is always "more of the same kind of thing", never a silent
  // category switch. Only acts on a clear majority (strictly more matches in one category than any
  // other) - on a tie, stay silent rather than guess which category the customer actually meant.
  const categoryCounts = new Map<string, number>();
  for (const p of matched) {
    if (p.category) categoryCounts.set(p.category, (categoryCounts.get(p.category) ?? 0) + 1);
  }
  const sortedCategories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedCategories.length < 2 || sortedCategories[0][1] > sortedCategories[1][1]) {
    const dominantCategory = sortedCategories[0]?.[0];
    if (dominantCategory) {
      return matched.filter((p) => !p.category || p.category === dominantCategory);
    }
  }
  return matched;
}

function lastAssistantText(history: { role: string; content: string }[]): string {
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].role === "ASSISTANT") return history[i].content;
    if (history[i].role === "CUSTOMER") break;
  }
  return "";
}

export async function generateReply(
  conversationId: string,
  context: ToolContext,
  personality?: BotPersonality | null,
  customerText?: string
): Promise<string> {
  const history = await getRecentHistory(conversationId);
  const contextSummary = await getOrRefreshContextSummary(conversationId, context.businessId);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(personality) },
    ...(contextSummary
      ? [
          {
            role: "system" as const,
            content: `RESUMEN DE LO HABLADO ANTES (mensajes mas viejos que ya no ves completos): ${contextSummary}`,
          },
        ]
      : []),
    ...history.map((m) => ({
      role: toOpenAiRole(m.role),
      content: messageText(m),
    })),
  ];

  let lastText = "";
  let mediaSentThisTurn = 0;
  let ownerAskedThisTurn = 0;
  let nameSavedThisTurn = 0;
  let contactSavedThisTurn = 0;
  let intentFlaggedThisTurn = 0;
  let catalogCheckedThisTurn = 0;
  let paymentMethodsThisTurn: { type: string; label: string; details: string }[] | null = null;
  let shippingRatesThisTurn: { label: string; cost: string }[] | null = null;
  // Set only when find_products_by_attributes ran this turn AND resolved unambiguously (not spanning
  // several categories with no category given - see "el rosadito" handling in tools.ts). This is the
  // real fix for "reloj negro sends airpods/wrong colors" (2026-09-12): the media backstop below prefers
  // this already-scoped result set over guessing from prose whenever it's available, instead of
  // re-deriving "which products" by scanning text for any name overlap (blind to color/category).
  let attributeMatchThisTurn: { productId: string; productName: string; variantId: string | null }[] | null = null;
  let shippingModalitiesThisTurn: { code: string; label: string }[] | null = null;

  async function finalizeTurn(text: string): Promise<string> {
    text = guardAgainstPaymentHallucination(text, paymentMethodsThisTurn);

    // Verify shipping-cost mentions even if the model never called get_shipping_rates this turn (it may
    // have paraphrased a business's own free-text tier table instead) - fetch the real rates ourselves
    // just for this check whenever shipping is mentioned. Read-only, no side effect on the order/reply.
    if (!shippingRatesThisTurn && SHIPPING_MENTION_PATTERN.test(text)) {
      const shippingResult = (await runCatalogTool(context, "get_shipping_rates", {})) as {
        rates?: { label: string; cost: string }[];
      };
      if (shippingResult?.rates?.length) shippingRatesThisTurn = shippingResult.rates;
    }
    guardAgainstShippingCostHallucination(text, shippingRatesThisTurn);

    if (
      !paymentMethodsThisTurn &&
      !/\d{6,}/.test(text) &&
      PAYMENT_OPTIONS_CLAIM_PATTERN.test(text) &&
      !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(text)
    ) {
      const result = (await runCatalogTool(context, "get_payment_methods", {})) as {
        methods?: { label: string; details: string }[];
      };
      if (result?.methods?.length) {
        text = `${text}\n\n${result.methods.map((m) => `*${m.label}*\n${m.details}`).join("\n\n")}`;
      }
    }

    // Same dropped-promise family, for shipping-payment-modality - only fires for a business that
    // actually configured this concept (empty for most businesses, see Business.shippingPaymentModalities).
    if (
      !shippingModalitiesThisTurn &&
      personality?.shippingPaymentModalities &&
      personality.shippingPaymentModalities.length > 0 &&
      SHIPPING_MODALITY_CLAIM_PATTERN.test(text) &&
      !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(text)
    ) {
      const result = (await runCatalogTool(context, "get_shipping_payment_modalities", {})) as {
        modalities?: { code: string; label: string }[];
      };
      if (result?.modalities?.length) {
        text = `${text}\n\n${result.modalities.map((m, i) => `${i + 1}. ${m.label}`).join("\n")}`;
      }
    }

    if (
      catalogCheckedThisTurn === 0 &&
      customerText &&
      CATALOG_CHECK_CLAIM_PATTERN.test(text) &&
      !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(text)
    ) {
      const result = (await runCatalogTool(context, "search_products", { query: customerText })) as
        | { id: string; name: string; price: string; currency: string }[]
        | { results?: { id: string; name: string; price: string; currency: string }[] };
      const products = Array.isArray(result) ? result : result?.results ?? [];
      if (products.length > 0) {
        text = `${text}\n\n${products
          .slice(0, 8)
          .map((p) => `*${p.name}* — $${p.price} ${p.currency}`)
          .join("\n")}`;
      }
    }

    if (
      ownerAskedThisTurn === 0 &&
      ESCALATION_CLAIM_PATTERN.test(text) &&
      customerText &&
      !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(text)
    ) {
      await runCatalogTool(context, "ask_owner", { question: customerText });
    }

    if (intentFlaggedThisTurn === 0 && customerText && customerRequestsHuman(customerText)) {
      await runCatalogTool(context, "flag_conversation_intent", { intent: "SOLICITA_AGENTE" });
    }

    if (nameSavedThisTurn === 0 && customerText) {
      if (looksLikePersonName(customerText) && ASK_NAME_PATTERN.test(lastAssistantText(history))) {
        await runCatalogTool(context, "save_customer_name", { name: customerText.trim() });
      } else {
        const selfIntroName = extractSelfIntroducedName(customerText);
        if (selfIntroName) {
          await runCatalogTool(context, "save_customer_name", { name: selfIntroName });
        }
      }
    }

    if (contactSavedThisTurn === 0 && customerText && looksLikeIdOrPhone(customerText)) {
      const priorAsk = lastAssistantText(history);
      const askedId = ASK_ID_PATTERN.test(priorAsk);
      const askedPhone = ASK_PHONE_PATTERN.test(priorAsk);
      if (askedId && !askedPhone) {
        await runCatalogTool(context, "save_customer_contact_info", { idNumber: customerText.trim() });
      } else if (askedPhone && !askedId) {
        await runCatalogTool(context, "save_customer_contact_info", { deliveryPhone: customerText.trim() });
      }
    }

    if (mediaSentThisTurn > 0) return text;

    const customerAsked = !!customerText && PHOTO_REQUEST_PATTERN.test(customerText);
    const fakeMediaTag = FAKE_MEDIA_TAG_PATTERN.test(text);
    const modelClaimsSent =
      (PHOTO_CLAIM_PATTERN.test(text) &&
        PHOTO_REQUEST_PATTERN.test(text) &&
        !OPEN_CLARIFYING_QUESTION_PATTERN.test(text)) ||
      fakeMediaTag;
    if (!customerAsked && !modelClaimsSent) return text;

    // The model can only have fabricated this tag, never really sent it (mediaSentThisTurn === 0 here) -
    // strip it so the customer doesn't see a broken "[Foto de X]" label alongside the real photos we're
    // about to send below.
    if (fakeMediaTag) {
      text = text.replace(/\[(?:foto|video)s? de [^\]]*\]/gi, "").trim();
    }

    // Prefer this turn's ALREADY-SCOPED find_products_by_attributes result over re-deriving "which
    // products" by scanning prose - that scan is blind to category/color (any product NAME mention
    // counts), which is exactly how "reloj negro" used to also send airpods and non-black watches (real
    // production bug, 2026-09-12): the bot's own clarifying reply lists every candidate by name, so the
    // prose scan matched all of them regardless of color. When the model called the real filter this
    // turn, trust its result instead of re-guessing from text.
    if (attributeMatchThisTurn && attributeMatchThisTurn.length <= 5) {
      for (let i = 0; i < attributeMatchThisTurn.length; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
        const m = attributeMatchThisTurn[i];
        await runCatalogTool(context, "send_product_media", { productId: m.productId, variantId: m.variantId ?? undefined });
      }
      return text;
    }

    // Fallback for everything else (direct product-name requests, vague follow-ups like "y los otros
    // productos?") - scanning the customer's message, the model's own reply, AND the bot's own PRIOR turn
    // (token-overlap, not exact substring - the model paraphrases names constantly, e.g. "Boombox 4 LED"
    // for "Parlante Bluetooth Portatil Boombox 4 LED"). Blind to color/category by design (it only knows
    // product NAMES), which is exactly why the branch above takes priority whenever it's available.
    //
    // The prior-turn scan matters for a real, reported failure: bot lists 4 numbered smartwatch options
    // ("1. Serie 11 Mini... 2. Serie 12 Ultra 3...") and asks which one; customer replies "Muestrame
    // fotos" with no name at all, since they haven't seen any yet and can't name one sight-unseen - the
    // reasonable read of that is "show me all 4 you just listed", not "pick one for me" or a clarifying
    // question that would just repeat the same dead end. The specific names only live in the bot's PRIOR
    // message, never in this turn's customerText/text, so without this the code below found zero matches
    // and fell back to calling send_product_media with the raw customer text ("Muestrame fotos") as if it
    // were a product name - never matches anything, so the bot's false "aqui van las fotos" claim went
    // out with nothing actually sent.
    //
    // Must compare whole tokens, not substrings: haystack.includes(t) on the raw normalized string used
    // to match "pro" (from "AirPods Pro 2") against the "pro" inside "producto", and single-digit tokens
    // like "2"/"3" against any stray digit in a price - false-positiving completely unrelated products
    // into a customer message that never mentioned them.
    const products = await listActiveProducts(context.businessId);
    const haystack = `${customerText ?? ""} ${text} ${lastAssistantText(history)}`;
    const matched = findMentionedProductsForMediaBackstop(products, haystack);

    // A generic "muestrame el catalogo" also matches PHOTO_REQUEST_PATTERN (it contains "muestrame"),
    // and if the model answers by listing the whole catalog by name, every product matches the
    // token-overlap check above - this used to blast every product's photos at once. Distinguish that
    // from a real request for several specific products (e.g. "mandame fotos de estos 3") by comparing
    // against how many active products exist at all: matching (almost) the entire catalog means "show
    // me everything", not an itemized request, so only that case stays text-only. A flat cap of 2 used
    // to silently drop legitimate 3+ product requests.
    const wholeCatalogMatch = products.length > 1 && matched.length === products.length;
    if (matched.length > 5 || wholeCatalogMatch) return text;

    for (let i = 0; i < matched.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
      await runCatalogTool(context, "send_product_media", { productName: matched[i].name });
    }

    return text;
  }

  const FALLBACK_TEXT = "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto.";

  try {
    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await deepseek.chat.completions.create({
        model: DEEPSEEK_MODEL,
        max_tokens: 1024,
        messages,
        tools: catalogTools,
        // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types. Disabled: reasoning
        // tokens add latency/cost we don't need for a WhatsApp sales reply.
        thinking: { type: "disabled" },
      });

      await logAiUsage({
        businessId: context.businessId,
        conversationId,
        kind: "CHAT",
        model: DEEPSEEK_MODEL,
        usage: response.usage,
      });

      const choice = response.choices[0];
      const message = choice.message;

      if (message.content?.trim()) {
        lastText = message.content;
      }

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return finalizeTurn(lastText || FALLBACK_TEXT);
      }

      messages.push(message);

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        const result = (await runCatalogTool(context, call.function.name, input)) as {
          mediaJustSent?: boolean;
          sent?: boolean;
          asked?: boolean;
          methods?: { type: string; label: string; details: string }[];
          rates?: { label: string; cost: string }[];
          matched?: boolean;
          label?: string;
          cost?: string;
          matches?: { productId: string; productName: string; variantId: string | null }[];
          ambiguousAcrossCategories?: boolean;
          modalities?: { code: string; label: string }[];
        };
        if (result?.mediaJustSent || result?.sent) mediaSentThisTurn++;
        if (call.function.name === "ask_owner") ownerAskedThisTurn++;
        if (call.function.name === "save_customer_name") nameSavedThisTurn++;
        if (call.function.name === "save_customer_contact_info") contactSavedThisTurn++;
        if (call.function.name === "flag_conversation_intent") intentFlaggedThisTurn++;
        if (["search_products", "get_product_details", "list_all_products"].includes(call.function.name)) {
          catalogCheckedThisTurn++;
        }
        if (call.function.name === "get_payment_methods" && Array.isArray(result?.methods)) {
          paymentMethodsThisTurn = result.methods;
        }
        if (call.function.name === "get_shipping_rates" && Array.isArray(result?.rates) && result.rates.length > 0) {
          shippingRatesThisTurn = result.rates;
        }
        if (call.function.name === "get_shipping_rate_for_city" && result?.matched && result.label && result.cost) {
          shippingRatesThisTurn = [...(shippingRatesThisTurn ?? []), { label: result.label, cost: result.cost }];
        }
        if (
          call.function.name === "find_products_by_attributes" &&
          !result?.ambiguousAcrossCategories &&
          Array.isArray(result?.matches) &&
          result.matches.length > 0
        ) {
          attributeMatchThisTurn = result.matches;
        }
        if (call.function.name === "get_shipping_payment_modalities" && Array.isArray(result?.modalities) && result.modalities.length > 0) {
          shippingModalitiesThisTurn = result.modalities;
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
  } catch (error) {
    // A DeepSeek network/API failure used to propagate uncaught out of generateReply - the webhook's
    // outer try/catch swallowed it with just a console.error, so the customer got NO reply at all for
    // that turn. Degrade instead: log it and fall through to the same apology text used when the model
    // itself has nothing to say, still running finalizeTurn's own safety nets (name/contact/photo
    // backstops) against whatever the customer said this turn.
    console.error("Fallo la llamada a DeepSeek en generateReply:", error);
    return finalizeTurn(lastText || FALLBACK_TEXT);
  }

  return finalizeTurn(lastText || FALLBACK_TEXT);
}
