# Plan: presentación de catálogo y medios

Fecha: 2026-09-15. Continúa `ONIX-PLAN-MAESTRO.md` (causa raíz C2) y corrige un supuesto
equivocado de sus Fases 3 y 5.

## 1. El supuesto que falló

Las Fases 3 y 5 del plan maestro sacaron los datos de las manos del modelo con dos
mecanismos:

1. Bloques fijos: el modelo escribe `{{BLOQUE_CATALOGO}}` y el sistema lo reemplaza con
   datos reales antes de enviar.
2. `tool_choice` forzado: cuando el mensaje del cliente pide el catálogo, se obliga al
   modelo a llamar `list_all_products`.

Los dos mecanismos son condicionales al comportamiento del modelo, y los dos fallaron en
producción el 2026-09-15:

- **El bloque se salta solo.** Si el modelo no llama ninguna herramienta, no hay lista que
  renderizar y tampoco hay marca que sustituir: el modelo escribe la lista en prosa y sale
  tal cual. Medido: 18 de 76 mensajes del bot con precio, ese día, salieron de turnos con
  cero llamadas a herramientas.
- **El `tool_choice` forzado no se honra siempre.** Conversación `cmu0ehwqx00076k2k64mjaats`,
  21:56:45 y 22:35:11 UTC. Mensaje del cliente: "muéstrame todo el catálogo completo con
  precios". `looksLikeCatalogRequest` devuelve `true` para ese texto y el código estaba
  desplegado (`3774470`). Aun así el turno registró **una sola** fila `AiUsageLog` —es decir,
  una sola llamada al modelo, sin `tool_calls`— y la respuesta inventó una categoría entera
  ("Cargadores y Cables": Cargador iPhone $60.000, Cargador Tipo C $50.000, Base de Carga
  Inalámbrica 3 en 1 $90.000). La categoría `cargadores` real de ese negocio tiene un solo
  producto. Mismo modelo (`deepseek-flash`) que en los turnos vecinos que sí llamaron
  herramientas, así que no es un problema de failover de modelo.

Conclusión: mientras la presentación dependa de que el modelo escriba una marca o llame una
herramienta, no hay garantía, solo probabilidad. Hay que quitarle la decisión.

## 2. Principio

**La presentación de productos la compone el servidor.** El modelo escribe únicamente la
frase que la rodea. Un producto, un precio o una foto que llegan al cliente salen de una
consulta a la base, nunca de la prosa del modelo ni de una marca que el modelo eligió poner.

## 3. Las piezas

### Pieza 1 — `resolveProductScope` (nuevo, `src/catalog/scope.ts`)

Decide en código de qué trata el turno, usando solo datos reales del negocio. Sin inventar
vocabulario nuevo: reusa `tokenize`, `CategoryAlias`, `canonicalColors` y la búsqueda de
producto que ya existen.

Devuelve una de estas formas:

- `{ kind: "one", product, variant? }` — el cliente nombró un producto (o eligió un número
  de la última lista enviada).
- `{ kind: "group", category, products }` — nombró una categoría configurada.
- `{ kind: "all", products }` — pidió el catálogo completo.
- `{ kind: "none" }` — el turno no es de presentación; el modelo responde como hoy.

Esto es lo que arregla "pidió un producto y le llegaron once": el alcance sale del mensaje
del cliente contra el catálogo real, no de lo que devolvió la última herramienta que corrió.

### Pieza 2 — `renderCatalog` (nuevo, `src/catalog/presenter.ts`)

Funciones puras. Entrada: los productos ya acotados por la Pieza 1. Salida: una lista
ordenada de bloques de salida, cada uno un mensaje, cada uno con sus medios opcionales.

- Agrupa por `category` en un orden estable y configurable.
- Numeración continua 1..N **a través de los grupos** (la directiva SELECCION POR NUMERO del
  prompt depende de que el último mensaje del bot sea una lista numerada).
- Un mensaje por grupo de categoría cuando se pide el catálogo completo. Ese es el corte
  natural, no una guillotina de 700 caracteres a mitad de lista.
- Nunca emite un producto que no venga en la entrada.
- Se prueba sin base de datos, sin red y sin modelo.

### Pieza 3 — los medios viajan con el alcance

Regla acordada con el dueño (2026-09-15), decidida por el alcance resuelto, no por el
criterio del modelo:

| Alcance | Qué pasa con las fotos |
|---|---|
| `one` — el cliente nombró un producto ("quiero el Serie 11 Mini") o eligió un número de la última lista | **La foto sale junto con el mensaje, en el mismo turno.** No se ofrece, no se pregunta. |
| `few` — 2 productos o menos | Igual: salen con el mensaje. |
| `group` — nombró una categoría ("qué relojes tienen") | **No se mandan.** Se ofrece: lista numerada y "¿de cuál querés ver fotos?" |
| `all` — pidió el catálogo completo | No se mandan. Se ofrece igual. |

El umbral (2) va como constante nombrada en un solo lugar.

Hoy esto existe solo como `Business.offerPhotosBeforeSending`, que es una frase inyectada al
prompt (`src/ai/prompts/systemPrompt.ts:456`) y por lo tanto se cumple o no según el turno.
Pasa a ser una regla de código decidida por el alcance.

Si la Pieza 1 resolvió `kind: "one"`, los medios de ese producto (o de esa variante) se
adjuntan al bloque y salen con él. Sin llamar `send_product_media`, sin depender de que el
modelo llame `get_product_details`, sin que el modelo decida nada.

El modelo deja de poder prometer una foto que no sale, porque la foto la manda el mismo
código que decidió que el producto está en alcance.

`send_product_media` sigue existiendo como herramienta para el caso explícito ("mándame esa
otra foto"), pero deja de ser el único camino.

Cuando no se nombró color y el producto tiene variantes, el criterio actual se conserva: se
mandan los medios generales más los de todas las variantes.

### Pieza 4 — estado del turno: la última lista presentada

Guardar por conversación la última lista que **se envió** (ids de producto, en orden). Sirve
para tres cosas que hoy no tienen dónde apoyarse: resolver "el 2" de forma determinista,
evitar reenviar los mismos medios, y saber qué vio el cliente.

### Pieza 5 — validación de la salida contra el catálogo real

Antes de que salga cualquier texto del bot: extraer los precios y los nombres de producto en
posición de lista o en negrita. Si aparece un precio que no es el precio real de un producto
en alcance, o un nombre de producto que no existe en el catálogo de ese negocio, el mensaje
no sale tal cual.

Esto es validación contra la base de datos (clase A/B), no lectura de la prosa para adivinar
qué quiso hacer el modelo (clase D). Es la diferencia entre "improbable" e "imposible".

**Se construye en modo sombra.** Durante 48 horas solo registra qué habría bloqueado, sin
cambiar una sola respuesta. Se activa después, con los números a la vista. Mismo criterio que
`WEBHOOK_SIGNATURE_ENFORCE`. Un falso positivo acá es peor que la enfermedad, así que no se
enciende sin medir.

### Pieza 6 — estado por cliente, no por conversación

`getCustomerCommerceState(businessId, customerId)`: pedidos abiertos en **cualquier**
conversación, última lista presentada, venta en curso. Va al prompt como bloque fijo corto.

Hoy `getLatestOrderForCustomer` se usa únicamente dentro de `cancel_order`
(`src/ai/tools.ts:1739`), así que el modelo nunca sabe que hay un pedido abierto hasta
después de decidir cancelarlo. Caso real del 2026-09-15: pedido `cmu3hv4y600ag4k2kanuuooyr`
(PARLANTE TIPO ALEXA, $80.000, `PENDING`) creado en la conversación
`cmu3hp5ve008f4k2ko22vdf2f`; la clienta pidió cancelarlo desde la conversación
`cmu3hw2qp00ar4k2ku58i0b5f` y para el modelo "el otro pedido" no existía.

Además: cuando el mensaje del cliente es sobre cancelar y hay un pedido abierto, la pregunta
de confirmación se hace de forma determinista, no se deja a criterio del modelo.

### Pieza 7 — observabilidad: `AgentTurn`

Una fila por turno: herramientas llamadas, qué herramienta se forzó y si el modelo la honró,
qué bloques se renderizaron, qué medios salieron, veredicto de la validación.

Hoy, saber qué hizo un turno exige cruzar `AiUsageLog`, `Message` y `mediaSentProductIds` y
deducir. Eso es arqueología, y es lo que hizo que este defecto viviera días sin verse.

Incluye una métrica propia: **tasa de cumplimiento de `tool_choice`**. Es una dependencia que
ahora sabemos que no es confiable y no tenemos un número para ella.

## 4. Qué se borra

- La sustitución de `{{BLOQUE_CATALOGO}}` (`src/ai/agent.ts:676-684`). La reemplazan las
  Piezas 1 y 2, que envían bloques reales en vez de rellenar un hueco en la prosa.
- La última frase de `CATALOG_LIST_NOTE` (`src/ai/tools.ts:760`): "Los datos de esta lista
  igual te sirven para decidir y para responder sobre un producto puntual". Es la frase que
  autoriza al modelo a contestar sobre un producto sin llamar `get_product_details`, que es
  el único camino de auto-envío de fotos que existe hoy.
- El corte único de `splitLongMessage` para contenido de catálogo. La función sigue existiendo
  para prosa normal, y de paso se arregla su defecto real: parte una sola vez y devuelve
  `[first, rest]` sin recursión, así que el segundo trozo puede superar el límite. Medido el
  2026-09-15: un mensaje de 1.068 caracteres con el límite en 700.

## 5. Orden de ejecución

| Fase | Qué | Por qué en este lugar |
|---|---|---|
| **A** | `AgentTurn` + métrica de cumplimiento de `tool_choice` + detector de producto inventado **en modo sombra** | Sin cambio de comportamiento. Hace verificable todo lo que viene después, y le da visibilidad al dueño mañana mismo sin tocar una respuesta. |
| **B** ✅ 2026-09-16 | Piezas 1, 2, 3 y 4 | El grueso. Cierra los problemas 1, 2 y 3. Verificable con la Fase A ya puesta. |
| **C** | Pieza 5 activada, después de 48 h de sombra | Necesita los números de A y el alcance de B para no dar falsos positivos. |
| **D** | Pieza 6 | Cierra el problema 4. Independiente de las otras tres. |

Cada fase va en su propia sesión, con contexto limpio, como el resto del plan maestro.

## 6. El marco general: efectos requeridos

El mecanismo de la Pieza 8 (declarar el efecto esperado, verificarlo contra la base antes de
responder, reintentar, caer a código, escalar) no es para un caso. Es el marco al que se va
a sumar cada fase.

**Regla de admisión — hay que respetarla o volvemos al problema original.** Un efecto solo
entra a la tabla cuando cumple las tres:

1. **Disparador determinista.** Se calcula desde estado de la base o desde metadatos
   estructurados del mensaje (`mediaType`, quién habla). **Nunca** desde interpretar la prosa
   del cliente ni la del modelo. Un disparador leído de la prosa es exactamente el guard de
   clase D que la Fase 5 del plan maestro vino a borrar.
2. **Verificable con una consulta.** Tiene que poder responderse con un `SELECT`, no con una
   opinión.
3. **Con fallback sin modelo.** Tiene que existir una forma de que el servidor lo haga solo,
   con datos de la base.

Estado de cada efecto candidato:

| Efecto | Disparador | Admisible hoy |
|---|---|---|
| Imagen entrante → **dueño avisado** | `mediaType` IMAGE + evidencia de venta escrita por el servidor (`SaleState.items` o `mediaSent`) | **Hecho** (`3d36903`). Ver la nota de abajo. |
| Producto en alcance → sus fotos enviadas | alcance resuelto por la Pieza 1 (`resolveProductScope`), o `mediaType` IMAGE/VIDEO más un `get_product_details` con un id real | **Hecho** (Fase B, 2026-09-16). Cumple las tres: el disparador sale del catálogo real y de metadatos estructurados, se verifica con un `SELECT` sobre los ids presentados, y el fallback no tiene modelo adentro — los bloques y sus medios los compone y los manda el servidor. |
| Pidió cancelar → pedido cancelado o pregunta de confirmación hecha | hoy solo se puede leer de la prosa | **No todavía.** Necesita la Pieza 6: primero el modelo tiene que poder ver el pedido abierto. |
| Prometió consultar al dueño → existe `PendingOwnerQuestion` | la promesa vive en la prosa | **No como efecto.** Se queda como **alerta** al dueño, nunca como creación automática de estado. Avisar de más es barato; inventar estado de negocio no. |

Por eso el orden importa y no se puede atajar: **cada fase vuelve determinista un disparador,
y recién ahí ese efecto puede entrar a la tabla.** La Fase B no es solo "catálogo más lindo":
es lo que habilita garantizar el envío de fotos. La Pieza 6 no es solo "que vea los pedidos":
es lo que habilita garantizar la cancelación.

Cada fase de acá en adelante termina agregando su fila. Una fase que no puede agregar
ninguna es una fase que dejó una decisión en manos del modelo.

**Nota sobre la primera fila, 2026-09-16.** El efecto se implementó como "el dueño queda
avisado", no como "el pedido queda creado", y la rebaja es deliberada. La condición de
disparo es "llegó una imagen" a secas: nada en la base distingue un comprobante de la foto
de un producto sin leer prosa. Crear un pedido sobre una imagen ambigua es un riesgo caro;
un aviso de más al dueño no cuesta nada. Cuando el negocio tenga `saleStateEnabled = true` y
el `SaleState` esté completo (items, total y forma de pago), ahí sí el efecto puede ser el
cierre real, y esa distinción está explícita en el código.

**Y sobre por qué el disparador se apoya en `SaleState`.** `saleStateEnabled` dejó de
controlar si el estado se *registra* y controla solo si se *aplica* y se *expone*. Con la
bandera apagada, el `SaleState` se llena igual como proyección del servidor, pero ni entra al
prompt, ni agrega herramientas, ni bloquea nada. Sin esa separación el disparador era un
placebo: medido en producción el 2026-09-15, los tres negocios tenían la bandera apagada y el
`SaleState` de la conversación de Milena estaba vacío salvo `mediaSent`.

## 7. Definición de terminado

- Un turno con cero llamadas a herramientas **no puede** producir un nombre de producto ni un
  precio que no exista en el catálogo de ese negocio.
- Pedir el catálogo completo produce un mensaje por categoría, con numeración continua.
- Pedir un producto produce ese producto y sus fotos, no el vecindario.
- Un pedido abierto del cliente es visible para el modelo desde cualquier conversación.
- Cualquier turno se puede auditar en una sola consulta.

## 8. Estado de la Fase B (2026-09-16)

Implementado: `src/catalog/scope.ts` (pieza 1), `src/catalog/presenter.ts` (pieza 2, con las fotos
atadas al alcance: pieza 3), `Conversation.lastPresentedProductIds` + `src/catalog/presentedList.ts`
(pieza 4) y `AgentTurn` + `src/ai/agentTurns.ts` (pieza 7, adelantada de la Fase A porque sin ella
esta fase no era verificable). Migración aditiva
`20260916180000_catalog_scope_and_agent_turn`.

**Qué decisión perdió el modelo.** Tres, en concreto:

1. **Qué productos se muestran.** Lo decide `resolveProductScope` contra el catálogo real, antes de
   la primera llamada al modelo. El modelo escribe una frase; los nombres, los precios y el stock
   salen de un `SELECT`.
2. **Si salen fotos y cuáles.** Lo decide el alcance (`one`/`few` las mandan, `group`/`all` las
   ofrecen), y las manda el mismo código que resolvió el alcance. Ya no hay forma de prometer una
   foto que no sale, ni de mandar la de otro color.
3. **Contra qué resuelve "el 3".** Contra `lastPresentedProductIds`, que escribe el servidor con lo
   que realmente envió, no contra lo que el modelo recuerde de su propia lista.

**Borrado**: la sustitución de `{{BLOQUE_CATALOGO}}` cuando hay alcance resuelto (queda solo como
respaldo de los turnos `none`, donde nada cambió), la última frase de `CATALOG_LIST_NOTE`, y el corte
único de `splitLongMessage` (ahora parte hasta que no quede nada por encima del límite).

**Pendiente, deliberado.** Una foto de producto que el modelo describe pero no resuelve con
`get_product_details` sigue sin alcance: convertir la descripción de visión en un `productId` sería
un disparador leído de prosa y la regla de admisión no lo permite. Hoy eso cae en el escalón que ya
existe (`ask_owner_about_photo`), y el turno no puede listar el catálogo.

