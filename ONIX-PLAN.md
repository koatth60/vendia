# Onix — el plan

Este es **el** plan. No hay otro. Reemplaza a `ONIX-PLAN-INFRAESTRUCTURA.md`,
`ONIX-PLAN-MAESTRO.md`, `ONIX-RELIABILITY-PLAN.md`, `ONIX-PLAN-CATALOGO-Y-MEDIOS.md`,
`ONIX-CRM-REORG-PLAN.md`, `ONIX-PENDIENTES.md`, `PLANES.md` y `design/ONIX-REDESIGN-PLAN.md`, que
pasaron a `docs/historico/` el 2026-09-17. Nada de lo que decían se perdió: cada etapa de acá dice
de qué documento salió (ver el Anexo).

Escrito el 2026-09-17, con los números de producción de ese día delante.

---

## Cómo se usa

El trabajo está partido en **etapas numeradas `E01` a `E75`**, en el orden recomendado. Las siete
primeras (`E01`–`E05c`) están **cerradas** (2026-09-17) y aparecen agrupadas al principio.

**Cada etapa entra sola a producción y deja el sistema funcionando.** Esa es la regla que ordenó
todo lo demás: si un trabajo no cabía en una etapa que se pueda desplegar sola, se partió hasta que
cupo. Ninguna etapa deja el código a medias esperando a la siguiente.

Se puede saltar el orden. Cada etapa dice de qué depende de verdad; si no depende de nada, se puede
hacer hoy. La **Parte VII** tiene un índice por tema, para cuando la pregunta es "hoy quiero tocar
el CRM" y no "cuál sigue".

Tamaños: **S** = una sesión de trabajo. **M** = un día. **L** = dos o tres días. No hay nada más
grande; lo que era más grande se partió.

---

# PARTE I — Las reglas que no se negocian

## El norte

Un vendedor con el catálogo del negocio en la mano. El cliente pregunta, el vendedor revisa el
catálogo y contesta con lo que hay. No inventa productos, no inventa precios, no dice "no hay" sin
mirar. Pero conversa como una persona: recomienda, pregunta, ofrece fotos, maneja una objeción,
cierra.

Onix tiene que ser eso para **cualquier** negocio: se le cargan categorías, productos, fotos,
descripciones y preguntas frecuentes, y con eso vende.

En una frase de ingeniería: pasar de *"un LLM que sabe vender y usa herramientas"* a *"un sistema de
ventas determinístico donde el LLM conversa pero no puede romper las reglas del negocio"*. No se
trata de que el modelo sea perfecto. Se trata de que no necesite serlo.

## Qué se le fuerza y qué no

| Se fuerza SIEMPRE | No se fuerza NUNCA |
|---|---|
| **Hechos**: precios, stock, qué productos existen, qué colores hay, qué dice la FAQ | **Conversación**: qué decir, cómo decirlo, cuándo preguntar, cuándo insistir, cómo manejar una objeción |
| **Efectos con plata**: crear el pedido, avisarle al dueño, cancelar. Se verifica contra la base que ocurrieron | |

Cada regla que se mete en la columna derecha convierte al agente en un chatbot con un adorno de IA
encima.

## La división de autoridad

| El LLM manda en | El backend manda en |
|---|---|
| Conversación, tono, orden de las preguntas | Productos, precios, stock, colores, variantes |
| Interpretación de la intención del cliente | Categorías, imágenes, métodos de pago |
| Lenguaje natural, recomendación, objeciones | Pedidos, pagos, estados de pedido |
| Solicitud de herramientas | Envío de media, datos del cliente, cierre de transacción |

Ninguna fuente de verdad es el LLM, en ningún caso. Productos, precios, stock y variantes son
PostgreSQL. Pedidos y su estado, PostgreSQL. Pago, el proveedor más el backend más PostgreSQL.
Media, el almacenamiento real más metadatos persistidos. Configuración del negocio y estado de la
conversación, PostgreSQL.

## Estructura, nunca parche

Decisión del dueño, 2026-09-15, después de una semana de "arreglamos un parche y rompimos otro".
Está por encima de cualquier prisa.

**Antes de proponer o implementar un arreglo, hay que responder esta pregunta:**

> ¿Después de este cambio, el modelo tiene MENOS decisiones que puede equivocar, o más reglas que
> puede desobedecer?

Menos decisiones = estructura. Más reglas = parche. **Un parche no se implementa.** Se dice que no
alcanza y se propone el cambio estructural, aunque sea más grande y tarde más.

Son parche, sin excepción:

- Agregar texto al prompt pidiéndole al modelo que se acuerde de algo.
- Una expresión regular nueva sobre la prosa ya generada para deducir qué quiso hacer el modelo.
- Confiar en que el modelo llame una herramienta, sin verificar que la haya llamado.
- Forzar `tool_choice` como única defensa. Medido en producción el 2026-09-15: DeepSeek devolvió
  texto sin `tool_calls` con `tool_choice` forzado, dos veces, y el bot inventó productos que no
  existen en el catálogo.

**Sacar los datos de las manos del modelo pero dejarle la decisión no es media garantía: es cero
garantía con mejor apariencia.**

## Tool call ≠ success

Que el modelo pida una herramienta no significa que la operación haya ocurrido.

```
LLM solicita → BACKEND valida → TOOL ejecuta → BACKEND recibe resultado real
  → BACKEND verifica éxito/fallo → BACKEND persiste → LLM recibe resultado real
  → LLM comunica únicamente lo que ocurrió
```

Nunca: `LLM solicita → LLM asume éxito → LLM le dice al cliente que ocurrió`.

Toda afirmación del agente necesita evidencia detrás. "Cuesta $140.000" necesita el precio en la
base. "Hay stock" necesita el stock. "Lo tenemos en ese color" necesita la variante. "Te envié las
fotos" necesita la confirmación de la herramienta de envío. "Tu pedido fue creado" necesita una fila
`Order` real. "Tu pago fue recibido" necesita la confirmación del proveedor o del dueño.

## No arreglar el síntoma

Ante un defecto, la pregunta no es *"¿cómo hago que este caso funcione?"* sino **"¿qué garantía
faltaba que permitió que esto fuera posible?"**. Se eliminan **clases de error**, no ejemplos.

| Defecto real | Solución débil | Solución arquitectónica |
|---|---|---|
| El agente inventó el color naranja | "No inventes colores" en el prompt | El backend solo permite valores del catálogo, y se verifican antes de enviar |
| El agente dijo que mandó una foto que no llegó | "Acordate de mandar las fotos" | El agente no puede afirmar el envío si la herramienta no devolvió éxito |
| El bot dijo "mañana" cuando ya era hoy | "Fijate en las fechas" | El instante actual y el día de cada tramo del historial son datos del servidor |

## Las tres reglas de admisión

Una etapa entra al plan solo si responde las tres:

1. **¿Qué decisión le quita a alguien?** Al modelo, al operador o a la configuración. Una etapa que
   agrega una bandera para que alguien se acuerde de prenderla es un parche.
2. **¿Qué se puede verificar con una consulta?** Con un `SELECT`, no con una opinión ni con "se ve
   bien".
3. **¿Qué pasa si el proceso muere en el peor momento?** Si la respuesta es "se pierde y nadie se
   entera", la etapa no está terminada.

## Efectos requeridos: regla de admisión propia

El mecanismo de efectos requeridos (declarar el efecto esperado, verificarlo contra la base antes de
responder, reintentar, caer a código, escalar) admite un efecto nuevo solo si cumple las tres:

1. **Disparador determinista** — se calcula desde estado de la base o metadatos estructurados del
   mensaje (`mediaType`, quién habla). Nunca desde interpretar prosa, ni del cliente ni del modelo.
2. **Verificable con una consulta** — se responde con un `SELECT`, no con una opinión.
3. **Con fallback sin modelo** — el servidor tiene que poder hacerlo solo, con datos de la base.

El reintento es mitigación, no garantía. La garantía la da el fallback, porque no tiene al modelo
adentro.

## Regla de cambio mínimo

- Nada de "ya que estamos, refactorizamos X, Y y Z".
- Nada de renombrar, embellecer ni abstraer sin necesidad.
- Nada de tocar funcionalidad no relacionada.

## La medida: las líneas del prompt

> **Cada hecho que el servidor se lleva es una directiva del prompt que se puede borrar.**

El error histórico fue hacer solo la mitad: agregar garantías en código y dejar las directivas
viejas que existían para suplirlas. Por eso el prompt llegó a 568 líneas de "cuando el cliente diga
X, hacé Y".

`src/ai/prompts/systemPrompt.ts` tiene **541 líneas** hoy. Tiene que ir **bajando** mientras los
errores se mantienen en cero. Objetivo al terminar el Bloque 6: **por debajo de 400**. Si sube y no
hay errores, nos estamos convirtiendo en chatbot sin que nadie lo decida.

Antes de agregar texto al prompt hay que poder decir qué línea se borra a cambio. Una etapa que no
puede nombrar la directiva que vuelve innecesaria **no está haciendo trabajo estructural**, está
agregando superficie — salvo que declare explícitamente por qué su borrado le toca a otra etapa, y
cuál.

## Regla de no regresión

Decisión del dueño, 2026-09-16: **el comportamiento actual es aceptable y ninguna etapa puede
empeorarlo.** No es una aspiración, es una condición de admisión más.

Tiene una consecuencia: no se puede prometer "no empeora" sin poder medirlo. Por eso la línea base
de la Parte III está tomada, y por eso `E25` (el panel que la compara) va temprano y no al final.

---

# PARTE II — Cómo se trabaja y se cierra una etapa

## El ciclo

```
ELEGIR UNA ETAPA → ESCRIBIR LA FICHA → IMPLEMENTAR → PROBAR → REVISAR EL DIFF
  → DESPLEGAR → MIRAR 48 h → DETENERSE
```

**Una etapa por vez.** Antes de tocar código se escribe:

```
PROBLEMA:
CAUSA RAÍZ:
GARANTÍA QUE SE AGREGA:
ARCHIVOS QUE SE TOCAN:
CAMBIOS PROPUESTOS:
PRUEBAS QUE SE CREAN:
RIESGOS DE REGRESIÓN:
```

**Después de desplegar, detenerse.** No se pasa automáticamente a la etapa siguiente.

## Criterio de salida

Una etapa **no** está terminada porque compila, porque `tsc` está limpio o porque el bot responde
lindo. Está terminada cuando se cumplen las seis:

1. **`npm test` en verde**, con los fixtures de replay dando **idéntico** antes y después. El motor
   de replay es determinista y no llama a DeepSeek: es la única prueba de no regresión que se puede
   correr todas las veces que haga falta y gratis.
2. **Una prueba nueva** que cubra lo que la etapa cambia o preserva. Una etapa sin prueba nueva no
   dejó nada probado. Para lo que solo cambia el CONTENIDO del turno (un dato que el servidor le
   pone delante al modelo), la prueba es un fixture de replay con `systemMustContain`.
3. **`npx tsc --noEmit` limpio** y `npm run typecheck:all` limpio.
4. **La garantía existe de verdad y no depende solo del modelo.** Se comprueba a mano: ¿qué pasa si
   el modelo no colabora?
5. **Reversión escrita antes de desplegar**, en una línea: qué se revierte, qué migración es
   reversible y cuál no.
6. **48 horas de números contra la línea base** antes de dar la etapa por cerrada, para las etapas
   que cambian algo que el cliente ve.

## Migraciones

Toda migración de este plan es **aditiva**. Columnas y tablas nuevas, valores de enum nuevos. Nada
de `DROP COLUMN` ni de renombrar en la misma migración que cambia código. Cuando una columna queda
obsoleta se deja muerta hasta una limpieza posterior y separada. Una migración que no se puede
revertir sin perder datos no entra.

## Sobre las suites pagadas

`npm run regression` y `npm run test:paid` llaman a DeepSeek de verdad y cuestan plata por corrida.
**Las decide el dueño, siempre.** No se corren mientras se itera, no se corren por iniciativa
propia, y un cambio de CSS nunca las justifica. Para iterar están los fixtures de replay, que son
gratis.

Todo archivo de prueba que llame a DeepSeek de verdad se llama `*Paid.ts`, nunca `*.test.ts`, y va
en el script `test:paid`. Confirmado tres veces en producción: la tercera, una copia COMPILADA en
`dist/` facturó en un `npm test` común.

## Despliegue

Un negocio por vez, nunca global. Primero el piloto (MAGByLizN es el único negocio real conectado
hoy), 48 horas de números contra la línea base, después el resto.

Con el código en `origin`: `git pull --ff-only` en `/opt/vendia`, `npx prisma migrate deploy` si hay
esquema nuevo, `pm2 restart vendia --update-env`, **y recargar nginx después de cada `pm2 restart`**
o las rutas devuelven 502. `pm2` tiene que correr `node --import tsx`; el 2026-09-11 no hacerlo
tumbó producción.

**Sobre las banderas por negocio.** Una bandera (`Business.saleStateEnabled`, `requiredEffectsEnabled`,
`interactiveListsEnabled`) es una columna booleana que enciende una función negocio por negocio.
Sirve cuando el cambio puede salir mal de una forma que solo se ve con tráfico real, porque apagarla
revierte sin desplegar. **No sirve como sustituto de terminar el trabajo**: una etapa que deja su
función apagada esperando que alguien se acuerde de prenderla no está terminada. La regla de este
plan: bandera solo si la etapa cambia algo que el cliente ve **y** el riesgo es de falso positivo
(el sistema bloquea algo legítimo). Para todo lo demás, la etapa sale encendida. Cada ficha dice cuál
es su caso.

---

# PARTE III — Dónde estamos, medido

## La línea base

Producción, MAGByLizN, siete días hasta el 2026-09-17 18:42 UTC. Es contra estos números que se mide
"no empeoró".

| Qué | Cuánto |
|---|---|
| Turnos del agente | **164** |
| Conversaciones tocadas | **84** — 45 `NEW`, 22 `SOLD`, 17 `ABANDONED` |
| Pedidos creados | **22** |
| Conversión real | **26 %** (22 / 84) |
| Incidentes del agente | **95** — 92 `BACKSTOP_INTERVENTION`, 2 `DEGRADED_REPLY`, 1 `EXTERNAL_API_FAILURE` |
| **Intervenciones de respaldo por 100 turnos** | **56** |
| Mensajes de cliente sin ninguna respuesta posterior | **2** |
| Caídas al bloque del servidor (`catalogAuthor`) | 1 de 11 turnos que pasaron por ese camino |
| Fallos de entrega | **9** — 5 con código 131053, 4 con 131047 |
| Costo de IA | **US$ 0,97** en 2.038 llamadas → **US$ 0,0115 por conversación** |

Y dos números de 14 días que salieron el 2026-09-17 revisando dos conversaciones, y que reordenan el
plan:

| Qué | Cuánto |
|---|---|
| Pedidos creados | 22 |
| **Turnos donde el agente llamó `close_conversation`** | **2** |
| **Turnos donde llamó `get_faq`** (con 16 entradas activas) | **0** |

**El bot registra el 9 % de las ventas en las que participa; el resto las cierra la dueña a mano. Y
nunca lee las preguntas frecuentes del negocio.** Las dos son la misma falla: un hecho o un efecto que
solo ocurre si el modelo se acuerda de llamar una herramienta. Las cierran `E09` y `E09b`.

Desglose de los 95 incidentes, que es el mapa de lo que está roto hoy:

| Incidente | Veces | Etapa que lo cierra |
|---|---|---|
| `RESPUESTA_DUPLICADA` | **41** | `E06`, `E07`, `E08` |
| Guard `escalation` reparó una promesa | 11 | `E13` |
| El bot prometió consultar al dueño sin abrir pregunta | 11 | `E13` |
| `VENTA_SIN_PEDIDO` | 6 | `E09` |
| `FOTO_PROMETIDA_SIN_ENVIAR` | 6 | `E10` |
| El backstop de `send_product_media` se saltó un producto | 5 | `E12` |
| Prometió fotos y no las logró mandar | 3 | `E10` |
| Marca de bloque fijo sin resolver | 4 | `E09` |
| `ESCALACION_PROMETIDA_SIN_HERRAMIENTA` | 3 | `E13` |
| DeepSeek falló sin texto de respaldo | 2 | `E24` |
| Failover de modelo | 1 | — (funcionó) |
| El agente escribió datos que no existen | 1 | `E11` |

Lectura corta: **el costo de IA no es un problema** (US$ 0,01 por conversación contra un plan de
COP 36.000 al mes). Lo que está roto es que el bot afirma cosas que no pasaron y que responde dos
veces.

## Los negocios

| Negocio | WhatsApp | `saleStateEnabled` | `requiredEffectsEnabled` | Listas tocables | Fotos |
|---|---|---|---|---|---|
| **MAGByLizN** | **conectado** | **true** | true | true | por categoría |
| Aurora Joyas | no | false | true | false | por producto |
| Boutique Alondra | no | false | true | false | por producto |

**Solo MAGByLizN es real.** Los otros dos son de prueba y no están conectados a WhatsApp. Esto
importa para la regla de despliegue: "por negocio" hoy quiere decir "el piloto", y "global" quiere
decir lo mismo.

> Corrección a los documentos archivados: decían que `saleStateEnabled` estaba apagada en los tres
> negocios. **En MAGByLizN está encendida.** Su causa raíz se encontró y corrigió el 2026-09-16
> (commit `11b277d`): `close_conversation` tomaba los ítems únicamente de `SaleState`, que dependía
> de que el modelo llamara `set_order_item`. Hoy `SaleState` manda cuando tiene líneas y, vacío, los
> ítems se resuelven contra el catálogo igual que con la bandera apagada.

## Lo que ya está construido y no hay que rehacer

Verificado contra el código el 2026-09-17. Los documentos archivados listan varias de estas como
pendientes y ya no lo son:

- Suite de replay determinista (`src/ai/replay/`), 11 fixtures, gratis, sin red a DeepSeek.
- Efectos requeridos (`src/ai/requiredEffects.ts`), encendidos en los tres negocios.
- `SaleState` como estado de venta en curso, y `checkoutState` calculando qué falta.
- Alcance del turno resuelto en código (`resolveProductScope`) y catálogo compuesto por el servidor.
- Un solo autor: el agente escribe, el servidor verifica contra el catálogo.
- `AgentTurn` con herramientas llamadas, alcance, bloques, autor y hallazgos de sombra.
- `AgentIncident` con `guard`, que es lo que permite la tabla de arriba.
- Pedidos por CLIENTE, no por conversación (`customerCommerceState`, `postSale`).
- Precios acordados con el dueño como dato de la base.
- Locale, moneda, zona horaria, país y horario por negocio.
- Modalidades de envío y contraentrega por zona y por ciudad, como datos.
- Cifrado de secretos en reposo (`src/crypto/secretBox.ts`), `helmet`, sesiones en Postgres,
  `SIGTERM` ordenado, `ecosystem.config.js` con `exec_mode: fork` e `instances: 1`.
- CI en GitHub Actions corriendo `npm test`, y `npm run typecheck:all` cubriendo `scripts/`.
- Verificación de firma del webhook, **en modo registro** (falta encenderla: `E26`).
- El archivo viaja a Meta en vez de darle un enlace de S3. El último fallo 131053 por ese motivo fue
  el 2026-09-16 17:56 UTC, antes de ese cambio; no volvió a aparecer.
- El reloj del turno (`src/ai/clock.ts`), commit `1d6bf28`. **Construido, sin desplegar** (`E01`).

## Estado del repositorio al 2026-09-17

Esto no es una etapa: es dónde quedó el árbol, para que una sesión nueva no tenga que deducirlo.

**Ramas.** El trabajo del rediseño del sitio público y del alta vive en `redesign/completo`
(`91bca98`), ya desplegada. Una sesión de nube agregó encima `redesign/completo-afikox`
(`6a961b1`), que es la misma rama más un arreglo de tipos. **Fusionar `completo-afikox` en
`completo` antes de desplegar**, porque el script de despliegue lee `completo`.

**Desplegado en producción:** todo hasta `91bca98`, verificado con `curl` sobre `/health`.

**Construido y NO verificado en producción:** la bandeja "Cuentas esperando activación" de
`/zaqi-admin` (`GET /zaqi-admin/api/pending-activations`,
`POST /zaqi-admin/api/pending-activations/:id/activate`). El código se leyó entero y las dos
escrituras de credenciales de WhatsApp están cubiertas — la del cliente responde 403 mientras
`active` sea false — pero la página nunca se vio renderizada con una sesión real. Falta recorrer
el flujo completo: crear una cuenta sin clave, ver el aviso en el panel, activarla, comprobar que
ya conecta WhatsApp.

**Deriva de esquema encontrada el 2026-09-17** (al generar la migración de `E08`): la base tiene un
índice `Conversation_pendingConfirmationNextAttemptAt_idx` que `schema.prisma` ya no declara, así que
`prisma migrate dev` propone borrarlo en cada migración nueva. Se quitó a mano del SQL de `E08`
—ninguna migración de este plan borra nada— y hay que quitarlo a mano de la siguiente también, hasta
que se decida aparte si el índice se declara de nuevo o se borra en una migración propia.

**Decisión pendiente, sin urgencia:** `POST /auth/request-key` y el modelo `KeyRequest` quedaron
sin uso desde el front el 2026-09-17 — crear la cuenta *es* la solicitud. La sección "Solicitudes
de clave" del panel de plataforma sigue mostrando filas históricas. No se borró nada.

---

# PARTE IV — Las etapas

---

## BLOQUE 1 — El bot deja de decirle cosas falsas al cliente

Es el bloque que más duele hoy: 56 intervenciones de respaldo por cada 100 turnos. Ninguna etapa de
este bloque necesita nada del resto del plan.

---

### E01–E05 · **CERRADAS el 2026-09-17** (commits `1d6bf28`, `de7b3b4`) — sin desplegar

El defecto de Andrés y Ariadna, completo. Se dejan nombradas y no se borran porque el resto del plan
las referencia como dependencia, y porque `E03` corrigió un diagnóstico que este mismo plan tenía mal
escrito.

| | Qué quedó |
|---|---|
| **E01** · El turno lleva reloj | `src/ai/clock.ts`. El instante en la zona del negocio entra en todos los turnos; el historial lleva un marcador por día calendario. La edad del pedido se cuenta en días calendario y no en bloques de 24 h. |
| **E02** · La identidad del cliente entra al turno | `src/crm/customerFacts.ts`. Nombre, documento, teléfono de entrega y dirección, leídos de `Customer`. Sin un solo dato guardado no sale ningún mensaje. |
| **E03** · Un pedido en curso que no existe no se anuncia | `formatSaleStateForPrompt` sale con cero productos elegidos. Y el resumen sembrado de la compra anterior llega al modelo. |
| **E04** · Sale del prompt lo que E02 volvió innecesario | 541 → **540 líneas**. |
| **E05** · La fecha de despacho es un cálculo | `src/shipping/dispatchPromise.ts`, cinco columnas aditivas en `ShippingRate`, con su interfaz en el panel. |

**`E03` corrige el diagnóstico de este plan.** Lo que estaba escrito acá era que al modelo le faltaba
el dato. Medido contra producción, era lo contrario: **se lo dábamos mal.**
`formatSaleStateForPrompt` salía con la condición `items vacíos Y faltan vacío`, que no se cumple
nunca — sin productos elegidos, `computeCheckoutState` siempre lista faltantes. O sea que el bloque
salía SIEMPRE, y el 2026-09-17, con el pedido de Andrés ya despachado, decía:

> PEDIDO EN CURSO: (todavia sin productos). Falta: que producto quieres y cuantas unidades, **tu
> nombre y apellido**, **tu barrio, la direccion exacta, y si es casa o apartamento con piso**, como
> prefieres pagar.

El modelo pidió exactamente eso. **No desobedeció: obedeció un dato falso que le dimos nosotros.**
Es la lección que vale para el resto del plan: antes de culpar al modelo, hay que mirar qué le puso
el servidor delante.

**Lo que quedó fuera de `E04`, y por qué.** La deducción del plan era que había 20 líneas de prompt
para borrar. No las hay: lo que `E02` y `E03` vuelven borrable no estaba en `systemPrompt.ts` sino en
la herramienta `get_previous_conversation` y en las instrucciones del negocio. Salieron como `E05b` y
`E05c`, cerradas el mismo día.

---

### E05b y E05c · **CERRADAS el 2026-09-17** (commit `2468150`)

La contrapartida que `E02` y `E03` habían dejado pendiente: cada hecho que el servidor se lleva borra
una directiva.

| | Qué salió |
|---|---|
| **E05b** | La herramienta `get_previous_conversation`, con su handler, `getPreviousClosedConversation`, sus tres pruebas y la entrada en `TOOL_CALL_LEAK_PATTERN`. Devolvía el resumen de la compra anterior, que ya viaja en cada turno en tres bloques del servidor. Se llamaba 4 veces cada 14 días y cada llamada gastaba una iteración completa del modelo; su esquema viajaba en **cada** petición. |
| **E05c** | El punto 6 de la Etapa 2 de `customInstructions` de MAGByLizN: **17 líneas** que enumeraban a mano los datos de entrega por zona. `computeCheckoutState` ya los calcula. |

Las instrucciones de MAGByLizN: **84 → 67 líneas**, 7.110 → 6.366 bytes. Copia de seguridad en
`/root/customInstructions.backup.1789672430047.txt`.

### Lo que el despliegue encontró (2026-09-17, commit `82a980d`)

`E03` hizo que el resumen sembrado llegara al modelo. Al verificar contra producción, ese resumen
**estaba mintiendo**: de las siete conversaciones que lo tenían, **cuatro** decían *"ese pedido todavía
no ha sido despachado"* sobre pedidos ya en `SHIPPED`, y una decía *"un total de 0 COP"* para un pedido
de 149.000.

`summarizePreviousPurchase` escribía esa frase **una vez**, al crear la conversación, y no se volvía a
tocar. El pedido sí cambia. Se borró entera, y no se reemplazó por una versión que se refresque: lo que
decía ya viaja en cada turno, leído de la base en el momento, en el bloque del pedido cerrado. Las siete
filas viejas se limpiaron.

**La regla que deja, y aplica a todas las etapas que faltan:** un hecho que se escribe una vez y se lee
muchas es un hecho que va a mentir. O se lee de la base en el turno, o no entra. **Y un segundo autor
del mismo hecho solo puede aportar una contradicción** — antes de agregar un bloque, hay que mirar si
otro ya lo dice.

**El prompt del negocio también cuenta.** La medida de la Parte VI mira `systemPrompt.ts`, que es el
texto que comparten todos los negocios. Pero `customInstructions` viaja en cada llamada igual que él, y
en MAGByLizN pesaba más: 84 líneas contra 541. Toda etapa que se lleve un hecho tiene que mirar los dos.

---

### E06 · De dónde sale la respuesta duplicada — diagnóstico, sin cambio de código
**Lectura del código HECHA el 2026-09-17** (hallazgos debajo de la ficha). Falta correr la
clasificación contra producción para cerrarla.

**Quita:** nada todavía. Es la única etapa de lectura del plan, y existe porque el incidente número
uno no tiene causa raíz escrita en ningún lado.
**Porque:** **41 de 95 incidentes en siete días.** El detector
(`src/jobs/conversationHealth.ts:102`) marca dos respuestas `ASSISTANT` con menos de 12 segundos de
diferencia. Las candidatas conocidas son tres y hay que saber cuál es: el lock de conversación en
memoria (`Map` en `src/routes/whatsapp.ts`, que no protege entre procesos ni sobrevive un reinicio),
el `burstBuffer` que tampoco persiste, y la respuesta del modelo saliendo junto con un bloque del
servidor que el detector cuenta como dos.
**Se hace:** se clasifican los 41 casos reales contra `Message`, `AgentTurn` y los reinicios de pm2,
y se escribe el resultado en este archivo, debajo de esta ficha. Nada más.
**Se prueba:** no aplica.
**Tamaño:** S. **Depende de:** nada.
**Vuelta atrás:** no aplica.

#### Lo que encontró la lectura del código (2026-09-17)

**Qué cuenta exactamente el detector.** Dos filas `ASSISTANT` seguidas, ninguna con `mediaType`,
menos de 12 s entre ellas y **sin ninguna fila del cliente en el medio** — cualquier `CUSTOMER`
rompe la adyacencia y el par no se forma (`conversationHealth.ts:95-103`). Eso no es "dos turnos":
es "de este lado salieron dos mensajes seguidos". Todo lo que sigue nace de esa distinción.

**Las tres candidatas, medidas contra el árbol:**

1. **El lock en memoria — no puede producir esta firma hoy.** Tres razones, las tres verificables sin
   base de datos. `ecosystem.config.js` fija `exec_mode: "fork"` + `instances: 1`, así que no existe
   el segundo proceso contra el cual el `Map` no protege. En `withConversationLock`
   (`whatsapp.ts:106-128`) el `get` y el `set` del `Map` ocurren sin ningún `await` en medio, así que
   dos webhooks no pueden leer el mismo `previous`. Y la fila `CUSTOMER` del mensaje entrante se
   graba **adentro** de ese mismo lock (`whatsapp.ts:1045`): un mensaje que llega mientras se está
   generando una respuesta se graba *después* de esa respuesta, así que la secuencia queda `C A C A`
   y nunca forma un par. Lo que el lock no protege es todo lo que nunca se lo pide — punto 4.
2. **El `burstBuffer` — tampoco.** Una ráfaga que se descarga mientras corre otra queda encolada
   detrás del mismo lock, y le suma su ventana de silencio (8 s) más su propia generación antes de
   escribir: el hueco entre las dos filas queda casi siempre por encima de los 12 s que el detector
   mira. Que pierda mensajes en un reinicio es cierto y es el problema que `E08` arregla, pero
   perder no es duplicar: el webhook ya devolvió 200 y Meta no reintenta.
3. **Un turno que escribe varios mensajes — es la única de las tres que produce la firma**, y lo hace
   por dos caminos distintos, los dos a menos de un segundo entre filas:
   - `sendTextInChunks` (`outbound.ts:398`): toda respuesta de más de 700 caracteres sale partida, y
     **cada trozo graba su propia fila** (`recordAs` por trozo, `outbound.ts:405`), con
     `SPLIT_PAUSE_MS = 600` de pausa. Una respuesta larga de tres trozos deja dos pares, no uno.
   - `sendCatalogBlocks` (`catalogBlocks.ts:92`): la frase del modelo sale primero y el bloque
     compuesto por el servidor después, con `BLOCK_GAP_MS = 900` entre bloques, y cada bloque de
     texto graba su fila. Solo ocurre cuando el bloque **no** viajó dentro del mensaje del modelo
     (`AgentTurn.catalogInlined = false`), que es la columna con la que el script de abajo lo
     confirma sin tener que adivinar.

**Una cuarta clase que este plan no listaba: los escritores que nunca piden el lock.** Graban filas
`ASSISTANT` en la conversación del cliente sin pasar por `withConversationLock`, así que pueden caer
al lado de una respuesta del bot: la respuesta del dueño relevada al cliente (`whatsapp.ts:323, 345,
403, 422, 433` — corre en el webhook del teléfono del **dueño**, que es otra conversación y otro
lock), el cierre de venta por confirmación del dueño (`whatsapp.ts:502, 521`), el mensaje manual y la
plantilla del panel (`admin/conversations.ts:247, 359`), los avisos de pedido (`admin/orders.ts:70,
141`), los jobs (`followUp.ts:45`, `abandonment.ts:67`, `escalationReminder.ts`,
`saleConfirmationChaser.ts`) y el drenaje de la cola (`outbound.ts:634`). Para el cliente esto sí es
un mensaje encima de otro — el del dueño es el que se lee contradictorio — pero **no lo arreglan
`E07` ni `E08`**, porque no hay dos turnos compitiendo: hay dos autores distintos.

**Un defecto aparte, encontrado de paso.** `deliverOwnerAnswerToCustomer` (`whatsapp.ts:190`) manda
con `onWindowClosed: "queue"` y **sin** `recordAs`, y el llamador graba la fila igual
(`whatsapp.ts:323, 345, 403, 422, 433`). Si la ventana de 24 h estaba cerrada, el mensaje queda en
cola y, al entregarse, `deliverQueuedItem` lo graba **otra vez** (`outbound.ts:634`): un envío, dos
filas. El detector no lo ve (quedan separadas por minutos u horas), pero el modelo lee esa respuesta
dos veces en el historial. No es de `E06` arreglarlo — queda anotado acá para que no se redescubra.

**Lo que esto le hace a `E07` y `E08`.** Las dos siguen valiendo por lo que dicen quitar: `E07` le
quita al operador ser responsable de no escalar el proceso, `E08` le quita a un reinicio poder
perder una ráfaga. Pero **ninguna de las dos baja el número que este detector reporta**, salvo la
porción que caiga en `DOS_TURNOS`. Si esa porción sale chica contra producción, lo que hay que
cambiar es el detector: estaría contando como incidente algo que el sistema hace a propósito, y un
detector que cuenta lo normal entrena a ignorar lo anormal — el mismo motivo por el que el
2026-09-17 se le sacó el aviso al dueño.

**Lo que falta para cerrar `E06`.** La clasificación contra producción, que no se puede hacer desde
un entorno sin la base: `npx tsx scripts/e06-clasificar-duplicadas.ts` en el droplet (solo lectura,
se puede correr con el bot andando) reconstruye los pares desde `Message` con la regla exacta del
detector y los reparte en `TROZOS`, `BLOQUE_CATALOGO`, `DOS_TURNOS`, `OTRO_AUTOR`, `COLA` y
`UN_TURNO_OTRO`, contrastando contra `AgentTurn.blocks` y `QueuedOutboundMessage`. Los reinicios de
pm2 no están en la base; el script imprime la marca de hora de cada par para cruzarla a mano con
`grep -iE "restart|starting" ~/.pm2/pm2.log`. **La tabla que salga va acá abajo, y con eso la etapa
queda cerrada.**

---

### E07 · El lock de conversación deja de vivir en memoria — **CERRADA el 2026-09-17** (commit `416dce7`), sin desplegar

**Quita:** al operador, ser responsable de no escalar el proceso.
**Porque:** lo que impide hoy que dos instancias dupliquen mensajes a clientes reales es una línea
en `ecosystem.config.js`. El `Map` en memoria no protege entre procesos y se pierde en cada
reinicio; hubo 103 reinicios registrados.
**Se hace:** el `Map` se reemplaza por `pg_advisory_xact_lock(hashtext(conversationId))`. Funciona
entre procesos, se libera solo si el proceso muere, y no necesita Redis.
**Se prueba:** dos procesos contra la misma conversación producen exactamente una respuesta.
**Tamaño:** M. **Depende de:** `E06` (para saber si es la causa). **Bandera:** no.
**Vuelta atrás:** revertir; vuelve el `Map`.

**Lo que quedó** (`src/db/conversationLock.ts`): un lock consultivo de **sesión**
(`pg_advisory_lock` / `pg_advisory_unlock`, espacio de nombres `ONIX`) sobre
`hashtext(conversationId)`, con su propio pool de `pg`.

**No es `pg_advisory_xact_lock`, que es lo que pedía esta ficha.** Un lock de transacción obliga a
tener una transacción **abierta** durante toda la sección crítica, y la sección crítica de un turno
es `generateReply` + el envío: hasta 10 minutos (`STALE_REPLY_MINUTES`). Eso es una transacción
inactiva por minutos y por conversación, con el horizonte de `xmin` congelado y `VACUUM` frenado; y
las transacciones interactivas de Prisma **vencen solas**, así que al vencer sueltan el lock mientras
el turno sigue corriendo. Un lock que se suelta a mitad de la sección crítica es peor que no tener
lock, porque parece que protege. El lock de sesión da la misma garantía entre procesos, tampoco
necesita Redis, y también se libera solo si el proceso muere — porque al morir se cae la conexión,
que es justo lo que la cuarta prueba comprueba.

**La cadena en memoria se queda, con otro trabajo.** No son dos mecanismos para lo mismo: la cadena
garantiza el **orden de llegada** dentro del proceso (el lock no puede: dos llamadas simultáneas
compiten por una conexión del pool, y el orden en que la consiguen no está definido), y el lock
garantiza la **exclusión entre procesos** (la cadena no puede: cada proceso tiene su propio `Map`).

**Se probó** con dos pools distintos, que para Postgres es exactamente lo mismo que dos procesos:
no se solapan en la misma conversación, sí corren en paralelo en conversaciones distintas, una
sección que revienta suelta el lock, y un proceso que muere lo suelta solo.

**Esto no baja el número de `RESPUESTA_DUPLICADA`** — `E06` ya mostró que ese detector cuenta sobre
todo un turno mandando varios mensajes. Lo que quita es la responsabilidad del operador de no
escalar el proceso, que es lo que `E23` necesita para poder separar `web` y `worker`. El comentario
de `ecosystem.config.js` ya dice eso: `instances: 1` sigue ahí porque nada pide todavía dos
procesos, no porque correr dos duplique respuestas.

---

### E08 · La ráfaga no muere con el proceso — **CERRADA el 2026-09-17** (commit `7644d70`), sin desplegar

**Quita:** al operador, que un reinicio pierda los mensajes agrupados.
**Porque:** `burstBuffer` vive en memoria. Un reinicio en medio de una ráfaga la pierde entera, y una
ráfaga a medias es una de las formas en que salen dos respuestas.
**Se hace:** tabla `PendingBurst` con `flushAt`. El drenaje pasa a ser un job con reclamo de fila.
**Se prueba:** tres mensajes en dos segundos producen **una** llamada a `generateReply`, incluso con
un reinicio en el medio.
**Tamaño:** M. **Depende de:** `E06`. **Bandera:** no.
**Vuelta atrás:** revertir el código; la tabla queda muerta.

**Lo que quedó.** Tabla `PendingBurst` (migración `20260917233820_rafaga_persistente`, aditiva: tabla
nueva y dos índices, nada existente se toca) con una fila por mensaje entrante;
`src/conversation/pendingBursts.ts` tiene el encolado, el reclamo y el drenaje, y
`src/jobs/pendingBursts.ts` mira el reloj cada segundo. La ventana de silencio y su tope no cambian
de valor, solo de lugar. `src/whatsapp/burstBuffer.ts` y su prueba se borraron: no los usaba nadie
más.

**Cuatro decisiones que valen más que el código.**
1. El negocio, el cliente y las credenciales **no** se guardan en la fila: se leen de la base al
   contestar. Es la regla que dejó el despliegue de `E01`–`E05c` — un hecho que se escribe una vez y
   se lee muchas es un hecho que va a mentir.
2. El drenaje **arranca** los turnos y no los espera. Esperar uno por uno habría puesto a cada
   cliente en fila detrás del turno más lento de otro negocio, que es justo lo que la versión con
   timers no hacía.
3. Una ráfaga reclamada por un proceso que murió se suelta a los 10 minutos (`STALE_REPLY_MINUTES`).
   Al volver a tomarse, `runGenerateAndSend` la descarta por vieja y pasa la conversación a una
   persona — que es exactamente lo que corresponde con un mensaje de hace diez minutos.
4. Un turno que revienta borra igual su ráfaga. Reintentar después de un envío a medias es como se
   le manda dos veces lo mismo a un cliente.

**El apagado ordenado cambió de sentido.** Ya no fuerza la descarga (arrancar turnos justo antes de
morir era como se quedaban a medias): ahora solo adelanta el `flushAt` de lo pendiente, para que al
volver se drene de una en vez de terminar de esperar una ventana que empezó antes del reinicio.

**Se probó** con 9 pruebas, entre ellas la que pedía la ficha — tres mensajes en dos segundos
producen **una** sola generación, también con un reinicio en el medio — más el reclamo exclusivo
entre dos procesos, el rescate de una ráfaga cuyo proceso murió con el reclamo puesto, y que dos
conversaciones distintas se contestan en paralelo.

---

### E09 · El pedido lo crea el sistema — **CERRADA el 2026-09-17** (commit `f408d6b`), desplegada

**Quitó:** al modelo, decidir si una venta cerrada se registra.

**Lo medido, sobre 14 días de producción:** 22 pedidos creados, y el agente llamó `close_conversation`
en **2** turnos. Las otras 20 las cerró la dueña a mano desde el panel. El caso completo es Carlos
Mendoza (`cmu4e3q9l001ozi2ka2x1t1b1`, 19:27): `SaleState` con el ítem, checkout completo,
Contraentrega, Bogotá, total $94.000, el cliente confirmando — y el bot mandó el texto de cierre
copiado palabra por palabra de la plantilla de la Etapa 3 de `customInstructions`, sin llamar ninguna
herramienta. **Copiar la plantilla no crea nada.**

**Resultó mucho más chica de lo estimado (M, no L), y el porqué vale para el resto del plan.** La
maquinaria estaba entera desde la Fase 2 del plan viejo: reintento con `tool_choice`, fallback por
código (`registerSaleFromServer`, que crea el pedido por el mismo camino que `close_conversation`) y
escalación al dueño. Lo único que faltaba era **el disparador**: el único que existía era "hay una
imagen del cliente sin atender", o sea el comprobante de pago. **Una venta contraentrega no tiene
comprobante**, y contraentrega es la modalidad de la mayoría de las ventas de este negocio.

Disparador nuevo, con las tres condiciones:

- **Determinista:** `SaleState.checkout.completo` más la fecha del último mensaje del cliente. Dos
  `SELECT`, ni una palabra leída.
- **Verificable:** existe o no una fila `Order` para esta conversación.
- **Con fallback sin modelo:** `registerSaleFromServer`, que ya corría para el otro caso.

**El disparador invertido, que es la garantía de que no se registra nada de más:** el turno en el que
el estado se completa **no registra nada**. Recién el siguiente, cuando el cliente volvió a escribir
con el pedido ya armado delante. Así siempre le queda un mensaje entero para decir "esperate, no", y
esa garantía no depende de leerle la respuesta: son dos fechas.

**Verificación en producción antes de que escribiera nadie:** de **62** conversaciones abiertas de
negocios conectados, el efecto dispara en **1** — la de Carlos. Cero colateral.

**De paso, el negocio sembrado dejó de mentir.** `catalog.json` no declaraba `settlement`, así que
Prisma le ponía `PREPAID` por defecto y "Contraentrega" se comportaba como una transferencia, al revés
que en producción. **Una venta contraentrega no se podía probar de punta a punta.** Las dos pruebas
del comprobante ahora fijan una forma de pago prepaga explícita en vez de tomar "la primera activa".

**Lo que queda pendiente de esta etapa:** borrar la plantilla de cierre de la Etapa 3 de
`customInstructions` —la que el modelo copia— y las líneas de la sección "CIERRE" del prompt base.
Va cuando haya 48 h de pedidos creados bien, no antes: hoy esa plantilla es el respaldo.

---

### E09b · La FAQ entra al turno como dato — **CERRADA el 2026-09-17** (commit `cf23211`), desplegada

**Quita:** al modelo, decidir si va a mirar lo que el negocio ya respondió.
**Porque:** medido el 2026-09-17 sobre 14 días: **`get_faq` se llamó 0 veces en 179 turnos.**

MAGByLizN tiene **16 preguntas frecuentes activas**, y **12 salieron del ciclo de aprendizaje** — el
único subsistema que este proyecto tiene funcionando como se diseñó, y el diferenciador que ningún
competidor tiene. **El bot nunca las lee.**

El caso, conversación `cmtxl4534001d8f2k8kie1cdg`, 2026-09-17 18:59. El cliente pregunta *"Dónde se
ubican"*. El turno corre con `iter=1` y **cero herramientas**. El bot contesta:

> "¡Liseth! Esa información no está disponible por el momento. Voy a consultar con el equipo y en un
> momento te respondo."

La FAQ del negocio, en la base, en ese mismo momento:

> **"¿De qué ciudad son ustedes? ¿Tienen tienda física?"** → *"Somos una tienda 100 % virtual ubicada
> en **Bogotá**. Hacemos envíos a todo el país por Interrapidísimo…"*

Dos fallas en una frase: no leyó el dato que tenía, y prometió una consulta que tampoco abrió (eso es
`E13`). La causa de la primera es la de siempre: **un hecho detrás de una herramienta que el modelo
tiene que acordarse de llamar no es un hecho, es una posibilidad.**

**Se hace:** las preguntas frecuentes activas entran como bloque `system`, en todos los turnos, igual
que el catálogo y los datos del cliente. Dato, sin instrucción alrededor. Y se borra `get_faq`.

**El costo está medido y es el argumento:** las 16 entradas son **2.170 caracteres, ~600 tokens**. El
bloque es idéntico turno a turno, así que entra en caché — la tasa de acierto de este negocio es
88 %. Contra eso, cada `get_faq` que el modelo *sí* llegara a llamar gasta una iteración completa del
loop, que cuesta más que el bloque.

**Se prueba:** fixture donde el cliente pregunta algo que está en la FAQ, el turno no llama ninguna
herramienta, y `systemMustContain` encuentra la respuesta delante del modelo.
**Prompt:** se borra la escalera *"revisá catálogo, `get_faq`, formas de pago Y las instrucciones
específicas… recién ahí `ask_owner`"*, que existe entera para ordenar unas llamadas que dejan de ser
necesarias. **−8 líneas**, más la descripción de la herramienta en `tools.ts`.
**Tamaño:** M. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

> **Esto reemplaza a `E60`.** Esa etapa proponía recuperación por relevancia porque `get_faq` devolvía
> la lista entera y no escalaba a 100 entradas. Con 16 entradas y 600 tokens cacheados el problema no
> existe, y la etapa apuntaba a la mitad equivocada: no era que la FAQ llegara grande, era que **no
> llegaba**. La recuperación por relevancia vuelve a hacer falta pasadas las ~80 entradas; queda
> anotada dentro de `E59` como condición de crecimiento, no como etapa propia.

---

### E10 · El envío de fotos afirmado tiene que haber ocurrido

**Quita:** al modelo, poder afirmar un envío que no ocurrió.
**Porque:** `FOTO_PROMETIDA_SIN_ENVIAR` seis veces, más tres de "prometió fotos y no las logró
mandar". `send_product_media` devuelve `sent: false` y el prompt le pide al modelo que lo diga con
sus palabras: la única cosa que impide la afirmación falsa es que el modelo colabore. Además,
`sendCatalogBlocks` ignora el resultado del envío del texto pero igual registra su media como
enviada, así que la deduplicación del turno siguiente la suprime: un fallo se convierte en dos.
**Se hace:** efecto requerido `MEDIA_SENT`. Disparador determinista (el turno llamó
`send_product_media`, o el alcance resuelto trae media). Verificable con una consulta (las filas
`Message` del envío). Fallback sin modelo (o el servidor manda la media él mismo, o el texto que
afirma el envío no sale). Y `sendCatalogBlocks` deja de registrar como enviada una media cuyo envío
falló.
**Se prueba:** fixture donde `send_product_media` devuelve `sent: false` y el texto final no afirma
ningún envío; fixture donde el envío del bloque falla y su media **no** queda registrada.
**Prompt:** `PHOTO_DIRECTIVE_SHARED_TAIL` entera, que existe solo por la ausencia de esta garantía.
**−18 líneas.**
**Tamaño:** L. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir; el efecto sale de la tabla.
**Estado (2026-09-18):** primera parte hecha y sin desplegar (ver abajo). Queda el efecto requerido
`MEDIA_SENT` — con la decisión de arquitectura que también quedó anotada abajo — y el borrado de
`PHOTO_DIRECTIVE_SHARED_TAIL`, que no se puede tocar hasta que la garantía exista.

#### Primera parte HECHA (2026-09-18) — el fallo que se convertía en dos

`sendCatalogBlocks` ignoraba el resultado del envío del **texto** del bloque (el mensaje que lleva los
nombres y los precios) y registraba igual sus productos en `Conversation.browsePhotoProductIds` /
`mediaSentProductIds`. Como `renderCatalog` lee esos campos antes de adjuntar nada, el turno siguiente
suprimía esas mismas fotos: la clienta se quedaba sin el bloque para siempre.

Ahora un bloque cuenta como visto **solo si su texto llegó** — y en el camino de lista tocable, si llegó
la lista o su respaldo numerado. `SaleState.mediaSent` se sigue registrando cuando la foto sale de
verdad, porque es otro hecho: es la evidencia de venta en curso que lee `computeRequiredEffects`, y
perderla apagaría los efectos requeridos.

Tres pruebas nuevas en `src/whatsapp/catalogBlocks.dedup.test.ts`. La del medio **falla contra el código
anterior** y pasa contra el nuevo, comprobado cambiando el archivo por el de `HEAD`.

#### Segundo caso real, 2026-09-18 01:54 UTC — la marca se borra y la promesa se queda

Conversación `cmu6b0uja0028od2ka6c04qol` (Dennis Vanegas). La clienta manda la captura de un reloj. El
bot responde:

> ¡Qué lindo reloj! 😍 Creo que puede ser alguno de estos que manejamos en tono rosado/dorado. Déjame
> mostrarte las opciones que tenemos en ese estilo ✨ / ¿Alguno de estos es el que viste?

Y no salió ninguna opción. Pero acá **sí hubo herramienta**: el turno registra
`toolsCalled: ["search_products"]`, y un `AgentIncident` con guard `fixed_block_missing_data`:

> El bot puso una marca de bloque fijo (catalogo) sin haber llamado la herramienta que la respalda este
> turno - se borro antes de enviar.

Lo que pasó, exacto: el modelo escribió la marca del bloque de catálogo, y `renderFixedBlocks`
(`agent.ts:1414`) la borró porque `customerSentMediaThisTurn` es verdadero y ahí `catalog` se pasa en
`null` a propósito — la regla "una lista nunca es la respuesta correcta a una foto", puesta después del
caso del 2026-09-15/16 (foto de un reloj, respuesta con 11 productos). **Esa regla está bien.**

El defecto es otro y es más chico de lo que parece: **se borra el contenido y sobrevive la frase que lo
anunciaba.** El guard repara la mitad del mensaje. Hoy eso deja un `AgentIncident` y nada más; el
mensaje sale igual, mutilado, y la clienta ve una promesa vacía.

Dos caminos, y los dos están al alcance de esta etapa:

1. Que borrar una marca obligue a rehacer el texto — la misma escalera que ya existe para un precio
   inventado (`enforceAuthoredCatalog`): reintento y, si no, texto del servidor. Hoy esa escalera corre
   para precios y nombres pero no para una marca caída.
2. Que la marca no se borre cuando el turno **sí** resolvió productos concretos. Acá `search_products`
   había devuelto resultados reales (cuatro minutos después, con "G9", salieron las dos fotos del
   *Smartwatch gen 9*): había con qué contestar, y se tiró.

La opción 1 es la garantía; la 2 es la que además le sirve a la clienta. No son excluyentes.

#### Tercer caso, 2026-09-18 ~02:03 UTC — la misma reparación a medias, ahora con el envío

Conversación de Gabriel. Pide envío a **Piedecuesta** y el bot contesta, dos veces:

> 📦 Costo del envío:  *(nada)*
> … el valor del envío a Piedecuesta es de **COP**  *(sin cifra)*

Misma mecánica que el caso anterior, otra marca: `renderFixedBlocks` borra
`SHIPPING_BLOCK_MARKER` cuando `data.shippingRate` es `null` (`agent.ts:751`) y **la frase que lo
anunciaba sobrevive**. Ya van tres marcas distintas —catálogo, envío— con el mismo desenlace, así que
no es un caso: es la forma en que este guard repara.

**Por qué el dato era `null`:** MAGByLizN tiene **148** reglas por ciudad cargadas y Piedecuesta no es
ninguna. `resolveShippingRateForCity` devuelve `null` cuando no hay regla
(`src/catalog/shippingRates.ts:178`), aunque el negocio SÍ tiene cargada una zona que es exactamente la
respuesta para ese caso: *"Municipal (otros municipios de Colombia)"*, $20.900. La dueña, escribiendo a
mano, le cobró $18.500 — o sea Nacional.

Dos arreglos, de tamaños muy distintos:

1. **Sin desplegar, hoy:** cargar Piedecuesta en Envíos > reglas por ciudad. Son datos del negocio, y
   cuál zona le corresponde lo decide la dueña.
2. **Estructural, con `E10`:** una ciudad sin regla no puede terminar en un mensaje mutilado. O hay zona
   por defecto configurada —el catálogo de tarifas ya tiene el "otros municipios" que sirve para eso, lo
   que falta es decir cuál es— o el turno pregunta en vez de afirmar a medias. Lo que no puede seguir
   pasando es que se borre la cifra y quede la frase.

#### El dato de diseño que le falta a esta ficha, medido el 2026-09-18

Antes de construir `MEDIA_SENT` hay que saber esto, porque decide dónde puede vivir la verificación:

**Los medios del catálogo no se envían dentro de `generateReply`.** El alcance se resuelve ANTES de
llamar al modelo (`agent.ts:983`, `resolveProductScope`), los bloques se componen ahí mismo
(`renderCatalog`, `agent.ts:1002`), y `generateReply` los **devuelve** — quien los manda es el llamador
(`routes/whatsapp.ts` → `sendCatalogBlocks`), ya fuera del turno. La escalera de efectos requeridos
(`runTurnWithRequiredEffects`) corre dentro de `generateReply`, así que **no puede verificar contra la
base que esos medios salieron: todavía no salieron.**

Solo los medios de `send_product_media` se envían dentro del turno.

O sea que `MEDIA_SENT` no es un efecto más de la misma lista. O la verificación se mueve al llamador
(después de `sendCatalogBlocks`, que es donde el hecho ya es cierto o falso), o los bloques pasan a
enviarse dentro del turno. Es una decisión de arquitectura, no un detalle de implementación, y conviene
tomarla escrita antes de tocar `requiredEffects.ts`.

#### Caso real que le AMPLÍA el disparador (2026-09-18, reportado por el dueño)

Conversación `cmu69ybx60001od2kurx01zha`, MAGByLizN, 2026-09-18 01:23 UTC. La clienta escribe, manda
una foto de un producto que no está en el catálogo, y el bot contesta:

> ¡Con mucho gusto! 😊 Aquí te dejo nuestro catálogo por categorías para que veas las opciones:

Y no llegó nada. Los tres `AgentTurn` de esa conversación, tal cual:

```
01:23:22  toolsCalled: []  scope: "none"  blocks: []  catalogInlined: false
01:23:38  toolsCalled: []  scope: "none"  blocks: []  catalogInlined: false
01:23:43  toolsCalled: []  scope: "none"  blocks: []  catalogInlined: false
```

No falló ningún envío: **nunca hubo envío**. El modelo no llamó ninguna herramienta y el servidor no
compuso ningún bloque, así que la frase salió sola. Cero `AgentIncident`: ningún respaldo lo vio.

**Por qué esta ficha, como está escrita, no lo atrapa.** El disparador de `MEDIA_SENT` es "el turno
llamó `send_product_media`, o el alcance resuelto trae media". Acá `toolsCalled` está vacío y `scope`
es `none`: no hay disparador, así que el efecto nunca se exige. El agujero es justo el peor caso — el
modelo que promete **sin llamar nada** es el que ninguna verificación anclada a la llamada puede ver.

**Repro local, determinista, sin red a DeepSeek** (base local, modelo mockeado devolviendo esa misma
frase y cero `tool_calls`; el único cambio entre los dos turnos es lo que dijo la clienta):

```
A - la clienta pide el catalogo ("muestrame todo el catalogo completo con precios")
  toolsCalled: []   scope: all:2   bloques: 2   catalogo real en la salida: SI
B - caso Viviana (la clienta no pidio nada en ese turno)
  toolsCalled: []   scope: none    bloques: 0   catalogo real en la salida: NO
```

O sea: **la garantía existe y funciona, pero cuelga del texto de la clienta, no de lo que el bot
prometió.** `resolveProductScope` mira lo que ella escribió; si ahí no hay pedido de catálogo, no hay
bloque, y la prosa del modelo queda sin nadie detrás. El caso B es exactamente la pantalla que reportó
el dueño.

**Qué implica para el diseño de esta etapa.** El disparador no puede salir de lo que el modelo hizo
(llamó o no llamó) ni de una expresión regular sobre su prosa — eso último es parche explícito según la
Parte I. Tiene que salir del estado, que es consulta: *esta conversación no tiene catálogo enviado y la
clienta preguntó qué venden*. Con eso, el bloque lo compone el servidor tanto en A como en B, y la
promesa nunca puede quedar sola.

**Y hay un segundo defecto encima, de otra familia.** Ese turno de las 01:23:43 salió **sin ningún
mensaje nuevo de la clienta**: el último es la imagen de las 01:23:36. El bot le contestó a su propia
pregunta ("¿Te gustaría que te muestre lo que tenemos?" → "¡Con mucho gusto!"). Dos `ASSISTANT`
seguidas, 5 s, sin nada de la clienta en medio, ninguna con media: la firma exacta que cuenta el
detector de `E06`. No hay `AgentIncident` en esa conversación, y falta mirar si el job ya había corrido
sobre esa ventana antes de darlo por defecto del detector.

Los tres mensajes cortos que se ven después en la pantalla ("hola nena si sra", "35 mil", "pillo
secador") **no son del bot**: la conversación tiene `humanControl: true` y es la dueña escribiendo desde
el panel. Eso funcionó como debe.

---

### E11 · Un color que no existe no sale

**Quita:** al modelo, decidir qué atributos del producto son ciertos.
**Porque:** `verifyAgainstCatalog` tiene exactamente dos tipos de hallazgo: `precio_inexistente` y
`producto_inexistente`. **Ningún color, ninguna variante, ningún stock.** El agente puede escribir
"lo tenemos en naranja" y el mensaje sale sin que nada lo mire. Pasó una vez en los últimos siete
días ("el agente escribió datos que no existen") y el caso histórico es "Serie 12 Ultra 3 en
naranja".
**Se hace:** tercer tipo de hallazgo, `atributo_inexistente`: todo color o talla en posición de
atributo de un producto en alcance se compara contra las variantes reales. Se reusan
`canonicalColors` y `attributeTaxonomy`, que ya existen; **cero expresiones regulares nuevas**. Pasa
por la misma escalera que ya funciona para precios: un reintento diciéndole cuál atributo no existe
—dato de la comparación, nunca de leer su prosa— y si vuelve a fallar sale el bloque del servidor con
los colores reales.
**Se prueba:** fixture donde el modelo escribe un color inexistente y sale el bloque del servidor.
**Prompt:** sin cambios directos; habilita el borrado de `E12`.
**Tamaño:** M. **Depende de:** nada. **Bandera:** **sí** — sale en modo sombra primero, con la tasa
de falsos positivos medida 48 h. Un color legítimo marcado por error le llega al cliente.
**Vuelta atrás:** apagar la bandera.

**Estado (2026-09-18): implementada, sin desplegar, y APAGADA en los tres negocios.**

- Tercer tipo de hallazgo, `atributo_inexistente`, en `src/catalog/outputValidation.ts`. La comparación
  reusa `canonicalColors`: cero expresiones regulares nuevas, como pedía la ficha. Si una palabra no está
  en ese diccionario, no es un color para nadie en este repositorio.
- Los colores reales de un producto salen de **tres** lugares, los tres de la base: sus variantes,
  `Product.color`, y su propio nombre — el servidor mismo escribe "Smartwatch hello plum (Negro)", así
  que ese negro es tan real como el de la columna. Sin esa tercera fuente, el validador marcaría los
  bloques del propio servidor, que es el falso positivo que ya pasó con los nombres decorados el
  2026-09-16.
- Los colores se buscan en **todas** las líneas, no solo en las que llevan precio: *"sí, lo tenemos en
  naranja"* no lleva ninguna cifra y es justo la frase del caso histórico.
- Lados conservadores, explícitos: una línea que no nombra ningún producto se compara contra los colores
  de TODO el negocio (un color que sí maneja en otro producto no se marca), y un producto sin colores
  cargados no marca nada — eso es un hueco de catálogo, no una invención comprobable.
- `Business.attributeCheckEnabled`, aditiva y en `false`, con su interruptor en el panel (Bot > ajustes).
  Con la bandera apagada el hallazgo **igual se registra** en `AgentTurn.shadowFindings`: así es como se
  miden las 48 h que la ficha exige antes de encenderla en un negocio real.
- Seis pruebas nuevas en `src/catalog/outputValidation.test.ts`, todas sobre el núcleo puro.

**Lo que NO cubre, y por qué.** Las **tallas** quedan fuera. No existe taxonomía de tallas, y escribir
una sería exactamente el error contra el que advierte `attributeTaxonomy.ts`: un vocabulario fijo que
solo le sirve a una vertical. Una talla se vería como un dato por negocio (como `CategoryAlias`), y eso
es una etapa propia, no un renglón de esta.

---

### E12 · La foto es del producto del que se está hablando

**Quita:** al modelo, de qué producto son los archivos que salen.
**Porque:** "el backstop de `send_product_media` se saltó un producto", 5 veces en siete días. Y el
fixture `y1iz5l-foto-no-converge`, turnos 43 y 45: el modelo llamó la herramienta, las fotos **sí**
salieron — de otro producto. La clienta pedía un reloj y recibió audífonos; en el otro turno, la
variante plateada en vez de la negra. El bot tuvo que autocorregirse delante de ella.
`send_product_media` valida que el producto **exista**, nunca que sea el producto **del que se está
hablando**: esa correspondencia vive solo en la descripción de la herramienta.
**Se hace:** el `productId` se compara contra la unión de tres conjuntos que escribió el servidor: el
alcance resuelto del turno, `Conversation.lastPresentedProductIds`, y los ítems del pedido en curso.
Lo mismo con `variantId`. **El lado seguro es explícito:** si no hay ninguna de las tres fuentes
—conversación nueva, producto que nunca se listó— no hay contra qué validar y **no se bloquea nada**.
Una venta no se frena por una duda nuestra.
**Se prueba:** **`y1iz5l-foto-no-converge` sale de `knownFailing` y queda en verde.** Es el criterio
de salida. Más un fixture donde el cliente nombra un producto que nunca se listó y el envío **sí**
sale.
**Prompt:** las dos frases de "el producto DEL QUE SE ESTÁ HABLANDO AHORA" en
`PHOTO_DIRECTIVE_REACTIVE` y `PHOTO_DIRECTIVE_AUTO`, más el paréntesis equivalente en la descripción
de la herramienta. **−4 líneas.**
**Tamaño:** M. **Depende de:** `E10`. **Bandera:** no — el lado seguro ya no bloquea.
**Vuelta atrás:** revertir.

#### Caso real 2026-09-18 01:59 UTC — y por qué esta ficha, sola, NO lo atrapa

Conversación de Gabriel. Manda la foto de un reloj **redondo y compacto** con el texto *"Este por favor
costo y especificaciones"*. Lo que pasó, con los tiempos de la base:

```
01:59:48  VISION            deepseek-v4-flash-vision-exp
01:59:52  VISION_ESCALATION claude-sonnet-5
02:00:15  turno: search_products, get_product_details, get_product_details
02:00:01-02:00:12  salen 5 archivos: video + foto del Serie 12 Ultra 3, y 2 fotos del Combo T2000 Ultra
02:00:17  "Los dos modelos que más se parecen a lo que muestras en la captura son estos"
02:00:29  turno: ask_owner_about_photo   -> PendingOwnerQuestion PHOTO_PRODUCT
02:01:00  "Según nuestro equipo, el producto que buscas es: Serie 11 Mini"
```

Los dos candidatos que eligió son de 49 mm, deportivos y robustos. El real era el **Serie 11 Mini**,
compacto y elegante — lo dijo la dueña 30 segundos después. **La visión sí corrió**, y sí escaló a
`claude-sonnet-5`: no falló por falta de modelo, falló el emparejamiento contra el catálogo.

**Lo que esta ficha valida no alcanza.** `E12` compara el `productId` contra el alcance del turno,
`lastPresentedProductIds` y los ítems del pedido. Acá no había ninguna de las tres cosas — conversación
recién empezada, nada listado antes — y su propio lado seguro dice, con razón, que sin fuentes **no se
bloquea nada**. Así que `E12` dejaría pasar exactamente este caso.

**El defecto tiene forma propia: el ORDEN.** El bot mandó cinco archivos de dos productos equivocados
**antes** de preguntarle a la dueña, y catorce segundos después le preguntó. Hizo lo correcto, tarde y
después de haber inundado a la clienta con lo que no era.

La garantía que falta es de secuencia, y es verificable: **en un turno que nace de una foto del cliente,
no sale media hasta que haya UNA coincidencia confiable o hasta que la dueña conteste.** "Los dos que
más se parecen" no es una identificación: es una duda, y una duda se le pregunta a quien sabe, no se le
despacha al cliente en cinco mensajes. El disparador es estado puro (`Message.mediaType = IMAGE` en este
turno, `PendingOwnerQuestion` abierta o no), sin leer una sola palabra de la prosa.

Es la misma familia que el fixture `y1iz5l-foto-no-converge`, que sigue en `knownFailing` con la nota de
que el defecto real es el emparejamiento semántico y que no tenía fase asignada. Ya la tiene: acá.

---

### E12b · La foto del cliente se compara contra el catálogo, no contra los nombres

**Quita:** al modelo, tener que adivinar cuál producto es, a partir de una prosa que nadie puede
verificar.

**Porque:** el caso del reloj redondo (arriba, en `E12`) no falló por falta de modelo — la visión corrió
y escaló a `claude-sonnet-5`. Falló porque **lo que se compara hoy no tiene con qué acertar**. La cadena
completa, leída del código el 2026-09-18:

1. `getCatalogHintText` (`catalog/products.ts:435`) le manda a la visión **solo los nombres y las
   categorías** de hasta 40 productos. Sin descripciones, sin colores, sin forma y **sin las fotos del
   catálogo**.
2. La visión devuelve prosa libre: *"reloj inteligente dorado, pantalla redonda, correa de eslabones"*.
3. Esa prosa la usa el modelo para llamar `search_products`, que puntúa por coincidencia de palabras
   contra el NOMBRE del producto.

La palabra que importaba —**redondo**— no está en ningún nombre del catálogo. Los nombres dicen "Serie
12 Ultra 3 (Edición Deportiva / Robusta)" y "Serie 11 Mini (Edición Compacta y Elegante)". Lo único que
podía enganchar era "reloj/smartwatch", que lo comparten todos. **El dato que distinguía al producto
nunca participó de la comparación**, en ninguno de los dos lados.

**Se hace,** en tres pasos que se pueden desplegar por separado:

**Paso 1 — la visión ELIGE, no describe.** El contexto que recibe pasa a ser el catálogo con su
descripción y su id, y la respuesta obligatoria es `PRODUCTO_ID: <id>` o `POCO_CLARO`. El servidor
verifica que ese id exista antes de usarlo. Desaparece el paso con pérdida —prosa → `search_products`—
que es donde hoy se rompe. Tamaño S.

**Paso 2 — cada foto del catálogo tiene su ficha visual, hecha por el mismo modelo.** Las fotos ya están
en S3. Se corre la MISMA visión una vez por foto de producto y se guarda su descripción estructurada en
la base. A partir de ahí, la foto de una clienta se compara contra descripciones **del mismo modelo y
del mismo vocabulario**, en vez de contra un nombre comercial: "redondo" contra "redondo". Se recalcula
solo cuando la foto cambia, así que son unas decenas de llamadas una vez por negocio, no una por
consulta. Tamaño M.

**Paso 3 — lo que se ve es un dato del catálogo.** Forma, color, correa, tamaño aparente, como atributos
por negocio (el mismo patrón de `CategoryAlias`: vocabulario del negocio, nunca cableado por vertical —
ver la advertencia de `attributeTaxonomy.ts`). La visión los devuelve estructurados y el emparejamiento
pasa a ser una **consulta**: "reloj + redondo" deja un producto, no dos de 49 mm. Tamaño M.

**Las tres reglas de admisión.** (1) Le quita al modelo la decisión de cuál producto es, y se la da a una
comparación contra la base. (2) Se verifica con una consulta: el `productId` elegido existe y sus
atributos coinciden con los que devolvió la visión. (3) Si el proceso muere, no se pierde nada: las
fichas visuales del paso 2 son cache reconstruible, y sin ellas el sistema cae al camino de hoy.

**Lo que no reemplaza:** la garantía de secuencia de `E12` sigue haciendo falta. Un emparejamiento mejor
va a fallar menos, no cero, y mientras dude la respuesta correcta sigue siendo preguntarle a la dueña
antes de mandar nada.

**Se prueba:** el fixture `y1iz5l-foto-no-converge` en verde; y una prueba con dos productos que solo se
distinguen por un atributo visual, donde el emparejamiento devuelve uno solo.
**Tamaño:** L en total, S + M + M por paso. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir por paso; sin las fichas visuales el sistema vuelve al camino de hoy.

#### Paso 2 HECHO (2026-09-18), sin desplegar

- `ProductMedia.visionDescription` + `visionDescriptionAt`, aditivas y nullable (migración
  `20260918130000_ficha_visual_de_la_foto`). Una foto sin ficha simplemente no participa del
  emparejamiento y el turno queda como antes: la etapa no puede quitar nada.
- `src/ai/photoIndex.ts` describe cada foto del catálogo con el **mismo** modelo de visión que mira la
  foto del cliente, y con un prompt **paralelo** al de `visionPrompt.ts` — mismas facetas, mismo orden,
  mismas palabras. Que los dos lados hablen el mismo idioma es la etapa entera; con vocabularios
  distintos volveríamos a comparar entre idiomas.
- Se calcula **al subir la foto**, sin `await`: la dueña no espera a un modelo para ver su foto cargada,
  y si falla la rellena `npx tsx scripts/index-catalog-photos.ts`, que es idempotente y solo toca las que
  están en null.
- `src/catalog/visualIndex.ts` es la comparación, **pura**: sin base, sin red, sin modelo. Puntúa sobre
  los tokens de la foto DEL CLIENTE (no sobre la unión), así que una ficha larga no gana por tener más
  palabras; se queda con la **mejor foto** de cada producto, así que tener cinco cargadas no es ventaja;
  y exige piso (`0.34`) **y margen sobre el segundo** (`0.15`).
- **La duda se devuelve como duda.** Con dos candidatos pegados no elige: marca `ambiguous` y el servidor
  le pone al turno *"NO pudo distinguir entre X y Y"*. Es literal lo que falló el 2026-09-18, cuando el
  bot mandó "los dos modelos que más se parecen".
- Lo que el servidor agrega al turno es un **hecho** ("corresponde a X (productId: …)"), nunca una
  instrucción. Qué hacer con una duda sigue siendo conversación.

Nueve pruebas en `src/catalog/visualIndex.test.ts`, todas sobre el núcleo puro, **incluida la del caso
real**: la descripción del reloj redondo resuelve al Serie 11 Mini y no a los dos deportivos de 49 mm.

**Al desplegar:** `npx tsx scripts/index-catalog-photos.ts` una vez. Sin eso, las fotos ya cargadas no
tienen ficha y el emparejamiento no tiene contra qué comparar. Son ~39 fotos en MAGByLizN, una llamada de
visión cada una (~USD 0,01), y se paga una sola vez por foto, no una por consulta.

**Siguen pendientes el paso 1** (que la visión elija un `productId` real en vez de describir al aire) **y
el paso 3** (forma/color/correa como atributos por negocio).

---

### E13 · Prometer consultar al dueño abre una consulta de verdad

**Quita:** al modelo, poder decir "voy a consultar con el equipo" sin que exista una consulta.
**Porque:** es el segundo incidente por volumen: **11 veces** el guard `escalation` reparó una
promesa, **11 veces** el bot prometió consultar sin abrir ninguna pregunta real, **3** más de
`ESCALACION_PROMETIDA_SIN_HERRAMIENTA`. Son 25 en siete días. Hoy lo repara un regex sobre la prosa
que el modelo ya escribió (`ESCALATION_CLAIM_PATTERN`), que es la clase de guard que no converge.
Fixture `igmt9z` en `knownFailing` por esto. Caso nuevo del 2026-09-17, conversación `cmtxl4534001d8f2k8kie1cdg`:
el cliente preguntó "Dónde se ubican" y el bot contestó *"Voy a consultar con el equipo y en un momento
te respondo"* — turno con **cero herramientas llamadas**, así que no hubo consulta ninguna. Y la
respuesta estaba en la FAQ (ver `E09b`).
**Se hace:** el efecto no puede ser "prometió → crear pregunta" (disparador de prosa, inadmisible).
Se invierte: mientras el negocio no tenga el dato, las herramientas que necesitan ese dato devuelven
error con el motivo, y el servidor inserta un bloque fijo. El modelo no tiene qué prometer porque ya
tiene la respuesta real. `ask_owner` sigue siendo la única puerta, y el recordatorio al dueño escala
a un tercer aviso y a las 48 h marca la conversación con prioridad alta en el panel.
**Se prueba:** `igmt9z` sale de `knownFailing`. Cero llamadas a `ask_owner` disparadas por texto.
**Prompt:** cae el guard `escalation` completo con su patrón; la sección de `ask_owner` se reduce.
**−12 líneas.**
**Tamaño:** L. **Depende de:** `E09`. **Bandera:** sí — cambia lo que el cliente ve cuando el negocio
no sabe algo.
**Vuelta atrás:** apagar la bandera.

---

## BLOQUE 2 — Nada se pierde en silencio

Hoy hay 2 mensajes de cliente sin respuesta en siete días, 103 reinicios registrados y una cola de
salida que se envenena sin avisar. El bloque termina con "turnos perdidos = 0, y medible".

---

### E14 · Un job que revienta no deja sin atender a los demás negocios

**Quita:** al operador, tener que descubrir a mano que un job dejó de correr.
**Porque:** `escalationReminder`, `saleConfirmationChaser`, `tokenExpiry` y `conversationHealth`
recorren negocios en un bucle sin `try/catch` por ítem: un solo `throw` aborta la pasada y deja sin
atender a todos los negocios restantes. Son justo los cuatro que manejan plata y caídas.
**Se hace:** `try/catch` por ítem en los cuatro, con el error registrado y la pasada siguiendo.
**Se prueba:** un negocio que tira en el ítem 1 no impide que se procese el ítem 2.
**Tamaño:** S. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E15 · Reservar, enviar, confirmar

**Quita:** al sistema, poder marcar como avisado algo que no se avisó.
**Porque:** `tokenExpiry.ts` marca "ya avisé" aunque el aviso haya fallado, y es la compuerta de un
aviso por ciclo. Un envío fallido significa que al dueño **nunca** se le avisa y el bot se apaga el
día 60 sin que nadie lo sepa.
**Se hace:** se invierte el orden en los jobs que tienen compuerta: reservar, enviar, confirmar.
**Se prueba:** con el envío mockeado en fallo, la marca no queda puesta y el ciclo siguiente
reintenta.
**Tamaño:** S. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E16 · El webhook recorre el lote completo

**Quita:** al sistema, descartar mensajes sin dejar rastro.
**Porque:** `src/routes/whatsapp.ts` lee solamente `entry[0]`, `changes[0]`, `messages[0]` y
`statuses[0]`. Todo mensaje adicional del mismo lote se descarta en silencio. Es una sola función y
no necesita esperar a `E20`.
**Se hace:** bucle sobre `entry[] → changes[] → messages[] + statuses[]`.
**Se prueba:** un lote con tres mensajes produce tres turnos.
**Tamaño:** S. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E17 · Una foto de más de 5 MB no se intenta enviar

**Quita:** al operador, descubrir por el reclamo del cliente que una foto nunca salió.
**Porque:** dos fallos 131053 en siete días con el mensaje exacto *"Image file has size 6303812 bytes
but must be atmost 5242880 bytes"*. Es una foto del catálogo que ya está en S3 pesando de más: el
tope de subida ya se alineó, pero las que entraron antes siguen ahí.
**Se hace:** el tamaño se verifica contra el límite real de WhatsApp antes de intentar el envío. Si
pasa, se reduce al vuelo o se marca el producto en el panel con el motivo. El dueño ve cuáles son
sus fotos pesadas, con enlace a arreglarlas.
**Se prueba:** un archivo por encima del tope no produce una llamada a Meta.
**Tamaño:** M. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

**Estado (2026-09-18): DESPLEGADA**, commit `198981d`, en producción a las 20:1x UTC con tráfico en
cero (decisión del dueño: se esperó a que no hubiera flujo). Faltan las 48 h contra la línea base;
hasta entonces no se da por cerrada.

Al desplegar se midió el catálogo entero de producción: **39 medios, ninguno por encima del tope**, y
los 39 quedaron con su peso guardado. Las dos fotos de 6.303.812 bytes que aparecen en el log del
2026-09-16 ya no están en el catálogo — alguien las reemplazó. O sea que hoy la garantía es preventiva:
lo que cierra no es un incendio activo sino la clase de error, que es de lo que se trataba.

Lo que se construyó:

- `ProductMedia.bytes`, columna aditiva y nullable (migración `20260918110000_peso_del_medio_en_la_base`).
  El peso deja de ser un `HeadObject` a S3 por archivo y pasa a ser un `SELECT`. `null` significa
  "todavía no se midió", nunca "está bien".
- Se llena al subir (`uploadMedia` devuelve `bytes`, `addProductMedia` lo exige) **y solo**, la primera
  vez que se manda un archivo viejo: `resolveSendableMedia` ya baja los bytes de S3 para subírselos a
  Meta, así que medirlos no cuesta ni una llamada extra. El catálogo viejo se mide con el tráfico real,
  sin que nadie tenga que acordarse de correr nada.
- `unsendableReason` en `src/media/oversizedMedia.ts`: la decisión pura, un solo lugar, el mismo que ya
  compartían el tope de subida y el listado.
- `resolveSendableMedia` devuelve `{ ok: false, reason }` y **nada llega a Meta**: ni el id ni el link.
  Esto es lo que faltaba de verdad — el respaldo al link de S3, que protege a todos los demás casos,
  para un archivo pesado devolvía el camino viejo y volvía a producir el 131053 asíncrono.
- El envío se detiene y queda registrado como `DeliveryFailure` con el motivo, así que aparece en
  **Bot > Salud** en vez de solo en el log.
- El turno **no** se cae por eso. Un archivo que WhatsApp no acepta es un dato malo del catálogo, no una
  falla del sistema: viaja como `UnsendableMediaError`, `send_product_media` lo devuelve como
  `{ sent: false, reason }` y el modelo sigue la conversación sabiendo que esa foto no salió. Cortar el
  turno habría dejado a la clienta peor que antes de la etapa (antes recibía el texto y solo perdía la
  foto), y la regla de no regresión lo prohíbe.
- El panel marca la miniatura en rojo con "no se envía" y pone el motivo arriba de la galería del
  producto. El motivo lo calcula el servidor: copiar el tope al JS del panel habría creado una segunda
  lista de "qué archivo sirve", que es el defecto que el tope de subida vino a cerrar.
- `scripts/list-oversized-media.ts` ahora también guarda el peso mientras lista, para medir el catálogo
  entero de una sin esperar al tráfico. Sigue sin tocar nada en S3.

Pruebas nuevas: 4 en `src/media/oversizedMedia.test.ts` (el motivo, el masculino del video, el que cabe,
el no medido) y 4 en `src/whatsapp/productMedia.test.ts` (ninguna llamada a la red, el fallo de entrega
con el motivo, que un archivo sin medir no se bloquea, y que la herramienta devuelve `sent: false` en vez
de tumbar el turno). `npm test`: 883 pruebas, 881 en verde, 0 en rojo, 2 `todo` — las dos fixtures de
replay que ya estaban en `knownFailing`. Los 11 fixtures de replay dan idéntico.

Lo que queda de `E17`: mirar 48 h de números contra la línea base (fallos de entrega con código 131053
por tamaño, que tienen que ser cero) antes de darla por cerrada.

---

### E17b · Lo que manda el panel también viaja hacia Meta

**Quita:** al sistema, depender de que Meta pueda descargar una URL nuestra.
**Porque:** `E17` y el cambio del 2026-09-17 sacaron el link de S3 del camino del bot, pero no del
camino del panel. Cuando la dueña adjunta una foto, un video o un documento desde el chat
(`src/routes/admin/conversations.ts`) o al marcar un pedido como despachado
(`src/routes/admin/orders.ts`), lo que sale sigue siendo la URL firmada para que Meta la descargue —
exactamente el paso que producía `131053 Downloading media from weblink failed with http code 500`
(cinco veces en la línea base). La nota de voz de ese mismo formulario ya viaja como bytes hacia Meta
desde que existe, así que el camino correcto ya está probado al lado del que falta.
**Se hace:** el archivo se le sube a Meta y viaja un id, igual que los del catálogo pero **sin caché**:
un adjunto del panel se manda una sola vez y no tiene fila donde guardar el id. Si la subida falla, se
cae a la URL de siempre, así que solo puede mejorar la entrega. `sendImageMessage`/`sendVideoMessage`/
`sendDocumentMessage` ya aceptan id o link y deciden por la forma (`isUploadedMediaId`), así que no
cambia ninguna firma.
**Se prueba:** con la subida a Meta mockeada, lo que la ruta le entrega al envío es un id (y por tanto
sale como `{ id }`, no como `{ link }`); con la subida fallando, sigue siendo la URL de S3.
**Tamaño:** S. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir; el envío vuelve a mandar el link.

**Estado (2026-09-18): implementada, sin desplegar.** `uploadOnceToWhatsapp` en
`src/whatsapp/mediaUpload.ts`, usada por los dos adjuntos del panel. La nota de voz no cambió: ya
viajaba como bytes. Dos pruebas nuevas en `src/whatsapp/mediaUpload.test.ts` (el id, y el respaldo
cuando Meta rechaza la subida). `npm test` completo antes de desplegar.

---

### E18 · Fuera de la ventana de 24 h se manda plantilla

**Quita:** al sistema, intentar un envío que Meta va a rechazar.
**Porque:** cuatro fallos 131047 en siete días — *"Message failed to send because more than 24 hours
have passed"*. La ventana se verifica en algunos caminos y no en todos.
**Se hace:** `src/whatsapp/outbound.ts`, punto único de envío. Verifica la ventana **siempre**, cae a
plantilla cuando está cerrada, pone `timeout` explícito en `callGraphApi`, y ramifica por
`error.code` de Meta: **131047** ventana, **131050** opt-out, **190** token expirado, **429** límite
de tasa, **132018** formato de plantilla. Una prueba de arquitectura hace `grep` para que no quede
ninguna llamada directa a `whatsapp/client.ts` fuera de ahí.
**Se prueba:** `fetch` mockeado devolviendo cada código, con la decisión correcta en cada uno.
**Tamaño:** L. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** la capa nueva delega en las funciones viejas; se desactiva la política y queda el
paso directo.

---

### E19 · El token de WhatsApp avisa antes de vencerse

**Quita:** al operador, tener que acordarse de una fecha.
**Porque:** el token expira a los 60 días y el bot queda mudo sin aviso. No hay columna de
expiración ni detección del error 190. Es el riesgo con más probabilidad del inventario, porque es
una fecha y no un evento.
**Se hace:** columna `whatsappTokenExpiresAt`, alerta al dueño y a Zaqi a 7 días, y detección del
error 190 para marcar la conexión como caída en el panel.
**Se prueba:** con la fecha a 6 días, el job manda exactamente una alerta.
**Tamaño:** M. **Depende de:** `E18`. **Bandera:** no.
**Vuelta atrás:** revertir; la columna queda muerta.

---

### E20 · El mensaje entrante existe aunque el proceso muera

**Quita:** al webhook, decidir en memoria y sin red de seguridad si un mensaje del cliente existe.
**Porque:** el webhook responde `200` antes de procesar y Meta no reintenta. La deduplicación por
`wamid` ocurre después de haber pagado descarga de medios, subida a S3, visión y transcripción. Con
103 reinicios registrados, cada uno pudo comerse un turno. Hoy hay 2 mensajes sin respuesta en siete
días; sin esto, ese número no se puede llevar a cero ni garantizar.
**Se hace:** tabla `InboundEvent { id, businessId, wamid @unique, kind, payload, status, attempts,
lockedUntil, lastError, receivedAt, processedAt }`. El webhook se reduce a tres pasos: validar
firma, insertar **todos** los elementos del lote, responder 200. Nada más: sin descargas, sin
modelo, sin S3. El `wamid @unique` hace la idempotencia **antes** de gastar.
**Se prueba:** reenviar el mismo `wamid` dos veces no dispara una segunda descarga de medios.
**Tamaño:** L. **Depende de:** `E16`. **Bandera:** no.
**Vuelta atrás:** revertir; la tabla queda muerta y el webhook vuelve a procesar en línea.

---

### E21 · El consumidor, el reintento y la carta muerta

**Quita:** al sistema, perder un evento sin que nadie se entere.
**Porque:** es la otra mitad de `E20`. Sin consumidor, la tabla solo acumula.
**Se hace:** consumidor con `SELECT ... FOR UPDATE SKIP LOCKED`, reintento acotado con espera
creciente, y una fila muerta **visible en el panel** en vez de un mensaje perdido en silencio. Mismo
criterio que ya tiene `QueuedOutboundMessage`.
**Se prueba:** matar el proceso con `SIGKILL` en medio de un turno; al reiniciar, el turno se
reprocesa y el cliente recibe respuesta.
**Tamaño:** L. **Depende de:** `E20`. **Bandera:** no.
**Vuelta atrás:** revertir junto con `E20`.

---

### E22 · Un turno perdido deja de ser invisible

**Quita:** al operador, tener que descubrir a mano que un cliente se quedó sin respuesta.
**Porque:** hoy nada detecta una ausencia. `conversationHealth` detecta respuestas duplicadas y
promesas incumplidas, pero no el silencio. El número de arriba (2 en siete días) salió de una
consulta escrita a mano para este plan, no de ninguna alerta.
**Se hace:** job de reconciliación que busca conversaciones con un mensaje de `CUSTOMER` sin
respuesta de `ASSISTANT` pasados N minutos, y reencola o escala. Arranca con una ventana amplia,
para no contestar algo de hace horas como si fuera nuevo.
**Se prueba:** una conversación con un mensaje sin respuesta aparece en la métrica y se reencola.
**Tamaño:** M. **Depende de:** `E21`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E23 · Dos procesos: `web` y `worker`

**Quita:** al operador, que escalar el proceso duplique mensajes a clientes reales.
**Porque:** hoy `instances: 1` es lo único que lo impide. Además, `saleConfirmationChaser` corre cada
60 segundos con un bucle secuencial sin tope, y una pasada que tarde más de 60 segundos se pisa a sí
misma.
**Se hace:** dos entradas en `ecosystem.config.js` sobre el mismo código: `web` (HTTP + Socket.IO) y
`worker` (el consumidor de `InboundEvent` más los jobs). Cada job toma su trabajo con
`FOR UPDATE SKIP LOCKED` y `lockedUntil`. El breaker de `modelFailover` sale de memoria a una tabla,
para que los dos procesos compartan la decisión. Entran `uncaughtException` y `unhandledRejection`,
que hoy no existen en ninguna parte.
**Se prueba:** dos `worker` levantados, un cliente recibe exactamente una respuesta y un dueño
exactamente una confirmación.
**Tamaño:** L. **Depende de:** `E07`, `E21`. **Bandera:** no.
**Vuelta atrás:** volver a una sola entrada en `ecosystem.config.js`.

---

### E24 · `/health` deja de mentir y `/metrics` existe

**Quita:** al operador, tener que hacer `grep` en `pm2 logs` para saber si algo se rompió.
**Porque:** `/health` responde sano mientras todos los jobs revientan, mientras las credenciales de
Meta están vencidas y mientras el proveedor de IA está en enfriamiento. Y hubo 2 `DEGRADED_REPLY` en
siete días que nadie vio pasar.
**Se hace:** `/metrics` en formato Prometheus (turnos, latencia por etapa, fallos de entrega,
incidentes por tipo, profundidad de colas, costo por negocio) y `/health` de verdad (base,
profundidad y antigüedad de las colas, credenciales de Meta por negocio, estado del breaker). Log
estructurado con `pino`, con `requestId`, `businessId`, `conversationId` y `turnId` en cada línea.
**Se prueba:** con un job caído, `/health` devuelve el estado degradado y nombra cuál.
**Tamaño:** M. **Depende de:** `E23`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E25 · El panel compara contra la línea base

**Quita:** a todos, que "no empeoró" sea una opinión.
**Porque:** el único detector de una regresión conversacional hoy es una persona leyendo
conversaciones. La línea base de la Parte III se tomó a mano con consultas escritas para este plan.
Sin un panel, se vuelve a tomar a mano cada vez.
**Se hace:** una vista que muestre los mismos números de la Parte III, con la comparación contra la
línea base y alertas por umbral: crecimiento de `AgentIncident`, tasa de caída al fallback del
validador, cola estancada, token por vencer.
**Se prueba:** los números del panel coinciden con las consultas de la Parte III.
**Tamaño:** M. **Depende de:** `E24`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

## BLOQUE 3 — El borde y las llaves

Ninguno de estos riesgos se materializó todavía. Van después del Bloque 2 porque el Bloque 2 arregla
cosas que ya están pasando, pero `E26` es la más urgente de todo este bloque.

---

### E26 · La firma del webhook deja de ser opcional

**Quita:** a la seguridad, depender de que alguien se acuerde de poner una variable de entorno.
**Porque:** la verificación está construida y corriendo **en modo registro**: `.env` en producción no
tiene `WEBHOOK_SIGNATURE_ENFORCE`. Cualquiera que conozca un `phone_number_id` puede inyectar
mensajes de cliente falsos, gastar el presupuesto de IA del negocio y disparar creación de pedidos.
**Se hace:** 48 h mirando el log en modo registro para confirmar que todas las entregas reales
validan. Después se pone `WEBHOOK_SIGNATURE_ENFORCE=true` en el servidor y, en un commit aparte, se
elimina la variable del código: la firma se valida siempre. Un negocio sin `appSecret` pasa a ser un
error de arranque, no un caso permitido en caliente — **se verifican los `appSecret` de todos los
negocios antes de quitar la bandera**.
**Se prueba:** una petición sin firma devuelve 401.
**Tamaño:** S (el encendido) + S (la limpieza). **Depende de:** nada. **Bandera:** es la bandera; se
va con la etapa.
**Vuelta atrás:** volver a poner la variable en `false`.

---

### E27 · Nadie lee lo que no es suyo

**Quita:** a las rutas, confiar en el id que viene en la URL.
**Porque:** `src/routes/admin/conversations.ts` no valida `req.params.id` contra el negocio en una de
sus rutas, como sí hacen las otras cinco del mismo archivo. Y `whatsappConnect.ts`, `catalog.ts` y
`orders.ts` tienen rutas sin `requireOwner`.
**Se hace:** validación por `getConversationForBusiness` en la ruta que falta, `listQueuedOutbound`
recibiendo `businessId`, y `requireOwner` donde corresponda.
**Se prueba:** leer desde el negocio A una conversación del negocio B devuelve 404.
**Tamaño:** S. **Depende de:** **`D5`** — dónde va `requireOwner` depende de qué puede hacer el rol
`EMPLOYEE`. La parte del IDOR no depende de nada y puede salir sola.
**Vuelta atrás:** revertir.

---

### E28 · Borrar un miembro le cierra la sesión

**Quita:** al operador, que quitarle el acceso a alguien no surta efecto hasta que expire su sesión.
**Porque:** hoy no existe `sessionVersion` en ningún modelo. Borrar o desactivar un `TeamMember` no
mata sus sesiones vivas.
**Se hace:** `TeamMember.sessionVersion` y `Business.sessionVersion`; `requireAuth` compara la
versión de la sesión contra la actual; borrar o desactivar incrementa. Regeneración de sesión en
cada login.
**Se prueba:** borrar un miembro invalida su sesión en la petición siguiente.
**Tamaño:** M. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir; las columnas quedan muertas.

---

### E29 · El login de plataforma y los límites de tasa

**Quita:** a la plataforma, tener una contraseña en texto plano en el entorno.
**Porque:** `src/routes/platformAdmin.ts` compara contra texto plano, sin límite de tasa ni bloqueo
por intentos, y no hay ninguna auditoría de qué hizo un administrador de plataforma.
**Se hace:** contraseña en `bcrypt`, comparación de tiempo constante, el mismo limitador que
`authRouter`, bloqueo por intentos, y tabla `PlatformAuditLog` con actor, negocio afectado y momento.
Límite de tasa global por IP y por negocio en `/admin/api/*`, incluidas las subidas de archivo y
`improve-instructions`, que gasta en IA. Normalización de correo a minúsculas con migración de datos.
`TeamMember` chequeado en el registro, para que registrar un negocio con el correo de un miembro
existente deje de bloquear a esa persona para siempre.
**Se prueba:** una prueba por punto.
**Tamaño:** L. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E30 · Un secreto corrupto no tumba la plataforma

**Quita:** al sistema, que una fila mala deje sin servicio a todos los inquilinos.
**Porque:** `decryptSecret` en `src/db/client.ts` no está dentro de `try/catch`. Una fila con texto
cifrado corrupto hace que `findMany` lance y caiga todo para todos.
**Se hace:** `try/catch`; devuelve `null` y se marca en una columna `secretsBroken`, visible en el
panel.
**Se prueba:** una fila con `whatsappAccessToken` corrupto no impide listar negocios.
**Tamaño:** S. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

---

## BLOQUE 4 — El pedido es una máquina de estados

---

### E31 · Estados reales y transiciones permitidas

**Quita:** al panel y a las rutas, poder sobrescribir el estado de un pedido desde cualquier lado.
**Porque:** hoy son tres estados, y `ConversationIntent` ya tiene `DEVOLUCION` y `NO_RECIBIDO` sin
nada del lado del pedido que los represente. El panel puede cancelar un pedido ya enviado y
re-enviar uno cancelado.
**Se hace:** `PENDING_PAYMENT | PAID | PREPARING | SHIPPED | DELIVERED | CANCELED | RETURNED |
REFUNDED`. Un solo módulo de transición, `src/orders/stateMachine.ts`, con la tabla de transiciones
permitidas; `markOrderShipped` y `markOrderCanceled` dejan de ser `update` sueltos. Tabla
`OrderEvent` con actor (usuario, agente, job), estado anterior, estado nuevo, motivo y momento: hoy
no hay ningún campo que registre quién envió o quién canceló. Migración aditiva; los pedidos
existentes se mapean al estado equivalente.
**Se prueba:** una transición prohibida devuelve un error claro en el panel, no un silencio.
**Tamaño:** L. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir el código; el enum queda con valores de más, que es aditivo.

---

### E32 · Cancelar devuelve el stock

**Quita:** al inventario, perder unidades para siempre.
**Porque:** el stock se descuenta en la venta pero **no vuelve al cancelar**: cada cancelación
destruye unidades. Y el descuento no tiene condición `stock >= cantidad`, así que un negocio puede
vender más de lo que tiene y enterarse cuando se le acabe físicamente.
**Se hace:** `{ decrement }` con condición dentro de la transacción; `StockReservation` con
vencimiento mientras la venta está en curso; devolución automática al cancelar.
**Se prueba:** cancelar un pedido devuelve exactamente las unidades que descontó.
**Tamaño:** M. **Depende de:** `E31`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E33 · La plata es `Decimal` de punta a punta

**Quita:** al código, mezclar punto flotante con dinero.
**Porque:** es `Decimal` en Postgres y punto flotante en todos los caminos de código. Además
`Product.currency` tiene `USD` por defecto contra `Business.currency` en `COP`.
**Se hace:** una clase `Money` y cero `Number(...)` sobre precios. Un pedido con monedas mezcladas se
rechaza en vez de sumar números sin significado.
**Se prueba:** prueba de arquitectura que hace `grep` de `Number(` sobre los módulos de precio.
**Tamaño:** M. **Depende de:** `E31`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E34 · Cancelar nunca ocurre en el mismo turno en que se pide

**Quita:** al modelo, que la confirmación de cancelación dependa de que recuerde preguntar.
**Porque:** hoy la confirmación la sostiene una directiva del prompt. El disparador correcto **no**
es "el cliente pidió cancelar" —eso es leer prosa y el plan no lo admite— sino la llamada a
`cancel_order` sobre un pedido abierto, que es un evento estructurado.
**Se hace:** la primera llamada no cancela: escribe `Order.cancelRequestedAt` (columna aditiva,
nullable) y devuelve el pedido para que el agente pregunte. Una llamada posterior cancela **solo** si
`cancelRequestedAt` es anterior al arranque del turno actual, o sea si hubo un mensaje del cliente en
el medio. La solicitud se limpia al final de cualquier turno que no la use. El fallback no tiene
modelo adentro: si nada pasa, el pedido sigue vivo, que es el estado seguro. Y `cancel_order` pasa a
recibir un id, no "el último pedido del cliente".
**Se prueba:** la prueba existente `"cancel_order cancels a pending order and notifies the owner"`
**cambia de contrato** y hay que reescribirla — por eso esta etapa necesita decisión (`D2`).
**Prompt:** la sección `CANCELAR UN PEDIDO` entera. **−3 líneas.**
**Tamaño:** M. **Depende de:** `E31`, **`D2`**. **Bandera:** no.
**Vuelta atrás:** revertir; la columna queda muerta.

---

### E35 · El pedido sabe dónde está

**Quita:** al dueño, tener que contestar "¿dónde está mi pedido?" a mano.
**Porque:** no hay `trackingNumber`, `carrier`, `estimatedDelivery`, `paymentStatus`,
`paymentReference`, `taxAmount` ni `discountAmount`. La pregunta más común después de la venta hoy
es imposible de responder.
**Se hace:** las columnas, el formulario en el panel, y la herramienta que las lee. Con la UI en la
misma etapa.
**Se prueba:** fixture donde el cliente pregunta por su envío y el bot responde con la guía real.
**Tamaño:** M. **Depende de:** `E31`, `E05`. **Bandera:** no.
**Vuelta atrás:** revertir; las columnas quedan muertas.

---

## BLOQUE 5 — El negocio expresa lo que vende de verdad

---

### E36 · Una talla XL puede costar más que una S

**Quita:** al catálogo, obligar a un precio único por producto.
**Se hace:** `ProductVariant.price` opcional, con caída al precio del producto. Panel en la misma
etapa.
**Se prueba:** un pedido de la variante cara cobra el precio de la variante.
**Tamaño:** M. **Depende de:** `E33`. **Bandera:** no; sin precios por variante se comporta como hoy.
**Vuelta atrás:** revertir; la columna queda muerta.

---

### E37 · Una promoción es un dato, no una frase

**Quita:** al modelo, tener que recordar un descuento que alguien mencionó.
**Porque:** hoy un descuento del negocio no existe como dato. `AgreedPrice` se queda como está: es
otra cosa, un acuerdo puntual con un cliente, no una promoción del negocio.
**Se hace:** `Promotion` (porcentaje o monto, vigencia, alcance producto/categoría/global, mínimo de
cantidad, código opcional) y herramienta `get_active_promotions`. Panel en la misma etapa.
**Se prueba:** fixture con una promoción vigente y otra vencida.
**Tamaño:** M. **Depende de:** `E36`. **Bandera:** no.
**Vuelta atrás:** revertir; la tabla queda muerta.

---

### E38 · Un combo es un producto, no prosa en una descripción

**Quita:** al catálogo, esconder un combo dentro de un campo de texto.
**Porque:** hoy un combo es prosa en `description`, y el propio código documenta que eso ya rompió la
búsqueda por color.
**Se hace:** `Bundle`, un producto compuesto por ítems reales del catálogo, con su propio precio.
**Se prueba:** la búsqueda por color deja de devolver el combo por las palabras de su descripción.
**Tamaño:** M. **Depende de:** `E37`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E39 · El envío se resuelve por zona, no por nombre exacto de ciudad

**Quita:** al dueño, que renombrar una tarifa deje ciudades sin regla en silencio.
**Porque:** `ShippingCityRule.label` no es clave foránea real: renombrar una tarifa convierte en
silencio una ciudad configurada en "sin regla". Y la coincidencia es por nombre exacto de ciudad.
**Se hace:** zonas jerárquicas (país, departamento, ciudad), `label` pasa a clave foránea real,
tarifas por peso y volumen, y umbral de envío gratis. Panel en la misma etapa.
**Se prueba:** renombrar una tarifa no deja ninguna ciudad huérfana.
**Prompt:** `SHIPPING_RATES_DIRECTIVE` entera, que existe porque la tabla de tarifas vive en prosa
dentro de `customInstructions`. **−30 líneas.**
**Tamaño:** L. **Depende de:** `E05`. **Bandera:** no.
**Vuelta atrás:** revertir; migración aditiva.

---

### E40 · Peso, dimensiones, SKU e impuesto

**Quita:** al bot, no poder contestar "¿cuánto pesa?".
**Se hace:** atributos físicos en el producto, e impuesto como línea propia del total, configurable
por negocio. Panel en la misma etapa.
**Se prueba:** el total con impuesto cuadra al centavo.
**Tamaño:** M. **Depende de:** `E39`, `E33`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

## BLOQUE 6 — El CRM alimenta la conversación

`E02` ya se llevó lo más urgente de este bloque. Lo que queda es lo que el sistema guarda y no usa.

---

### E41 · `CustomerStage` la calcula el servidor

**Quita:** a la configuración, un campo que nadie escribe.
**Porque:** `CustomerStage` está prácticamente muerto: nada escribe jamás `COMPRADOR` ni
`RECURRENTE`. Los 84 clientes tocados en siete días están todos en `NUEVO`, incluidos los que ya
compraron.
**Se hace:** `NUEVO | INTERESADO | COMPRADOR | RECURRENTE | INACTIVO`, derivada de pedidos y
actividad, recalculada en cada cierre de pedido y por el job diario.
**Se prueba:** un cliente con un pedido cerrado queda en `COMPRADOR` sin que nadie lo toque.
**Tamaño:** S. **Depende de:** `E02`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E42 · El consentimiento de datos, decidido

**Quita:** al proyecto, una decisión que bloquea una mejora visible desde hace semanas.
**Porque:** es `D1`. Sin resolverla, `E02` no puede salir encendida en un negocio real.
**Se hace:** campo `customerDataPolicy` por negocio con tres valores: guardar en silencio, guardar
con aviso una vez, preguntar siempre. Panel en la misma etapa. La opción que exige la ley colombiana
es la del aviso único, y cuesta un mensaje extra por conversación.
**Se prueba:** fixture por cada uno de los tres valores.
**Tamaño:** M. **Depende de:** **`D1`**. **Bandera:** es la política; no hace falta otra.
**Vuelta atrás:** revertir; la columna queda muerta.

---

### E43 · Las notas del dueño que se pueden compartir

**Quita:** al dueño, que lo que anota de un cliente no le sirva al bot.
**Porque:** `CustomerNote` y `tags` nunca entran a ningún prompt.
**Se hace:** una bandera por nota: compartible o privada, explícita en el esquema. Las compartibles
entran a `customerFacts`. Las privadas siguen siendo privadas.
**Se prueba:** una nota privada no aparece en el contexto del turno.
**Tamaño:** S. **Depende de:** `E02`, `E42`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E44 · Reposición

**Quita:** al dueño, tener que acordarse de quién ya necesita repetir la compra.
**Se hace:** si el cliente compró algo marcado como consumible hace más de su ciclo estimado, ese
hecho entra en el contexto. **El agente decide si lo menciona. El servidor no manda un mensaje por
su cuenta.**
**Se prueba:** el hecho aparece en el contexto y no genera ningún envío automático.
**Tamaño:** M. **Depende de:** `E43`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E45 · La Bandeja y el hilo paginan por cursor

**Quita:** al panel, traer todo a memoria en cada carga.
**Porque:** `GET /admin/api/customers` trae **todas** las conversaciones del negocio con su último
mensaje y las agrupa en memoria; `getCustomerThreadForBusiness` carga **todos** los mensajes de un
ciclo. Con el volumen de hoy no se nota; con cientos de clientes sí.
**Se hace:** el patrón de cursor que ya está resuelto y probado dos veces en el repositorio
(`listCustomersForBusiness`, `listConversationsForBusiness`). **La parte que no es mecánica:** los
handlers de Socket.IO hacen `document.querySelector` directo sobre el DOM renderizado y hay que
decidir qué pasa cuando la fila que cambió no está en la página cargada — ver `D7`.
**Se prueba:** con 500 conversaciones sembradas, la primera carga trae una página.
**Tamaño:** L. **Depende de:** **`D7`**. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E46 · `PUT /api/business` admite payloads parciales

**Quita:** al frontend, tener que mandar el objeto entero para cambiar un campo.
**Porque:** varios campos usan `x || null` y `Boolean(x)`: con un payload parcial, omitir un campo lo
pondría en `null` o en `false` en vez de dejarlo como está. Es el prerrequisito para partir el
guardado por sección.
**Se prueba:** un `PUT` con un solo campo no toca ningún otro.
**Tamaño:** S. **Depende de:** nada. **Bandera:** no.
**Vuelta atrás:** revertir.

---

## BLOQUE 7 — El panel se ve como el diseño

Siete fases del rediseño, cada una su propia rama y su propio PR. **Una por sesión**: `admin.js` pesa
164 KB y `admin/index.html` 47 KB. `src/ai/*` no se toca en ninguna, y un cambio de CSS nunca
justifica `npm run regression`.

Checklist al cerrar cada una: el `grep` de color literal sale vacío; se ve bien en claro **y** en
oscuro; el chrome no se duplicó; cero emoji como iconos; los números usan `.onix-num`; toque mínimo
de 44 px en móvil; `npx tsc --noEmit` limpio; `npm test` solo al cerrar; y la auditoría responsive
(`node design/audit-responsive.mjs`) a 360/390/768/1024/1440.

---

### E47 · Exportar los PNG del diseño a `design/onix-a/`

**Quita:** a las siete fases siguientes, tener que trabajar contra una descripción en vez de contra
la pantalla.
**Porque:** el directorio `design/onix-a/` **no existe**. Cada fase del rediseño exige mirar el PNG
de su pantalla, y sin eso ninguna se puede hacer bien.
**Se hace:** exportar los 22 artboards del lienzo con el nombre de la pantalla (`inicio.png`,
`crm-bandeja.png`, …). **Lo hace el dueño, no el código.**
**Tamaño:** S. **Depende de:** nada — es lo primero de este bloque.

---

### E48 · El `grep` de color literal entra a CI

**Quita:** al revisor, tener que acordarse de correr el `grep`.
**Porque:** `.github/workflows/test.yml` corre `npm test` pero no el `grep` de color literal ni
`tsc --noEmit`. Es la única regla del rediseño que necesita vigilancia automática.
**Se hace:** los dos pasos en el workflow.
**Tamaño:** S. **Depende de:** nada.

---

### E49 · Fase CRM del rediseño

Bandeja en dos paneles, Clientes como tabla con cabecera, Pedidos con el total a la derecha.
**Tamaño:** L — es la más larga, y va en tres commits. **Depende de:** `E47`.

### E50 · Fase Catálogo

Formulario a la izquierda (520 px fijos), grilla a la derecha. Las variantes de color llevan muestra
circular, no solo texto. **Tamaño:** M. **Depende de:** `E47`.

### E51 · Fase Bot

Personalidad, Reglas, FAQ, Pagos, Envíos, Canales, Salud. Los checkboxes pasan a switches. Salud
reutiliza las tarjetas de métrica de Inicio. **Tamaño:** M. **Depende de:** `E47`, `E25`.

### E52 · Fase Negocio y Analytics

**Acá hay trabajo real, no solo estilos: las tablas planas pasan a barras.** Embudo por estado
(barras horizontales proporcionales al máximo), mensajes por día (barras agrupadas, dos series),
productos más consultados (una serie). Series desde `--onix-series-*`, validadas para daltonismo en
los dos temas. **Un valor de 0 no dibuja barra, ni un pixel.** Dos series o más llevan leyenda
siempre. Tooltip al hover. **Nunca dos ejes Y.** **Tamaño:** L. **Depende de:** `E47`.

### E53 · Fase Auth

`login.html`, `signup.html`, `forgot-password.html`. Campos de 46 px, botón de 48 px, panel derecho
con la demo de conversación. **Tamaño:** M. **Depende de:** `E47`.

### E54 · Fase Landing en oscuro

`public/index.html`. Mismo `tokens.css`, mismo toggle, mismo `localStorage`, para que el tema viaje
de la landing al panel. La estructura no se toca. **Tamaño:** S. **Depende de:** `E47`, **`D8`**.

### E55 · Fase Marca

SVG nuevo en `public/img/` y `favicon.ico` a 16/32/48 con la versión simplificada. **Tamaño:** S.
**Depende de:** **`D9`**.

---

## BLOQUE 8 — Aprende solo

Es el subsistema que **ya rinde**: 12 de las 24 entradas de FAQ activas salieron de él, con solo 3
descartes. Y es el diferenciador que ningún competidor tiene. Está a mitad de camino.

---

### E56 · Lo que el dueño contesta a mano deja de tirarse — **CERRADA el 2026-09-17** (commit `7803a93`), sin desplegar

**Quita:** al sistema, destruir la evidencia más valiosa que produce.
**Porque:** cuando el dueño responde a mano desde el panel, ese par pregunta/respuesta se pierde: no
se llama `recordAskOwnerResolution` (su único invocador en todo `src/` es `whatsapp.ts:280`) y
`clearPendingOwnerQuestionsForConversation` **borra la fila**. Es más volumen y mejor contexto que la
escalación por WhatsApp. Hoy no solo no se aprende: se destruye.
**Se hace:** el panel llama `recordAskOwnerResolution` con la pregunta del cliente y la respuesta del
dueño, y el `PendingOwnerQuestion` se marca resuelto en vez de borrarse.
**Y hay una segunda consecuencia, medida el 2026-09-17, que nadie había conectado: borrar esa fila hace
que el bot repita mensajes.**

Conversación `cmu4xfymx00bxq92kb1aj3iil` (Maira Rodríguez). La clienta mandó una foto a las 02:56
preguntando *"¿Es ese el mismo?"*. El 17 a las 19:38 el bot llamó `ask_owner_about_photo` y le mandó la
identificación: *"Según nuestro equipo, el producto que buscas es: Reloj … Serie 12 Ultra 3 - $140000
COP"*. A las 19:42, ante un simple *"Ok" / "Si señora"*, **mandó exactamente el mismo mensaje otra vez**.

El mecanismo, exacto: `ownerWasNotifiedSince` prueba que una imagen quedó atendida contando filas de
`PendingOwnerQuestion` posteriores a ella. Cuando el dueño responde, esa fila **se borra**. Sin fila, la
imagen del 02:56 queda "sin atender" **para siempre**, y cada turno siguiente vuelve a exigir el efecto
`OWNER_NOTIFIED_ABOUT_IMAGE`, vuelve a forzar `ask_owner_about_photo` y vuelve a mandar la respuesta
guardada. En esa conversación `PendingOwnerQuestion` está en **0** y `humanControl` en **true**: la dueña
tuvo que tomar el control y no lo devolvió.

O sea que esta etapa no es solo "no perder el dato del aprendizaje": **es la causa de un defecto que el
cliente ve hoy.** Marcar la fila como resuelta en vez de borrarla arregla las dos cosas con el mismo
cambio.

**Se prueba:** una conversación con toma de control manual genera un candidato. Y: contestada la
pregunta del dueño, un turno posterior **no** vuelve a exigir el efecto ni a reenviar la respuesta.
**Tamaño:** S. **Depende de:** nada. **Es el ítem de mejor relación valor/tamaño de todo el plan**, y
desde el 2026-09-17 además corrige un defecto visible.
**Vuelta atrás:** revertir.

**Lo que quedó.** Columna `resolvedAt` en `PendingOwnerQuestion` (migración
`20260917235030_pregunta_resuelta_no_borrada`, aditiva). Resolver marca y ya no borra:
`clearPendingOwnerQuestion` pasó a `markPendingOwnerQuestionResolved` y
`clearPendingOwnerQuestionsForConversation` a `markConversationOwnerQuestionsResolved`, porque los
nombres viejos ya no dirían la verdad. El panel, al mandarle un mensaje de **texto** al cliente,
llama `recordAskOwnerResolution` con ese texto como respuesta; una plantilla no, porque una plantilla
no es la respuesta del dueño a nada y ensuciaría la FAQ.

**La parte peligrosa no es marcar: es que "abierta" siga significando abierta** ahora que las filas
no desaparecen. Llevan `resolvedAt: null` las cinco consultas que lo significan (preguntas abiertas
por conversación y por negocio, el recordatorio, el timeout, y la que matchea la respuesta citada del
dueño) y el conteo que libera `blockedBy`. **La única que no filtra es `ownerWasNotifiedSince`, a
propósito**: ahí la pregunta no es "¿sigue abierta?" sino "¿se le avisó al dueño?", y avisado sigue
avisado después de contestar. Esa distinción es toda la corrección del defecto visible.

**Se probó** con 6 pruebas nuevas, incluida la que pedía la ficha (contestada la pregunta, un turno
posterior ya no vuelve a exigir el aviso por la imagen ni a reenviar la respuesta) y la del panel
dejando un candidato de FAQ. Cuatro pruebas existentes afirmaban que la fila **se borraba**: es el
contrato que esta etapa cambia a propósito, y pasaron a afirmar `resolvedAt`.

---

### E57 · El borrador de la FAQ se escribe solo

**Quita:** al dueño, tener que reescribir a mano lo que dijo por WhatsApp.
**Porque:** **es la causa real de que las primeras 12 entradas salieran mal.** El candidato se guarda
literal ("Estamos en Bogotá Linda") y el panel le pide al dueño que lo reescriba, cosa que no hace.
**Se hace:** una sola llamada al modelo **en el momento de sugerir** (no por mensaje) que normalice
la pregunta, pase la respuesta a voz de política y saque nombres y números. Se muestra como borrador
editable.
**Se prueba:** el borrador sugerido no contiene nombres propios ni números de una persona.
**Tamaño:** M. **Depende de:** `E56`. **Bandera:** no.
**Vuelta atrás:** revertir; vuelve el texto crudo.

---

### E58 · La deduplicación y el umbral dejan de fallar en los dos sentidos

**Quita:** al sistema, fusionar preguntas distintas y duplicar la misma.
**Porque:** el solapamiento de ≥2 tokens **por substring** fusiona "¿Hacen envíos a Cali?" con
"¿Hacen envíos a Medellín?" porque comparten *hacen* y *envíos*; y dos parafraseos del mismo tema no
comparten nada y se duplican. Al fusionar, **la respuesta nueva se descarta**: gana la primera para
siempre. Y `MIN_OCCURRENCES_TO_SUGGEST = 2` cuenta cuántos clientes preguntaron, no cuántas veces el
dueño confirmó la misma respuesta.
**Se hace:** la deduplicación se resuelve en la misma llamada de `E57`. El umbral pasa a exigir ≥2
clientes distintos **y** respuestas del dueño concordantes. Al fusionar se conserva la respuesta
nueva.
**Se prueba:** los dos casos de arriba, como pruebas puras.
**Tamaño:** M. **Depende de:** `E57`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E59 · La FAQ tiene contador de uso y fecha de revisión

**Quita:** al dueño, no poder saber si una FAQ sirvió, y tener una promesa vieja viva para siempre.
**Porque:** `FaqEntry` no tiene contador de uso, ni vínculo al candidato de origen, ni `updatedAt`,
ni fecha de revisión. Una FAQ aprendida de "envío gratis" queda para siempre.
**Se hace:** contador de uso, vínculo al candidato, y fecha de revisión con recordatorio para las
entradas con precios o promociones, que `learnedFaqQuality.ts` ya sabe detectar.
**Se prueba:** el contador sube cuando el modelo usa la entrada.
**Condición de crecimiento (heredada de la retirada `E60`):** mientras la FAQ activa quepa en el
bloque de `E09b` no hace falta recuperación. Pasadas las ~80 entradas deja de caber y hay que
recuperar por relevancia; el contador de uso de esta etapa es justo el dato que dice cuáles conservar.
**Tamaño:** M. **Depende de:** `E58`. **Bandera:** no.
**Vuelta atrás:** revertir; las columnas quedan muertas.

---

### E60 · ~~`get_faq` por relevancia~~ — **RETIRADA**, la reemplaza `E09b`

Proponía recuperación por relevancia porque `get_faq` volcaba la lista entera. Medido el 2026-09-17,
el problema era el contrario: **`get_faq` se llamó 0 veces en 179 turnos**, y la lista entera son 600
tokens que caben cacheados en cada turno. `E09b` mete la FAQ como dato y borra la herramienta.

Lo único que sobrevive de esta etapa es la condición de crecimiento, anotada en `E59`: pasadas las
~80 entradas el bloque deja de caber y ahí sí hace falta recuperación.

La otra mitad —sacar la intercepción de FAQ del loop, que gasta una iteración y obliga a llamar
`ask_owner` dos veces— **se hace en `E13`**, que es donde vive la escalación.

---

## BLOQUE 9 — Buscar bien y vigilar

---

### E61 · Recuperación semántica del catálogo

**Quita:** al modelo, recibir el catálogo entero para elegir a ojo.
**Porque:** `searchProducts` carga todos los productos activos a memoria y los puntúa en JavaScript,
hasta tres veces por turno; si no encuentra nada, devuelve el catálogo completo. No hay tolerancia a
errores de tipeo — el código documenta un fallo real en producción ("micrófonos" por "audífonos") que
solo atrapó el modelo. Y medido: el fallback de catálogo completo pesó **18.812 caracteres
(~4.700 tokens)** en un solo tool-result, más que el prompt base entero.
**Se hace:** `pgvector` en la base que ya existe, tabla `CatalogEmbedding` con una fila por producto,
variante, entrada de FAQ e instrucción, regenerada al guardar desde el panel. Búsqueda híbrida:
vector para el significado, el puntaje por tokens actual como señal adicional, y la taxonomía de
colores y alias de categoría como filtro duro. `search_products` deja de devolver el catálogo
completo: devuelve los K mejores, siempre. Corrección de tipeos por distancia de edición como último
recurso.
**Se prueba:** se despliega con la búsqueda vieja corriendo en paralelo y registrando la diferencia,
sin afectar la respuesta. Se activa cuando los fixtures de catálogo dan igual o mejor.
**Prompt:** la instrucción *"`search_products` te devuelve el catálogo completo igual, revisalo por
significado antes de decidir"*, que existe solo porque la búsqueda es mala. **−15 líneas.**
**Tamaño:** L. **Depende de:** `E24`. **Bandera:** sí, mientras corre en paralelo.
**Vuelta atrás:** apagar la bandera.

---

### E62 · Se mide el tamaño de cada tool-result

**Quita:** al operador, no poder ver el siguiente `E61` en otro negocio.
**Porque:** **nada hoy mide el tamaño de un tool-result en el momento de la llamada.** El caso de los
18.812 caracteres se encontró a mano.
**Se hace:** instrumentación del tamaño por negocio y por herramienta, visible en el panel junto a
`cacheHitRatio`, que ya existe.
**Se prueba:** el número aparece y coincide con una medición manual.
**Tamaño:** S. **Depende de:** `E24`. **Bandera:** no.
**Vuelta atrás:** revertir.

---

### E63 · Trazas por turno

**Quita:** al operador, tener que reconstruir un turno cruzando tres tablas.
**Se hace:** OpenTelemetry, cada llamada al modelo y cada herramienta como un tramo. `AgentTurn` ya
guarda lo que pasó; falta poder verlo en el tiempo.
**Tamaño:** M. **Depende de:** `E24`. **Bandera:** no.

---

### E64 · Se activa el validador de catálogo fuera de modo sombra

**Quita:** al modelo, qué precio y qué nombre de producto puede escribir en una lista.
**Porque:** `validateAgainstCatalog` está construido, corriendo y **sin tocar una sola respuesta**.
Mide, no bloquea. En siete días marcó lo suficiente como para decidir, y la caída al bloque del
servidor pasó 1 vez en 11 turnos del camino de un solo autor.
**Se hace:** con la ventana de 48 h de tráfico real delante: `flaggedTurns` sobre `turns` en el
panel, y los casos uno por uno. **Un hallazgo sobre un bloque compuesto por el servidor no es una
detección: es un defecto del validador, y se arregla antes de seguir.** Los tres falsos positivos
conocidos a vigilar: una etiqueta en negrita con cifra que no es del catálogo (`*Abono:* $50.000`),
un nombre real con palabras agregadas (`*Combo Pareja + obsequio*`), y un precio con decimales donde
el catálogo los tiene en cero.
**Se prueba:** la tasa de falsos positivos medida sobre 48 h reales. **Si no es cercana a cero, no
se activa: se arregla el validador.**
**Tamaño:** M. **Depende de:** `E11`, `E25`. **Bandera:** sí. Es **la única parte del plan que puede
bloquear un mensaje que hoy sale**.
**Vuelta atrás:** apagar la bandera.

---

### E65 · Juez nocturno

**Quita:** a una persona, tener que leer conversaciones para saber si el bot está bien.
**Se hace:** un juez LLM sobre una muestra de conversaciones cerradas: puntúa resolución, tono y
fidelidad al catálogo, y escribe en una tabla que el panel muestra. Corre de noche, sobre una
muestra, con costo acotado y declarado.
**Tamaño:** M. **Depende de:** `E63`. **Bandera:** no.

---

## BLOQUE 10 — Handoff y política de venta

---

### E66 · El humano recibe la conversación con contexto

**Quita:** al humano, tener que leer todo el hilo para entender dónde está parado.
**Porque:** hoy recibe la conversación sin contexto armado, y cuando la suelta el bot retoma a
ciegas.
**Se hace:** paquete de handoff en el panel (resumen, pedido en curso con lo que falta, qué se le
prometió al cliente, qué preguntas quedaron abiertas), y retorno con contexto: cuando el humano
suelta, el bot retoma con un resumen de lo que el humano dijo, inyectado como `system`.
**Se prueba:** fixture de retorno tras handoff.
**Tamaño:** L. **Depende de:** `E02`, `E13`. **Bandera:** no — solo agrega contexto.
**Vuelta atrás:** revertir.

---

### E67 · El límite de lo que el agente puede prometer es un dato

**Quita:** a `customInstructions`, contener las reglas de negocio como prosa.
**Se hace:** guardrails declarativos por negocio, en tabla: descuento máximo, plazos que puede
prometer, qué no puede afirmar. Se verifican contra la respuesta con el mismo mecanismo que ya usa
`verifyAgainstCatalog`: comparación contra un `SELECT`, no lectura de prosa.
**Prompt:** `neverSay` y buena parte de `customInstructions` de cada negocio. **−20 líneas del prompt
base**, y una reducción mucho mayor en las instrucciones por negocio.
**Tamaño:** L. **Depende de:** `E66`, `E11`. **Bandera:** sí — mismo riesgo de falso positivo que
`E64`.
**Vuelta atrás:** apagar la bandera.

---

## BLOQUE 11 — Vender: lo que falta solo para poder competir

Contexto que ordena este bloque: **Meta lanzó su propio agente globalmente el 3 de junio de 2026 y
empezó a cobrarlo el 1 de agosto** (US$ 2 por millón de tokens, ≈4-5 centavos por mensaje; gratis en
los planes Premium de la app). *"Una IA que contesta tu WhatsApp"* dejó de ser un producto vendible
por sí solo.

Lo que Meta **no** hace y sí queda defendible: **transaccionar en Colombia y México**,
**preguntarle al dueño y retomar**, y **aprender de lo que el dueño contesta**. Los dos últimos son
los Bloques 8 y 10 de este plan. El primero es este.

---

### E68 · Cada conversación tiene dueño

**Quita:** al equipo, que dos personas contesten lo mismo.
**Porque:** `assignedTo` **no existe en ningún modelo**. Wati vende exactamente esto como el techo de
Meta, y es de las primeras cosas que un comprador con equipo mira.
**Se hace:** `Conversation.assignedToId` hacia `TeamMember`, filtro en la Bandeja y aviso al
asignado. Panel en la misma etapa.
**Tamaño:** M. **Depende de:** `E45`. **Bandera:** no.

---

### E69 · Opt-out por palabra clave

**Quita:** al número de WhatsApp, el riesgo de que Meta le baje la calificación de calidad.
**Porque:** no hay manejo de STOP/BAJA ni del código 131050, y la calificación de calidad cae cuando
la tasa de opt-out supera ~2 %. **Es prerrequisito de `E70` por política de Meta**, no una opción.
**Se hace:** palabra clave de baja, marca en `Customer`, y respeto en todos los caminos de envío.
Lectura de los webhooks de calidad (`change.field`, que hoy nunca se lee).
**Se prueba:** un cliente dado de baja no recibe ningún envío saliente.
**Tamaño:** M. **Depende de:** `E18`. **Bandera:** no.

---

### E70 · Difusión con plantillas y segmentos

**Quita:** al dueño, tener que mandar mensajes de campaña uno por uno.
**Porque:** es la ausencia más citada por la que un comprador descarta una herramienta de WhatsApp.
**Se hace:** segmentos guardados sobre el CRM que ya existe, plantillas aprobadas, envío por lote con
la cola de `E21` y respeto del opt-out.
**Tamaño:** L. **Depende de:** `E69`, `E21`, `E41`. **Bandera:** no.

---

### E71 · Las primitivas nativas de WhatsApp

**Quita:** al bot, tener que componer con texto lo que Meta regala a nivel de protocolo.
**Porque:** mensajes de catálogo, multiproducto y carrusel existen en el protocolo y Onix no los usa.
Las listas tocables (`interactiveListsEnabled`) ya son el primer paso y están encendidas en
MAGByLizN.
**Tamaño:** L. **Depende de:** `E39`. **Bandera:** sí, por negocio.

---

### E72 · Checkout en chat — Wompi (Colombia)

**Quita:** al dueño, tener que mirar una foto de comprobante para saber si le pagaron.
**Porque:** es lo único que Meta dice explícitamente que su agente no hace. Wompi cubre con **una**
integración tarjetas, PSE, Nequi, Daviplata, botón Bancolombia y efectivo (Baloto/Efecty), con
comisión plana **2,65 % + $700 COP + IVA** solo sobre transacciones exitosas.
**Se hace:** el enlace de pago se genera desde `SaleState`; la confirmación llega por webhook y
alimenta `paymentStatus` real. **El flujo actual de comprobante más confirmación del dueño con
botones Sí/No se conserva**: es el camino correcto para contraentrega y para quien no quiere pagar
en línea. Los dos conviven.
**Se prueba:** una venta completa de punta a punta en sandbox, con el pedido pasando a pagado por
webhook y no por inspección humana.
**Tamaño:** L (y es de las más largas del plan). **Depende de:** `E31`, `E35`, **`D3`** (cuenta,
contrato y comisión). **Bandera:** sí, por negocio.
**Vuelta atrás:** apagar la bandera; el flujo viejo nunca se quita.

---

### E73 · Checkout en chat — Mercado Pago (México)

Espejo exacto de `E72`: Checkout API cubre tarjetas, **SPEI** y **OXXO** en una sola integración,
~3,49 % + $4,00 MXN + 16 % de IVA sobre la comisión. **CoDi no se construye**: Banxico reconoce que
no despegó y está reestandarizando.
**Tamaño:** L. **Depende de:** `E72`, **`D4`**. **Bandera:** sí, por negocio.

---

### E74 · Sincronización de inventario

**Quita:** al stock, ser lo que alguien tecleó por última vez.
**Se hace:** `InventorySource`, una interfaz con implementaciones: manual (lo actual), Shopify,
WooCommerce, MercadoLibre. Sincronización periódica y por webhook. El resto del sistema no se entera
de cuál está activa.
**Tamaño:** L por integración. **Depende de:** `E32`. **Bandera:** sí, por negocio.

---

### E75 · Un canal nuevo es un adaptador

**Quita:** al código de envío, estar acoplado a WhatsApp.
**Porque:** `Customer.@@unique([businessId, phoneNumber])` es la identidad, y es específica de
WhatsApp: un cliente de Instagram no tiene teléfono. El envío sigue acoplado a
`src/whatsapp/client.ts`.
**Se hace:** tabla de identidades por canal, y una capa de canal por debajo de `recordMessage` /
`sendTextMessage`. Instagram y Messenger primero, web después, todos sobre el mismo `InboundEvent`.
**Depende de:** `E20`, `E18`. **Por eso `E20` va antes: con la cola de entrada normalizada, un canal
nuevo es un adaptador y no una segunda copia del webhook.**
**Tamaño:** L. **Bloqueador declarado:** no tiene sentido diseñarla sin un segundo canal real contra
el cual validarla. **Decisión:** `D6`.

---

# PARTE V — Decisiones que esperan al dueño

Ninguna la resuelve el código. Cada una bloquea algo concreto.

| # | Decisión | Opciones | Qué bloquea |
|---|---|---|---|
| **D1** | **Consentimiento para guardar datos del cliente final** | (a) guardar en silencio, (b) aviso único al primer contacto, (c) preguntar cada vez | `E42`, y con ella que `E02` salga encendida. (b) es lo que exige la ley colombiana y cuesta un mensaje extra por conversación. **Es la que más tiempo lleva parada.** |
| **D2** | **¿Se cambia el contrato de `cancel_order`?** | (a) sí, la primera llamada deja de cancelar, (b) no, se queda como está | `E34`. Cambiar la prueba existente para acomodarlo es exactamente lo que este repositorio no admite sin tu decisión. |
| **D3** | **Wompi: cuenta, contrato y comisión** | — | `E72`. No es técnico. |
| **D4** | **Cuándo se abre México** | (a) ahora, (b) después de que Colombia esté estable, (c) nunca | `E73`. Recomendación de los documentos archivados: no abrir México antes de que Colombia cumpla la definición de listo. |
| **D5** | **Qué puede hacer el rol `EMPLOYEE`** | (a) solo Bandeja, (b) Bandeja + Catálogo, (c) todo menos Equipo y WhatsApp | La mitad de `E27` (dónde va `requireOwner`). La parte del IDOR no espera. |
| **D6** | **Cuál es el segundo canal y cuándo entra** | Instagram / Messenger / ninguno por ahora | `E75`. |
| **D7** | **Socket.IO con la Bandeja paginada:** ¿qué pasa cuando cambia una fila que no está en la página cargada? | (a) ignorarla, (b) mostrar "hay actividad más abajo" | `E45`. Es decisión de producto tanto como de código. |
| **D8** | **Las tres cifras del hero de la landing** | (a) publicarlas, (b) borrar esa franja | `E54`. Sin ellas el hero queda igual de sólido. |
| **D9** | **Construcción del logo** | A calada / B suelta a dos verdes / C en anillo | `E55`. Hasta que elijas, las pantallas siguen con la gota actual. |
| **D10** | **Retención de conversaciones y media en S3** | (a) indefinida, (b) 12 meses, (c) 24 meses | Costo de S3 y exposición legal. No bloquea ninguna etapa. |

**Trámites que no son código y conviene empezar ya:** verificación de negocio en Meta más URL de
política de privacidad; aviso de tratamiento de datos y contrato de encargo (ligado a `D1`); y sacar
el tarifario vivo de Meta para Colombia y México desde Business Manager antes de publicar cualquier
número de economía unitaria — las fuentes secundarias se contradicen.

---

# PARTE VI — Cómo se sabe que el plan funciona

Cuatro números, revisados al cerrar cada etapa, contra la línea base de la Parte III.

1. **Intervenciones de respaldo por cada cien turnos.** **56 hoy.** Tiene que bajar, porque cada
   etapa le quita al modelo una decisión que podía equivocar. **El objetivo no es bajar el número:
   es que los guards que lo producen dejen de existir.** Un número que baja con los mismos guards
   puestos no prueba nada.
2. **Líneas de `src/ai/prompts/systemPrompt.ts`.** 541 al empezar, **540 desde `E04`**. Objetivo al cerrar el Bloque 6:
   **por debajo de 400**. Si sube, algo se convirtió en chatbot sin que nadie lo decidiera.
3. **Turnos perdidos** — mensajes de `CUSTOMER` sin ninguna respuesta de `ASSISTANT`. **2 hoy**, y
   hoy solo se pueden contar con una consulta a mano. A partir de `E22` tiene que ser **cero, y
   medible**.
4. **Conversión** — pedidos sobre conversaciones tocadas. **26 % hoy** (22 de 84). El denominador
   correcto incluye las abandonadas; el panel lo calculaba sobre `SOLD + LOST` y por eso mostraba
   79 %.

Lo que **no** es una métrica de este plan: el costo de IA. US$ 0,0115 por conversación contra un
plan de COP 36.000 al mes. Está medido, está bien, y perseguirlo es perder el tiempo.

**Y la prohibición explícita:** `npm test` en verde es una referencia, nunca un objetivo. No se
maquilla una prueba para que pase. Un fixture que prueba un defecto real se queda en `knownFailing`
hasta que la etapa que lo arregla lo ponga en verde de verdad.

---

# PARTE VII — Si hoy quieres trabajar en...

| Tema | Etapas |
|---|---|
| **Lo que más duele hoy** | `E01`–`E05c`, `E09` y `E09b` desplegadas; sigue `E56`, después `E06` |
| **El bot dice cosas falsas** | `E09`, `E09b`, `E10`, `E11`, `E12`, `E13` |
| **Respuestas duplicadas** | `E06`, `E07`, `E08` |
| **Fechas y tiempos de entrega** | `E01` y `E05` hechas; queda `E35` |
| **Nada se pierde** | `E14`, `E15`, `E16`, `E20`, `E21`, `E22` |
| **Envíos que fallan** | `E17`, `E18`, `E19` |
| **Seguridad** | `E26`, `E27`, `E28`, `E29`, `E30` |
| **Pedidos** | `E31`, `E32`, `E33`, `E34`, `E35` |
| **Catálogo** | `E36`, `E37`, `E38`, `E39`, `E40`, `E61` |
| **CRM** | `E02` hecha; quedan `E41`, `E42`, `E43`, `E44`, `E45`, `E46`, `E68` |
| **Panel (rediseño)** | `E47`, `E48`, `E49`, `E50`, `E51`, `E52`, `E53`, `E54`, `E55` |
| **FAQ que aprende** | `E09b` (que la lea), `E56`, `E57`, `E58`, `E59` |
| **Observabilidad** | `E24`, `E25`, `E62`, `E63`, `E65` |
| **Vender más** | `E68`, `E69`, `E70`, `E71`, `E72`, `E73` |

**Lo siguiente: `E56`.** Es de una tarde, y desde el 2026-09-17 se sabe que no es solo aprendizaje: la
fila que se borra al contestar es la prueba con la que el motor de efectos sabe que una imagen ya fue
atendida, así que borrarla hace que el bot **repita mensajes** (caso Maira, en su ficha). Después `E06`,
el diagnóstico de `RESPUESTA_DUPLICADA` — y `E56` puede resultar ser parte de su causa.

**La más barata con más retorno:** `E56`. Una tarde, y deja de destruirse el dato que alimenta el
único diferenciador que ningún competidor tiene.

---

# Anexo — De dónde salió cada etapa

Los documentos viejos están en `docs/historico/`. No se borraron: el código los cita en comentarios
que explican por qué está hecho así.

| Etapa | Origen |
|---|---|
| `E01`, `E05`, `E05b`, `E05c` | Hallazgo de esta sesión (2026-09-17). No estaba en ningún plan. |
| `E02`, `E03`, `E04`, `E41`, `E43`, `E44` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 5 — más el hallazgo del 2026-09-17 |
| `E06`, `E07`, `E08`, `E23`, `E24` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 2 |
| `E09`, `E13` | `ONIX-PLAN-MAESTRO.md`, Fases 3 y 4 — más la línea base de esta sesión |
| `E10`, `E11`, `E12` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 3B, clases B, A y C |
| `E14`, `E15`, `E16`, `E26` | `ONIX-PLAN-INFRAESTRUCTURA.md`, "qué se puede hacer esta semana" |
| `E17`, `E18`, `E19` | `ONIX-PLAN-MAESTRO.md`, Fase 7 — más los `DeliveryFailure` de esta sesión |
| `E20`, `E21`, `E22` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 1 |
| `E25` | `ONIX-PLAN-MAESTRO.md`, Fase 0 (línea base), ya tomada en la Parte III |
| `E27`–`E30` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 0, y `ONIX-PLAN-MAESTRO.md`, Fase 8 |
| `E31`–`E35` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 3 |
| `E34` | `ONIX-PENDIENTES.md`, sección 2 (el diseño ya estaba escrito ahí) |
| `E36`–`E40` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 4 |
| `E42` | `ONIX-DIAGNOSTICO-2026-09.md`, decisión D1 |
| `E45`, `E46` | `ONIX-CRM-REORG-PLAN.md`, Fase 5 y desvío de P5 |
| `E47`–`E55` | `design/ONIX-REDESIGN-PLAN.md`, fases 3 a 9 |
| `E56`–`E60` | `ONIX-AUDITORIA-ARQUITECTURA.md`, capítulo 5 (los 8 puntos) y `ONIX-PLAN-MAESTRO.md`, Fase 12 |
| `E61`, `E62` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 6, y `ONIX-RELIABILITY-PLAN.md`, Track C ítem 5 |
| `E63`, `E64`, `E65` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 7, y `ONIX-PLAN-CATALOGO-Y-MEDIOS.md`, Fase C |
| `E66`, `E67` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 8 |
| `E68`, `E70`, `E71` | `ONIX-PLAN-MAESTRO.md`, Fase 14 |
| `E69` | `ONIX-DIAGNOSTICO-2026-09.md`, riesgo R4 |
| `E72`, `E73` | `ONIX-PLAN-MAESTRO.md`, Fase 13, y `ONIX-DIAGNOSTICO-2026-09.md`, capítulo 11.6 |
| `E74`, `E75` | `ONIX-PLAN-INFRAESTRUCTURA.md`, Fase 9, y `ONIX-CRM-REORG-PLAN.md`, multicanal |

## Lo que se decidió NO hacer, para que no se reabra por error

- **Un efecto requerido disparado por prosa del cliente** ("pidió cancelar", "pidió un descuento").
  El disparador es prosa y viola la regla de admisión. `E34` es la forma que sí cumple.
- **"Prometió consultar al dueño → crear `PendingOwnerQuestion`" como efecto.** Se queda como alerta,
  nunca como creación automática de estado. Avisar de más es barato; inventar estado de negocio no.
- **Convertir la descripción de visión de una foto en un `productId`.** Es un disparador leído de
  prosa. Hoy cae en `ask_owner_about_photo`, que es el escalón correcto.
- **Limpiar automáticamente las descripciones de producto mal cargadas.** Una descripción es texto
  que escribió el negocio; un limpiador tendría que adivinar qué quiso decir. Lo arregla el dueño
  desde el panel. Caso conocido: "Smartwatch serie 12 mini", línea 7 de su descripción dice
  `Cargador les (WhatsApp,` — un pegado de dos columnas al cargar el producto. Vale la pena revisar
  el resto de ese negocio.
- **Rechazo previo de `variantLabel` ambiguo**: `resolveOrderItems` ya lo bloquea antes de llegar a
  un pedido real; el rechazo previo solo ahorraría un turno y duplicaría lógica.
- **Enum dinámico de `productId` por turno** en el esquema de herramientas: el guard de código ya
  cierra el hueco en runtime.
- **Más backstops de expresión regular sobre la prosa del modelo.** Es la clase que no converge.
- **CoDi, WhatsApp Pay nativo, agente de voz, arquitectura multi-agente, cambiar de proveedor de
  modelo, reescribir el sistema.**

## Un defecto de proceso que sigue abierto y no es una etapa

**`npm run build` compila los archivos de prueba a `dist/`.** `tsconfig.json` tiene
`"include": ["src"]` y ningún `exclude`. Ya rompió un despliegue (2026-09-16, cuatro huérfanos de un
rename viejo) y una copia compilada de un test de costo real en `dist/` **facturó a DeepSeek en un
`npm test` común**. Producción corre el código fuente con `tsx` y no usa `dist/`. Arreglarlo es una
línea de `exclude`; va con la primera etapa que toque el build.

**CI no revisa tipos.** `.github/workflows/test.yml` corre `npm ci`, `prisma generate`,
`prisma migrate deploy` y `npm test`, nada más. `npm test` corre con `tsx`, que **borra los tipos
sin mirarlos**: un archivo puede estar en verde en CI y no compilar. Medido el 2026-09-17:
`src/routes/auth.activation.test.ts` pasó sus 5 pruebas mientras `npx tsc --noEmit` daba 11
errores, o sea con `npm run build` roto y nadie enterado. Se arregló el archivo (`6a961b1`), no el
agujero. El agujero se cierra con dos líneas en el workflow — `npx tsc --noEmit` y
`npm run typecheck:all`, los dos en verde hoy — y va con la primera etapa que toque CI.
