# Onix Pro — Plan de confiabilidad e infraestructura

Documento unificado. Junta dos cosas:

1. **La auditoría de código del 2026-09-16**, hecha a pedido del dueño sin leer ningún `.md` previo
   para no heredar sesgo. De ahí salen las fases 0 a 9.
2. **El encargo de arquitectura del dueño del 2026-09-17** (Master Audit & Incremental Reliability
   Plan). De ahí salen los principios de gobierno, el ciclo de trabajo, la Fase A y la Fase 3B.

**Qué NO cubre este documento:** las Fases 12, 13 y 14 de `ONIX-PLAN-MAESTRO.md` siguen su propio
camino y no se tocan acá. Tampoco reemplaza a `ONIX-PLAN-CATALOGO-Y-MEDIOS.md` ni a
`ONIX-RELIABILITY-PLAN.md`: aquellos son el plan del agente, este es el plan del sistema que lo rodea
y de las garantías que lo limitan.

---

# PARTE I — PRINCIPIOS DE GOBIERNO

## El objetivo, en una frase

Pasar de *"un LLM que sabe vender y usa herramientas"* a *"un sistema de ventas determinístico donde
el LLM conversa pero no puede romper las reglas del negocio"*.

No es hacer que el LLM sea perfecto. Es diseñar el sistema para que **no necesite serlo**.

## La división de autoridad

| El LLM manda en | El backend manda en |
|---|---|
| Conversación, tono, orden de las preguntas | Productos, precios, stock, colores, variantes |
| Interpretación de la intención del cliente | Categorías, imágenes, métodos de pago |
| Lenguaje natural, recomendación, objeciones | Pedidos, pagos, estados de pedido |
| Solicitud de herramientas | Envío de media, datos del cliente, cierre de transacción |

El LLM puede interpretar "quiero el naranja". El backend determina que naranja no existe y le entrega
las opciones reales. La conversación es flexible. Las reglas del negocio no.

## Fuente de verdad por dominio

Ninguna de estas es el LLM, en ningún caso:

- Productos, precios, stock, variantes, colores → PostgreSQL (catálogo).
- Pedidos y su estado → PostgreSQL.
- Pago → proveedor de pago, más backend, más PostgreSQL.
- Media → almacenamiento real, más metadatos persistidos.
- Configuración del negocio → PostgreSQL.
- Estado de la conversación → estado persistido.

## Regla de oro: TOOL CALL ≠ SUCCESS

Que el modelo pida una herramienta no significa que la operación haya ocurrido.

```
LLM solicita → BACKEND valida → TOOL ejecuta → BACKEND recibe resultado real
  → BACKEND verifica éxito/fallo → BACKEND persiste → LLM recibe resultado real
  → LLM comunica únicamente lo que ocurrió
```

Nunca: `LLM solicita → LLM asume éxito → LLM le dice al cliente que ocurrió`.

## El LLM no puede cambiar la realidad

Toda afirmación del agente necesita evidencia detrás:

| Si el agente dice | Tiene que existir |
|---|---|
| "cuesta $140.000" | El precio en la base |
| "hay stock" | El stock en la base |
| "lo tenemos en ese color" | La variante en el catálogo |
| "te envié las fotos" | Confirmación de la herramienta de envío |
| "tu pedido fue creado" | Una fila `Order` real |
| "tu pago fue recibido" | Confirmación del proveedor o del dueño |

## No arreglar el síntoma

Ante un defecto, la pregunta no es *"¿cómo hago que este caso funcione?"* sino **"¿qué garantía
faltaba que permitió que esto fuera posible?"**.

| Defecto real | Solución débil | Solución arquitectónica |
|---|---|---|
| El agente inventó el color naranja | "No inventes colores" en el prompt | El backend solo permite valores del catálogo, y se verifican antes de enviar |
| El agente dijo que mandó una foto que no llegó | "Acordate de mandar las fotos" | El agente no puede afirmar el envío si la herramienta no devolvió éxito |

Buscamos eliminar **clases de error**, no ejemplos.

## Las tres reglas de admisión del repositorio

Una fase entra solo si responde las tres:

1. **¿Qué decisión le quita a alguien?** Al modelo, al operador, o a la configuración. Una fase que
   agrega una bandera para que alguien se acuerde de prenderla es un parche.
2. **¿Qué se puede verificar con una consulta?** Con un `SELECT`, no con una opinión.
3. **¿Qué pasa si el proceso muere en el peor momento?** Si la respuesta es "se pierde y nadie se
   entera", la fase no está terminada.

Y para un efecto requerido, las tres del plan de catálogo: disparador determinista (nunca leído de la
prosa), verificable con una consulta, y con fallback sin modelo.

## Regla de cambio mínimo

- Nada de "ya que estamos, refactorizamos X, Y y Z".
- Nada de renombrar, embellecer ni abstraer sin necesidad.
- Nada de tocar funcionalidad no relacionada.

Cada cambio responde: qué error elimina, qué garantía agrega, qué prueba lo demuestra. Si no hace
falta para la debilidad en curso, no se hace.

## Criterio de terminación

Una fase **no** está terminada porque compila, porque `tsc` está limpio, porque los tests pasan o
porque el bot responde lindo. Está terminada cuando:

1. Existe una garantía concreta.
2. Existe una prueba que la demuestra.
3. El modelo no puede saltearla fácilmente.
4. Los fallos importantes producen estados explícitos, no silencio.
5. El sistema comunica solo información respaldada por resultados reales.
6. No se introdujeron regresiones.

---

# PARTE II — CICLO DE TRABAJO

```
AUDITAR → PRIORIZAR → ELEGIR UNA DEBILIDAD → DISEÑAR LA GARANTÍA
  → IMPLEMENTAR CAMBIO PEQUEÑO → TESTEAR → AUDITAR EL CAMBIO → OBSERVAR → DETENERSE
```

**Una debilidad por vez.** Antes de tocar código, se escribe:

```
PROBLEMA:
CAUSA RAÍZ:
GARANTÍA QUE SE AGREGA:
ARCHIVOS QUE SE TOCAN:
CAMBIOS PROPUESTOS:
TESTS QUE SE CREAN:
RIESGOS DE REGRESIÓN:
```

Después de implementar: correr los tests nuevos y los existentes relevantes, revisar el diff, buscar
regresiones y efectos secundarios, comprobar que la garantía existe de verdad y que no depende solo
del modelo, comprobar los caminos de fallo, y comprobar que lo que antes funcionaba sigue
funcionando.

**Después, detenerse.** No se pasa automáticamente a la debilidad siguiente.

---

# PARTE III — FASE A: AUDITORÍA CONSOLIDADA, SIN CAMBIOS

Va **antes** de la Fase 0. No modifica una sola línea de código.

## Por qué existe

La auditoría del 2026-09-16 se hizo a ciegas de los documentos previos, a propósito. Eso dio una
mirada sin sesgo, pero dejó una pregunta abierta: **de todo lo que ya se auditó y planificó antes,
qué se resolvió, qué quedó a medias y qué se resolvió de una forma que depende del modelo.**

## Alcance

Documentos a cruzar contra el código actual: `ONIX-RELIABILITY-PLAN.md`,
`ONIX-ROBUSTNESS-AUDIT.md`, `ONIX-DIAGNOSTICO-2026-09.md`, `ONIX-PLAN-MAESTRO.md`,
`ONIX-PLAN-CATALOGO-Y-MEDIOS.md`, `ONIX-AUDITORIA-ARQUITECTURA.md`, `ONIX-PENDIENTES.md`,
`ONIX-CRM-REORG-PLAN.md`.

Código a cruzar: `src/ai/*`, `src/catalog/*`, `src/orders/*`, `src/whatsapp/*`, `src/routes/*`,
`src/jobs/*`, `prisma/schema.prisma`, y los 81 archivos de prueba.

## Qué determina, por cada problema ya identificado antes

1. Resuelto.
2. Pendiente.
3. Resuelto a medias.
4. **Resuelto de forma frágil**: la corrección existe pero depende de que el modelo colabore. Esta
   categoría es la más importante de todas y es la razón de ser de la Fase A.
5. Convertible en garantía determinística, y cómo.
6. Problemas nuevos que no estaban en ningún documento.

## Inventario de operaciones críticas

Parte del entregable. Toda operación con efecto secundario — crear o actualizar pedido, mover stock,
iniciar o confirmar pago, enviar media, cambiar estado, handoff, enviar mensajes, cualquier escritura
en base, cualquier llamada externa — con siete columnas:

quién la solicita · quién la autoriza · qué se valida · qué pasa si falla · cómo se confirma el éxito
· cómo se persiste · qué recibe después el modelo.

## Formato de cada hallazgo

```
ID:
TITLE:
SEVERITY:              CRITICAL | HIGH | MEDIUM | LOW
FILE:
FUNCTION:
CURRENT BEHAVIOR:
FAILURE SCENARIO:
ROOT CAUSE:
WHY CURRENT ARCHITECTURE ALLOWS IT:
BUSINESS IMPACT:
CURRENT MITIGATION:
RECOMMENDED GUARANTEE:
PROPOSED CHANGE:
TESTS NEEDED:
```

## Priorización, por riesgo y no por gusto

En este orden: pérdida de ventas · información falsa al cliente · pedidos incorrectos · pagos
incorrectos · operaciones duplicadas · corrupción de estado · frecuencia del problema · facilidad de
implementar la garantía.

## Entregable

`ONIX-DIAGNOSTICO-CONSOLIDADO.md` en la raíz del repo. Los hallazgos que sobrevivan se reparten
entre las fases 0 a 9 de la Parte IV, o crean una fase nueva si ninguna los cubre.

## Esfuerzo estimado

1 a 2 días. Sin cambios de código, sin riesgo.

---

# PARTE IV — LAS FASES DE CONSTRUCCIÓN

## Regla de admisión de las fases

Es la misma regla permanente del repositorio, aplicada a infraestructura. Una fase entra solo si
puede responder las tres preguntas:

1. **¿Qué decisión le quita a alguien?** Al modelo, al operador, o a la configuración. Una fase que
   agrega una bandera para que alguien se acuerde de prenderla es un parche.
2. **¿Qué se puede verificar con una consulta?** No con una opinión ni con "se ve bien".
3. **¿Qué pasa si el proceso muere en el peor momento?** Si la respuesta es "se pierde y nadie se
   entera", la fase no está terminada.

Y la medida transversal: **cada fase declara qué líneas de `src/ai/prompts/systemPrompt.ts` borra.**
534 líneas al empezar. Una fase que no puede nombrar la directiva que vuelve innecesaria no está
haciendo trabajo estructural, está agregando superficie.

## Regla de no regresión

Decisión del dueño, 2026-09-16: **el comportamiento actual es aceptable y ninguna fase puede
empeorarlo.** Esto no es una aspiración del plan, es una condición de admisión más, al mismo nivel
que las tres de arriba.

Tiene una consecuencia que reordena el plan: **no se puede prometer "no empeora" sin poder medirlo.**
Hoy el único detector de una regresión conversacional es una persona leyendo conversaciones — los
hallazgos de la auditoría de septiembre salieron de revisar 361 mensajes a mano, ninguno llegó por
una alerta. Por eso la parte de medición de la Fase 7 se adelanta al Bloque I (ver Fase 2), y la
Fase 7 se queda con lo que de verdad necesita datos acumulados.

### Línea base, antes de tocar nada

Se mide una sola vez, sobre los últimos 7 días de producción, y queda escrita en este documento:

- Turnos totales, y turnos por conversación.
- `AgentIncident` por tipo y por `guard`.
- Intervenciones de respaldo cada cien turnos.
- Caídas al fallback del validador de catálogo (`catalogAuthor = "servidor"` en `AgentTurn`).
- Conversaciones que llegaron a `Order`, sobre el total.
- Escalaciones a humano, y cuántas volvieron solas.
- Fallos de entrega (`DeliveryFailure`) por tipo.
- Costo por negocio (`AiUsageLog`).

Sin esa línea base, "no empeoró" es una opinión.

### Criterio de salida, igual para todas las fases

Ninguna fase se considera terminada sin las cinco:

1. **`npm test` en verde**, con los fixtures de replay dando **idéntico** antes y después. El motor
   de replay es determinista y no llama a DeepSeek: es la única prueba de no regresión que se puede
   correr todas las veces que haga falta y gratis.
2. **Un fixture nuevo** que cubra el comportamiento que la fase cambia o preserva. Una fase sin
   fixture nuevo no dejó nada probado.
3. **`npx tsc --noEmit` limpio.**
4. **Despliegue por negocio, nunca global.** Primero el negocio piloto, 48 horas de números contra
   la línea base, y recién después el resto. Es el mismo criterio que el propio código ya declara
   para el modo sombra del validador de catálogo.
5. **Reversión escrita antes de desplegar.** Cada fase dice, en una línea, cómo se vuelve atrás:
   qué se revierte, qué migración es reversible y cuál no.

### Sobre la suite de regresión pagada

`npm run regression` y `npm run test:paid` llaman a DeepSeek de verdad y cuestan plata por corrida.
Van una vez por fase, al final, y **las decide el dueño**. No se corren mientras se itera, y no se
corren por iniciativa propia. Para iterar están los fixtures de replay, que son gratis.

### Migraciones: ninguna destructiva

Toda migración de esquema de este plan es aditiva. Columnas y tablas nuevas, valores de enum nuevos.
Nada de `DROP COLUMN` ni de renombrar en la misma migración que cambia código. Cuando una columna
queda obsoleta, se deja muerta hasta una limpieza posterior y separada. Una migración que no se
puede revertir sin perder datos no entra.

## Estructura general

Once fases: una de auditoría y diez de construcción, en tres bloques. Los bloques son secuenciales
entre sí; dentro de un bloque hay fases que pueden ir en paralelo.

- **Fase A — Auditoría consolidada.** Sin cambios de código. Va primero (ver Parte III).

- **Bloque I — Cimientos (Fases 0, 1, 2).** No cambia nada que el cliente vea. Hace que todo lo
  demás sea seguro de construir. Bloqueante.
- **Bloque II — Dominio (Fases 3, 3B, 4, 5).** Lo que el negocio puede expresar, lo que el agente
  puede afirmar y lo que el agente puede saber. Acá están las afirmaciones verificadas y el CRM que
  de verdad alimenta la conversación.
- **Bloque III — Inteligencia y operación (Fases 6, 7, 8, 9).** Recuperación, observabilidad,
  política de venta, integraciones y canales.

No se remodela todo. La arquitectura del agente (`generateReply`, alcance resuelto en código,
efectos requeridos, un solo autor) queda como está: es lo mejor que tiene el sistema. Lo que cambia
es lo que la rodea.

---

# BLOQUE I — CIMIENTOS

## Fase 0 — El borde deja de confiar en la configuración

**Decisión que quita:** la seguridad deja de depender de que alguien se acuerde de poner una
variable de entorno.

### Qué se hace

1. **Firma de webhook obligatoria.** Se elimina `WEBHOOK_SIGNATURE_ENFORCE` de `src/config/env.ts`.
   La firma se valida siempre; una firma inválida devuelve 401 y no procesa. Un negocio sin
   `appSecret` configurado es un error de arranque, no un caso permitido en caliente.
2. **Login de plataforma endurecido.** `src/routes/platformAdmin.ts`: contraseña en `bcrypt`, no en
   texto plano en el entorno; comparación de tiempo constante; el mismo limitador de tasa que
   `authRouter`; bloqueo por intentos; y una tabla `PlatformAuditLog` que registra cada acción de
   administrador de plataforma con actor, negocio afectado y momento.
3. **Descifrado que no tumba la plataforma.** `src/db/client.ts`: `decryptSecret` dentro de
   `try/catch`. Una fila con texto cifrado corrupto devuelve `null` y se marca en una columna
   `secretsBroken`, en vez de hacer que `findMany` lance y caiga todo para todos los inquilinos.
4. **Sesiones con versión.** `TeamMember.sessionVersion` y `Business.sessionVersion`. `requireAuth`
   compara la versión de la sesión contra la actual; borrar o desactivar un miembro incrementa la
   versión y sus sesiones vivas mueren. Regeneración de sesión en cada login.
5. **Límite de tasa donde falta.** Global por IP, y por negocio en `/admin/api/*` — incluidas las
   rutas de subida de archivos y `improve-instructions`, que gasta en IA.
6. **Normalización de correo.** Minúsculas en el modelo y migración de datos existentes. Largo
   mínimo de contraseña en `/signup` igual al de `/reset-password`.
7. **`TeamMember` chequeado en el registro**, para que registrar un negocio con el correo de un
   miembro existente deje de bloquear a esa persona para siempre.

### Verificación

- Una petición sin firma a `/webhook` devuelve 401 (prueba automatizada).
- Borrar un miembro invalida su sesión en la petición siguiente (prueba automatizada).
- Una fila con `whatsappAccessToken` corrupto no impide listar negocios (prueba automatizada).

### Prompt

Sin cambios. Esta fase no toca al agente.

### Esfuerzo estimado

2 a 3 días.

---

## Fase 1 — El turno deja de depender de que el proceso siga vivo

Es el cambio estructural más grande de todo el plan, y el que habilita casi todo lo demás.

**Decisión que quita:** el webhook deja de decidir, en memoria y sin red de seguridad, si un mensaje
del cliente existe o no.

### El problema, medido en código

`src/routes/whatsapp.ts:729` responde `200` antes de procesar. Meta no reintenta. Además,
`:733-742` lee solamente `entry[0]`, `changes[0]`, `messages[0]`, `statuses[0]`: todo mensaje
adicional del mismo lote se descarta sin rastro. Y la deduplicación por `wamid` ocurre recién en
`:970`, después de haber pagado descarga de medios, subida a S3, visión y transcripción.

### Qué se hace

1. **Tabla `InboundEvent`.**

   ```
   InboundEvent {
     id, businessId, wamid @unique, kind (MESSAGE|STATUS),
     payload Json, status (PENDING|PROCESSING|DONE|DEAD),
     attempts Int, lockedUntil DateTime?, lastError String?,
     receivedAt, processedAt
   }
   ```

2. **El webhook se reduce a tres pasos:** validar firma, insertar **todos** los elementos del lote
   en un bucle sobre `entry[] → changes[] → messages[] + statuses[]`, responder 200. Nada más. Sin
   descargas, sin modelo, sin S3.

3. **Un consumidor** toma trabajo con `SELECT ... FOR UPDATE SKIP LOCKED`, procesa, y marca `DONE`.
   El `wamid @unique` hace la idempotencia **antes** de gastar en medios y visión, no después.

4. **Reintento y dead-letter** con el mismo criterio que ya tiene `QueuedOutboundMessage`: intentos
   acotados, espera creciente, y una fila muerta visible en el panel en vez de un mensaje perdido en
   silencio.

5. **Job de reconciliación:** busca conversaciones con un mensaje de `CUSTOMER` sin respuesta de
   `ASSISTANT` pasados N minutos, y reencola o escala. Hoy no existe nada que detecte un turno
   perdido; `conversationHealth` detecta respuestas duplicadas y promesas incumplidas, pero no
   ausencias.

### Verificación

- Matar el proceso con `SIGKILL` en medio de un turno y comprobar que al reiniciar el turno se
  reprocesa y el cliente recibe respuesta.
- Un lote de Meta con tres mensajes produce tres `InboundEvent` y tres turnos.
- Reenviar el mismo `wamid` dos veces no dispara una segunda descarga de medios.

### Prompt

Sin cambios.

### Esfuerzo estimado

4 a 6 días. Es la fase más cara del plan y la que más devuelve.

---

## Fase 2 — La corrección deja de depender de `instances: 1`

**Decisión que quita:** el operador deja de ser responsable de no escalar. Hoy correr dos instancias
duplica mensajes a clientes reales, y lo único que lo impide es una línea en `ecosystem.config.js`.

### Qué se hace

1. **Dos procesos.** `web` (HTTP + Socket.IO) y `worker` (el consumidor de `InboundEvent` más los
   siete jobs). Dos entradas en `ecosystem.config.js`, un solo código base.

2. **Lock de conversación en Postgres.** El `Map` en memoria de `src/routes/whatsapp.ts:91` se
   reemplaza por `pg_advisory_xact_lock(hashtext(conversationId))`. Funciona entre procesos, se
   libera solo si el proceso muere, y no necesita Redis.

3. **Ráfagas persistidas.** `burstBuffer` pasa a una tabla `PendingBurst` con `flushAt`. Una ráfaga
   deja de morir con el proceso.

4. **Jobs con reclamo de fila y guarda de reentrada.** Cada job toma su trabajo con
   `FOR UPDATE SKIP LOCKED` y una columna `lockedUntil`. Se acabó el doble envío por solapamiento:
   hoy `saleConfirmationChaser` corre cada 60 segundos con un bucle secuencial sin tope, y una
   pasada que tarde más de 60 segundos se pisa a sí misma.

5. **`try/catch` por ítem** en `escalationReminder`, `saleConfirmationChaser`, `tokenExpiry` y
   `conversationHealth`. Hoy un solo throw aborta la pasada y deja sin atender a todos los negocios
   restantes, y son justo los cuatro que manejan plata y caídas.

6. **Marcar antes de enviar, no después.** `tokenExpiry.ts:61-64` marca "ya avisé" aunque el aviso
   haya fallado; es la compuerta de un aviso por ciclo, así que un envío fallido significa que al
   dueño nunca se le avisa y el bot se apaga el día 60. Se invierte el orden: reservar, enviar,
   confirmar.

7. **Breaker de failover fuera de memoria.** `src/ai/modelFailover.ts` guarda su estado en una tabla,
   para que los dos procesos compartan la misma decisión.

8. **Log estructurado, acá y no después.** Ya que se parte el proceso, entra `pino` con
   `requestId`, `businessId`, `conversationId` y `turnId` en cada línea. Sin esto, depurar dos
   procesos es peor que depurar uno.

9. **Manejadores de `uncaughtException` y `unhandledRejection`**, que hoy no existen en ninguna parte.

10. **Medición adelantada desde la Fase 7, por la regla de no regresión.** No se puede garantizar que
    ninguna fase empeora el comportamiento sin poder verlo el mismo día. Entra acá, no al final:

    - `/metrics` en formato Prometheus: turnos, latencia por etapa, fallos de entrega, incidentes por
      tipo, profundidad de colas, costo por negocio.
    - `/health` de verdad: base, profundidad y antigüedad de las colas, credenciales de Meta por
      negocio, estado del breaker de failover. Hoy responde sano mientras todos los jobs revientan.
    - Alertas sobre umbrales contra la línea base: crecimiento de `AgentIncident`, tasa de caída al
      fallback del validador, cola estancada, token por vencer.
    - Un panel de comparación contra la línea base, para poder decir "no empeoró" con un número.

    Lo que se queda en la Fase 7 es lo que necesita datos acumulados o cambia comportamiento: las
    trazas por turno, el juez LLM nocturno y la activación del validador fuera de modo sombra.

### Verificación

- Levantar dos `worker` y comprobar que un cliente recibe exactamente una respuesta y un dueño
  exactamente una confirmación.
- Prueba de solapamiento: forzar una pasada de job más larga que su intervalo y comprobar que no se
  duplica ningún envío.

### Prompt

Sin cambios.

### Esfuerzo estimado

4 a 5 días.

---

# BLOQUE II — DOMINIO

## Fase 3 — El pedido es una máquina de estados, no un campo

**Decisión que quita:** el estado del pedido deja de ser algo que cualquier ruta sobrescribe.

### Qué se hace

1. **Estados reales.** `PENDING_PAYMENT | PAID | PREPARING | SHIPPED | DELIVERED | CANCELED |
   RETURNED | REFUNDED`. Hoy son tres, y `ConversationIntent` ya tiene `DEVOLUCION` y `NO_RECIBIDO`
   sin nada del lado del pedido que los represente.

2. **Un solo módulo de transición.** `src/orders/stateMachine.ts` con la tabla de transiciones
   permitidas. `markOrderShipped` y `markOrderCanceled` dejan de ser `update` sueltos. Hoy el panel
   puede cancelar un pedido ya enviado y re-enviar uno cancelado.

3. **`OrderEvent`**: actor (usuario, agente, job), estado anterior, estado nuevo, motivo, momento.
   Hoy no hay ningún campo que registre quién envió o quién canceló.

4. **Stock atómico y con reserva.** `{ decrement }` con condición `stock >= cantidad` dentro de la
   transacción; `StockReservation` con vencimiento mientras la venta está en curso; y devolución
   automática del stock al cancelar, que hoy no ocurre — cada cancelación destruye unidades para
   siempre.

5. **Plata en `Decimal` de punta a punta.** Una clase `Money` y cero `Number(...)` sobre precios.
   Hoy es `Decimal` en Postgres y punto flotante en todos los caminos de código.

6. **Campos que faltan en `Order`:** `paymentStatus`, `paymentReference`, `taxAmount`,
   `discountAmount`, `trackingNumber`, `carrier`, `estimatedDelivery`.

7. **`cancel_order` por id**, no "el último pedido del cliente".

8. **Moneda coherente:** `Product.currency` deja de tener `USD` por defecto contra `Business.currency`
   en `COP`; un pedido con monedas mezcladas se rechaza en vez de sumar números sin significado.

9. **`saleStateEnabled`: causa encontrada el 2026-09-17 (commit `11b277d`), bandera todavía apagada.**
   El defecto era de orden, no del motor: con la bandera encendida, `close_conversation` tomaba los
   ítems únicamente de `SaleState`, y si estaba vacío devolvía "usa `set_order_item` primero".
   Llenar `SaleState` dependía de que el modelo llamara `set_order_item` en el turno en que el
   cliente elegía — pedido solo por una línea de la descripción de la herramienta. Si no lo hacía,
   la venta no cerraba nunca.

   Corregido: `SaleState` manda cuando tiene líneas y, vacío, los ítems se resuelven contra el
   catálogo igual que con la bandera apagada. `resolveOrderItems` sigue validando contra el catálogo
   y tomando el precio de la base, así que la garantía se conserva.

   **Es el ejemplo canónico de la regla de la Parte I.** La corrección real no fue pedirle al modelo
   que se acordara de llamar `set_order_item`: fue quitar la dependencia de que lo llamara. Esa es
   la diferencia entre parche y estructura, y este defecto es el que hay que citar cuando la
   distinción se vuelva abstracta.

   **Lo que le queda a esta fase:** un fixture de replay determinista que recorra el camino completo
   hasta `createOrder` con la bandera encendida, para que el caso quede cubierto para siempre. La
   bandera sigue apagada en los tres negocios y encenderla es decisión del dueño, de a un negocio por
   vez y mirando una conversación real.

### Prompt: lo que se borra

La sección "CIERRE" y parte de "RESUMEN Y TOTAL ANTES DE PEDIR EL PAGO" existen para que el modelo
no diga que un pedido quedó confirmado cuando no lo está. Con el estado en la base y verificable, la
directiva se reduce a una línea: el estado del pedido lo dice el bloque de sistema, no la memoria del
modelo. **Objetivo: −25 líneas.**

### Esfuerzo estimado

4 a 5 días.

---

## Fase 3B — Afirmaciones verificadas: atributos, envíos y de qué producto

Fase nueva, surgida del encargo del 2026-09-17. Es la que ataca directamente los casos reales que el
dueño puso como ejemplo, y los trata como clases de error, no como defectos sueltos.

**Decisión que quita:** el modelo deja de ser quien decide qué atributos del producto son ciertos, qué
envíos ocurrieron y **de qué producto** son los archivos que salen.

### Clase A — El atributo inventado (el caso "Serie 12 Ultra 3 en naranja")

**Por qué es posible hoy.** `verifyAgainstCatalog` (`src/catalog/outputValidation.ts`) tiene
exactamente dos tipos de hallazgo: `precio_inexistente` y `producto_inexistente`. **Ningún color,
ninguna variante, ningún stock.** El agente puede escribir "lo tenemos en naranja" y el mensaje sale
sin que nada lo mire. La única defensa actual es una directiva del prompt, que es precisamente la
solución débil.

**La garantía.** Se agrega un tercer tipo, `atributo_inexistente`: todo color o talla que el mensaje
nombre en posición de atributo de un producto en alcance se compara contra las variantes reales de
ese producto. Se reusa `canonicalColors` y `attributeTaxonomy`, que ya existen; **cero expresiones
regulares nuevas**, igual que el barrido carácter por carácter que ya hace ese módulo.

Pasa por la misma escalera que ya existe para precios y nombres: un reintento diciéndole cuál
atributo no existe — dato salido de la comparación contra la base, nunca de leer su prosa — y si
vuelve a fallar, sale el bloque compuesto por el servidor, que lista los colores reales.

**Dónde encaja.** No es un mecanismo nuevo: es una fila más en uno que ya funciona y ya está probado
en producción para precios. Ese es el punto.

### Clase B — El envío afirmado que no ocurrió (el caso "ahí tienes las fotos")

**Por qué es posible hoy.** `send_product_media` devuelve `sent: false` cuando no hay media o el
envío falla, y el prompt le pide al modelo que lo diga con sus palabras. Eso es exactamente
`tool call ≠ success` sin resolver: **la única cosa que impide la afirmación falsa es que el modelo
colabore.** Además, `sendCatalogBlocks` ignora el resultado del envío del texto del bloque pero igual
registra su media como enviada, así que la deduplicación del turno siguiente la suprime — un fallo se
convierte en dos.

**La garantía: un efecto requerido nuevo, `MEDIA_SENT`.** Cumple las tres condiciones de admisión:

- **Disparador determinista.** El turno llamó `send_product_media`, o el alcance resuelto trae media.
  Sale de la llamada a la herramienta y del alcance, no de leer lo que el modelo escribió.
- **Verificable con una consulta.** Las filas `Message` de rol `ASSISTANT` con la etiqueta del envío,
  o el registro de envío de media, dicen si el archivo salió. Un `SELECT`, no una opinión.
- **Con fallback sin modelo.** El servidor ya sabe componer el bloque con sus medios. Si el envío no
  ocurrió, o manda la media él mismo, o el texto que afirma el envío no sale.

Y se corrige `sendCatalogBlocks` para que no registre como enviada una media cuyo envío falló.

### Prompt: lo que se borra

`PHOTO_DIRECTIVE_SHARED_TAIL` existe entera por la ausencia de esta garantía: "si `send_product_media`
devuelve error o `sent:false`, nunca digas que ya la mandaste", y el párrafo entero sobre no escribir
`[Foto de PRODUCTO]` simulando un envío. Con el efecto requerido, el modelo no puede afirmarlo aunque
quiera, así que pedírselo sobra. **Objetivo: −18 líneas.**

### Clase C — El producto equivocado (el caso "audífonos en vez de reloj")

**El caso, medido.** Fixture de replay `y1iz5l-foto-no-converge`, turnos 43 y 45: el modelo llamó
`send_product_media` y las fotos **sí salieron** — de otro producto. La clienta pedía un reloj y
recibió audífonos, y en el otro turno la variante plateada en vez de la negra. El bot tuvo que
autocorregirse delante de ella. Ese fixture sigue en `knownFailing` y no tenía fase asignada.

**Por qué NO lo cubre la Clase B.** La Clase B garantiza que *si el modelo afirma un envío, el envío
ocurrió*. Acá ocurrió. Lo que falla es **cuál** producto salió. Son dos garantías distintas y hacen
falta las dos: sin esta, un envío perfectamente registrado puede seguir siendo el equivocado.

**Por qué es posible hoy.** `send_product_media` valida que el producto **exista** en el catálogo
(`getProductById` / `findConfidentProductMatch`), nunca que sea el producto **del que se está
hablando**. Esa correspondencia vive solo en la descripción de la herramienta — "el nombre del
producto que el cliente mencionó en ESTE mensaje (el que se está hablando ahora, no uno anterior)" — o
sea, otra vez, una instrucción que el modelo puede desobedecer sin que nada lo mire.

Es un hueco más chico que en septiembre: desde la Fase B del plan de catálogo y medios, el servidor
resuelve el alcance del turno y manda las fotos él mismo, y con la vitrina de categoría encendida más
todavía. `send_product_media` decide únicamente cuando el modelo la llama **por fuera** del alcance
resuelto. Pero es el único camino que queda donde el modelo elige qué foto ve una clienta.

**La garantía.** El `productId` que llega a `send_product_media` se compara contra el conjunto de
productos que el servidor considera en juego en esta conversación. Cumple las tres condiciones de
admisión:

- **Disparador determinista.** El turno llamó `send_product_media` y existe al menos una de estas tres
  fuentes: el alcance resuelto del turno (`resolveProductScope`), la última lista realmente presentada
  (`Conversation.lastPresentedProductIds`) o los ítems del pedido en curso. Las tres las escribió el
  servidor; ninguna sale de leer prosa.
- **Verificable con una consulta.** ¿El id pedido pertenece a la unión de esos tres conjuntos? Es una
  comparación de ids, no una opinión. Lo mismo con `variantId`: tiene que ser una variante de ESE
  producto, y si el cliente nombró un color, la que corresponde a ese color (`canonicalColors`, que ya
  se usa en `pickVariant`).
- **Con fallback sin modelo.** Si no pertenece, no sale ningún archivo: la herramienta devuelve el
  error nombrando los productos que **sí** están en juego, y el servidor ya sabe componer el bloque del
  alcance real. La escalera de reintento es la misma que ya usan los precios y los nombres.

**El lado seguro, explícito.** Si no hay ninguna de las tres fuentes — conversación nueva, el cliente
nombra un producto que nunca se listó — no hay contra qué validar y **no se bloquea nada**. Una venta
no se frena por una duda nuestra; ese es el mismo criterio con el que se admitieron las garantías del
comprobante y de las modalidades por zona.

### Prompt: lo que se borra

Además de `PHOTO_DIRECTIVE_SHARED_TAIL` (Clase B), esta clase vuelve innecesarias las dos frases que
hoy le piden al modelo la correspondencia a mano: "el nombre del producto DEL QUE SE ESTA HABLANDO
AHORA" en `PHOTO_DIRECTIVE_REACTIVE` y `PHOTO_DIRECTIVE_AUTO` (`src/ai/prompts/systemPrompt.ts`), y el
paréntesis equivalente en la descripción de `send_product_media` (`src/ai/tools.ts`). **Objetivo de la
fase completa: −22 líneas.**

### Verificación

- Un fixture de replay donde `send_product_media` devuelve `sent: false` y el texto final no afirma
  ningún envío.
- Un fixture donde el modelo escribe un color que no existe para el producto en alcance, y sale el
  bloque del servidor con los colores reales.
- Un fixture donde el envío del texto del bloque falla y su media **no** queda registrada como
  enviada.
- **`y1iz5l-foto-no-converge` sale de `knownFailing` y queda en verde.** Es el criterio de salida de la
  Clase C: ese fixture es el caso real, grabado, y mientras siga en rojo la clase no está cerrada.
- Un fixture donde el cliente nombra un producto que nunca se listó y el envío **sí** sale: la
  validación no puede convertirse en un freno para una conversación nueva.

### Esfuerzo estimado

4 a 5 días. Sigue siendo la fase con mejor relación entre riesgo eliminado y tamaño del cambio de todo
el plan: las tres clases reutilizan mecanismos que ya existen y ya están probados en producción — la
escalera de validación contra catálogo y la tabla de efectos requeridos — en vez de construir uno
nuevo.

---

## Fase 4 — El catálogo expresa lo que el negocio vende de verdad

**Decisión que quita:** el descuento deja de ser prosa acordada por WhatsApp, y el combo deja de ser
una frase dentro de una descripción.

### Qué se hace

1. **Precio en la variante.** `ProductVariant.price` opcional, con caída al precio del producto. Hoy
   una talla XL no puede costar más que una S.
2. **`Promotion`:** porcentaje o monto, vigencia, alcance (producto, categoría o global), mínimo de
   cantidad, código opcional. Herramienta `get_active_promotions`. `AgreedPrice` se queda como está:
   es otra cosa, un acuerdo puntual con un cliente, no una promoción del negocio.
3. **`Bundle`:** un producto compuesto por ítems reales del catálogo, con su propio precio. Hoy un
   combo es prosa en `description`, y el propio código documenta que eso ya rompió la búsqueda por
   color.
4. **Atributos físicos:** peso, dimensiones, SKU. Sin esto no hay envío por peso ni respuesta a
   "¿cuánto pesa?".
5. **Envío estructurado:** tarifas por peso y volumen, umbral de envío gratis, y zonas jerárquicas
   (país, departamento, ciudad) en vez de coincidencia exacta de nombre de ciudad.
   `ShippingCityRule.label` pasa a ser clave foránea real: hoy renombrar una tarifa convierte en
   silencio una ciudad configurada en "sin regla".
6. **Impuesto** como línea propia del total, configurable por negocio.

### Prompt: lo que se borra

`SHIPPING_RATES_DIRECTIVE` entera: existe porque la tabla de tarifas vive en prosa dentro de
`customInstructions` y hay que pedirle al modelo que no copie cifras de memoria. Con zonas
jerárquicas reales, la tarifa la resuelve el servidor siempre. **Objetivo: −30 líneas.**

### Esfuerzo estimado

5 a 6 días.

---

## Fase 5 — El CRM alimenta la conversación

Hoy el sistema guarda mucho y usa casi nada: `CustomerNote`, `tags`, `stage`, `source`, todas las
métricas derivadas y **el historial completo de ítems comprados** nunca entran a ningún prompt.
`CustomerStage` está prácticamente muerto: nada escribe jamás `COMPRADOR` ni `RECURRENTE`.

**Decisión que quita:** el agente deja de preguntar lo que el negocio ya sabe.

### Qué se hace

1. **Un solo compositor de hechos del cliente.** `src/crm/customerFacts.ts`, con la misma forma que
   ya tienen `getCustomerCommerceState` y `getAgreedPriceFacts`: lee la base, devuelve datos
   estructurados, y `generateReply` los inyecta como mensaje `system`. Sin directivas alrededor, sin
   prosa. El agente decide qué hacer con ellos; eso es conversación y no se fuerza.

2. **Qué entra en esos hechos:**
   - Identidad: nombre, documento, teléfono de entrega, dirección, **sin depender de
     `saleStateEnabled`**. Hoy, con esa bandera apagada (que es el valor real en todos los negocios),
     un cliente que vuelve pierde su nombre y su dirección guardados. Que la bandera esté apagada por
     un defecto abierto hace esta fase más urgente, no menos: los datos del cliente viven en
     `Customer`, que es una tabla que funciona, y no tienen por qué depender del motor de venta para
     llegar al prompt. Esta fase no espera a que el defecto de la Fase 3 esté resuelto.
   - Historial de compra: ítems comprados con fecha, variante y precio pagado. Es el dato más
     valioso que el sistema ya tiene y nunca usa.
   - Métricas: ticket promedio, cantidad de pedidos, días desde el último contacto, días desde la
     última compra.
   - Etiquetas y etapa.
   - Notas del dueño marcadas como compartibles. Una bandera por nota; las notas privadas siguen
     siendo privadas y eso queda explícito en el esquema.

3. **`CustomerStage` calculada por el servidor.** `NUEVO | INTERESADO | COMPRADOR | RECURRENTE |
   INACTIVO`, derivada de pedidos y actividad, recalculada en cada cierre de pedido y por el job
   diario. Deja de ser un campo que nadie escribe.

4. **Reposición.** Si el cliente compró algo marcado como consumible hace más de su ciclo estimado,
   ese hecho entra en el contexto. El agente decide si lo menciona. El servidor no manda un mensaje
   por su cuenta.

5. **Consentimiento, decidido.** Un campo por negocio (`customerDataPolicy`) con tres valores:
   guardar en silencio, guardar con aviso una vez, preguntar siempre. Es la decisión que está parada
   desde hace tiempo y que bloquea inyectar el nombre guardado. Sin resolverla, esta fase no puede
   cerrar.

6. **Panel:** la ficha del cliente muestra la línea de tiempo unificada que `crm/customers.ts` ya
   calcula y que hoy casi no se ve.

### Prompt: lo que se borra

El párrafo de `save_customer_name` y `save_customer_contact_info` existe porque el modelo tiene que
acordarse de guardar datos que el servidor ya podría tener. Con los hechos inyectados y los forzados
de `tool_choice` que ya existen, la directiva se reduce a dos líneas. **Objetivo: −20 líneas.**

### Esfuerzo estimado

4 a 5 días.

---

# BLOQUE III — INTELIGENCIA Y OPERACIÓN

## Fase 6 — Recuperación semántica

**Decisión que quita:** el modelo deja de recibir el catálogo entero para elegir a ojo.

Hoy `searchProducts` carga todos los productos activos a memoria y los puntúa en JavaScript, hasta
tres veces por turno. Si no hay coincidencia, devuelve el catálogo completo al modelo. No hay
tolerancia a errores de tipeo: el propio código documenta un fallo real en producción ("micrófonos"
por "audífonos") que solo atrapó el modelo.

### Qué se hace

1. **`pgvector` en la base que ya existe.** Tabla `CatalogEmbedding` con una fila por producto,
   variante, entrada de FAQ e instrucción del negocio. Se regenera al guardar desde el panel.
2. **Búsqueda híbrida:** vector para el significado, el puntaje por tokens actual como señal
   adicional, y la taxonomía de colores y alias de categoría como filtro duro. Ninguna de las tres
   se descarta: se combinan.
3. **`search_products` deja de devolver el catálogo completo** cuando no encuentra nada. Devuelve los
   K mejores por similitud, siempre.
4. **Corrección de tipeos** por distancia de edición sobre nombres de producto y categorías, como
   último recurso antes de responder "no lo manejamos".

### Prompt: lo que se borra

La sección "CATALOGO" contiene esta instrucción textual: `search_products` te devuelve el catálogo
completo igual, revisalo por significado antes de decidir. Esa directiva existe **solo** porque la
búsqueda es mala. Con recuperación semántica se borra entera. **Objetivo: −15 líneas.**

### Esfuerzo estimado

4 a 5 días.

---

## Fase 7 — El silencio deja de significar "no pasó nada"

**Decisión que quita:** el operador deja de tener que buscar los problemas a mano. Hoy el canal de
alerta entre inquilinos es `grep ZAQI ALERT` en `pm2 logs`, y `/health` responde sano mientras todos
los jobs revientan en silencio, mientras las credenciales de Meta están vencidas y mientras el
proveedor de IA está en enfriamiento por failover.

Las métricas, el `/health` real y las alertas por umbral ya entraron en la Fase 2, adelantados por la
regla de no regresión. Acá queda lo que necesita datos acumulados o cambia comportamiento.

### Qué se hace

1. **Trazas por turno** con OpenTelemetry: cada llamada al modelo y cada herramienta como un tramo.
   `AgentTurn` ya guarda lo que pasó; falta poder verlo en el tiempo.
2. **Juez LLM nocturno** sobre una muestra de conversaciones cerradas: puntúa resolución, tono y
   fidelidad al catálogo, y escribe en una tabla que el panel muestra. Es lo que Decagon vende como
   diferenciador y lo único de esa categoría que a Onix le falta del lado del turno. Corre de noche,
   sobre una muestra, con costo acotado y declarado.
3. **El modo sombra del validador de catálogo se activa**, con los números a la vista, que es el
   criterio que el propio módulo declara. **Esta es la única parte del plan que puede bloquear un
   mensaje que hoy sale**, así que va con la tasa de falsos positivos medida sobre 48 horas reales, y
   negocio por negocio. Si la tasa no es cercana a cero, no se activa: se arregla el validador.

### Prompt

Sin cambios directos, pero esta fase es la que permite borrar directivas con evidencia en vez de por
intuición: sin la tasa de intervención medida, no se sabe qué directiva ya es innecesaria.

### Esfuerzo estimado

5 a 6 días.

---

## Fase 8 — Handoff con contexto y política de venta

**Decisión que quita:** el límite de lo que el agente puede prometer deja de vivir en prosa dentro de
`customInstructions`.

### Qué se hace

1. **Paquete de handoff.** Cuando una conversación pasa a control humano, el panel muestra en un solo
   lugar: resumen, pedido en curso con lo que falta, qué se le prometió al cliente, qué preguntas
   quedaron abiertas con el dueño. Hoy el humano recibe la conversación sin contexto armado.
2. **Retorno con contexto.** Cuando el humano suelta la conversación, el bot retoma con un resumen de
   lo que el humano dijo, inyectado como `system`. Hoy retoma a ciegas.
3. **Siguiente paso explícito.** `checkout.missing` ya calcula qué falta; se extiende a un objetivo
   de conversación que el servidor computa y el agente lee. Es un hecho, no una instrucción: el
   agente sigue decidiendo cómo y cuándo pedirlo.
4. **Guardrails declarativos por negocio,** en tabla: descuento máximo, plazos que puede prometer,
   qué no puede afirmar. Se verifican contra la respuesta con el mismo mecanismo que ya usa
   `verifyAgainstCatalog`: comparación contra un `SELECT`, no lectura de prosa.

### Prompt: lo que se borra

`neverSay` y buena parte de `customInstructions` de cada negocio se vuelven datos verificados en vez
de texto que el modelo debe recordar. **Objetivo: −20 líneas del prompt base, y una reducción mucho
mayor en las instrucciones por negocio.**

### Esfuerzo estimado

4 a 5 días.

---

## Fase 9 — Integraciones y canales

**Decisión que quita:** el stock deja de ser lo que alguien tecleó por última vez.

### Qué se hace

1. **`InventorySource`,** una interfaz con implementaciones: manual (lo actual), Shopify,
   WooCommerce, MercadoLibre. Sincronización periódica y por webhook. El resto del sistema no se
   entera de cuál está activa.
2. **Link de pago** (Wompi ya tiene diseño aprobado). Alimenta `paymentStatus` real y hace que
   "¿ya entró mi pago?" tenga respuesta sin que el dueño escriba "sí".
3. **Tracking de transportadora:** número de guía y estado. Responde "¿dónde está mi pedido?", que
   hoy es imposible.
4. **Facturación**, si el negocio la necesita.
5. **Canales nuevos** sobre el mismo `InboundEvent`: Instagram y Messenger primero, web después. Por
   esto la Fase 1 va primero: con la cola de entrada normalizada, un canal nuevo es un adaptador, no
   una segunda copia del webhook.

### Esfuerzo estimado

Abierto. Cada integración es independiente y se prioriza por cliente real.

---

# Orden, dependencias y tiempo

```
Fase A  (auditoría, sin código)
  |
Fase 0
  |
Fase 1
  |
Fase 2
  |
  +-- Fase 3 --+-- Fase 3B
  |            |
  |            +-- Fase 4
  |            |
  |            +-- Fase 5
  |
  +-- Fase 6
  |
  +-- Fase 7
        |
      Fase 8  (usa 3, 5 y 7)
        |
      Fase 9
```

- **Fase A:** 1 a 2 días. Sin riesgo.
- **Bloque I:** 10 a 14 días. Bloqueante y no negociable en su orden.
- **Bloque II:** 17 a 21 días. Las fases 3B, 4 y 5 pueden repartirse; todas necesitan la 3 terminada.
- **Bloque III:** 13 a 16 días, más las integraciones, que son abiertas.

Total del trabajo cerrado: entre 41 y 53 días de trabajo enfocado, sin contar la Fase 9.

**La Fase 3B se puede adelantar.** Es la única del Bloque II que no depende del Bloque I para dar
valor: reutiliza mecanismos que ya corren en producción y ataca los tres casos que más duelen hoy - el
atributo inventado, el envío afirmado que no ocurrió y el archivo del producto equivocado. Si hay que
elegir una sola cosa después de la Fase A, es esa.

## Qué se puede hacer esta semana, antes de arrancar el plan

Estos no son fases, son sangrados que no conviene dejar corriendo mientras se construye lo demás:

1. Poner `WEBHOOK_SIGNATURE_ENFORCE=true` en el servidor, hoy.
2. `try/catch` por ítem en los cuatro jobs que no lo tienen.
3. Invertir el orden de marcado en `tokenExpiry.ts:61-64`.
4. Recorrer el lote completo en el webhook (`entry[]`, `changes[]`, `messages[]`, `statuses[]`), que
   es una sola función y no necesita esperar a la Fase 1.
5. Encender `requiredEffectsEnabled` por defecto. Está construido, probado y apagado, y no depende
   de `saleStateEnabled`: sin el motor de venta, `computeRequiredEffects` cae al efecto
   `OWNER_NOTIFIED_ABOUT_IMAGE`, que es el camino que ya funciona.

`saleStateEnabled` **no** entra en esta lista. Queda apagado a propósito: tiene un defecto abierto
(ver Fase 3) y encenderlo hoy es cambiar comportamiento sin haber entendido la causa.

## Dónde se resuelve cada punto del encargo

Trazabilidad del encargo del 2026-09-17 contra este plan. Ningún punto queda sin destino.

| Punto del encargo | Dónde se resuelve |
|---|---|
| No descartar la auditoría existente | Fase A |
| Separación LLM / backend, fuente de verdad | Parte I, y se verifica fase por fase |
| Tool call ≠ success | **Fase 3B** (media), y el mecanismo de efectos requeridos que ya existe |
| Caso real: media / fotos | **Fase 3B, clase B** |
| Caso real: color inventado | **Fase 3B, clase A** |
| Caso real: fotos del producto equivocado (`y1iz5l`) | **Fase 3B, clase C** |
| El LLM no puede cambiar la realidad | Fases 3, 3B y 4 según el dato |
| Estados explícitos | Fase 3 (máquina de estados del pedido) + `SaleState`, que ya existe |
| Inventario de operaciones críticas | Fase A, entregable propio |
| No confirmar antes de tiempo | Fase 3B + efectos requeridos |
| Fallbacks, retries y watchdogs que no oculten errores | Fase A los audita; Fase 2 los corrige (`try/catch` por ítem, marcar después de enviar) |
| Idempotencia y operaciones duplicadas | Fase A los documenta; Fases 1, 2 y 3 los cierran |
| Conversaciones entre turnos y entre procesos | Fases 1 y 2 |
| Observabilidad y "¿por qué hizo esto?" | Fase 2 (medición adelantada) + Fase 7 (trazas por turno) |
| Testing por clase de fallo | Transversal: criterio de salida de toda fase |
| No arreglar el síntoma | Parte I, y regla de admisión de toda fase |
| Cambio mínimo y detenerse después de cada fase | Parte II |

## Los cambios de comportamiento, uno por uno, y cómo se protege cada uno

Todo el Bloque I es invisible para el cliente: no toca `generateReply`, ni el alcance resuelto en
código, ni los efectos requeridos, ni el validador de un solo autor, ni ninguna de las 26
herramientas. Los fixtures de replay tienen que dar idéntico, y ese es el criterio de salida.

Lo que sí cambia comportamiento está acotado a esta lista. No hay ningún otro punto del plan donde
el cliente perciba algo distinto:

| Fase | Qué cambia para el cliente | Cómo se protege |
|---|---|---|
| 0 | Un negocio sin `appSecret` deja de recibir webhooks | Se verifican los `appSecret` de todos los negocios **antes** de quitar la bandera. Si falta uno, la fase no sale |
| 1 | Un turno que hoy se pierde en silencio, se responde tarde | Es lo que se busca. El job de reconciliación arranca con una ventana amplia, para no contestar algo de hace horas como si fuera nuevo |
| 3 | Cancelar devuelve stock; un pedido enviado ya no se puede cancelar desde el panel | Migración aditiva. Los pedidos existentes se mapean al estado equivalente. La transición prohibida devuelve un error claro en el panel, no un silencio |
| 3B | El bot deja de poder afirmar un color que no existe, un envío que no ocurrió, ni mandar el archivo de otro producto | Es la corrección, no una regresión. El riesgo real es el falso positivo: un color legítimo marcado por error. Sale en modo sombra primero, con la tasa medida, igual que el validador de precios |
| 4 | El bot puede hablar de promociones y combos | No hay riesgo de regresión: un negocio sin promociones cargadas se comporta exactamente como hoy |
| 5 | **El bot deja de pedirle el nombre y la dirección a un cliente que ya compró** | Es el cambio más visible. Sale con `customerDataPolicy` por negocio y se mira una conversación real de un cliente repetido antes de extenderlo |
| 6 | Las búsquedas devuelven otras cosas | Se despliega con la búsqueda vieja corriendo en paralelo y registrando la diferencia, sin afectar la respuesta. Se activa cuando los fixtures de catálogo dan igual o mejor |
| 7 | Algunos mensajes dejan de salir y caen al bloque del servidor | Solo si la tasa de falsos positivos medida es cercana a cero. Si no, no se activa |
| 8 | El bot retoma con contexto después de un handoff | Solo agrega contexto. No quita nada de lo que hoy funciona |

Las fases 2 y 9 no tienen ninguna fila: la 2 es interna y la 9 agrega capacidades que hoy no
existen.

## Cómo se sabe que el plan está funcionando

Tres números, revisados al cerrar cada fase:

1. **Líneas de `src/ai/prompts/systemPrompt.ts`.** 534 al empezar (verificado el 2026-09-17: sigue en
   534). Objetivo al terminar el Bloque III: por debajo de 400, contando el −22 de la Fase 3B. Si
   sube, algo se convirtió en chatbot sin que nadie lo decidiera.
2. **Intervenciones de respaldo por cada cien turnos.** Sale de `AgentIncident` con tipo
   `BACKSTOP_INTERVENTION`. Tiene que bajar, porque cada fase le quita al modelo una decisión que
   podía equivocar.
3. **Turnos perdidos.** Mensajes de `CUSTOMER` sin respuesta de `ASSISTANT`. Hoy es un número que
   nadie puede calcular. A partir de la Fase 1 tiene que ser cero, y medible.
