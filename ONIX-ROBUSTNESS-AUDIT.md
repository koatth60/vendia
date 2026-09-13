# Onix — auditoría de robustez y plan de trabajo

Escrito 2026-09-13 (Opus). Investigación pedida por el dueño: encontrar huecos, bugs y situaciones donde
el bot falla al hacer llamados a herramientas, con foco en cuatro flujos concretos:

1. Catálogo → ofrecer fotos (salvo que el cliente ya las haya pedido, ahí van de una).
2. Precisión por categoría y color ("relojes negros", "audífonos rosa").
3. El round-trip completo de `ask_owner`: que la pregunta llegue al dueño y su respuesta vuelva al cliente.
4. El bug de "ya te paso el catálogo / permíteme un momento" y el bot nunca vuelve.

Más un pedido adicional: evaluar si faltan backstops y lógica para que el bot sea robusto en negocios de
rubros distintos, no solo en el piloto actual.

**Nada de esto está implementado todavía. Este documento es solo el diagnóstico y el plan.**

## Método

Lectura directa del código de los cuatro caminos reales: el loop de `generateReply` y sus backstops
(`src/ai/agent.ts`), el webhook de entrada y el camino de respuesta del dueño (`src/routes/whatsapp.ts`),
el job de recordatorios (`src/jobs/escalationReminder.ts`), la capa de envío (`src/whatsapp/client.ts`) y
el matching de catálogo (`src/catalog/products.ts`, `src/ai/tools.ts`).

Dato de contexto importante: el `npm run regression` corrido hoy (37 conversaciones reales, 470 turnos)
dio **0 intervenciones de backstop y 0 fallas duras**. Eso NO contradice los hallazgos de abajo: la
suite replica turnos de clientes uno por uno contra `generateReply`, así que por construcción no puede
observar ninguna de las fallas que ocurren *entre* turnos o *fuera* del turno — que es exactamente donde
está la mayoría de lo que sigue. Es un punto ciego de la suite, no una contradicción.

## Hallazgos

Severidad por impacto en el cliente real, no por dificultad de arreglo.

### F1 (ALTO) — Conversación muerta para siempre después de `flag_conversation_intent`

`flag_conversation_intent` (PQR, DEVOLUCION, NO_RECIBIDO, SOLICITA_AGENTE) llama
`setHumanControl(businessId, conversationId, true)` en `src/ai/tools.ts:928`, pero **no crea ninguna
`PendingOwnerQuestion`**. Solo `ask_owner` (`tools.ts:1001`) y `ask_owner_about_photo` (`tools.ts:1085`)
crean una.

El job de recordatorios (`src/jobs/escalationReminder.ts:30`) busca únicamente
`findPendingOwnerQuestionsDueForReminder`. Una conversación escalada por intent **nunca aparece ahí**.

Y con `humanControl = true`, el webhook corta el bot en `src/routes/whatsapp.ts:402-424`: manda un solo
acuse ("Ya te leímos, en un momento te contesta el equipo"), lo marca con `humanControlAckSent`, y a
partir de ahí ignora todo lo que el cliente escriba.

**Escenario de falla concreto:** cliente dice "quiero hablar con una persona" un sábado. El bot escala,
manda el acuse, se apaga. El dueño no abre el panel ese fin de semana. El cliente escribe tres veces más:
silencio total. Nadie — ni el cliente ni el dueño — recibe un solo recordatorio, nunca. La conversación
queda muerta de forma permanente hasta que alguien entre manualmente al panel.

Este es el candidato número uno a la queja de "el bot nunca más responde y el cliente tiene que volver a
escribir" — con el agravante de que acá volver a escribir tampoco lo reactiva.

El mismo agujero aplica al takeover manual desde el panel (`src/routes/admin.ts:809`): ahí es intencional
que el bot se calle, pero tampoco existe ningún aviso de "esta conversación lleva 3 días pausada".

### F2 (ALTO) — El loop de 5 iteraciones se agota y manda una promesa vieja, sin dejar rastro

`src/ai/agent.ts:787` — `for (let iteration = 0; iteration < 5; iteration++)`. Si el modelo sigue pidiendo
herramientas en la quinta iteración, el `for` termina y cae a `return finalizeTurn(lastText || FALLBACK_TEXT)`
(`agent.ts:970`).

`lastText` (`agent.ts:812-814`) guarda el último `message.content` no vacío de **cualquier** iteración,
incluido el texto que el modelo escribe *junto con* una tool call intermedia. Ese texto intermedio es
típicamente justo la frase problemática: "dame un momento que reviso el catálogo".

El problema fino: los cuatro backstops de `applyClaimBackstops` (`agent.ts:580-644`) se desarman con
`alreadyHandled` — `catalogCheckedThisTurn !== 0`, `!!paymentMethodsThisTurn`, `ownerAskedThisTurn !== 0`.
En un agotamiento de loop las herramientas **sí corrieron**, así que `alreadyHandled` es `true` y **ningún
backstop se activa**. El cliente recibe la promesa cruda, sin el contenido prometido.

Además no hay ni un `console.warn` cuando el loop se agota. Es completamente invisible en producción: solo
se descubre por queja del cliente.

**Escenario:** consulta compleja (varios productos + envío + pago) donde el modelo encadena 5 rondas de
herramientas. Turno termina. Cliente recibe "dame un momento que te confirmo" y nada más. Tiene que
escribir de nuevo para que el bot arranque un turno nuevo.

### F3 (ALTO) — La ventana de 24h de WhatsApp no está protegida hacia el cliente

`sendOwnerAlert` (`src/whatsapp/client.ts:220`) resuelve bien este problema **hacia el dueño**: intenta una
plantilla aprobada (`onix_owner_alert`) y cae a texto libre si falla, justamente porque el texto plano no
sale fuera de la ventana de 24h.

El camino inverso no tiene nada de eso. Cuando el dueño responde la pregunta, el reenvío al cliente es un
`sendTextMessage` pelado en `src/routes/whatsapp.ts:125` (y lo mismo en :103 y :114 para el caso
`PHOTO_PRODUCT`). Si pasaron más de 24 horas desde el último mensaje del cliente, Meta rechaza ese envío.

Tres consecuencias encadenadas:

- El cliente nunca recibe la respuesta que el dueño sí se tomó el trabajo de escribir.
- La línea 125 **no tiene try/catch** (a diferencia del envío de foto en :106-110, que sí lo tiene). La
  excepción sube.
- Si esa excepción hace fallar el handler del webhook, Meta **reintenta** la entrega del mensaje del dueño
  → riesgo de procesar la respuesta dos veces y mandarle al cliente la respuesta duplicada.

El negocio ya tiene plantillas configuradas (`followUpTemplateName`), o sea que la herramienta para
resolverlo existe; simplemente no se usa en este camino.

### F4 (MEDIO) — Un solo recordatorio en toda la vida de la pregunta

`escalationReminder.ts:62` marca `markPendingOwnerQuestionReminded` y el propio test lo confirma como
diseño: *"reminds the owner once for an old unanswered question, then never again"*
(`escalationReminder.test.ts:61`).

Después de ese único recordatorio a las 3 horas (`ownerReminderMinutes`, configurable por negocio), si el
dueño sigue sin contestar no pasa nada más nunca. El cliente recibió "Seguimos revisando tu consulta" y
queda esperando indefinidamente.

### F5 (MEDIO) — El backstop de escalación no verifica que la escalación haya funcionado

`agent.ts:639-642`: el `repair` llama `runCatalogTool(context, "ask_owner", ...)` y devuelve el texto sin
mirar el resultado. Pero `ask_owner` devuelve `{ asked: false }` cuando el negocio no tiene `contactPhone`
configurado (`tools.ts:904-909`) o cuando el envío al dueño falla (`tools.ts:932-937`).

En esos casos el cliente igual se queda con el texto del modelo diciendo "lo consulto con el equipo",
cuando en realidad no se consultó con nadie y nadie va a responder.

Es especialmente relevante para negocios nuevos: un negocio recién dado de alta que todavía no cargó
`contactPhone` tiene este agujero abierto en todas sus escalaciones.

### F6 (MEDIO) — Un costo de envío inventado llega al cliente, solo queda en logs

`guardAgainstShippingCostHallucination` (`agent.ts:366-403`) devuelve `void` a propósito: solo hace
`console.error`. El comentario del propio código lo reconoce como media solución ("closing half the gap"),
con razones defendibles — no hay un único "número real" para sustituir cuando hay varias tarifas, y
descartar el mensaje entero rompería contenido no relacionado.

Sigue siendo un hueco abierto: a diferencia del guard de pagos (`agent.ts:567`, que sí reescribe el texto),
acá una cifra de envío inventada llega tal cual al cliente y el negocio se entera solo si alguien lee los
logs.

### F7 (MEDIO) — El forzado de búsqueda por color/categoría no se activa en la mayoría de los casos

La Fase 4 del plan de fiabilidad fuerza `find_products_by_attributes` vía `tool_choice`, pero con una
condición doble (`agent.ts:793`): `canonicalColors(customerText).length > 0 && textMentionsConfiguredCategory(...)`.

`textMentionsConfiguredCategory` (`src/catalog/products.ts`) construye su vocabulario desde
`Product.category` de los productos activos del negocio. Si ese campo está vacío — que es el estado por
defecto de un negocio nuevo que carga productos sin categoría — `categoryTokens.size === 0` y la función
devuelve `false` **siempre**. El forzado nunca se activa para ese negocio.

Tres huecos concretos, todos relevantes para tu ejemplo de "relojes negros / audífonos rosa":

- Negocio sin `category` poblada: el mecanismo entero está muerto, sin ningún aviso.
- Consulta de solo color ("el rosadito", "quiero el negro"): no hay palabra de categoría, no fuerza.
- Consulta de solo categoría ("¿qué relojes tienen?"): tampoco fuerza, porque falta el color.
- Solo se fuerza en `iteration === 0`. Si el cliente aclara el color en la misma conversación pero el
  modelo ya gastó la primera iteración en otra cosa, no hay segunda oportunidad en ese turno.

### F8 (MEDIO, producto) — El flujo "catálogo → ¿querés fotos?" que pediste no existe

Hoy hay dos comportamientos, según `autoSendPhotoOnQuote`:

- `PHOTO_DIRECTIVE_AUTO`: al pedir `get_product_details` de un producto por primera vez, el sistema manda
  la foto solo, automáticamente.
- `PHOTO_DIRECTIVE_REACTIVE`: solo manda fotos si el cliente las pide.

Ninguno de los dos es lo que describiste. No existe en ningún lado la regla "mostrá la lista del catálogo
y preguntá si quiere ver fotos, salvo que ya las haya pedido, en cuyo caso mandá productos y fotos juntos".
Los resultados de lista ya traen `hasMedia` por producto (`tools.ts`, Fase 6.0b), así que el dato para
decidirlo está disponible; falta la regla y la variante de directiva.

### F9 (BAJO, observabilidad) — Ninguna de estas fallas es visible sin leer logs a mano

No hay métrica ni alerta para: agotamiento del loop (F2, que ni siquiera loguea), conversaciones
estancadas en `humanControl` (F1), frecuencia de intervenciones de backstop en producción, ni envíos al
cliente rechazados por Meta (F3). El panel muestra consumo de IA, no salud conversacional.

## Backstops y lógica que faltan

Respondiendo directamente a la pregunta de si hacen falta más: sí, cinco.

- **B1 — Backstop de promesa incumplida independiente de `alreadyHandled`.** Los cuatro actuales asumen
  "si la herramienta corrió, la promesa se cumplió". F2 rompe esa suposición. Hace falta uno que compare
  la promesa contra el *contenido real del mensaje saliente* (¿prometió una lista y el texto no tiene
  ninguna?), no contra si la herramienta corrió.
- **B2 — Watchdog de conversaciones estancadas.** Cubre F1 y F4: cualquier conversación con
  `humanControl = true` sin actividad por N minutos debería generar recordatorio al dueño y aviso al
  cliente, venga de `flag_conversation_intent`, de `ask_owner_about_photo` o del takeover manual. Hoy el
  job solo cubre una de las tres fuentes.
- **B3 — Verificación de entrega real.** `sendTextMessage` devuelve el `wamid`; varios call sites lo
  ignoran o no atrapan la excepción. Hace falta una capa que, ante rechazo de Meta hacia el cliente,
  reintente con plantilla (como ya hace `sendOwnerAlert` hacia el dueño) y registre el fallo.
- **B4 — Alerta de respuesta degradada.** Cuando `finalizeTurn` termina devolviendo `FALLBACK_TEXT`
  ("Disculpa, tuve un problema procesando tu consulta"), el cliente recibe una disculpa genérica y el
  dueño no se entera nunca. Debería avisarle.
- **B5 — Guard de total del pedido.** Existe guard para números de pago (`agent.ts:567`) y para costo de
  envío (F6). No existe para el TOTAL que el bot le dice al cliente: si el modelo escribe un total que no
  coincide con lo que devolvió `show_order_summary`, nada lo detecta.

## Robustez multi-negocio

Lo que hoy depende de que el negocio esté configurado "como el piloto":

- **Categorías de producto** (F7): sin `Product.category` poblado, el forzado de atributos nunca corre.
  Debería al menos avisar en el panel, o derivar vocabulario del nombre del producto como fallback.
- **`contactPhone`** (F5): sin él, toda escalación es una promesa vacía. Debería bloquearse o advertirse
  al activar el bot.
- **Plantilla `onix_owner_alert`**: si el negocio no la tiene aprobada, `sendOwnerAlert` cae a texto libre,
  que fuera de la ventana de 24h no llega. El dueño puede no enterarse de ninguna escalación nocturna.
- **`autoSendPhotoOnQuote`** (F8): hoy es binario y ninguna de las dos opciones cubre el flujo pedido.

## Plan de trabajo

Cada fase es independientemente desplegable y tiene su propio criterio de validación. El orden es por
impacto real en el cliente, no por dificultad.

### Fase A — Que ninguna conversación quede muerta (cubre F1, F4, B2)

Generalizar el job de recordatorios para que deje de mirar solo `PendingOwnerQuestion` y pase a mirar
**cualquier conversación con `humanControl = true` sin actividad**, con su origen (intent, foto, manual).
Recordatorios escalonados en vez de uno solo (por ejemplo a 3h y a 24h, con tope), y un aviso al cliente
que no se repita de forma molesta. Reusar `ownerReminderMinutes` que ya es per-negocio.

Validación: tests de job con conversaciones sembradas en los tres orígenes; verificar que una conversación
escalada por `flag_conversation_intent` ahora sí genera recordatorio.

### Fase B — Que la respuesta del dueño llegue siempre (cubre F3, B3)

Envolver los envíos al cliente del camino de respuesta del dueño (`whatsapp.ts:103`, `:114`, `:125`) en la
misma estrategia que `sendOwnerAlert`: intentar texto, y ante rechazo por ventana de 24h reintentar con
plantilla. Agregar try/catch para que una falla de envío no haga fallar el webhook (evita el reintento de
Meta y el doble envío). Avisarle al dueño cuando su respuesta no se pudo entregar, en vez de decirle
"Listo, le reenvié tu respuesta ✅" cuando no fue así.

Validación: test con `sendTextMessage` mockeado devolviendo el error de ventana de Meta; verificar
reintento con plantilla y que el mensaje de confirmación al dueño refleje lo que realmente pasó.

### Fase C — Que el loop nunca deje una promesa colgada (cubre F2, B1, B4, F9 parcial)

Tres cambios en `generateReply`:

1. Loguear explícitamente el agotamiento del loop (hoy es invisible).
2. Al agotarse, no devolver `lastText` crudo: hacer una última llamada al modelo **sin herramientas**,
   forzándolo a redactar la respuesta final con lo que ya tiene en `messages`. Es una llamada extra solo
   en el caso raro, no en el camino normal.
3. Backstop B1: si el texto final promete mostrar algo y no contiene nada parecido a un listado/dato, o si
   se devolvió `FALLBACK_TEXT`, avisar al dueño (B4).

Validación: test unitario que simule 5 iteraciones con tool calls encadenadas y verifique que el texto que
sale no es la promesa intermedia. Esto sí es testeable sin costo real, mockeando el cliente DeepSeek.

### Fase D — Precisión de categoría y color (cubre F7)

Aflojar la condición doble de `shouldForceAttributeFilter`: forzar también con **solo color** o **solo
categoría**, no exigir ambos. Agregar fallback de vocabulario cuando `Product.category` está vacío
(derivar de nombres de producto). Considerar permitir el forzado en iteraciones posteriores a la primera
cuando el cliente aporta el color recién ahí.

Validación: tests de la clasificación con negocio sin categorías cargadas; `agent.categoryColorScopePaid.ts`
para el comportamiento real del modelo (costo real, solo con tu aprobación).

### Fase E — Flujo de catálogo y fotos (cubre F8)

Tercera variante de directiva de fotos: listar el catálogo y ofrecer fotos, salvo que el mensaje del
cliente ya las haya pedido, en cuyo caso mandar productos y fotos en el mismo turno. Usar `hasMedia` para
no ofrecer fotos de productos que no tienen. Como es un toggle nuevo por negocio, ships con su UI en el
panel en la misma fase (regla vigente del proyecto).

Validación: `agent.ambiguousRequestsPaid.ts` cubre parte del terreno; probablemente haga falta un caso
nuevo. Costo real, solo con tu aprobación.

### Fase F — Guard de total y observabilidad (cubre B5, F6, F9)

Guard del TOTAL contra lo que devolvió `show_order_summary`. Revisitar F6 ahora que hay más contexto:
posiblemente sí se pueda reescribir la cifra de envío cuando hay una sola tarifa aplicable. Exponer en el
panel: conversaciones estancadas, agotamientos de loop, intervenciones de backstop por período.

### Fase G — Chequeo de configuración por negocio (robustez multi-negocio)

Una vista de "salud de configuración" en el panel que marque lo que hoy falla en silencio: sin
`contactPhone`, sin categorías cargadas, sin plantilla de alerta aprobada, sin métodos de pago. Hoy cada
una de esas produce una falla distinta y silenciosa en producción.

## Orden sugerido

A → B → C son las tres que atacan directamente la queja de "el bot se calla y no vuelve", y ninguna
depende de las otras. D y E son precisión/producto. F y G son red de seguridad y prevención.

Recomendación: arrancar por A, que es la que hoy deja conversaciones muertas de forma permanente y es la
única de las tres donde ni el cliente ni el dueño se enteran de nada.
