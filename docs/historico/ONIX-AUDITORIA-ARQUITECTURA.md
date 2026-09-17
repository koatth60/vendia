# Onix — auditoría de arquitectura del agente de ventas

Fecha: 2026-09-14. Alcance: `src/ai/agent.ts`, `src/ai/tools.ts`, `src/ai/prompts/systemPrompt.ts`,
`src/orders/checkoutState*.ts`, `src/catalog/faq.ts`, `src/catalog/learnedFaq*.ts`,
`src/jobs/conversationHealth.ts`, `src/routes/whatsapp.ts`.

Esta auditoría no repite las anteriores (`ONIX-ROBUSTNESS-AUDIT.md`, `ONIX-RELIABILITY-PLAN.md`), que
listan fallos individuales y sus parches. Esta pregunta por qué los fallos no se terminan.

---

## 1. Diagnóstico: por qué el ciclo de parches no termina

**El modelo es la máquina de estados.** Todo lo que el bot "sabe" sobre la venta en curso —qué producto
eligió el cliente, qué variante, qué datos ya dio, qué falta— existe únicamente como recuerdo del modelo
releyendo la conversación en cada turno. No hay ningún lugar del sistema que lo sepa.

Todo lo demás se deduce de ahí:

- Si el estado vive en la cabeza del modelo, el sistema no puede verificar nada por adelantado. Solo puede
  **leer lo que el modelo ya escribió e intentar repararlo**. Eso es exactamente lo que hacen los 36
  regex con nombre de `agent.ts` (49 en toda la superficie de guards).
- Detectar intención sobre prosa generada con expresiones regulares no puede converger: el conjunto de
  formas de decir "ya te la mandé" en español es abierto, el conjunto de regex es finito. Cada ajuste
  arregla un caso y abre el opuesto.
- El repositorio ya aprendió esta lección, en un solo lugar, y no la generalizó. En `learnedFaqQuality.ts`
  está escrito: *"perseguir palabras sueltas no puede funcionar: el conjunto de frases que no son nombres
  es infinito"*. Es la misma imposibilidad que tienen los otros 30 regex, que siguen persiguiendo frases.

### Evidencia medible

| Señal | Valor |
|---|---|
| Regex con nombre en `agent.ts` | 36 |
| Regex en toda la superficie de guards | 49 |
| Commits que tocan `agent.ts` desde 2026-09-01 | 55 |
| Capas de parche sobre UNA sola promesa (fotos) | 5 (`PHOTO_CLAIM` → `OPEN_CLARIFYING_QUESTION` → `OFFER_OR_PENDING` → `NON_PRODUCT_PHOTO` → rama `matched.length === 0`) |
| Pruebas deterministas de conversación completa | 0 |

### La confirmación está escrita en el propio repo

`src/orders/checkoutStateFromDb.ts:43` ya encontró el hueco y lo dejó anotado:

> *"ninguna de las dos fuentes se llena mientras la venta está EN CURSO. `pendingOrderItems` solo se
> escribe en el paso de confirmación, y el Order recién existe al cerrar — o sea que hoy no hay ningún
> lugar que registre qué producto está eligiendo el cliente: eso vive solo en la cabeza del modelo."*

Ese párrafo es el diagnóstico completo. Lo que sigue son sus consecuencias.

---

## 2. Fallos encontrados

Ordenados por severidad. Los marcados **[raíz]** desaparecen solos al arreglar el estado; los marcados
**[propio]** son fallos independientes.

### A — CRÍTICO [raíz] — El pedido en curso no existe en ninguna parte

`pendingOrderItems` se escribe en un solo lugar (`tools.ts:584`, paso de confirmación) y el `Order` recién
existe al cerrar. Entre "el cliente eligió el reloj negro" y "se cerró el pedido" no hay registro.

Consecuencias directas, todas vistas en producción:

- Se pregunta el mismo dato varias veces (a una clienta se le pidió el barrio cinco veces en veinte
  minutos; el apellido se pidió después de haber mostrado el resumen).
- "Ya tengo tu nombre y tu cédula" con los dos campos en `null` en la base.
- Resumen de pedido mostrado antes de tener los datos completos.
- Variante/color olvidada después de elegida.

`checkoutState.ts` —que es la solución correcta y está bien diseñada— hoy **no mide nada**: corre en
`void ... .then()` dentro de `finalizeTurn`, solo imprime a log, y su fuente principal de datos está vacía
por el mismo motivo que documenta. Está construida sobre un hueco.

### B — ALTO [propio] — Guards que ejecutan efectos reales decididos por regex sobre prosa

Cuatro backstops no solo corrigen texto: **disparan acciones**.

| Guard | Acción real que dispara | Riesgo del falso positivo |
|---|---|---|
| `escalation` | `ask_owner` → WhatsApp real al dueño | Molesta al dueño sin motivo, con el texto del cliente |
| `catalog_check` | `search_products` + pega lista al final del mensaje | Mensaje autocontradictorio |
| `payment_options` | `get_payment_methods` + pega datos de pago | Datos de pago no pedidos |
| media backstop | `send_product_media` real, por solapamiento de tokens ≥0.6 | Fotos no pedidas (pasó al menos 4 veces) |

Esta es la clase más peligrosa del sistema: **una decisión de efecto lateral tomada por una expresión
regular sobre texto que el propio modelo generó**. El supresor de cada uno es otro regex
(`OFFER_OR_PENDING_CONFIRMATION_PATTERN`), o sea que el falso positivo y el falso negativo se controlan con
la misma herramienta que los causa.

Contraste dentro del mismo archivo: el guard de `close_conversation` que valida `paymentMethodLabel`
contra las formas de pago reales **es del tipo correcto** — valida un argumento de herramienta contra la
base antes de ejecutar, no adivina intención leyendo prosa. Ese se queda.

### C — ALTO [propio] — La composición de guards no está probada ni ordenada

`finalizeTurn` aplica ~12 transformaciones sucesivas sobre `text`. Cada una se escribió para su propio
incidente; ninguna prueba cubre la combinación. Problemas visibles de composición:

- `guardAgainstPaymentHallucination` **reemplaza la respuesta entera**. Si el cliente preguntó dos cosas y
  un dígito no coincidió, se descarta también la respuesta correcta a la otra pregunta, incluida la
  pregunta que el flujo necesitaba hacer.
- Las reparaciones **agregan texto al final**, después de un mensaje que muchas veces ya terminaba en una
  pregunta. Queda "¿cuál prefieres?" seguido de una lista que responde otra cosa.
- El orden entre guards es el orden en que se fueron escribiendo, no un orden diseñado.

### D — ALTO [propio] — No existe prueba determinista de flujo completo

- `npm test` prueba funciones puras (extracción de nombre, matching de productos). No prueba una
  conversación.
- `npm run regression` llama a DeepSeek de verdad, cuesta plata, se corre a mano, y su criterio de éxito es
  *"cero intervenciones de backstop nuevas"* — una métrica sustituta: mide cuántas veces se activó el
  parche, no si la venta funcionó.

Resultado: **producción es la suite de pruebas.** Esa es la mecánica literal del ciclo infinito. Mientras
no exista una prueba barata y determinista de conversación completa, cada cambio se valida con clientes
reales y cada validación produce el siguiente incidente.

### E — MEDIO [propio] — `tool_choice` forzado demasiado amplio

`shouldForceAttributeFilter` se activa si el mensaje del cliente contiene **cualquier** color **o**
**cualquier** palabra de categoría configurada. "el negro que ya pedí" en medio del checkout fuerza
`find_products_by_attributes` en la iteración 0, gasta una llamada y puede reencuadrar la conversación
sobre el producto equivocado. Se amplió de AND a OR en la fase F7 sin acotar el contexto (solo debería
forzarse cuando todavía no hay producto elegido).

### F — MEDIO [propio] — El presupuesto de iteraciones está al límite

5 iteraciones, y ya hay tres cosas que consumen una: `tool_choice` forzado, la intercepción de FAQ antes de
`ask_owner` (que obliga al modelo a llamar `ask_owner` dos veces), y la llamada final sin herramientas que
existe justamente porque el loop se agota. `LOOP_EXHAUSTED` ya tiene su propio camino de recuperación, lo
cual es la señal de que el presupuesto no alcanza.

### G — MEDIO [propio] — Reglas de negocio de un cliente dentro de un archivo core

`checkoutState.ts` declara *"pensado core desde el principio"* y a la vez trae
`zonasSinDocumento: ["bogota", "soacha"]`, que es la regla operativa de MAG.IMP, no de Colombia. El día que
entre el segundo negocio colombiano con otra política de cédula, esto se rompe silenciosamente. Debe ser
configuración por negocio, no constante de país.

### H — MEDIO [propio] — Sin agrupación de mensajes (debounce)

El lock por conversación evita la carrera (bien), pero no evita responder tres veces a una ráfaga de tres
mensajes del cliente. El cliente que escribe "hola" / "quiero un reloj" / "el negro" recibe tres respuestas
donde una persona habría mandado una.

### I — MEDIO [propio] — El prompt creció por acumulación de incidentes

`BASE_SYSTEM_PROMPT` + directivas condicionales + `PRODUCT_IMAGE_DIRECTIVE` + `customInstructions` marcadas
"PRIORIDAD ALTA". El prompt contiene **meta-reglas sobre cuál regla gana** (el párrafo que explica que el
listado de datos del negocio no reemplaza la regla genérica de pedirlos juntos). Que haya que escribir eso
es la señal de que el conjunto de reglas superó lo que el modelo aplica de forma confiable. Cada incidente
agregó prosa; la prosa nueva diluye la vieja. Es a la vez un problema de calidad y de costo por mensaje.

### J — BAJO [propio] — Cierre sin venta poco desarrollado

La salida "el cliente no compra" depende de que el modelo decida llamar `close_conversation` con
`outcome=LOST`. No hay estado ni criterio de inactividad que la resuelva. La despedida amable existe como
instrucción de prompt, no como flujo.

---

## 3. Comparación con el mercado

Productos comparados: Wati, Zoko, Charles, Yalo, Blip, Landbot, Treble, ManyChat, Cliengo/Aivo, Intercom
Fin, y las integraciones nativas de Shopify/WooCommerce sobre WhatsApp.

**Lo que hacen todos, sin excepción, y Onix no hace:** separan la conversación en dos capas.

- **Motor de flujo determinista**: es dueño del estado, de los campos obligatorios, de la validación y de
  las transiciones. El carrito, en las integraciones de e-commerce, vive en el backend de comercio.
- **LLM**: entiende lo que dice el cliente, responde preguntas abiertas y redacta. No es dueño de la
  transacción.

Consecuencia directa: en ninguno de esos productos existe algo parecido a un guard que inspeccione con
regex el texto que el modelo generó para decidir si dispara un efecto lateral. No es que lo hagan mejor —
es que su arquitectura hace innecesaria esa categoría entera de código.

**Dónde Onix está por delante:** visión sobre fotos del cliente, escalación al dueño por WhatsApp con
respuesta de vuelta al cliente, y el aprendizaje de FAQ a partir de las respuestas reales del dueño. Wati y
Zoko tienen FAQ estática; Fin aprende de documentación, no de lo que el dueño contesta por WhatsApp. Eso es
un diferenciador real.

**Conclusión de la comparación:** el problema de Onix no es falta de funcionalidad. Tiene más que la
mayoría. El problema es que la transacción no tiene máquina de estados, y eso se paga en cada turno.

---

## 4. Plan de acción

Principio rector: **no se agrega un regex más sin borrar uno.** Cada fase reemplaza una clase de guard
haciendo imposible su modo de falla, con una prueba determinista que lo demuestre.

Regla de diseño que separa lo que se queda de lo que se va:

> Un guard que **valida el argumento de una herramienta contra la base de datos antes de ejecutarla** es
> correcto y se queda. Un guard que **lee la prosa generada por el modelo para adivinar qué pasó** se va.

### Fase 0 — Línea base (1 día, sin cambio visible para el cliente)

Hoy no hay número contra el cual comparar ninguna mejora.

- Métrica principal: % de conversaciones que llegan a pedido cerrado sin intervención humana.
- Métrica secundaria: intervenciones de backstop por cada 100 turnos, abierta por guard.
- Ambas salen de `AgentIncident`, que ya existe. Falta el panel y la línea base de una semana.

### Fase 1 — Capturar la elección del cliente (desbloquea todo lo demás)

El hueco que `checkoutStateFromDb.ts` ya documentó. Sin esto ninguna fase siguiente sirve.

- Que el producto/variante/cantidad elegidos se escriban en `pendingOrderItems` **durante** la venta, no
  al confirmar. El modelo sigue decidiendo *qué* eligió el cliente; el sistema lo guarda.
- Herramienta explícita (`set_order_item`) o escritura implícita al resolver
  `find_products_by_attributes`/`get_product_details` con confirmación del cliente. Preferible la
  explícita: es verificable y deja rastro.

### Fase 2 — El estado entra al prompt

Inyectar en cada turno, como mensaje `system` (el mismo canal que ya usa `FOTOS/VIDEOS YA ENVIADOS`):
*"PEDIDO EN CURSO: tiene X, Y. Falta Z."*, calculado por `computeCheckoutState`, que ya está escrito.

Elimina de raíz, sin un regex nuevo: la preguntadera repetida, el "ya tengo tu cédula" falso, el resumen
prematuro, la variante olvidada.

Permite borrar: el chequeo `SAVED_CLAIM` de `conversationHealth.ts` y buena parte de los backstops de
nombre y contacto.

### Fase 3 — Reemplazar los backstops de promesa por validación de herramienta

En vez de detectar por regex que el modelo prometió algo y repararlo después, exigir la herramienta antes:
si el estado dice que falta la forma de pago y el modelo intenta cerrar, la herramienta devuelve error con
el motivo y el modelo corrige dentro del mismo turno. Es exactamente lo que ya hace el guard de
`paymentMethodLabel`, aplicado al resto.

Reemplazables por este mecanismo: `payment_options`, `shipping_modality`, `catalog_check`, `escalation`, y
el backstop de fotos completo.

### Fase 4 — Un solo punto de verdad para las cifras

Precio, costo de envío y total nunca salen del texto del modelo: los inserta el sistema con plantilla
determinista, y el modelo redacta alrededor. Elimina de una sola vez los tres guards de cifras
(`guardAgainstPaymentHallucination`, `guardAgainstShippingCostHallucination`,
`guardAgainstOrderTotalMismatch`) y con ellos el riesgo de plata mal cobrada.

### Fase 5 — Suite determinista de conversación completa (la que rompe el ciclo)

20–30 conversaciones reales anonimizadas (ya existe `scripts/anonymize-conversations.js`), reproducidas
contra un DeepSeek **mockeado con respuestas grabadas**, asertando sobre **estado final y secuencia de tool
calls**, nunca sobre el texto exacto. Corre dentro de `npm test`, gratis, en CI, en segundos.

Esto es lo que cambia el régimen: hoy la única prueba real es producción.

### Fase 6 — Adelgazar el prompt

Al pasar a código las reglas que hoy son prosa (datos obligatorios, orden de pedido, cifras), el prompt baja
sustancialmente. Menos reglas se cumplen mejor, y el costo por mensaje baja en la misma operación.

### Fase 7 — Agrupar la ráfaga del cliente

Ventana de ~6–10 s por conversación antes de generar: una respuesta por ráfaga, no una por mensaje.

### Fase 8 — Sacar la regla de MAG.IMP del core

`zonasSinDocumento` pasa a configuración por negocio.

---

## 5. Autoaprendizaje y preguntas frecuentes

Evaluado aparte por pedido explícito. El potencial es real y hoy está usado a medias.

### Lo que está bien y hay que conservar

- **La fuente es la correcta.** Una pregunta real de un cliente que el dueño respondió de verdad es la
  señal de más calidad que existe; es mejor que minar transcripciones.
- **El criterio de `classifyCandidate`** —descartar lo transaccional, **marcar** (no descartar) lo que
  compromete plata, y no descartar por redacción— es un hallazgo bueno y costó doce entradas malas
  aprenderlo.
- **Usar la pregunta del cliente y no el texto de escalación del bot** (`findCustomerQuestion`).
- **Aprobación humana obligatoria antes de publicar.** Correcto; nunca debe auto-publicarse.

### Lo que falta o está mal

1. **El umbral mide la cosa equivocada.** `MIN_OCCURRENCES_TO_SUGGEST = 2` cuenta **cuántos clientes
   preguntaron**, no cuántas veces el dueño confirmó la misma respuesta. El propio comentario del código
   advierte del riesgo y el umbral igual se aplica sobre ese contador. Debería exigir: ≥2 clientes
   distintos **y** respuestas del dueño concordantes.

2. **No hay reescritura — ésta es la causa real de que las 12 entradas salieran mal.** El candidato se
   guarda literal de WhatsApp ("Estamos en Bogotá Linda") y el panel le pide al dueño que lo reescriba a
   mano, cosa que no hace. Una sola llamada al modelo **en el momento de sugerir** (no por mensaje)
   que normalice la pregunta, pase la respuesta a voz de política y saque nombres y números, mostrada como
   borrador editable, ataca el problema donde está. Es la mejora de mayor retorno y la más barata.

3. **La deduplicación por ≥2 tokens compartidos falla en los dos sentidos.** "¿Hacen envíos a Cali?" y
   "¿Hacen envíos a Medellín?" comparten *hacen* y *envíos* y se fusionan siendo distintas; dos
   parafraseos del mismo tema comparten uno o ninguno y se duplican. Resolver en la misma llamada del
   punto 2.

4. **No hay ciclo de retroalimentación.** Una vez aprobada, nada mide si la FAQ efectivamente dejó de
   generar escalaciones sobre ese tema. Hace falta contar cuántas veces el modelo respondió usando cada
   entrada.

5. **No hay caducidad ni revisión.** Precios y promociones cambian; una FAQ aprendida de "envío gratis"
   queda para siempre. Debe tener fecha de revisión.

6. **`get_faq` devuelve la lista completa en cada llamada.** Con 12 entradas es correcto; con 100 —que es
   justo a donde apunta el aprendizaje— deja de serlo, en costo y en precisión. Necesita recuperación por
   relevancia antes de escalar.

7. **La intercepción de FAQ antes de `ask_owner` es la idea correcta en el lugar caro.** Gasta una
   iteración del loop y obliga a llamar `ask_owner` dos veces. Mejor: adjuntar las FAQ al contexto cuando
   el mensaje parece una pregunta de política, o traerlas junto al resultado de la herramienta.

8. **Falta la fuente más rica: las conversaciones donde el humano tomó el control.** Hoy solo se aprende de
   `ask_owner`. Cuando se activa `humanControl` y el dueño responde a mano desde el panel, ese par
   pregunta/respuesta se pierde. Es más volumen y mejor contexto que la escalación sola. Corresponde a la
   "Fase 3 (PQR)" que quedó abierta.

### Prioridad sugerida

El punto 2 (reescritura) es pequeño, independiente del resto del plan y de alto retorno: se puede hacer en
paralelo a la Fase 1. Los puntos 1, 3, 4 y 8 conviene hacerlos después de la Fase 5, cuando exista una
prueba determinista que los cubra. Los puntos 5, 6 y 7 son para cuando el volumen de entradas lo justifique.
