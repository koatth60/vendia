# Onix — plan maestro de desarrollo

Fecha: 2026-09-15. Documento hermano de `ONIX-DIAGNOSTICO-2026-09.md`, que contiene la evidencia.
Este documento no repite hallazgos: dice qué se construye, en qué orden, qué código se borra en cada
paso y cómo se prueba sin gastar plata.

Principio rector, heredado y reafirmado: **no se agrega un regex más sin borrar uno.** Cada fase
reemplaza una clase entera de parche haciendo imposible su modo de falla, con una prueba
determinista que lo demuestre.

Regla que separa lo que se queda de lo que se va:

> Un guard que **valida el argumento de una herramienta contra la base de datos antes de
> ejecutarla** es correcto y se queda. Un guard que **lee la prosa generada por el modelo para
> adivinar qué pasó** se va.

---

## 1. Arquitectura objetivo

### 1.1 La idea en una frase

El sistema es dueño de la transacción. El modelo entiende al cliente y redacta. Ninguna de las dos
capas hace el trabajo de la otra.

### 1.2 Diagrama

```
                        WhatsApp Cloud API
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ [1] INGESTA                                          DETERMINISTA │
│  · verifica X-Hub-Signature-256                                   │
│  · idempotencia por wamid ANTES de descargar media                │
│  · normaliza tipo (texto/imagen/audio/video/ubicacion/contacto)   │
│  · agrupa la rafaga del cliente (ventana ~8 s por conversacion)   │
└──────────────────────────────────────────────────────────────────┘
                               │ un turno por rafaga
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ [2] TURNO                                            DETERMINISTA │
│  · lock por conversacion                                          │
│  · carga SaleState (tabla real) + config del negocio              │
│  · compuerta de configuracion: si falta lo indispensable para     │
│    vender, el flujo de cierre no se habilita                      │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ [3] COMPRENSION                                            MODELO │
│  · ve: historia + SaleState renderizado + catalogo por herramienta│
│  · PROPONE intenciones llamando herramientas                      │
│  · NO decide efectos laterales, NO escribe cifras                 │
└──────────────────────────────────────────────────────────────────┘
                               │ tool calls
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ [4] MOTOR DE VENTA (maquina de estados)              DETERMINISTA │
│  · unico dueño de SaleState                                       │
│  · valida CADA argumento contra catalogo/config antes de aplicar  │
│  · transicion invalida -> error estructurado de vuelta al modelo  │
│    en el MISMO turno (el modelo corrige, el cliente no se entera) │
│  · calcula subtotal, envio y total                                │
│  · sabe que falta y cual es el siguiente dato a pedir             │
└──────────────────────────────────────────────────────────────────┘
                               │ estado nuevo + bloques fijos
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ [5] REDACCION                                              MODELO │
│  · redacta ALREDEDOR de bloques que el motor ya fijo              │
│    (total, datos de pago, resumen de pedido, tarifa de envio)     │
│  · unico post-proceso permitido: saneamiento de fugas (clase B)   │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ [6] SALIDA (capa unica de envio)                     DETERMINISTA │
│  · ventana de 24 h verificada SIEMPRE, en un solo lugar           │
│  · plantilla automatica cuando la ventana esta cerrada            │
│  · reintentos con backoff, limite de intentos, dead-letter        │
│  · orden garantizado, partido de mensajes largos, "escribiendo"   │
│  · traduce los codigos de error de Meta a decisiones              │
└──────────────────────────────────────────────────────────────────┘
```

### 1.3 Dónde vive el estado

**Tabla nueva `SaleState`, una fila por conversación**, escrita únicamente por el motor [4]:

| Campo | Tipo | Quién lo escribe |
|---|---|---|
| `conversationId` | `String @unique` | motor |
| `items` | `Json` — `[{productId, variantId, quantity, unitPrice, productName, variantLabel}]` | `set_order_item` validado contra catálogo |
| `customerName`, `idNumber`, `deliveryPhone`, `address`, `city`, `neighborhood` | `String?` | `save_delivery_data` validado contra las reglas del negocio |
| `shippingRateId`, `shippingCost` | resueltos | motor, desde `ShippingCityRule` |
| `shippingModality` | enum | `set_shipping_modality` validado contra `Business.shippingPaymentModalities` |
| `paymentMethodId` | `String?` | `set_payment_method` validado contra `PaymentMethod` activos |
| `subtotal`, `total` | `Decimal` | **calculados**, nunca recibidos |
| `missing` | `String[]` | **derivado**, nunca escrito a mano |
| `blockedBy` | `String?` — p.ej. `PENDING_OWNER_QUESTION`, `CONFIG_INCOMPLETE` | motor |
| `updatedAt` | | |

Se deriva, no se duplica: `missing`, `subtotal`, `total` y `shippingCost` se recalculan en cada
lectura con `computeCheckoutState` —que ya existe y ya está bien escrito
(`orders/checkoutState.ts:139`)— sobre los campos crudos. Así no puede desincronizarse, que es la
objeción correcta que el propio repo dejó anotada en `checkoutStateFromDb.ts:10-13`.

Al cerrar, `SaleState` se vuelca a `Order` y se marca como consumido. `Order` sigue siendo la verdad
histórica; `SaleState` es la verdad **en curso**, que es justamente lo que hoy no existe.

### 1.4 Qué es determinista y qué decide el modelo

| Decisión | Quién |
|---|---|
| Qué producto quiere el cliente | **Modelo** (propone), motor valida que exista y esté activo |
| Qué variante y cuántas unidades | **Modelo** propone, motor valida contra stock |
| Precio, subtotal, costo de envío, total | **Motor**. El modelo nunca escribe una cifra |
| Si los datos de entrega están completos | **Motor** |
| Cuál es el siguiente dato a pedir | **Motor** decide *cuál*; el modelo decide *cómo* preguntarlo |
| Si se puede cerrar la venta | **Motor** |
| Qué método de pago se le muestra al cliente | **Motor**, desde `PaymentMethod` |
| Si hay que escalarle al dueño | **Modelo** propone, **motor** crea el estado y bloquea el flujo |
| Si se manda una foto | **Modelo** llama la herramienta, **motor** valida el `productId` del turno |
| Tono, redacción, preguntas abiertas, manejo de objeciones | **Modelo** |

### 1.5 Qué se valida antes de hablar y qué después

- **Antes**: todo argumento de herramienta, contra la base. Una transición inválida nunca se ejecuta;
  vuelve al modelo como error de herramienta dentro del mismo turno. Es exactamente el mecanismo del
  guard de `paymentMethodLabel` (`agent.ts:1489-1519`), generalizado.
- **Después**: solo saneamiento de fugas (`stripInternalLeaks` y compañía, clase B del inventario de
  deuda). **Cero lectura de prosa para decidir efectos.**

### 1.6 Alternativas descartadas

| Alternativa | Por qué se descarta |
|---|---|
| **Motor de flujo puro tipo ManyChat/Wati** (árbol de decisión, sin LLM en el volante) | Pierde el diferenciador y el mercado ya lo tiene resuelto. Además Meta regala el agente conversacional desde junio de 2026 |
| **Seguir con prompt + guards, afinando los regex** | Demostrado no convergente. La prueba empírica es `VARIANT_DENIAL_PATTERN`, agregado el 2026-09-15, un día después de la auditoría que explicaba por qué esa clase no puede cerrar |
| **Multi-agente (un agente por etapa del embudo)** | Multiplica llamadas y latencia sin resolver la ausencia de estado: N agentes sin memoria compartida tienen el mismo problema que uno |
| **Cambiar de modelo a uno más capaz** | No arregla la arquitectura. Y con 88,3 % de acierto de caché y USD 0,0127 por conversación, el costo no es hoy la restricción |
| **Inyectar el estado solo como texto en el prompt** (la Fase 2 del plan anterior) | Necesario pero insuficiente. Un estado *legible* no impide una transición inválida; hace falta que sea *ejecutable*. Se conserva como parte de la Fase 2 de este plan, no como toda la Fase 2 |
| **Reescribir de cero en otro stack** | El 80 % del repo está bien: catálogo, envíos, panel, CRM, aprendizaje de FAQ, aislamiento por negocio. El problema está concentrado en `agent.ts` y en la capa de salida |

---

## 2. Fase 0 — Línea base (obligatoria, 1-2 días)

**Objetivo:** tener un número contra el cual comparar cada fase siguiente.

Los datos del capítulo 3 bis del diagnóstico ya dan el punto de partida. Falta el desglose y el
embudo honesto.

**Cambios concretos**

1. `prisma/schema.prisma`: agregar `guard String?` a `AgentIncident` (migración aditiva, sin
   backfill). Cada `recordAgentIncident` de `agent.ts` pasa el nombre del guard que intervino.
2. `src/analytics/service.ts:17-18`: corregir el denominador de la conversión. Nueva definición:
   conversaciones **con intención de compra** (las que llegaron al menos a `QUOTED`, o donde el
   modelo llamó `get_product_details`/`show_order_summary`) como denominador, no `SOLD + LOST`.
3. Panel: sección "Línea base" en Salud del bot con las siete métricas de abajo (la UI va en la
   misma fase, por la regla del repositorio).

**Métricas (P1-P7)**

| Id | Métrica | Fuente | Valor hoy |
|---|---|---|---|
| P1 | % de conversaciones con intención que terminan en pedido, sin intervención humana | `Conversation` + `Order` | **26,8 %** (medido sobre el total; falta recalcular con el denominador correcto) |
| P2 | Turnos hasta el cierre (mediana) | `Message` | sin medir |
| P3 | Datos pedidos dos veces en una conversación | detector nuevo en `conversationHealth` | 6 de 37 en fixtures |
| P4 | Promesas del bot no cumplidas (consulta al dueño / foto) | `conversationHealth` | 25 de 25 (consulta), 19 de 30 (foto), en fixtures |
| P5 | Intervenciones de backstop por 100 turnos, **abierto por guard** | `AgentIncident.guard` | **1,53** (agregado, sin desglose) |
| P6 | Latencia mensaje entrante → saliente, p50 y p95 | timestamps de `Message` | sin medir |
| P7 | Costo por conversación | `AiUsageLog` | **USD 0,0127** |

**Cuánto tiempo de línea base**: hay 10 días de historia utilizable. Con el desglose por guard
instrumentado, **2 semanas más** de observación son suficientes para que P5 tenga señal por guard.
P1, P2, P6 y P7 se pueden calcular retroactivamente sobre los datos existentes el mismo día.

**Qué borra:** nada. Es la única fase que solo suma, y se justifica porque sin ella ninguna otra se
puede evaluar.

**Riesgo / reversión:** ninguno. Migración aditiva.

---

## 3. Fase 1 — Prueba determinista de conversación completa (3-4 días)

Es la fase que cambia el régimen. Sin ella, producción sigue siendo la suite de pruebas y todo lo
que sigue se valida con clientes reales.

**Buena noticia: la infraestructura ya existe y está probada.**
`src/ai/agent.loopExhaustion.test.ts:5-15` demuestra que `deepseek.chat.completions.create` se
sustituye directamente sobre una instancia mutable de OpenAI, gratis, contra Postgres local con un
negocio semilla. Falta el formato de conversación grabada y las aserciones, no el andamiaje.

### 3.1 Diseño

**Estructura de archivos**

```
src/ai/replay/
  fixtures/
    igmt9z-aurora-sin-config.json      <- la venta perdida
    y1iz5l-foto-no-converge.json       <- 163 mensajes sin cierre
    ps2evr-datos-repetidos.json        <- repregunta de datos
    bf5c4k-cierre-feliz.json           <- el camino que SI funciona
    ... (20-30 en total)
  seed.ts                              <- siembra negocio+catalogo desde fixtures/catalog.json
  replay.ts                            <- motor de reproduccion
  replay.test.ts                       <- un test por fixture, corre en npm test
scripts/record-replay.ts               <- graba una conversacion contra DeepSeek REAL (costo unico)
```

**Formato de un fixture**

```jsonc
{
  "name": "aurora sin metodos de pago configurados",
  "seed": { "catalog": "aurora", "paymentMethods": [], "shippingRates": ["nacional"] },
  "turns": [
    {
      "customer": "Quiero los aretes de perla cultivada",
      // respuestas del modelo GRABADAS, en orden; el mock las devuelve una por llamada
      "modelResponses": [
        { "tool_calls": [{ "name": "search_products", "arguments": { "query": "aretes perla" } }] },
        { "tool_calls": [{ "name": "set_order_item",
                           "arguments": { "productId": "$ref:aretes", "quantity": 1 } }] },
        { "content": "Perfecto, anoto unos aretes de perla. ¿A que ciudad te los enviamos?" }
      ],
      "expect": {
        "toolSequence": ["search_products", "set_order_item"],
        "state": { "items": [{ "productName": "Aretes de perla cultivada", "quantity": 1 }],
                   "missing": ["ciudad", "direccion", "nombre", "documento"] },
        "sideEffects": { "mediaSent": 0, "ownerAsked": 0, "messagesSent": 1 },
        "textMustNotContain": ["$", "total"]     // el motor todavia no fijo cifras
      }
    }
  ]
}
```

**Reglas de aserción — esto es lo que hace que la suite no sea frágil**

1. **Nunca se aserta sobre el texto exacto del modelo.** El modelo cambia de redacción y eso no es
   una regresión.
2. Se asierta sobre: **estado final** (`SaleState` completo tras el turno), **secuencia de llamadas
   a herramientas** (nombres y orden, no argumentos libres), y **efectos laterales contados**
   (mensajes enviados, fotos enviadas, escalaciones creadas).
3. Se permite asertar **presencia o ausencia de bloques deterministas** (el total, los datos de
   pago, la tarifa de envío) porque a partir de la Fase 3 los inserta el sistema, con texto fijo.
   Esa es la única excepción, y es legítima: no es texto del modelo.
4. `textMustNotContain` cubre las regresiones de clase "el bot dijo una cifra que no debía".

**Grabación de las respuestas**

`scripts/record-replay.ts` toma una conversación anonimizada de
`src/ai/regression/fixtures/conversations.json`, la reproduce **una sola vez** contra DeepSeek real
—costo controlado, del orden de centavos según los datos de `AiUsageLog`— y guarda cada respuesta
del modelo en el fixture. A partir de ahí la suite es gratis y determinista para siempre. Regrabar
solo cuando cambie deliberadamente el contrato de herramientas.

**Cobertura obligatoria del set inicial (20-30 conversaciones)**

- Las cuatro conversaciones peores del diagnóstico: `igmt9z`, `y1iz5l`, `ps2evr`, `bf5c4k`.
- Al menos 3 cierres exitosos completos (el camino feliz tiene que estar protegido).
- Un negocio sin configurar (Aurora) y uno configurado (MAGByLizN).
- Un cliente que vuelve (`get_previous_conversation`).
- Una cancelación de pedido.
- Una escalación al dueño con respuesta, y una sin respuesta.
- Un envío de foto y una petición de foto de un producto sin foto cargada.

**Criterios de aceptación**

- `npm test` sigue corriendo en menos de 90 segundos con la suite nueva incluida.
- Cero llamadas de red a DeepSeek durante `npm test` (verificado con un `fetch` mockeado que falla).
- Las 4 conversaciones problemáticas **fallan** al escribirse la prueba: eso confirma que la prueba
  mide el defecto real y no describe el comportamiento actual.

**Qué borra:** nada todavía. Habilita el borrado de todo lo demás.

**Riesgo:** que los fixtures grabados queden obsoletos al cambiar el contrato de herramientas.
**Mitigación:** el script de regrabación es parte de la fase, y el contrato cambia en fases
explícitas (2, 3, 4, 5), donde regrabar es parte del trabajo.

**Reversión:** borrar el directorio. No toca producción.

**Esfuerzo:** 3-4 días. **Core.**

---

## 4. Fases en orden de dependencia

### Bloque A — Romper el ciclo de parches

---

#### Fase 2 — Estado de venta ejecutable

**Objetivo en una frase:** que el sistema sepa qué está comprando el cliente, mientras lo compra.

**Causa raíz que cierra:** C1.

**Cambios concretos**

- Migración: tabla `SaleState` (sección 1.3).
- `src/orders/saleState.ts` (nuevo): dueño único de lectura/escritura. Reusa
  `computeCheckoutState` (`orders/checkoutState.ts:139`) para derivar `missing`.
- Herramientas nuevas, todas con validación contra la base antes de aplicar:
  `set_order_item(productId, variantId?, quantity)`, `remove_order_item(productId)`,
  `set_shipping_modality(code)`, `set_payment_method(paymentMethodId)`.
- `save_customer_contact_info` pasa a escribir en `SaleState` además de `Customer`, y **rechaza**
  un documento o celular con forma inválida según la config del negocio, devolviendo el motivo al
  modelo.
- `agent.ts`: el estado se inyecta como mensaje `system` en cada turno —el mismo canal que ya usa
  `FOTOS/VIDEOS YA ENVIADOS` (`agent.ts:1021-1026`)— con el formato
  `PEDIDO EN CURSO: 1x Airpods Max (azul). Falta: ciudad, direccion, documento.`
- `show_order_summary` y `close_conversation` leen de `SaleState`, no de lo que diga el modelo.
- `agent.ts:1074`: `buildCheckoutState` sale del `void ... .then()` y pasa a ser la fuente real.

**Parches que elimina**

- Los 13 patrones de clase C: `ASK_NAME_PATTERN` (`:272`), `ASK_ID_PATTERN` (`:525`),
  `ASK_PHONE_PATTERN` (`:526`), `ASK_DELIVERY_DATA_PATTERN` (`:531`), `MONEY_NEAR_PATTERN` (`:548`),
  `ID_LABEL_PATTERN` (`:549`), `PHONE_LABEL_PATTERN` (`:550`), `STREET_WORD_PATTERN` (`:588`),
  `looksLikeIdOrPhone` (`:755`), y con ellos `extractNameFromAnswer`,
  `extractDeliveryDataFromAnswer`, `extractAddressFromAnswer`, `extractNameFromDeliveryAnswer`.
- Las etapas 10 y 11 de `finalizeTurn` (`agent.ts:1174-1221`) desaparecen completas.
- El detector `DATO_NO_GUARDADO` de `jobs/conversationHealth.ts:57-99` pierde su motivo de existir
  (se conserva un trimestre como control cruzado, después se borra).
- El párrafo de meta-regla del prompt (`systemPrompt.ts:482-489`).

**Criterios de aceptación**

- `ps2evr` reproducida: **cero** repreguntas de un dato ya presente en `SaleState`.
- P3 (datos pedidos dos veces) baja a 0 en la suite de replay.
- El prompt baja al menos 800 caracteres.

**Cómo se prueba sin gastar plata:** suite de replay de la Fase 1, más pruebas unitarias de
`saleState.ts`.

**Riesgo:** medio-alto. Toca el camino de compra completo.
**Reversión:** bandera por negocio `saleStateEnabled`; se enciende primero en un negocio de prueba,
después en MAG.IMP. La tabla es aditiva; apagar la bandera vuelve al comportamiento anterior.

**Esfuerzo:** 5-7 días. **Core.**

---

#### Fase 3 — Un solo punto de verdad para las cifras

**Objetivo:** que ninguna cifra que ve el cliente salga del texto del modelo.

**Causa raíz:** C2 (la mitad de plata).

**Cambios concretos**

- El motor arma bloques fijos: resumen de pedido, total, costo de envío, datos de pago. El modelo
  recibe una marca (`{{BLOQUE_TOTAL}}`) y redacta alrededor; el motor sustituye antes de enviar.
- El prompt pasa a prohibir cifras por construcción: el modelo no las tiene, las recibe ya
  renderizadas.

**Parches que elimina**

- `guardAgainstPaymentHallucination` (`agent.ts:624-643`) — **y con él la etapa que reemplaza la
  respuesta entera**, que es el peor problema de composición del pipeline.
- `guardAgainstShippingCostHallucination` (`agent.ts:671`).
- `guardAgainstOrderTotalMismatch` (`agent.ts:734`).
- `PAYMENT_MENTION_PATTERN` (`:617`), `SHIPPING_MENTION_PATTERN` (`:661`),
  `ORDER_TOTAL_MENTION_PATTERN` (`:723`).
- La llamada extra a `get_shipping_rates` dentro de `finalizeTurn` (`agent.ts:1084-1090`).
- Etapas 2, 4, 5 y 6 de `finalizeTurn`.

**Criterios de aceptación**

- `textMustNotContain` con un patrón de dígitos pasa en las 30 conversaciones de replay, salvo en
  los bloques fijos.
- `igmt9z` t13 reproducida: el bot **no** puede decir un total, porque el negocio no tiene métodos
  de pago (queda bloqueado por la Fase 6).

**Riesgo:** bajo. Es sustitución de plantilla.
**Reversión:** trivial, los guards se pueden restituir.

**Esfuerzo:** 3-4 días. **Core.**

---

#### Fase 4 — La escalación al dueño es un estado, no una frase

**Objetivo:** que "voy a consultar con el equipo" sea imposible de decir sin que exista una consulta
real.

**Causa raíz:** C2. Cierra F1 y F7, las dos fallas críticas más frecuentes del diagnóstico
(25 promesas, 0 cumplidas).

**Cambios concretos**

- `ask_owner` crea un `PendingOwnerQuestion` y pone `SaleState.blockedBy = PENDING_OWNER_QUESTION`.
- Mientras esté bloqueado, el motor inserta un bloque fijo ("ya le pregunté a la dueña, apenas
  responda te aviso") y **el modelo no puede prometer nada por su cuenta**: recibe el estado y sabe
  que la consulta ya está hecha.
- Si el modelo intenta cerrar o avanzar con el flujo bloqueado, la herramienta devuelve error.
- La intercepción de FAQ sale del loop (`agent.ts:1540-1554`): las FAQ relevantes se adjuntan al
  contexto cuando el mensaje parece pregunta de política, o viajan junto al resultado de la primera
  herramienta. Deja de costar una iteración y una doble llamada a `ask_owner`.
- El recordatorio al dueño deja de tener tope de dos: escala a un tercer aviso y, si sigue sin
  respuesta a las 48 h, marca la conversación para el panel con prioridad alta.

**Parches que elimina**

- El guard `escalation` completo (`agent.ts:1155-1166`) y `ESCALATION_CLAIM_PATTERN` (`:224`).
- Parte de `OFFER_OR_PENDING_CONFIRMATION_PATTERN` (`:216`).
- El guard `catalog_check` (`:1136-1154`) y `CATALOG_CHECK_CLAIM_PATTERN` (`:249`), por el mismo
  mecanismo: si el modelo dijo que va a revisar el catálogo y no llamó la herramienta, el motor no
  pega una lista al final — el turno no avanza hasta que la llame.
- El guard `payment_options` (`:1104-1123`) y `PAYMENT_OPTIONS_CLAIM_PATTERN` (`:233`) — los datos
  de pago los inserta la Fase 3.
- El guard `shipping_modality` (`:1124-1135`) y `SHIPPING_MODALITY_CLAIM_PATTERN` (`:239`).
- Etapa 8 de `finalizeTurn` (`applyClaimBackstops`) desaparece completa, con sus cuatro entradas.

**Criterios de aceptación**

- P4 (promesas incumplidas de consulta) = 0 en la suite de replay.
- `igmt9z` reproducida: la pregunta por cobertura contraentrega genera un `PendingOwnerQuestion`
  real y el flujo queda bloqueado, en vez de cuatro promesas y una derivación al "WhatsApp del
  negocio".
- Cero llamadas a `ask_owner` disparadas por texto.

**Riesgo:** medio. Cambia el comportamiento visible cuando el negocio no sabe algo.
**Reversión:** bandera por negocio.

**Esfuerzo:** 4-5 días. **Core.**

---

#### Fase 5 — Los medios son una decisión de herramienta, no de texto

**Objetivo:** que enviar una foto sea siempre consecuencia de una llamada a herramienta validada.

**Causa raíz:** C2. Cierra F2 y F6.

**Cambios concretos**

- `send_product_media` es el único camino. Ya tiene la validación correcta
  (`agent.ts:1556-1584`): se conserva y se endurece para que exija siempre un `productId` del turno.
- El estado de medios (`FOTOS/VIDEOS YA ENVIADOS`) pasa a `SaleState.mediaSent`, en vez de
  reconstruirse leyendo el historial con `MEDIA_CAPTION_PATTERN`.
- Cuando el producto no tiene foto, la herramienta devuelve `{sent:false, reason:"sin_media"}` y el
  modelo lo dice con sus palabras en el mismo turno. Nunca se pega una retractación después.
- El bucle de identificación por foto (`y1iz5l`) se corta con el contador que ya existe
  (`countUnresolvedPhotoIdStreak`, `agent.ts:885`), pero elevado a estado: tras 2 intentos, el motor
  fuerza `ask_owner_about_photo` y bloquea el reintento. `shouldForcePhotoEscalation`
  (`agent.ts:1449-1454`) ya está bien acotado y se conserva.

**Parches que elimina** — las 5 capas sobre una sola promesa:

- `PHOTO_REQUEST_PATTERN` (`:154`), `CUSTOMER_PHOTO_REQUEST_PATTERN` (`:163`),
  `CUSTOMER_PHOTO_NEGATION_PATTERN` (`:165`), `PHOTO_CLAIM_PATTERN` (`:173`),
  `OPEN_CLARIFYING_QUESTION_PATTERN` (`:182`), `NON_PRODUCT_PHOTO_PATTERN` (`:200`),
  `FAKE_MEDIA_TAG_PATTERN` (`:203`), `PHOTO_ID_CLARIFY_PATTERN` (`:263`),
  `VARIANT_DENIAL_PATTERN` (`:257`).
- `findMentionedProductsForMediaBackstop` (`:793`) completa, con su barrido de tokens sobre el turno
  anterior.
- `honorOrRetractMediaPromise` (`:984`).
- Etapa 12 de `finalizeTurn` (`agent.ts:1223-1372`, **150 líneas**) desaparece completa.
- `OFFER_OR_PENDING_CONFIRMATION_PATTERN` (`:216`) se borra acá, al perder su último consumidor.
- Se conservan `MEDIA_TAG_STRIP_PATTERN` y `MEDIA_CAPTION_PATTERN` solo como saneamiento de
  historial (clase B).

**Criterios de aceptación**

- P4 (promesas de foto incumplidas) = 0.
- `y1iz5l` reproducida: máximo 2 rondas de identificación antes de escalar al dueño.
- Cero envíos de foto no originados en una llamada a herramienta del modelo.

**Riesgo:** medio. Es la superficie con más incidentes históricos.
**Reversión:** bandera por negocio.

**Esfuerzo:** 4-5 días. **Core.**

**Al terminar el Bloque A**: `agent.ts` pierde ~450 líneas y **18 de los 41 patrones con nombre**,
más la reubicación de otros 13. `finalizeTurn` queda en 2 etapas: saneamiento de fugas y sustitución
de bloques fijos.

---

### Bloque B — No perder el canal

---

#### Fase 6 — Compuerta de configuración

**Objetivo:** que un negocio sin lo indispensable no pueda entrar al flujo de venta.

**Causa raíz:** C5 + el riesgo R8. Cierra F8.

**Cambios concretos**

- `src/ai/configHealth.ts` deja de ser informativo y pasa a ser compuerta. Define dos niveles:
  *puede conversar* (catálogo con al menos un producto activo) y *puede vender* (métodos de pago
  activos, al menos una tarifa de envío, teléfono de contacto).
- Sin "puede vender", las herramientas `show_order_summary`, `set_payment_method` y
  `close_conversation` devuelven error con el motivo, y el motor inserta un bloque fijo que ofrece
  tomar el pedido y que el dueño confirme.
- Panel: tarjeta de bloqueo en el tablero, con la lista de lo que falta y el enlace directo a cada
  sección. Misma fase, por la regla del repositorio.

**Parches que elimina:** ninguno directamente; evita que el resto de las fases tengan que manejar el
caso "el negocio no tiene el dato".

**Criterios de aceptación:** `igmt9z` reproducida con Aurora sin métodos de pago: el bot no promete
datos bancarios ni un total; ofrece dejar el pedido anotado.

**Riesgo:** bajo. **Reversión:** bandera global.
**Esfuerzo:** 2-3 días. **Core.**

---

#### Fase 7 — Capa única de salida confiable

**Objetivo:** que mandar un mensaje de WhatsApp sea una operación con garantías, en un solo lugar.

**Causa raíz:** C4. Cierra R1, R3, R9 y los 15 puntos de pérdida silenciosa.

**Cambios concretos**

- `src/whatsapp/outbound.ts` (nuevo): único punto de envío. Todos los llamadores actuales de
  `sendTextMessage`/`sendImageMessage`/`sendTemplateMessage` pasan por acá
  (`whatsapp.ts:738`, `:339`, `:348`, `admin/conversations.ts:159`, `:219`, `:337`,
  `jobs/*`, `orders/service.ts` CSAT, `ai/tools.ts` medios).
- Responsabilidades de esa capa: verificar la ventana de 24 h **siempre**; caer a plantilla cuando
  está cerrada; `timeout` explícito en `callGraphApi` (hoy no tiene, `whatsapp/client.ts:23-40`);
  parsear el JSON de error de Meta y **ramificar por `error.code`** (131047 ventana, 131050 opt-out,
  190 token expirado, 429 límite de tasa, 132018 formato de plantilla); reintentos con backoff;
  `QueuedOutboundMessage` con `attempts`, `nextAttemptAt`, `lastError` y **dead-letter**; registrar
  siempre un `DeliveryFailure` cuando se agota.
- Job periódico de drenaje de la cola (hoy solo drena cuando el cliente escribe).
- Ciclo de vida del token: columna `whatsappTokenExpiresAt`, alerta al dueño y a Zaqi a 7 días, y
  detección del error 190 para marcar la conexión como caída.
- `SIGTERM`/`SIGINT` con `server.close()` y espera de los turnos en vuelo. `/health` que toque la
  base.
- `ecosystem.config.js` versionado con `exec_mode: fork` y `instances: 1`, para que la suposición
  del lock esté escrita en código y no en un comentario (`whatsapp.ts:57-58`).
- Persistir `sent/delivered/read` en una columna de `Message`, para que el panel muestre estado real.

**Parches que elimina**

- Los `try/catch` ad-hoc dispersos por sitio de llamada.
- `STALE_REPLY_MINUTES` deja de ser la red principal (se conserva como métrica).
- `alertOwnerOfDegradedReply` se conserva: es observabilidad correcta.

**Criterios de aceptación**

- Pruebas con `fetch` mockeado que devuelven 131047, 190, 429 y 500: cada una produce la decisión
  correcta y nunca deja al cliente sin mensaje ni al dueño sin aviso.
- Un reinicio durante un turno en vuelo deja un registro explícito y el turno se reintenta.
- Cero llamadas directas a `whatsapp/client.ts` fuera de `outbound.ts` (verificado con una prueba de
  arquitectura que hace `grep`).

**Riesgo:** alto por alcance, bajo por naturaleza (es refactor con contratos claros).
**Reversión:** la capa nueva delega en las funciones viejas; se puede desactivar la política y dejar
el paso directo.

**Esfuerzo:** 6-8 días. **Core.**

---

#### Fase 8 — Seguridad de plataforma

**Objetivo:** cerrar lo que puede convertirse en un incidente frente a un cliente.

**Causa raíz:** C4 + deuda de seguridad. Cierra R2, R5 y el IDOR.

**Cambios concretos**

1. **Firma del webhook**: `express.raw` solo en `/webhook` (o `verify` callback en `express.json`),
   y verificación HMAC-SHA256 contra `env.facebook.appSecret`. Rechazo 401 si no valida.
   `index.ts:17` es el cambio estructural que lo habilita.
2. **Cifrado de tokens en reposo**: `whatsappAccessToken` con `aes-256-gcm` y clave en variable de
   entorno. Migración con re-cifrado de las 3 filas existentes.
3. **IDOR**: `admin/conversations.ts:170-177` valida `req.params.id` con
   `getConversationForBusiness` como hacen las otras cinco rutas del archivo. Y `listQueuedOutbound`
   pasa a recibir `businessId`.
4. **`requireOwner`** en las rutas que hoy no lo tienen: `whatsappConnect.ts:43` (crítica),
   `catalog.ts:32-140`, `orders.ts:40`, `:111`. Depende de la decisión D5 del diagnóstico.
5. **`SESSION_SECRET`** pasa por `required()` (`config/env.ts:15`), y las sesiones a un store en
   Postgres (`connect-pg-simple`) — hoy se pierden en cada uno de los 103 reinicios.
6. **Código de recuperación**: `crypto.randomInt`, hash antes de guardar, comparación de tiempo
   constante, y **dejar de escribirlo en `OwnerMessageLog`** (hoy es legible desde dos APIs).
7. **Subida de archivos**: `fileFilter` con lista blanca de tipos, tope de tamaño por tipo, y
   derivar la extensión y el `Content-Type` del contenido real, no del cliente (`media/s3.ts:29`).
8. `helmet` con CSP básica y cabeceras de seguridad.
9. Dejar de loguear teléfonos de clientes (`whatsapp.ts:383`, `:406`, `:438`).

**Criterios de aceptación:** una prueba por punto; para el IDOR, una prueba que intente leer desde
el negocio A una conversación del negocio B y reciba 404.

**Riesgo:** bajo-medio. El punto 1 puede romper la recepción si se despliega mal — desplegar con
registro de "firma inválida" durante 48 h **antes** de activar el rechazo.

**Esfuerzo:** 4-5 días. **Core.**

---

### Bloque C — Producto vendible

---

#### Fase 9 — Salidas de conversación e inactividad

**Objetivo:** que el 61 % de conversaciones en `NEW` deje de existir.

**Causa raíz:** C1 + eje 18. Cierra F11.

**Cambios concretos**

- Job de inactividad: una conversación sin mensajes del cliente por N horas (configurable por
  negocio, default 72) pasa a `ABANDONED`, un estado nuevo distinto de `LOST` (que sigue siendo el
  rechazo explícito). Migración de enum.
- `Customer.stage = INACTIVO` se asigna automáticamente (hoy el valor existe y nada lo escribe,
  `schema.prisma:446`).
- Reactivación: si hay `SaleState` con ítems y la conversación se abandonó, plantilla aprobada de
  recuperación de carrito, respetando la ventana por construcción (igual que `followUp.ts`).
- Panel: embudo con el denominador correcto y la columna de abandonadas.

**Parches que elimina:** ninguno; corrige la métrica que hoy miente por 52 puntos.

**Criterios de aceptación:** P1 refleja el abandono; cero conversaciones con más de 7 días de
inactividad en estado abierto.

**Riesgo:** bajo. **Esfuerzo:** 3 días. **Core.**

---

#### Fase 10 — Ritmo y forma de la respuesta

**Objetivo:** que se sienta una persona.

**Causa raíz:** eje 19, que está en cero completo.

**Cambios concretos**

- **Agrupación de ráfaga**: ventana de ~8 s por conversación en la capa [1] antes de generar. Una
  respuesta por ráfaga.
- Indicador de "escribiendo" y marcar como leído al recibir.
- Partir mensajes de más de ~700 caracteres en dos envíos con pausa corta.
- Retardo proporcional al largo antes de responder (tope ~4 s).

**Criterios de aceptación:** una prueba de la capa de ingesta con 3 mensajes en 2 s produce **1**
llamada a `generateReply`.

**Riesgo:** bajo. Es aditivo y medible.
**Esfuerzo:** 3-4 días. **Core.**

---

#### Fase 11 — Todo lo del negocio es configuración

**Objetivo:** que el segundo, el décimo y el mexicano no necesiten tocar código.

**Causa raíz:** C5.

**Cambios concretos**

- `Business`: `countryCode`, `currency`, `timezone`, `businessHours`, `requiresIdDocument` con
  reglas por zona, `ownerReminderMinutes` expuesto en la API.
- `checkoutState.ts:99`: `zonasSinDocumento` sale del código y pasa a una tabla por negocio.
- `formatCopPrice` (`catalog/products.ts:37-39`) pasa a `formatPrice(amount, currency, locale)`.
- La heurística cédula/celular (`agent.ts:545-580`) se reemplaza por validadores por país; en la
  Fase 2 ya dejó de ser un regex sobre prosa, acá deja de ser colombiana.
- El regex de vía colombiana (`checkoutState.ts:78-80`) pasa a validador de dirección por país.
- `PAYMENT_MENTION_PATTERN` ya se borró en la Fase 3; el guard de pago es por configuración.
- Ejemplos del prompt (Nequi en `systemPrompt.ts:464`, `tools.ts:449`, `extractSale.ts:28`,
  `visionPrompt.ts:17`) se generan desde los métodos reales del negocio.
- `CATEGORY_LABELS` (`systemPrompt.ts:352`) deja de ser un conjunto cerrado de 5.
- Panel: sección "País y moneda" y "Horario de atención". Misma fase.

**Criterios de aceptación:** un negocio mexicano de prueba, sembrado con MXN, SPEI/OXXO, dirección
con colonia y C.P., completa una venta en la suite de replay sin un solo cambio de código.

**Riesgo:** medio. Toca muchas superficies pequeñas.
**Esfuerzo:** 5-6 días. **Core**, y es el prerrequisito de México.

---

#### Fase 12 — Cerrar el ciclo de aprendizaje (el diferenciador)

**Objetivo:** convertir el subsistema que ya funciona en el foso del producto.

**Causa raíz:** eje 17. Es el único subsistema que hoy rinde (12 de 24 entradas de FAQ salieron de
él) y está a mitad de camino.

**Cambios concretos, en orden de retorno**

1. **Aprender de `humanControl`** — el punto más caro hoy. Cuando el dueño responde a mano desde el
   panel, llamar `recordAskOwnerResolution` con la pregunta del cliente y la respuesta del dueño
   (`admin/conversations.ts:145-162`), y **dejar de borrar** el `PendingOwnerQuestion`
   (`conversation/service.ts:495-497`): marcarlo resuelto. Es más volumen y mejor contexto que la
   escalación por WhatsApp.
2. **Reescritura del borrador** — una sola llamada al modelo *en el momento de sugerir*, no por
   mensaje: normaliza la pregunta, pasa la respuesta a voz de política, saca nombres y números. Se
   muestra como borrador editable. Es la causa real de que las primeras entradas salieran mal.
3. **Deduplicación en la misma llamada** — reemplaza el solapamiento de ≥2 tokens por substring
   (`learnedFaq.ts:15-20`), que falla en los dos sentidos. Y al fusionar, **conservar la respuesta
   nueva** en vez de descartarla (`:61-64`).
4. **Umbral correcto** — exigir ≥2 clientes distintos **y** respuestas del dueño concordantes, no
   solo `occurrences >= 2` (`learnedFaq.ts:96`).
5. **Retroalimentación** — contador de uso por `FaqEntry` y vínculo al candidato de origen; medir si
   las escalaciones de ese tema bajaron.
6. **Caducidad** — `updatedAt` + fecha de revisión; recordatorio para las entradas con precios o
   promociones, que `learnedFaqQuality.ts:31-35` ya sabe detectar.
7. **`get_faq` por relevancia** — recuperación en vez de volcado completo (`tools.ts:930-939`),
   con el mismo criterio de tope que ya se aplicó a los productos
   (`LIST_DESCRIPTION_MAX_CHARS`, `tools.ts:600-613`).

**Criterios de aceptación:** una conversación con toma de control manual genera un candidato;
el borrador sugerido no contiene nombres propios ni números de una persona; `get_faq` con 100
entradas devuelve menos de 800 tokens.

**Riesgo:** bajo. **Esfuerzo:** 5-6 días. **Core y diferenciador.**

---

#### Fase 13 — Checkout en chat (Wompi y Mercado Pago)

**Objetivo:** hacer lo único que Meta dice explícitamente que su agente no hace: transaccionar.

**Cambios concretos**

- Integración con **Wompi** (Colombia): una sola integración cubre tarjetas, PSE, Nequi, Daviplata,
  botón Bancolombia y efectivo. Comisión 2,65 % + $700 COP + IVA.
- Integración con **Mercado Pago** (México): Checkout API cubre tarjetas, SPEI y OXXO.
- El enlace de pago se genera desde `SaleState` (por eso esta fase depende de la Fase 2) y la
  confirmación llega por webhook, no por foto del comprobante.
- **Se conserva el flujo actual** de comprobante + confirmación del dueño con botones Sí/No: es el
  camino correcto para contraentrega y para quien no quiere pagar en línea. Los dos conviven.
- Panel: configuración de la pasarela y conciliación.

**Criterios de aceptación:** una venta completa de punta a punta en sandbox, con el pedido pasando a
pagado por webhook y no por inspección humana.

**Riesgo:** medio-alto (dinero real, cumplimiento de la pasarela).
**Reversión:** bandera por negocio; el flujo viejo nunca se quita.
**Esfuerzo:** 8-10 días. **Core y diferenciador.**

---

#### Fase 14 — Table stakes de venta

**Objetivo:** quitar las tres razones por las que un comprador descarta la herramienta antes de
probarla.

- **Difusión y campañas con plantillas y segmentos** (la ausencia más citada del mercado).
  Requiere el opt-out de la Fase 7 funcionando, por política de Meta.
- **Asignación de conversaciones** a un miembro del equipo (`assignedTo` no existe en ningún
  modelo).
- **Primitivas nativas de WhatsApp**: mensajes de catálogo, multiproducto y carrusel. Meta las
  regala a nivel de protocolo y Onix no las usa.

**Esfuerzo:** 8-10 días. **Core.**

---

## 5. Ruta mínima a producto vendible

### 5.1 Colombia — lo que exige

| Requisito | Fase |
|---|---|
| Que el bot no prometa lo que no hace | 2, 4, 5 |
| Que las cifras sean ciertas | 3 |
| Que un negocio nuevo no queme su primera conversación | 6 |
| Que no se pierdan mensajes ni se muera el token | 7 |
| Que no haya un incidente de seguridad frente a un cliente | 8 |
| Que la métrica que se le muestra al negocio sea verdadera | 0, 9 |
| Difusión y asignación (o el comprador se va con Wati) | 14 |
| Verificación de negocio Meta + URL de política de privacidad | trámite, no código, **empezar ya** |
| Aviso de tratamiento de datos y contrato de encargo | D1, trámite legal |

**Camino crítico: Fases 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 14.**
Estimación acumulada: **48-60 días de trabajo efectivo.**

### 5.2 México — lo que exige además

| Requisito | Fase |
|---|---|
| País, moneda, zona horaria como configuración | 11 |
| Validadores de dirección y teléfono mexicanos | 11 |
| SPEI/OXXO por Mercado Pago | 13 |
| Aviso de privacidad LFPDPPP | D1 |
| Tarifario de Meta para México (marketing bajó desde 2025-10-01) | verificar en Business Manager |

**No abrir México antes de que Colombia cumpla la definición de listo.** Meta piloteó su propio
agente dos años en México: es el mercado donde más fuerte está.

---

## 6. Definición de "listo"

Onix se considera robusto cuando, medido sobre 30 días y al menos 3 negocios reales distintos:

| Id | Métrica **de resultado** | Meta | Hoy |
|---|---|---|---|
| L1 | % de conversaciones con intención de compra que terminan en pedido **sin que un humano tenga que intervenir** | **≥ 40 %** | 26,8 % sobre el total, sin denominador correcto |
| L2 | % de pedidos iniciados que se completan (no abandonados a mitad del checkout) | **≥ 70 %** | sin medir |
| L3 | Mediana de turnos desde "quiero X" hasta pedido cerrado | **≤ 12** | `ps2evr` tardó 65 mensajes |
| L4 | % de conversaciones donde el cliente tuvo que repetir un dato que ya dio | **0 %** | 16 % de los fixtures |
| L5 | % de promesas del bot que se cumplen (consulta al dueño, foto, dato) | **≥ 95 %** | 0 % (consulta), 37 % (foto) |
| L6 | Conversaciones abandonadas que reciben al menos un intento de reactivación | **≥ 90 %** | 0 % |
| L7 | Latencia p95 entre mensaje del cliente y respuesta | **≤ 20 s** | sin medir |
| L8 | Costo de IA por conversación | **≤ USD 0,05** | USD 0,0127 (ya cumple) |
| L9 | Mensajes de cliente que quedan sin ninguna respuesta | **0** | sin medir; hay 15 caminos que lo permiten |
| L10 | Calificación de calidad del número de WhatsApp | **Verde** en todos los negocios | no se monitorea |

**Métricas sustitutas, explícitamente degradadas a diagnóstico interno:**

- *Intervenciones de backstop por 100 turnos* (hoy 1,53). Mide cuántas veces se activó el parche, no
  si la venta funcionó. Se conserva **abierta por guard** como herramienta de desarrollo y como
  señal de que una fase realmente borró su clase de falla — pero **no** como criterio de "listo".
  El objetivo de esta métrica no es bajarla: es que los guards que la producen dejen de existir.
- *Cero incidentes*: un sistema sin incidentes registrados puede ser un sistema sin instrumentación.

---

## 7. Qué **no** se va a hacer, y por qué

| Descartado | Motivo |
|---|---|
| **Multicanal (Instagram, Messenger, web)** en esta ronda | Está bloqueado por el estado de Tech Provider, y Meta lo regala en los tres canales con su propio agente. Competir ahí es competir de frente contra gratis |
| **Agente de voz** | Yalo y Aivo lo tienen y es enterprise. Fuera del segmento |
| **Sincronización con Shopify/WooCommerce** | Es table stake real, pero los negocios objetivo (pymes colombianas de WhatsApp) mayormente no tienen tienda en línea. Se reevalúa después de la Fase 14 |
| **CoDi** | Banxico reconoce que no despegó. Mercado Pago cubre SPEI y OXXO |
| **WhatsApp Pay nativo** | No está disponible en Colombia ni en México. Solo India, Brasil y Singapur |
| **Cambiar de proveedor de modelo** | No resuelve ninguna de las cinco causas raíz. Con 88,3 % de acierto de caché, el costo tampoco lo justifica |
| **Arquitectura multi-agente** | Multiplica llamadas y latencia sin resolver la ausencia de estado |
| **Reescribir el sistema** | El 80 % del repositorio está bien. El problema está concentrado en `agent.ts` y en la capa de salida |
| **Más backstops de regex sobre prosa** | Es la causa C2. Cada fase de este plan borra una clase; ninguna agrega |
| **"Mejorar el prompt" como solución principal de cualquier hueco** | Se permite exactamente en un caso: el **tono, la redacción y el manejo de objeciones**, donde no hay resultado verificable y la instrucción en lenguaje natural es la herramienta correcta. Para todo lo que tenga un resultado comprobable —cifras, estado, datos, medios, escalación— el prompt es la solución equivocada por definición |

---

## 8. Decisiones del dueño que este plan necesita

Heredadas del diagnóstico, con el impacto sobre el plan:

| # | Decisión | Bloquea |
|---|---|---|
| D1 | Consentimiento de datos del cliente final | Fase 2 (inyectar el nombre guardado) y la venta a cualquier cliente que pregunte por cumplimiento |
| D3 | Cuándo se abre México | Si la Fase 11 entra antes o después de la Fase 14 |
| D4 | Modelo de precios frente al costo real (ya medido: USD 0,0127/conversación) | Nada técnico; sí la ruta comercial |
| D5 | Qué puede hacer el rol `EMPLOYEE` | Fase 8, punto 4 |
| D6 | Retención de conversaciones y media en S3 | Fase 9 y el costo de S3 |

---

## 9. Resumen de una página

1. **La causa es una sola, y tiene cuatro consecuencias**: la transacción no tiene máquina de
   estados. De ahí salen los guards que leen prosa, la ausencia de pruebas, y la imposibilidad de
   medir.
2. **La Fase 1 es la que cambia el régimen.** Sin prueba determinista de conversación completa,
   producción sigue siendo la suite y el ciclo se reinicia.
3. **El Bloque A borra 18 de 41 patrones y ~450 líneas de `agent.ts`.** Es el único bloque donde el
   sistema se hace más chico.
4. **El Bloque B evita perder el canal**: el token que expira a los 60 días y el webhook sin firma
   son las dos cosas que pueden causar un incidente con un cliente en los próximos 90 días.
5. **El Bloque C construye lo que Meta no puede hacer**: transaccionar en Colombia y México,
   preguntarle al dueño y retomar, y aprender de lo que el dueño contesta. Los tres están a medio
   construir hoy, y los tres son exactamente los diferenciadores que la investigación de mercado
   confirmó que nadie más tiene.
