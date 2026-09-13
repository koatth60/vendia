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

### Fase A — DONE 2026-09-13 (código) — Que ninguna conversación quede muerta (cubre F1, F4, B2)

Generalizar el job de recordatorios para que deje de mirar solo `PendingOwnerQuestion` y pase a mirar
**cualquier conversación con `humanControl = true` sin actividad**, con su origen (intent, foto, manual).
Recordatorios escalonados en vez de uno solo (por ejemplo a 3h y a 24h, con tope), y un aviso al cliente
que no se repita de forma molesta. Reusar `ownerReminderMinutes` que ya es per-negocio.

Validación: tests de job con conversaciones sembradas en los tres orígenes; verificar que una conversación
escalada por `flag_conversation_intent` ahora sí genera recordatorio.

**Implementado**: `Conversation` gana 3 campos (`humanControlSince`, `stalledReminderStage`,
`stalledReminderSentAt` — migración `20260913200822_add_stalled_conversation_watchdog`).
`setHumanControl` (`conversation/service.ts`) ahora arma/desarma el reloj en CADA flip (no solo el
primero): `active:true` siempre resetea `humanControlSince` a ahora y la etapa a 0 — cubre tanto una
escalación nueva como un dueño que ya respondió una vez y volvió a quedar en silencio; `active:false` limpia
todo (ya no hay nada que vigilar). Nuevo `findStalledConversationsDueForReminder` en el mismo archivo mira
`humanControl=true` + `humanControlSince` en vez de `PendingOwnerQuestion.createdAt`, así que
`flag_conversation_intent` y el takeover manual (`admin.ts:753`, `:809` — ninguno crea una pregunta) quedan
cubiertos por primera vez. Reparto de responsabilidad entre los dos mecanismos para que nunca se disparen
los dos a la vez sobre la misma conversación: una conversación CON `PendingOwnerQuestion` sigue recibiendo su
primer recordatorio (a las `ownerReminderMinutes`) del mecanismo viejo sin tocar (ya manda el texto de la
pregunta real); el watchdog nuevo solo entra ahí para el segundo aviso a las 24h si sigue sin respuesta.
Una conversación SIN pregunta (intent/manual) es pura responsabilidad del watchdog: primer aviso a
`ownerReminderMinutes`, segundo y último a las 24h, tope duro después (`stalledReminderStage` nunca pasa de
2). El aviso al cliente (`CUSTOMER_FOLLOWUP_TEXT`) solo sale en el primer aviso de cada mecanismo, nunca en
el segundo — evita mandarle el mismo mensaje enlatado dos veces a alguien que ya está esperando.
`src/jobs/escalationReminder.ts` corre ambos pasos en la misma ejecución del job (mismo cron, sin nuevo
job). 4 tests nuevos en `escalationReminder.test.ts` (origen intent, cap en stage 2, y que las dos
mecánicas no se pisen en la misma corrida) + los 3 tests preexistentes verdes sin cambios. `npx tsc --noEmit`
limpio; `escalationReminder.test.ts` (6/6), `ai/tools.test.ts` + `conversation/service.test.ts` +
`routes/whatsapp.test.ts` corridos juntos (62/62, cubren todos los call sites de `setHumanControl`) —
ningún assert existente dependía de la forma vieja. No es real-cost (no toca `generateReply`/DeepSeek).
No committeado ni desplegado todavía — se hace un solo commit/deploy al final de todas las fases, según lo
pedido.

### Fase B — DONE 2026-09-13 (código) — Que la respuesta del dueño llegue siempre (cubre F3, B3)

Envolver los envíos al cliente del camino de respuesta del dueño (`whatsapp.ts:103`, `:114`, `:125`) en la
misma estrategia que `sendOwnerAlert`: intentar texto, y ante rechazo por ventana de 24h reintentar con
plantilla. Agregar try/catch para que una falla de envío no haga fallar el webhook (evita el reintento de
Meta y el doble envío). Avisarle al dueño cuando su respuesta no se pudo entregar, en vez de decirle
"Listo, le reenvié tu respuesta ✅" cuando no fue así.

Validación: test con `sendTextMessage` mockeado devolviendo el error de ventana de Meta; verificar
reintento con plantilla y que el mensaje de confirmación al dueño refleje lo que realmente pasó.

**Correción de diagnóstico antes de implementar**: el riesgo de "Meta reintenta la entrega del webhook →
doble procesamiento" descrito en el hallazgo original NO aplica tal cual a este código: `POST /webhook`
manda `res.sendStatus(200)` como primera línea, antes de cualquier `try`/lógica (`whatsapp.ts:220-223`) -
Meta ya recibió su 200 antes de que `handleOwnerReply` corra, así que nunca reintenta por esto. El riesgo
real y confirmado por lectura de código es otro: sin try/catch, una excepción a mitad de función abortaba
todo lo que viene después - `clearPendingOwnerQuestion`, `setHumanControl(false)` y la confirmación al dueño
nunca corrían, dejando la pregunta abierta y la conversación muda para siempre (silenciosamente, sin que ni
el dueño ni el cliente se enteren). Tampoco es viable "reintentar con plantilla" cargando la respuesta real
del dueño (a diferencia de `sendOwnerAlert`, que siempre manda el mismo texto fijo al dueño vía UNA
plantilla aprobada): el texto del dueño es libre, y Meta no permite mandar contenido arbitrario por una
plantilla aprobada (solo la redacción exacta aprobada, con placeholders limitados). El reintento real posible
es reabrir la ventana: mandar `Business.followUpTemplateName` (la misma plantilla que ya usa
`runFollowUpJob`, sin parámetros) como aviso genérico para que el cliente vuelva a escribir.

**Implementado**: nuevo `deliverOwnerAnswerToCustomer` en `whatsapp.ts` envuelve el envío en try/catch; si
falla, intenta la plantilla de seguimiento del negocio (si está configurada) y registra el fallo en
`DeliveryFailure` (infraestructura ya existente, visible en el panel de plataforma - reutilizada en vez de
construir observabilidad nueva). `ownerConfirmationText` elige el mensaje real para el dueño: éxito
("Listo..."), fallo con aviso mandado, o fallo total pidiendo que el cliente vuelva a escribir - nunca más
la confirmación optimista cuando no hubo entrega. Aplicado en los 3 sitios (`PHOTO_PRODUCT` con match,
`PHOTO_PRODUCT` fallback, pregunta de texto plano); `clearPendingOwnerQuestion`/`setHumanControl(false)`
corren siempre, haya o no entrega real - dejarlos colgados hasta una redelivery automática (no construida,
ver abajo) crearía otra conversación muerta, peor que decirle la verdad al dueño ahora. **Deliberadamente
fuera de alcance**: reintregar la respuesta real cuando el cliente vuelve a escribir después del aviso de
reenganche - requeriría persistir el texto de la respuesta del dueño en algún lado hasta la entrega (hoy
`PendingOwnerQuestion` no guarda respuesta, se limpia al resolver), cambio de esquema más grande para un caso
de cola (dueño tarda 24h+ en responder Y cliente además lleva 24h+ sin escribir) - revisar si en la práctica
resulta ser más frecuente de lo esperado. 1 test nuevo en `whatsapp.test.ts` (fallo simulado con código Meta
131047, verifica plantilla de reenganche + mensaje real al dueño + `DeliveryFailure` creado + conversación no
queda colgada) + los 8 tests preexistentes de `handleOwnerReply` verdes sin cambios. `npx tsc --noEmit`
limpio, `whatsapp.test.ts` 9/9. No es real-cost. No committeado ni desplegado todavía (un solo commit/deploy
al final).

### Fase C — DONE 2026-09-13 (código) — Que el loop nunca deje una promesa colgada (cubre F2, B4, F9 parcial; B1 acotado)

Tres cambios en `generateReply`:

1. Loguear explícitamente el agotamiento del loop (hoy es invisible).
2. Al agotarse, no devolver `lastText` crudo: hacer una última llamada al modelo **sin herramientas**,
   forzándolo a redactar la respuesta final con lo que ya tiene en `messages`. Es una llamada extra solo
   en el caso raro, no en el camino normal.
3. Backstop B1: si el texto final promete mostrar algo y no contiene nada parecido a un listado/dato, o si
   se devolvió `FALLBACK_TEXT`, avisar al dueño (B4).

Validación: test unitario que simule 5 iteraciones con tool calls encadenadas y verifique que el texto que
sale no es la promesa intermedia. Esto sí es testeable sin costo real, mockeando el cliente DeepSeek.

**Implementado 1+2**: al agotar las 5 iteraciones sin que el modelo suelte texto plano,
`console.warn` deja rastro explícito (antes invisible), y se hace una llamada extra a DeepSeek con los
mismos `messages` acumulados pero SIN `tools` - fuerza texto final real en vez de devolver crudo lo que el
modelo haya escrito junto a la última tool call (el "dame un momento" que motivó este hallazgo). Solo ese
camino raro paga la llamada extra; el turno normal no se toca.

**B1 acotado a propósito, no implementado como detector genérico**: el plan pedía "si el texto final
promete mostrar algo y no contiene nada parecido a un listado/dato, avisar al dueño" - eso es un
clasificador de texto libre nuevo (¿qué cuenta como "promesa"? ¿qué cuenta como "dato entregado"?), con
riesgo real de falsos positivos sobre respuestas de producción normales si se escribe apurado. Los 4 guards
de `applyClaimBackstops` ya existentes cubren las promesas de pago/catálogo/envío/escalación con REPARACIÓN
real (llaman la herramienta y completan el texto) - construir un quinto genérico sin esa misma capacidad de
reparar (solo alertar) es una categoría de riesgo distinta y no estaba pedido con ese detalle. En su lugar
se implementó **B4 completo**: alerta real al dueño (mismo canal `sendOwnerAlert`) en los dos casos
concretos y sin ambigüedad de "el bot no resolvió nada": el loop se agotó Y la llamada final sin
herramientas tampoco devolvió texto, o cualquier camino termina usando `FALLBACK_TEXT` literal (incluye la
falla de red/API de DeepSeek ya manejada más abajo en el mismo archivo). `alertOwnerOfDegradedReply` nueva
función, reusa `sendOwnerAlert`/`recordOwnerMessage` (misma infraestructura que Fase A/B, sin canal nuevo).
Revisitar el clasificador genérico de B1 solo si en producción aparecen dandling-promises que sobrevivan a
la llamada extra sin herramientas del punto 2 (que en la práctica debería cerrar la mayoría de los casos,
ya que el modelo deja de tener la opción de pedir otra herramienta).

2 tests nuevos en `agent.loopExhaustion.test.ts` (mockeando `deepseek.chat.completions.create` directo -
gratis, sin `*Paid.ts`, mismo patrón que otros tests mockean `globalThis.fetch`): uno confirma la llamada
extra + que el texto final reemplaza la promesa colgada, otro confirma la alerta al dueño cuando ni
siquiera la llamada extra da texto. `npx tsc --noEmit` limpio; ese archivo (2/2) +
`agent.claimBackstopGuards.test.ts` + `agent.corePersonality.test.ts` + `agent.customerName.test.ts` +
`agent.humanRequest.test.ts` + `agent.paymentGuard.test.ts` + `agent.photoBackstop.test.ts` +
`tools.test.ts` corridos juntos (93/93) - ningún comportamiento del camino normal (loop que termina antes
de la 5ta iteración) cambia. No es real-cost. No committeado ni desplegado todavía.

### Fase D — DONE 2026-09-13 (código), SIN VALIDAR CONTRA CONVERSACIÓN REAL — Precisión de categoría y color (cubre F7)

Aflojar la condición doble de `shouldForceAttributeFilter`: forzar también con **solo color** o **solo
categoría**, no exigir ambos. Agregar fallback de vocabulario cuando `Product.category` está vacío
(derivar de nombres de producto). Considerar permitir el forzado en iteraciones posteriores a la primera
cuando el cliente aporta el color recién ahí.

Validación: tests de la clasificación con negocio sin categorías cargadas; `agent.categoryColorScopePaid.ts`
para el comportamiento real del modelo (costo real, solo con tu aprobación).

**Implementado**: `shouldForceAttributeFilter` en `agent.ts` cambió el `&&` por `||` entre
`canonicalColors(customerText).length > 0` y `textMentionsConfiguredCategory(...)` - ahora un mensaje de
solo color ("el negro", "quiero el rosadito") o solo categoría ("¿que relojes tienen?") fuerza igual que
antes solo forzaba la combinación exacta "reloj negro". `textMentionsConfiguredCategory` (`products.ts`)
gana el fallback de vocabulario: cuando ningún producto activo tiene `category` poblada (default de un
negocio nuevo), deriva palabras candidatas de los NOMBRES de producto, contando solo una palabra que
aparece en 2+ productos distintos (evita que un nombre de modelo/marca de un solo producto cuente como
"categoría"). Sigue sin vocabulario hardcodeado - se deriva 100% del catálogo real del negocio.
**Deliberadamente no implementado**: forzar en iteraciones >0 dentro del mismo turno - el escenario
concreto que motivaba esto ("cliente aclara color en OTRO turno, primera iteracion ya se gasto en algo
mas") ya queda resuelto por el cambio de `&&` a `||`: cada turno computa `shouldForceAttributeFilter` de
nuevo sobre SU PROPIO `customerText`, así que un turno posterior de "el negro" solo (color-only) ahora
fuerza por sí solo sin necesitar categoría en ese mismo mensaje. Forzar además a mitad del MISMO turno
agregaría una segunda superficie de `tool_choice` forzado por poco beneficio adicional identificado; el
plan mismo lo dejaba en "considerar", no como requisito.

**Riesgo real, más alto que la Fase 4 original, sin resolver todavía**: aflojar a `||` significa que
CUALQUIER mensaje que solo mencione una palabra de categoría (sin color) ahora fuerza
`find_products_by_attributes` - incluye una queja o pregunta que no es de catálogo pero comparte esa
palabra ("el reloj que compré llegó roto" en un negocio que vende relojes). Esto es una superficie de falso
positivo mayor que la que ya quedó "implementada pero no probada" en la Fase 4 original del plan de
fiabilidad. 3 tests nuevos en `products.test.ts` (fallback por nombre, palabra de un solo producto
excluida) + los 2 tests existentes de la clasificación + toda la suite no-paga corrida junta (118/118) -
pero ninguno de estos tests ejercita al modelo real decidiendo si llamar la herramienta, solo la
clasificación determinística que alimenta la decisión. Sigue pendiente, igual que Fase 4, correr
`agent.categoryColorScopePaid.ts` (ya cubre justo el caso reloj-negro) contra conversaciones reales antes
de confiar en este cambio en producción - no corrido en esta sesión (costo real, solo con aprobación
explícita del usuario, y el usuario ya indicó que no hacen falta más regresiones por ahora para lo ya
implementado hasta este punto - este trade-off queda anotado para revisar antes del deploy final). `npx
tsc --noEmit` limpio. No committeado ni desplegado todavía.

### Fase E — DONE 2026-09-13 (código), SIN VALIDAR CONTRA CONVERSACIÓN REAL — Flujo de catálogo y fotos (cubre F8)

Tercera variante de directiva de fotos: listar el catálogo y ofrecer fotos, salvo que el mensaje del
cliente ya las haya pedido, en cuyo caso mandar productos y fotos en el mismo turno. Usar `hasMedia` para
no ofrecer fotos de productos que no tienen. Como es un toggle nuevo por negocio, ships con su UI en el
panel en la misma fase (regla vigente del proyecto).

Validación: `agent.ambiguousRequestsPaid.ts` cubre parte del terreno; probablemente haga falta un caso
nuevo. Costo real, solo con tu aprobación.

**Implementado**: nuevo campo `Business.offerPhotosBeforeSending` (migración
`20260913202517_add_offer_photos_before_sending`), independiente de `autoSendPhotoOnQuote` en vez de
convertirlo en un enum de 3 valores - así ningún negocio existente cambia de comportamiento por default,
y el campo booleano AUTO/REACTIVE que ya usan todos los negocios queda intacto. Nueva
`PHOTO_DIRECTIVE_OFFER_THEN_SEND` en `systemPrompt.ts`: lista por texto con `hasMedia` para no ofrecer
fotos de productos sin media, excepción cuando el cliente ya pidió fotos en el mismo mensaje del
catálogo/lista (manda lista+fotos juntas), y sigue el mismo patrón que las otras dos para pedidos
puntuales posteriores. Aprovechado el cambio para sacar el bloque final duplicado (advertencias sobre
`[Foto de PRODUCTO]` falso y la cita de foto respondida) a `PHOTO_DIRECTIVE_SHARED_TAIL` compartido por
las 3 variantes - ahorro de edición duplicada, no de tokens por mensaje real (solo UNA variante se manda
por negocio). `buildSystemPrompt` prioriza `offerPhotosBeforeSending` sobre `autoSendPhotoOnQuote` cuando
está activo. Wireado en los 3 lugares que ya pasaban `autoSendPhotoOnQuote` (`whatsapp.ts`, `admin.ts` GET
(automático, ya devuelve el objeto completo) + PUT, `scripts/run-regression-suite.ts`). **UI en el panel
en la misma fase** (regla del proyecto): el checkbox único de fotos se reemplazó por un `<select>` de 3
opciones ("Tu negocio" → "Cuando el bot muestra fotos de productos") - verificado visualmente en el
navegador (`public/admin/index.html` abierto como archivo estático): las 3 opciones renderizan con el
texto correcto, sin errores de JS nuevos (el único error de consola, `io is not defined`, es de
socket.io no cargado en la vista estática sin servidor, no relacionado con este cambio). 3 tests nuevos en
`agent.corePersonality.test.ts` (default AUTO, REACTIVE explícito, y que `offerPhotosBeforeSending` gana
aunque `autoSendPhotoOnQuote` también esté en `true`). `npx tsc --noEmit` limpio; ese archivo (12/12).

**Sin validar contra conversación real** (igual que Fase D): esta es la primera fase de esta ronda que
cambia contenido visible al modelo para un caso de uso concreto - depende de que el modelo respete "listar
primero, ofrecer, no mandar fotos todavía salvo excepción" de forma consistente, algo que solo una
conversación real (`agent.ambiguousRequestsPaid.ts` o un caso nuevo) puede confirmar. No corrido en esta
sesión (costo real, requiere aprobación explícita). Feature nueva, off por defecto - cero riesgo para
negocios existentes hasta que alguno la active explícitamente desde el panel.

### Fase F — DONE 2026-09-13 (código) — Guard de total y observabilidad (cubre B5, F6, F9)

Guard del TOTAL contra lo que devolvió `show_order_summary`. Revisitar F6 ahora que hay más contexto:
posiblemente sí se pueda reescribir la cifra de envío cuando hay una sola tarifa aplicable. Exponer en el
panel: conversaciones estancadas, agotamientos de loop, intervenciones de backstop por período.

**B5 implementado**: nuevo `guardAgainstOrderTotalMismatch` en `agent.ts` - `show_order_summary` calcula un
único total real y sin ambigüedad por llamada (a diferencia del envío, que puede tener varias tarifas), así
que a diferencia del guard de envío este SÍ tiene con qué comparar de forma inequívoca. Detección + alerta
al dueño (no reescritura in-place): el número aparece con formato variable ("$145.000", "145000") y
reemplazar el substring a ciegas arriesga romper texto no relacionado peor que la reescritura de envío de
abajo. Refactor menor: `alertOwnerOfDegradedReply` (Fase C) ahora reusa un `alertOwner` compartido en vez de
duplicar la llamada a `sendOwnerAlert`/`recordOwnerMessage`.

**F6 revisitado**: `guardAgainstShippingCostHallucination` cambió de `void` (solo loggeaba) a `string`
(puede corregir). Con **exactamente una tarifa configurada** el número real es inequívoco, así que ahora
reescribe la cifra mencionada por la real en el mismo lugar del texto en vez de solo loguear. Con 2+
tarifas seguí siendo detection-only (razón original 2026-09-12 sigue siendo válida: no hay forma de saber
cuál tarifa aplica sin el contexto de ciudad/categoría que este guard no tiene).

**F9 implementado**: nuevo modelo `AgentIncident` (migración `20260913203332_add_agent_incidents`) +
`src/ai/incidents.ts` (`recordAgentIncident`, best-effort - nunca revienta el turno real si falla el
insert; `getAgentIncidentSummary`). Instrumentado en 3 puntos de `agent.ts`: agotamiento del loop
(`LOOP_EXHAUSTED`), cada reparación real de `applyClaimBackstops` (`BACKSTOP_INTERVENTION`, con el nombre
del guard) y cada alerta de respuesta degradada (`DEGRADED_REPLY`, vía `alertOwnerOfDegradedReply`). Nuevo
`GET /api/agent-incidents` en `admin.ts`, scoped por negocio igual que `/api/ai-usage`. Nueva sección "Salud
del bot (últimos 7 días)" en el panel, tab "Consumo de IA" (mismo lugar donde Track C item 5 agregó el
desglose de cache-hit): conversaciones estancadas ahora mismo (contadas en vivo desde `Conversation`, no
desde la tabla de incidentes - reusa los campos de la Fase A), respuestas degradadas, e intervenciones de
respaldo. Verificado visualmente (misma limitación que Fase E: vista estática sin servidor, el fetch falla
por URL relativa pero cae en el `catch` existente sin ningún error de JS nuevo).

10 tests nuevos: `agent.orderTotalGuard.test.ts` (4), `agent.shippingCostGuard.test.ts` (5 - reescribe con
1 tarifa, detection-only con 2+, no toca texto sin mención de envío), `incidents.test.ts` (3 - persistencia,
conteo por tipo, conteo en vivo de estancadas, nunca revienta con un businessId inexistente). `npx tsc
--noEmit` limpio; conjunto agent+tools+products corrido junto (130/130). No es real-cost. No committeado ni
desplegado todavía.

### Fase G — DONE 2026-09-13 (código) — Chequeo de configuración por negocio (robustez multi-negocio)

Una vista de "salud de configuración" en el panel que marque lo que hoy falla en silencio: sin
`contactPhone`, sin categorías cargadas, sin plantilla de alerta aprobada, sin métodos de pago. Hoy cada
una de esas produce una falla distinta y silenciosa en producción.

**Implementado**: nuevo `src/ai/configHealth.ts` (`getConfigHealth`), 4 chequeos DB-only más uno externo:
`contactPhone` configurado (F5), al menos un producto activo con `category` real poblada (F7 - el fallback
de nombres de la Fase D tapa el síntoma en código pero un negocio real sigue mejor con categorías reales),
al menos un método de pago activo, y si la plantilla `onix_owner_alert` está APROBADA en WhatsApp
(`listApprovedTemplates` contra la Graph API real - único chequeo que puede fallar/no aplicar, por eso
devuelve `null` explícito en vez de `false` cuando el negocio ni siquiera tiene WhatsApp Business conectado
todavía, para no mostrar una advertencia sobre algo que nunca se pudo verificar). Nuevo
`GET /api/config-health` en `admin.ts`, scoped por negocio. UI: checklist con ✅/⚠️/⏳ en la misma sección
"Salud del bot" del tab "Consumo de IA" (Fase F) - cada ítem sin cumplir explica en una línea qué se rompe
y en qué pestaña del panel arreglarlo. Verificado visualmente en el navegador (misma vista estática sin
servidor de las fases anteriores): la función de render se probó directo con los 4 estados posibles
(✅/⚠️/⏳ y combinaciones), sin errores de JS. 4 tests nuevos en `configHealth.test.ts` (negocio nuevo sin
nada configurado marca los 3 primeros en `false` y el cuarto en `null`; cada chequeo pasa a `true` una vez
configurado). `npx tsc --noEmit` limpio. No es real-cost (no llama a DeepSeek; sí llama a la Graph API real
de WhatsApp cuando el negocio tiene credenciales, mismo patrón que el resto del panel de plantillas). No
committeado ni desplegado todavía.

## Orden sugerido

A → B → C son las tres que atacan directamente la queja de "el bot se calla y no vuelve", y ninguna
depende de las otras. D y E son precisión/producto. F y G son red de seguridad y prevención.

Recomendación: arrancar por A, que es la que hoy deja conversaciones muertas de forma permanente y es la
única de las tres donde ni el cliente ni el dueño se enteran de nada.
