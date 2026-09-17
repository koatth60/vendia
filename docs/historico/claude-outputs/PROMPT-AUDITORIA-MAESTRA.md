# Prompt: auditoría maestra de Onix y plan de reconstrucción

> Pegar tal cual al iniciar una sesión nueva (recomendado: Opus, contexto limpio, sin trabajo previo
> en la conversación). No es un prompt de implementación: el resultado son dos documentos.

---

## Contexto

Onix es el agente de ventas por WhatsApp de Zaqi Solutions (repo `APP BOT`, Node/TypeScript/Express/
Prisma/Postgres, DeepSeek como modelo principal con failover, Anthropic solo para visión, panel admin
en `public/admin/`, socket.io para tiempo real). Es multi-tenant: cada `Business` tiene su catálogo,
sus métodos de pago, sus reglas de envío, su FAQ y su número de WhatsApp Cloud API. Hoy hay un piloto
real en producción (MAG.IMP, Colombia) y el producto se va a vender a negocios de Colombia primero y
de México después.

La ambición declarada del dueño: que Onix deje de ser "un bot con parches" y sea un agente de
mensajería y agente virtual de negocios **robusto, estructurado y completo**, comparable o superior a
Wati, Zoko, Yalo, ManyChat, Cliengo, Aivo e Intercom en el mercado hispanohablante.

El problema declarado: en los últimos días se encontraron errores de muchos tipos; cada uno se
resolvió con un parche; el resultado es un sistema sin una estructura que se sostenga sola. Los
parches acumulados (regex de backstop, guards, reglas de prompt) tapan síntomas y abren casos nuevos.

## Objetivo de esta sesión

Producir un **diagnóstico técnico de causa raíz** y un **plan maestro de desarrollo** que convierta a
Onix en un agente robusto de nivel producto. No es una lista de bugs: es la respuesta a por qué el
ciclo de parches no termina y qué arquitectura lo termina.

**No modifiques código en esta sesión.** Ni un archivo de `src/`, ni migraciones, ni prompts. La
única escritura permitida son los dos documentos entregables (y notas temporales en el scratchpad).

Esta es la **segunda auditoría**. Ya existe una previa de arquitectura del agente (2026-09-14) que
cubrió el núcleo de IA. El valor de esta está en dos cosas: (1) confirmar o refutar aquello contra el
código de hoy con conversaciones reales como evidencia, y (2) cubrir todo lo que aquella no miró —
plataforma WhatsApp, confiabilidad de infraestructura, seguridad y aislamiento entre negocios,
privacidad, costo a escala, panel, expansión a México y capacidades de producto frente al mercado.
Si tu documento termina siendo una reescritura del anterior, falló.

## Restricciones operativas (obligatorias)

- No corras `npm run regression` ni `npm run test:paid`: cuestan dinero real y el dueño decide cuándo.
  `npm test` (gratis) sí se puede correr para ver el estado real de la suite.
- No hagas deploy ni toques producción con escrituras. Lectura de la base de producción sí, si hace
  falta evidencia (`ssh vendia`, ver `CLAUDE.md` y `scripts/`).
- Respeta las reglas de tokens de `CLAUDE.md`: `Grep` y `Read` con `offset`/`limit` en vez de volcar
  archivos grandes; delega barridos amplios a subagentes `Explore` para no llenar el contexto
  principal con contenido crudo.
- Nunca pruebes con credenciales reales de WhatsApp: un `generateReply` real con credenciales del
  piloto ya le mandó mensajes al dueño real una vez.

## Lectura previa obligatoria (para no repetir trabajo ya hecho)

Lee estos documentos antes de auditar, y trátalos como estado del arte, no como verdad:

- `ONIX-AUDITORIA-ARQUITECTURA.md` (2026-09-14) — ya diagnostica que el modelo *es* la máquina de
  estados y que los ~49 guards de regex no pueden converger. Tu auditoría debe **partir de ahí y
  extenderlo**, no reescribirlo. Verifica sus afirmaciones contra el código actual y di cuáles siguen
  vigentes.
- `ONIX-RELIABILITY-PLAN.md` — plan por fases de endurecimiento; marca qué fases están DONE y cuáles
  no, y evalúa si las que faltan siguen siendo la respuesta correcta.
- `ONIX-ROBUSTNESS-AUDIT.md` — auditoría previa de robustez (fases A–G).
- `ONIX-CONVERSATIONS-GROUPING-PLAN.md`, `ONIX-CRM-REORG-PLAN.md`, `design/ONIX-REDESIGN-PLAN.md`.
- `CLAUDE.md` (reglas del repo) y `README.md`.

Al final del diagnóstico incluye una sección corta: **qué de lo ya documentado sigue siendo cierto,
qué quedó obsoleto y qué nunca se implementó.**

### Hallazgos ya establecidos: valídalos contra el código de hoy, no los redescubras

`ONIX-AUDITORIA-ARQUITECTURA.md` ya dejó esto medido. Para cada punto, confirma o refuta con
`archivo:línea` actual, actualiza el número si cambió, y **sigue de largo hacia lo que no está ahí**.
Si estás repitiendo uno de estos, estás gastando la sesión.

| Señal medida (2026-09-14) | Valor |
|---|---|
| Regex con nombre en `agent.ts` | 36 |
| Regex en toda la superficie de guards | 49 |
| Commits que tocan `agent.ts` desde 2026-09-01 | 55 |
| Capas de parche sobre una sola promesa (fotos) | 5 |
| Pruebas deterministas de conversación completa | 0 |

Fallos ya identificados (A–J): el pedido en curso no existe en ninguna parte hasta el cierre
(`pendingOrderItems` solo se escribe en `tools.ts` al confirmar; `checkoutStateFromDb.ts:43` lo deja
escrito); cuatro guards disparan efectos reales decididos por regex sobre prosa (`escalation` manda
WhatsApp al dueño, `catalog_check`, `payment_options`, y el backstop de media manda fotos por
solapamiento de tokens ≥0.6); la composición de ~12 transformaciones sobre `text` en `finalizeTurn`
no está probada ni ordenada, y una de ellas reemplaza la respuesta entera; no hay prueba determinista
de flujo completo; `tool_choice` forzado se activa con OR demasiado amplio; el presupuesto de 5
iteraciones está al límite; `zonasSinDocumento: ["bogota","soacha"]` es regla de MAG.IMP dentro de un
archivo core; no hay agrupación de ráfagas de mensajes; el prompt creció por acumulación y ya contiene
meta-reglas sobre cuál regla gana; el cierre sin venta (`LOST`) no tiene flujo ni criterio de
inactividad.

Diferenciadores ya identificados frente al mercado (verifícalos, no los repitas): visión sobre fotos
del cliente, round-trip de `ask_owner` por WhatsApp, y FAQ aprendida de las respuestas reales del
dueño. Lo que todos los competidores tienen y Onix no: dos capas separadas, un motor determinista
dueño del estado y la validación, y el LLM solo entendiendo y redactando.

## Evidencia que debes usar (no opines sin datos)

### 1. Conversaciones reales — esto es lo central del pedido

Revisa **todas** las conversaciones disponibles, no una muestra cómoda:

- Fixtures anonimizados: `src/ai/regression/fixtures/conversations.json` (+ su `README.md`) y
  `catalog.json`. Son conversaciones reales de producción ya anonimizadas.
- Base de datos: modelos `Conversation`, `Message`, `Customer`, `Order`, `PendingOwnerQuestion`,
  `AgentIncident`, `DeliveryFailure`, `OwnerMessageLog`, `QueuedOutboundMessage`, `AiUsageLog`,
  `LearnedFaqCandidate` en `prisma/schema.prisma`. Si necesitas datos de producción, usa
  `scripts/anonymize-conversations.js` y trabaja sobre la salida anonimizada, nunca sobre PII cruda.
- Escribe un script de análisis desechable en el scratchpad (no en `scripts/`) si te ayuda a
  clasificar en masa: turnos por conversación, tasa de escalamiento a humano, conversaciones que
  mueren sin cierre, pedidos abandonados, repreguntas del bot, mensajes del cliente sin respuesta,
  latencia entre mensaje entrante y saliente, reintentos, intervenciones de backstop.

Para cada conversación con problema anota: qué pidió el cliente, qué hizo el bot, en qué turno se
rompió, **qué causa estructural lo permitió** (no "faltó un regex"), y si un competidor del mercado
lo habría manejado bien.

### 2. Código

Mapea y cuantifica la superficie real:

- `src/ai/agent.ts` (loop, backstops, guards), `src/ai/tools.ts`, `src/ai/prompts/*`,
  `src/ai/client.ts`, `src/ai/modelFailover.ts`, `src/ai/incidents.ts`, `src/ai/configHealth.ts`.
- Estado de venta: `src/orders/checkoutState.ts`, `checkoutStateFromDb.ts`, `src/orders/service.ts`.
- Entrada/salida: `src/routes/whatsapp.ts`, `src/whatsapp/client.ts`, `src/whatsapp/embeddedSignup.ts`,
  `src/delivery/failures.ts`, `src/media/*`.
- Catálogo y conocimiento: `src/catalog/*` (products, faq, learnedFaq, attributeTaxonomy,
  categoryAliases, shippingRates, paymentMethods), `src/search/text.ts`.
- Jobs: `src/jobs/conversationHealth.ts`, `escalationReminder.ts`, `followUp.ts`.
- Panel y API: `src/routes/admin/*`, `public/admin/`.
- Tests: los 40+ `*.test.ts` — qué cubren de verdad y qué no; la suite `*Paid.ts`; la suite de
  regresión y **sus límites estructurales** (replica turnos aislados, no puede detectar fallas de
  varios turnos ni de infraestructura).

Números concretos que quiero ver en el documento: cuántos guards/regex hay y en qué archivos, cuántas
herramientas expone el modelo y con qué contrato, cuántas líneas tiene el system prompt y cuántos
tokens cuesta por turno, cuántas ramas condicionales hay en el loop, qué porcentaje del código de
`agent.ts` es reparación posterior en vez de lógica de negocio.

Tres barridos que dan señal barata y que la auditoría anterior no agotó:

- **Churn de git como mapa del dolor.** `git log --since=2026-08-01 --format= --name-only | sort |
  uniq -c | sort -rn | head -30`. Los archivos con más commits son donde el ciclo de parches vive.
  Para los tres primeros, lee los mensajes de commit y clasifica cada cambio: función nueva, o
  reparación de un incidente. La proporción es el indicador más honesto del estado del sistema.
- **Comentarios que documentan el hueco.** El repo ya se diagnostica solo en varios lugares
  (`checkoutStateFromDb.ts:43` describe exactamente el problema central; `learnedFaqQuality.ts`
  explica por qué perseguir palabras sueltas no puede funcionar, lección que no se generalizó a los
  otros 30 regex). Haz `grep` de TODO, FIXME, HACK, "por ahora", "temporal", "no debería" y de
  comentarios largos en `src/`, y arma una lista: qué hueco documenta cada uno y si sigue abierto.
- **Código correcto pero desconectado.** Busca lo que está bien diseñado y no mide nada.
  `computeCheckoutState` es el caso conocido: corre en `void ... .then()` dentro de `finalizeTurn`,
  solo escribe a log, y su fuente de datos está vacía. Lista todo lo que esté en esa situación: es
  trabajo ya pagado que se activa barato.

### 3. Benchmark de mercado

Compara contra Wati, Zoko, Yalo, ManyChat, Cliengo, Aivo, Intercom/Fin y, si aplica, contra los
agentes nativos de Meta. Usa búsqueda web para verificar capacidades actuales; no cites de memoria.
Distingue explícitamente entre **table stakes** (lo que cualquier competidor tiene y Onix debe tener
para poder venderse) y **diferenciador** (donde Onix puede ganar). Ya existe un artefacto publicado
de comparación de mercado; si lo encuentras, actualízalo en vez de duplicarlo.

## Ejes que la auditoría debe cubrir

No te quedes en la capa de IA. Cada eje: estado actual con evidencia, hueco, riesgo, causa raíz.
Los ejes 1 a 3 ya tienen trabajo previo (ver arriba): valida y avanza. Los ejes 4 a 19 son donde más
terreno nuevo hay.

1. **Arquitectura conversacional**: dónde vive el estado de la venta, qué es verificable antes de
   responder y qué solo se repara después. Veredicto explícito: ¿esto es un agente con arquitectura o
   un prompt con parches?
2. **Contrato de herramientas**: validación de argumentos, idempotencia, efectos secundarios,
   herramientas que el modelo puede llamar en un orden inválido, qué pasa cuando falla una.
   Inventario obligatorio: **todo guard que dispare un efecto lateral real** (mensaje al dueño, envío
   de fotos, datos de pago pegados al mensaje) y en qué se basa para decidirlo. Es la clase más
   peligrosa del sistema.
3. **Arquitectura de prompt**: qué es core vs por negocio vs por vertical, duplicación, reglas que se
   contradicen, meta-reglas sobre cuál regla gana, costo por turno, qué debería ser código y hoy es
   instrucción en lenguaje natural.
4. **Genericidad multi-negocio**: qué está hardcodeado al piloto (vocabulario, categorías, flujos,
   supuestos de moneda o envío) y rompería con un negocio de otro rubro. Marca cada hallazgo como
   MAG.IMP-específico o core.
5. **Expansión a México**: moneda y formato de precios, métodos de pago (Nequi/PSE/Bancolombia vs
   SPEI/OXXO/Mercado Pago/CoDi), reglas de envío y paquetería, formato de teléfono, zona horaria,
   variantes de español y modismos, facturación e impuestos, festivos. Qué es configuración y qué
   hoy está clavado en código.
6. **Plataforma WhatsApp**: ventana de 24 horas, plantillas y su aprobación, opt-in/opt-out, calidad
   del número y riesgo de bloqueo, límites de tasa, errores de la Cloud API, estados de entrega,
   webhooks duplicados o fuera de orden, multimedia, multi-número y Embedded Signup.
7. **Confiabilidad**: idempotencia del webhook, concurrencia y locks de conversación, orden de
   mensajes, reintentos y backoff, cola de salida, dead-letter, qué pasa si DeepSeek se cae o
   responde lento, límites de timeout, arranques en frío, migraciones.
8. **Traspaso a humano**: cuándo escala, qué ve el humano, cómo retoma el bot, qué pasa si el dueño
   nunca contesta, SLA y recordatorios.
9. **Observabilidad y evaluación**: qué se puede responder hoy a "¿el bot está funcionando bien?" sin
   leer conversaciones a mano. Falta (o no) un harness de evaluación offline determinista, métricas
   de calidad conversacional, alertas, trazas por turno, tablero de incidentes.
10. **Datos y privacidad**: Habeas Data (Ley 1581 de 2012, Colombia) y LFPDPPP (México) —
    consentimiento, retención, supresión, tratamiento de datos de clientes finales del negocio.
    Existe una decisión pendiente del dueño sobre consentimiento para persistir nombres; márcala.
11. **Seguridad**: autenticación y sesiones del panel, aislamiento entre negocios (¿algún endpoint
    puede leer datos de otro `Business`?), secretos, firma de webhooks, subida de archivos, S3.
12. **Costo y rendimiento**: tokens por conversación, latencia por turno, costo por negocio al mes,
    qué escala mal con 50 o 500 negocios.
13. **Panel de administración**: qué le falta al dueño del negocio para operar sin pedirle nada al
    desarrollador (esto es lo que venden los competidores).
14. **Capacidades de producto ausentes**: campañas y difusión, plantillas, segmentación, embudos,
    carritos y pagos en chat, catálogo nativo de WhatsApp, multiagente y bandeja de equipo, horarios
    de atención, reportes, integraciones, API pública, multicanal (Instagram/Messenger/web).
15. **Composición y orden del pipeline de respuesta**: las transformaciones sucesivas sobre el texto
    final. Cuántas son, en qué orden corren, si ese orden fue diseñado o es el orden en que se
    fueron escribiendo, cuáles reemplazan la respuesta entera y cuáles agregan texto después de una
    pregunta. Prueba de la combinación, no de cada una por separado.
16. **Control del loop**: presupuesto de iteraciones y qué lo consume, política de `tool_choice`
    forzado (en qué contexto corresponde forzar y en cuál reencuadra mal la conversación), caminos
    de recuperación por agotamiento, y cuántas llamadas al modelo cuesta un turno típico.
17. **Aprendizaje y base de conocimiento**: el ciclo de FAQ aprendida es el diferenciador real, y
    está a medias. Revisa: qué mide el umbral de sugerencia (cuántos clientes preguntaron vs cuántas
    veces el dueño confirmó la misma respuesta), si hay normalización/reescritura del borrador antes
    de mostrarlo al dueño, cómo se deduplican candidatos, si existe retroalimentación que mida si
    una FAQ aprobada bajó las escalaciones de ese tema, caducidad y revisión de entradas que
    envejecen (precios, promociones), cómo escala `get_faq` con 100 entradas en vez de 12, dónde se
    intercepta la FAQ dentro del loop y qué cuesta, y **la fuente que hoy se pierde**: las
    conversaciones donde el dueño tomó control manual desde el panel y respondió a mano
    (`humanControl`), que es más volumen y mejor contexto que la escalación sola.
18. **Salidas de la conversación**: cierre sin venta, inactividad, cliente que nunca vuelve,
    reactivación. Hoy la salida "no compra" depende de que el modelo decida llamar una herramienta.
    Qué pasa con las conversaciones que simplemente mueren, y cómo aparecen en las métricas.
19. **Ritmo y forma de la respuesta**: agrupación de ráfagas de mensajes del cliente, indicadores de
    escritura, partir mensajes largos, tiempos de respuesta. Es lo que hace que se sienta persona y
    ningún guard lo cubre.

## Entregables

Dos archivos markdown en la raíz del repo. Español neutro, técnico, sin emoji. Toda afirmación con
evidencia: `archivo:línea` para código, id o extracto para conversaciones.

### A. `ONIX-DIAGNOSTICO-2026-09.md`

1. Resumen ejecutivo (máximo 20 líneas): el veredicto, sin adornos.
2. Taxonomía de fallas encontradas en conversaciones reales: tabla con tipo de falla, frecuencia,
   ejemplo, impacto en el cliente, severidad.
3. Árbol de causa raíz: agrupa las fallas en pocas causas estructurales (idealmente 3 a 6) y muestra
   qué síntomas cuelgan de cada una. Cada causa debe explicar por qué generó parches y por qué los
   parches no la cierran.
4. Estado por cada uno de los 19 ejes de arriba.
5. Inventario de deuda: lista de parches, guards y reglas de prompt existentes, con la causa raíz que
   cada uno intenta tapar y si desaparece al arreglar la causa.
6. Brecha de mercado: tabla contra los competidores, separando table stakes de diferenciadores.
7. Qué de la documentación previa sigue vigente, qué quedó obsoleto, qué nunca se implementó.
8. Riesgos que pueden hundir el producto en los próximos 90 días (bloqueo del número de WhatsApp,
   fuga de datos entre negocios, costo por conversación, etc.).

### B. `ONIX-PLAN-MAESTRO.md`

1. Arquitectura objetivo: cómo se ve Onix cuando está bien hecho. Diagrama en texto de los
   componentes, dónde vive el estado, qué es determinista y qué decide el modelo, qué se valida antes
   de hablar y qué después. Incluye las alternativas que descartaste y por qué.
2. **Fase 0 obligatoria: línea base.** Hoy no existe un número contra el cual comparar ninguna
   mejora. Define qué se mide, de dónde sale (el modelo `AgentIncident` ya existe), y cuánto tiempo
   de línea base hace falta antes de cambiar nada.
3. **Diseño de la prueba determinista de conversación completa**, con detalle suficiente para
   implementarla: conversaciones reales anonimizadas, modelo mockeado con respuestas grabadas,
   aserciones sobre **estado final y secuencia de llamadas a herramientas**, nunca sobre el texto
   exacto; corre dentro de `npm test`, gratis, en segundos. Es la fase que cambia el régimen: sin
   ella, producción sigue siendo la suite de pruebas.
4. Fases en orden de dependencia. Cada fase con: objetivo en una frase, causa raíz que cierra,
   cambios concretos (archivos, modelos de datos, migraciones), **parches existentes que elimina**,
   criterios de aceptación verificables, cómo se prueba sin gastar dinero en llamadas reales, riesgo,
   plan de reversión, esfuerzo estimado, y si es core o específico de un negocio.
5. Ruta mínima a producto vendible en Colombia y ruta a México, con lo que cada una exige.
6. Definición de "listo": qué métricas debe cumplir Onix para considerarse robusto (tasa de
   resolución sin humano, tasa de pedidos completados, intervenciones de backstop por cada 100
   turnos, latencia, costo por conversación). Ojo: "cero intervenciones de backstop" es una métrica
   sustituta —mide cuántas veces se activó el parche, no si la venta funcionó—; propone métricas que
   midan el resultado para el cliente.
7. Qué **no** se va a hacer y por qué.

## Reglas para las propuestas

- **Criterio que separa lo que se queda de lo que se va**: un guard que **valida el argumento de una
  herramienta contra la base de datos antes de ejecutarla** es correcto y se queda (el guard de
  `paymentMethodLabel` es el ejemplo bueno). Un guard que **lee la prosa generada por el modelo para
  adivinar qué pasó** se va. Clasifica cada uno de los 49 con este criterio.
- **No se agrega un regex más sin borrar uno.** Cada fase reemplaza una clase de guard haciendo
  imposible su modo de falla, con una prueba determinista que lo demuestre.
- Ninguna propuesta puede ser "agregar otro backstop" o "mejorar el prompt" como solución principal.
  Si un hueco solo se arregla con instrucción en lenguaje natural, dilo explícitamente y explica por
  qué ahí sí corresponde.
- Cada fase debe decir qué código existente **borra**. Un plan que solo suma es otro parche.
- Prefiere lo determinista sobre lo probabilístico cuando el resultado sea verificable (totales,
  stock, precios, estados de pedido, datos de entrega).
- Nada de vocabulario de un rubro clavado en código: todo lo específico del negocio es configuración.
- Toda funcionalidad configurable por negocio incluye su UI en el panel en la misma fase.
- Si algo requiere una decisión de producto que no te corresponde (consentimiento de datos, precios,
  alcance), no la inventes: lístala como decisión pendiente del dueño, con opciones y consecuencias.

## Cómo trabajar

Esta sesión va a ser larga y es probable que el contexto se compacte en el medio. Trabaja para
sobrevivir eso: crea `ONIX-DIAGNOSTICO-2026-09.md` temprano y **ve escribiendo hallazgos con su
evidencia a medida que los confirmas**, en vez de acumular todo en el contexto para redactar al
final. Guarda en el scratchpad las salidas crudas de los barridos (churn de git, clasificación de
conversaciones) y cita el archivo, no el contenido.

Investiga primero y escribe después: no empieces a redactar hasta tener la evidencia. Usa subagentes
`Explore` en paralelo para los barridos amplios (conversaciones, superficie de código, benchmark de
mercado) y consolida tú en el contexto principal. Si al terminar el diagnóstico te queda una duda que
cambia el plan de forma material, pregúntala antes de escribir el plan; las demás resuélvelas con una
suposición declarada.

### Punto de parada obligatorio

La sesión tiene dos mitades con exigencias distintas. La primera (recolectar evidencia, clasificar
conversaciones, contar, verificar) es trabajo de barrido. La segunda (el árbol de causa raíz y la
arquitectura objetivo) es donde la profundidad de razonamiento cambia el resultado.

Cuando termines el diagnóstico —ejes cubiertos, taxonomía de fallas armada, evidencia recolectada— y
**antes** de escribir el árbol de causa raíz y `ONIX-PLAN-MAESTRO.md`, detente y escribe en el chat,
en una línea sola y exacta:

```
LISTO PARA SÍNTESIS — subir esfuerzo antes de continuar
```

Debajo, en cinco líneas máximo: cuántas conversaciones revisaste, cuántas fallas clasificaste,
cuántas causas candidatas ves, y qué decisiones pendientes del dueño encontraste. Después **espera**.
No sigas hasta que el dueño responda. Si responde "seguí" sin más, continúa igual.

Al final, resume en el chat: el veredicto en tres líneas, las causas raíz, y la primera fase
recomendada. Los detalles quedan en los documentos.
