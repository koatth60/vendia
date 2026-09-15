# Onix — diagnóstico técnico de causa raíz

Fecha: 2026-09-15. Rama auditada: `redesign/completo` (HEAD `c924c47`).
Alcance: todo el producto, no solo el núcleo de IA. Segunda auditoría; parte de
`ONIX-AUDITORIA-ARQUITECTURA.md` (2026-09-14) y la extiende a plataforma WhatsApp, confiabilidad,
seguridad, privacidad, costo, panel, expansión a México y capacidades de producto.

Toda afirmación lleva evidencia: `archivo:línea` para código, id de conversación y número de turno
para conversaciones. Las salidas crudas de los barridos están en el scratchpad de la sesión
(`classify.js`, `classify2.js`, `promises.js`, `dump.js`, `payload.ts`).

---

## 1. Resumen ejecutivo

1. Onix no es un agente con arquitectura: es un prompt de ~8.000 tokens rodeado de 35 expresiones
   regulares que leen la prosa que el propio modelo acaba de escribir e intentan repararla.
2. El diagnóstico de la auditoría anterior sigue vigente y empeoró: el estado de la venta no existe
   en ninguna parte hasta el cierre. `checkoutStateFromDb.ts:41-46` vuelve a documentarlo el
   2026-09-15, un día después de la auditoría que ya lo había dicho.
3. `computeCheckoutState` —la pieza correcta— sigue corriendo en `void ... .then()` dentro de
   `finalizeTurn` (`agent.ts:1074`), escribiendo solo a log, alimentada por dos fuentes vacías.
4. En las 37 conversaciones reales anonimizadas: 25 promesas del bot del tipo "déjame confirmar con
   el equipo" y **0** resueltas en los 4 turnos siguientes. La escalación es prosa, no estado.
5. Una venta se perdió íntegra (`igmt9z`, `LOST`) porque el bot prometió consultar tres veces, nunca
   consultó, y terminó diciéndole a la clienta *"escríbeme por el WhatsApp del negocio directo"* —
   siendo él el WhatsApp del negocio (turno 33).
6. Cuatro guards disparan efectos reales (WhatsApp al dueño, envío de fotos, datos de pago pegados)
   decididos por regex sobre prosa generada. Es la clase de código más peligrosa del sistema.
7. `finalizeTurn` aplica 12 etapas sucesivas sobre el texto final; 5 lo mutan, 1 lo reemplaza entero,
   4 disparan efectos laterales, 1 hace una llamada extra a herramienta. No hay una sola prueba de la
   composición.
8. `npm test` pasa 361 pruebas en 35 s y no prueba una sola conversación completa. La suite de
   regresión cuesta dinero real y su criterio de éxito mide el parche, no la venta.
9. `POST /webhook` no verifica la firma de Meta (`X-Hub-Signature-256` no existe en el repo) y es un
   disparador de envíos públicamente accesible. Con `express.json()` global (`index.ts:17`) hoy es
   estructuralmente imposible verificarla sin cambiar el bootstrap.
10. Los tokens de WhatsApp de cada negocio se guardan en texto plano (`schema.prisma:51`). Acceso de
    lectura a la base equivale a control total del número de WhatsApp de todos los clientes.
11. Un IDOR real permite a un negocio leer la cola de mensajes salientes de otro
    (`routes/admin/conversations.ts:170-177`).
12. Los tokens de Embedded Signup expiran a los 60 días; no hay almacenamiento de expiración, ni
    refresh, ni detección del error 190. El piloto va a quedar mudo un día sin aviso.
13. Costo: ~12.069 tokens fijos por llamada al modelo, 1,97 llamadas por mensaje de cliente. Pero la
    caché de DeepSeek acierta el 88,3 %: **USD 0,0127 por conversación**. El prompt inflado es un
    problema de calidad y latencia, no de plata. El único renglón que escala mal es la visión por
    Anthropic: 1 % de las llamadas, 21 % del costo.
14. Multi-negocio: la lógica de documento de identidad depende de dos nombres de ciudad literales
    (`checkoutState.ts:99`); el formateo de precios está clavado a `es-CO` (`products.ts:37-39`); la
    heurística cédula/celular asume numeración colombiana (`agent.ts:545-547`).
15. México: no hay campo de país, moneda ni zona horaria en `Business`. El bloque `MX` de
    `checkoutState.ts:112-126` está escrito y marcado como no verificado.
16. No hay opt-in/opt-out, ni monitoreo de calidad del número, ni manejo de códigos de error de la
    Cloud API, ni límites de tasa, ni reintentos con backoff.
17. **61 % de las conversaciones de producción (34 de 56) quedaron en `NEW` y nunca se cerraron.** La
    tasa de conversión que muestra el panel es 78,9 %; la real es 26,8 %. El abandono no existe en
    la métrica porque `LOST` solo lo escribe el modelo llamando una herramienta (`tools.ts:1352`).
18. El diferenciador real —la FAQ aprendida— desperdicia su mejor fuente: cuando el dueño responde a
    mano desde el panel, ese par pregunta/respuesta se borra (`conversation/service.ts:495-497`).
19. El ciclo de parches no termina porque el sistema no puede verificar nada antes de hablar; solo
    puede leer lo que ya dijo. Mientras esa asimetría exista, cada arreglo abre el caso opuesto.
20. Veredicto: **producción es la suite de pruebas.** Esa es la mecánica literal del ciclo.

---

## 2. Método y límites de la evidencia

- **Conversaciones**: 37 conversaciones reales anonimizadas, 1.152 mensajes, 2 negocios
  (MAGByLizN 35, Aurora Joyas 2), exportadas de producción el 2026-09-12
  (`src/ai/regression/fixtures/conversations.json`). `humanControl` es `false` en las 37: la muestra
  no contiene un solo caso de toma de control manual.
- **Límite conocido de la muestra**: la anonimización reemplaza nombres y direcciones con
  placeholders distintos en cada ocurrencia (`scripts/anonymize-conversations.js`). Por eso en los
  fixtures el mismo cliente aparece como "Nicolas56" y dos turnos después como "Santiago"
  (`ps2evr`, turnos 7 y 9). **Eso es artefacto de anonimización, no un fallo del bot**, y no se
  cuenta como hallazgo. Lo mismo aplica a direcciones repetidas dentro de una frase. Todos los
  hallazgos de abajo son independientes de esos campos.
- **Base de producción**: leída con autorización explícita del dueño, solo consultas agregadas de
  lectura, sin PII y sin escrituras. Resultados en el capítulo 3 bis.
- **Código**: lectura directa de `src/ai/agent.ts`, `tools.ts`, `prompts/systemPrompt.ts`,
  `orders/checkoutState*.ts`, más tres barridos delegados (plataforma WhatsApp y confiabilidad;
  seguridad y panel; catálogo, conocimiento y genericidad).
- **Pruebas**: `npm test` ejecutado una vez — 361 pruebas, 0 fallos, 34,6 s. No se corrió
  `npm run regression` ni `npm run test:paid` (cuestan dinero real; decisión del dueño).

---

## 3. Superficie medida

| Señal | 2026-09-14 (auditoría previa) | 2026-09-15 (hoy) |
|---|---|---|
| Líneas de `src/ai/agent.ts` | — | 1.666 |
| Constantes `*_PATTERN` con nombre en `agent.ts` | 36 | **35** |
| Constantes `*_PATTERN` con nombre en todo `src/` (sin tests) | — | **41** (`agent.ts` 35, `learnedFaqQuality.ts` 4, `checkoutState.ts` 2) |
| Expresiones regulares totales en `agent.ts` (con nombre + inline) | 49 (superficie completa) | **57** |
| Regex en `jobs/conversationHealth.ts` | — | 8 |
| Herramientas expuestas al modelo | — | **21** |
| Prompt del sistema renderizado | — | 23.528 ch (mínimo) / 28.561 ch (negocio configurado) |
| Tokens fijos por llamada al modelo (prompt + esquemas de herramientas) | — | **≈ 12.069** |
| Llamadas al modelo por turno | 5 | 5 + 1 de recuperación |
| Etapas de transformación en `finalizeTurn` | ~12 | **12** |
| Pruebas deterministas de conversación completa | 0 | **0** |
| Pruebas totales (`npm test`) | — | 361, 0 fallos, 34,6 s |
| Archivos de prueba que llaman `generateReply` | — | 4 (ninguno multiturno) |
| Commits desde 2026-08-01 | — | 201 |
| Reinicios de `pm2` del proceso en producción | — | **103** |

Churn desde 2026-08-01 (los archivos donde vive el ciclo de parches):

```
95 public/admin/index.html
55 src/ai/agent.ts
42 src/routes/admin.ts
41 src/ai/tools.ts
37 prisma/schema.prisma
36 src/routes/whatsapp.ts
33 src/conversation/service.ts
```

`agent.ts` mantiene 55 commits — el mismo número que medía la auditoría anterior para *todo*
septiembre, sobre un archivo de 1.666 líneas. La proporción entre función nueva y reparación de
incidente es visible en los propios comentarios del archivo: 23 de los ~40 bloques de comentario
largo de `agent.ts` empiezan describiendo un incidente de producción con fecha
(`agent.ts:1226`, `:1240`, `:1260`, `:1298`, `:1340`, `:1377`, `:1394`, `:1461`, `:1489`, entre
otros). **El archivo está escrito como una bitácora de incidentes, no como lógica de negocio.**

---

## 3 bis. Datos reales de producción (2026-09-06 → 2026-09-15)

Consultas agregadas de solo lectura sobre la base de producción, autorizadas por el dueño. Diez días
de operación, tres negocios activos. **Parte de este volumen es tráfico de prueba del propio
equipo**, así que los ratios valen más que los absolutos.

| Métrica | Valor |
|---|---|
| Negocios / activos | 3 / 3 |
| Conversaciones | 56 |
| Mensajes totales (cliente 764, bot 1.177) | 1.941 |
| Clientes | 39 |
| Pedidos | 15 |
| Conversaciones con `humanControl` | **1** |
| `PendingOwnerQuestion` abiertas | 0 |
| `DeliveryFailure` | 4 |
| Cola de salida sin enviar | 0 |
| Entradas de FAQ | 24 |
| Candidatos de FAQ aprendida: aprobados / descartados / pendientes | **12 / 3 / 1** |

**Estado de las conversaciones — la evidencia más dura del documento:**

| Estado | Cantidad | % |
|---|---|---|
| `NEW` | **34** | **61 %** |
| `SOLD` | 15 | 27 % |
| `LOST` | 4 | 7 % |
| `QUOTED` | 2 | 4 % |
| `NEGOTIATING` | 1 | 2 % |

- **34 de 56 conversaciones (61 %) quedaron en `NEW` y nunca se cerraron.** Confirma el eje 18 con
  datos: las conversaciones que se apagan no tienen salida.
- **La tasa de conversión que muestra el panel hoy es 15/(15+4) = 78,9 %. La real es 15/56 = 26,8 %.**
  Cincuenta y dos puntos de diferencia, producto de que el denominador solo cuenta `SOLD + LOST`
  (`analytics/service.ts:17-18`). Es el número que el producto le enseñaría a un negocio que paga.

**Incidentes del agente (10 días):**

| Tipo | Cantidad |
|---|---|
| `BACKSTOP_INTERVENTION` | **18** |
| `DEGRADED_REPLY` | 2 |
| `EXTERNAL_API_FAILURE` | 1 |
| **Total** | 21 |

**18 intervenciones de backstop sobre 1.177 respuestas del bot = 1,53 por cada 100 turnos.** Ese es
el único número de línea base que existe hoy, y no está abierto por guard: los 18 comparten el mismo
`kind` con el motivo en texto libre (`agent.ts:1098`, `:1347`, `:985`).

**Consumo del modelo (`AiUsageLog`, 1.595 llamadas):**

| Tipo | Llamadas | Tokens de entrada (caché + miss) | Tokens de salida | Costo USD |
|---|---|---|---|---|
| `CHAT` (DeepSeek) | 1.505 | 13.136.896 + 1.741.871 | 145.694 | **0,5388** |
| `VISION` (DeepSeek) | 74 | 12.672 + 87.876 | 6.234 | 0,0219 |
| `VISION_ESCALATION` (Anthropic) | **16** | 0 + 58.091 | 3.394 | **0,1501** |
| **Total** | 1.595 | 14.878.767 + 1.887.838 | 155.322 | **0,7108** |

Lecturas que cambian conclusiones:

1. **1.505 llamadas `CHAT` para 764 mensajes de cliente = 1,97 llamadas al modelo por mensaje
   entrante.** El presupuesto de 5 iteraciones no se agota en el caso típico; el costo viene del
   tamaño de cada llamada, no de la cantidad.
2. **Entrada promedio por llamada: 9.886 tokens**, consistente con los 12.069 fijos medidos para un
   negocio bien configurado.
3. **Corrección a mi propio eje 12: la tasa de acierto de caché es 88,3 %** (13,1 M de 14,9 M de
   tokens de entrada). El prompt grande **sí** se cachea, así que hoy no es el problema de costo que
   parecía. Sigue siendo un problema de **calidad** (reglas que se diluyen, medido en `ps2evr` t15)
   y de latencia, no de plata. La conclusión de "adelgazar el prompt" se mantiene, pero por el
   motivo correcto.
4. **Costo real: USD 0,71 en diez días. USD 0,0127 por conversación (≈ COP 50).** Contra un plan de
   COP 36.000/mes, el margen de IA no es el riesgo que se suponía. R6 baja de severidad.
5. **`VISION_ESCALATION` (Anthropic) es el 1 % de las llamadas y el 21 % del costo**, y nunca pega en
   caché. Es el único renglón que escala mal.
6. **`humanControl` en 1 sola conversación y 0 `PendingOwnerQuestion` abiertas** confirma que el
   round-trip de escalación casi no se usa en la práctica — mientras en los fixtures el bot prometió
   25 veces consultar al dueño. El modelo *dice* que escala mucho más de lo que *escala*.
7. **El ciclo de FAQ aprendida funciona: 12 de las 24 entradas activas salieron de él**, con solo 3
   descartes. Es el único subsistema del producto que rinde como se diseñó, y valida el
   diferenciador del capítulo 11.

---

## 4. Taxonomía de fallas en conversaciones reales

Clasificación automática sobre los 1.152 mensajes; los conteos de "promesa incumplida" se midieron
buscando el cumplimiento en los 4 turnos siguientes a la promesa.

| # | Tipo de falla | Frecuencia | Ejemplo (conv/turno) | Impacto en el cliente | Severidad |
|---|---|---|---|---|---|
| F1 | Promesa de consultar al dueño que nunca se resuelve | **25 promesas, 0 resueltas** | `igmt9z` t21, t25, t27, t29, t31 | El cliente espera una respuesta que no llega nunca | **Crítica** |
| F2 | Promesa de foto sin envío real | 19 de 30 | `y1iz5l` t50, `hloaj2` t3 | El cliente pide algo y recibe texto | Alta |
| F3 | Se vuelve a pedir un dato que el cliente ya dio | 6 de 37 conversaciones | `ps2evr` t9/t11/t15 tras el bloque de datos en t12; `igmt9z` t5/t7/t9 | Fricción; el cliente reenvía lo mismo | **Crítica** |
| F4 | El bot pide los datos "de a uno" contradiciendo la regla core de pedirlos juntos | `ps2evr` t15 | "Ahora necesito tus datos de entrega (de a uno para ir organizados): ¿Cuál es tu número de cédula?" | Alarga el cierre 6-8 turnos | Alta |
| F5 | Repetición casi idéntica del mismo mensaje | 57 ocurrencias | `ps2evr`, `y1iz5l` | Parece un robot atascado | Media |
| F6 | Bucle de identificación por foto que no converge | `y1iz5l` t44-t58 (y sigue hasta t163) | 6 fotos enviadas del producto equivocado en 12 turnos | Agota la paciencia; venta no cerrada | **Crítica** |
| F7 | El bot recomienda contactar "el WhatsApp del negocio" siendo él ese canal | `igmt9z` t33 | "Te recomiendo que me escribas por el WhatsApp del negocio directo" | Rompe la ilusión y el flujo; venta perdida | **Crítica** |
| F8 | El bot avanza a cierre sin que el negocio tenga métodos de pago configurados | `igmt9z` t13, t19, t21 | Promete datos bancarios 3 veces, luego dice que "los debería tener el dueño" | Venta imposible de completar | **Crítica** |
| F9 | Cifra de contacto o total compuesta por el modelo | `igmt9z` t15 (teléfono "1234559" que no corresponde a ningún dato dado) | Dato inventado en un resumen de pedido | Riesgo de plata / entrega fallida | Alta |
| F10 | Ráfaga de 3+ mensajes del cliente respondida de a uno | 5 conversaciones | — | N respuestas donde una persona manda una | Media |
| F11 | Conversación larga que muere sin cierre ni estado | 7 conversaciones ≥20 mensajes sin `SOLD` | `y1iz5l` (163 mensajes, status `NEW`) | El negocio no sabe que perdió la venta | Alta |
| F12 | Conversación que termina con un mensaje del cliente sin respuesta | 2 | — | Silencio total | Alta |
| F13 | El cliente que vuelve tiene que repetir todos sus datos | `ps2evr` t10-t11 | "los mismos datos de antes" → "por seguridad necesito confirmar los datos exactos" | El cliente recurrente es tratado como nuevo | Media |
| F14 | Cadena de disculpas (≥3 por conversación) | 3 conversaciones | `y1iz5l` t162 "mil disculpas por la confusión" | Erosiona la confianza | Media |

Dos casos merecen cita literal porque resumen el sistema entero:

**`igmt9z` (Aurora Joyas, `LOST`, 36 mensajes)** — negocio sin métodos de pago ni cobertura de envío
cargados. El bot igual llevó la venta hasta el resumen de pedido:

- t13: *"Te voy a pasar los datos para que hagas la transferencia. El total es: 2 pares de aretes = $78.000"* — total compuesto por el modelo, datos que no existen.
- t19: *"Te voy a enviar los datos bancarios"* — segunda promesa.
- t21: *"Los datos bancarios los debería tener el dueño del negocio. ¿Me esperas un momento mientras consigo esa información?"* — tercera, y ya inventa quién tiene el dato.
- t25, t27, t29, t31: cuatro promesas de "verificar con el equipo" la cobertura contra entrega.
- t33: *"no tengo acceso a esa información en el sistema ahora. Te recomiendo que me escribas por el WhatsApp del negocio directo"*.
- t35: *"veo que no tienen foto cargada en el sistema"*.

Ninguna de las siete promesas produjo una escalación resuelta. Ningún chequeo previo impidió entrar
a un flujo de venta imposible. `configHealth.ts:22-46` revisa cuatro cosas (teléfono de contacto,
categorías, métodos de pago, plantilla `onix_owner_alert`) pero **no bloquea nada**: es un tablero,
no una compuerta.

**`y1iz5l` (MAGByLizN, `NEW`, 163 mensajes)** — el cliente manda una foto con un producto y pregunta
cuál es. Turnos 47-49: tres fotos de `AIRPODS MAX`. Turno 50: *"No logro distinguir con claridad el
modelo exacto"*. Turno 55 el cliente dice "Rosa?" y turnos 56-58: **las mismas tres fotos otra vez**.
En t99 el bot vuelve a listar las mismas opciones; en t120 promete confirmar "para no volver a
equivocarme"; en t162 se disculpa por haber mostrado el producto equivocado. 163 mensajes, sin venta,
status `NEW` — para las métricas esta conversación sigue "abierta" y no cuenta como pérdida
(`analytics/service.ts:17-18`).

---

## 5. Estado por eje

### Eje 1 — Arquitectura conversacional

**Veredicto explícito: es un prompt con parches, no un agente con arquitectura.**

- El estado de la venta no existe fuera del modelo. `pendingOrderItems` se escribe en un solo lugar,
  el paso de confirmación (`tools.ts`), y el `Order` nace al cerrar. El propio repo lo documenta de
  nuevo el 2026-09-15 en `orders/checkoutStateFromDb.ts:41-46`:
  *"ninguna de las dos fuentes se llena mientras la venta esta EN CURSO ... eso vive solo en la
  cabeza del modelo. Es la pieza que falta para la etapa 2 y no se puede resolver leyendo mejor la
  base, hay que capturarlo cuando el cliente elige."*
- `computeCheckoutState` (`orders/checkoutState.ts:139`) está bien diseñado y **no mide nada**: su
  único invocador es `buildCheckoutState` (`checkoutStateFromDb.ts:21`), llamado desde
  `agent.ts:1074` dentro de un `void ... .then()` que solo hace `console.log`. Sigue en "etapa de
  observación" y sus dos fuentes están vacías.
- Lo verificable antes de responder se limita a dos guards de argumento de herramienta (ver eje 2).
  Todo lo demás se repara después.
- Progreso real desde la auditoría anterior: `checkoutStateFromDb` ahora lee los ítems del `Order`
  ya creado (`checkoutStateFromDb.ts:47-52`), lo que sirve para postventa pero no para la venta en
  curso, que es el hueco.

### Eje 2 — Contrato de herramientas

21 herramientas (`tools.ts`): `search_products`, `find_products_by_attributes`, `get_product_details`,
`list_all_products`, `send_product_media`, `get_faq`, `get_payment_methods`, `get_shipping_rates`,
`get_shipping_rate_for_city`, `get_shipping_payment_modalities`, `save_customer_name`,
`save_customer_contact_info`, `update_conversation_status`, `flag_conversation_intent`, `ask_owner`,
`ask_owner_about_photo`, `show_order_summary`, `close_conversation`, `get_order_status`,
`cancel_order`, `get_previous_conversation`.

**Validación de argumentos contra la base antes de ejecutar — solo 2 de 21:**

| Guard | Ubicación | Qué valida | Veredicto |
|---|---|---|---|
| `close_conversation.paymentMethodLabel` | `agent.ts:1489-1519` | El label contra `listActivePaymentMethods` | **Correcto, se queda** |
| `send_product_media.productId/variantId` | `agent.ts:1556-1584` | El id contra los resultados reales del turno | **Correcto, se queda** |

Las otras 19 ejecutan con lo que el modelo mande. No hay idempotencia declarada en ninguna:
`close_conversation` crea `Order` (protegido de hecho por `Order.conversationId @unique`);
`save_customer_contact_info` sobrescribe; `ask_owner` manda un WhatsApp real cada vez.

**Inventario obligatorio: todo guard que dispara un efecto lateral real decidido por prosa.**
Esta es la clase más peligrosa del sistema. Hoy son **cinco**, una más que en la auditoría anterior:

| # | Guard | Ubicación | Decide leyendo | Efecto real que dispara |
|---|---|---|---|---|
| G1 | `escalation` | `agent.ts:1155-1166` (patrón `:224`) | La prosa del modelo | `ask_owner` → **WhatsApp real al dueño** con el texto del cliente |
| G2 | `payment_options` | `agent.ts:1104-1123` (patrón `:233`) | La prosa del modelo | `get_payment_methods` + **pega los datos de pago** al final |
| G3 | `catalog_check` | `agent.ts:1136-1154` (patrón `:249`) | La prosa del modelo | `search_products` + pega la lista al final |
| G4 | `shipping_modality` | `agent.ts:1124-1135` (patrón `:239`) | La prosa del modelo | `get_shipping_payment_modalities` + pega la lista |
| G5 | backstop de fotos | `agent.ts:1223-1372` (patrones `:154`, `:163`, `:173`, `:182`, `:200`, `:203`) | La prosa del modelo **y la del turno anterior**, por solapamiento de tokens | `send_product_media` real, hasta 5 productos, o una **retractación pegada al texto** (`honorOrRetractMediaPromise`, `:984`) |

A esos cinco se suman dos mutaciones de texto decididas por prosa:

| # | Guard | Ubicación | Efecto |
|---|---|---|---|
| G6 | `guardAgainstPaymentHallucination` | `agent.ts:624-643` | **Reemplaza la respuesta completa** por la lista de métodos de pago |
| G7 | `VARIANT_DENIAL_PATTERN` | `agent.ts:1096-1103` (patrón `:257`) | `text.replace()` dentro de la frase del modelo. **Añadido el 2026-09-15**, después de la auditoría que pidió dejar de agregar regex |

G7 es la prueba de que el ciclo no se detuvo solo: es un regex nuevo, con efecto de reescritura,
agregado un día después del documento que explicaba por qué esa clase no puede converger.

El supresor de G1-G4 es otro regex (`OFFER_OR_PENDING_CONFIRMATION_PATTERN`, `agent.ts:216`): el
falso positivo y el falso negativo se controlan con la misma herramienta que los produce.

**Qué pasa cuando falla una herramienta**: el error se serializa al modelo como resultado
(`agent.ts:1620`, `messages.push({role:"tool", ...})`) y el modelo decide. Los envíos de foto del
backstop se envuelven en `try/catch` individual (`agent.ts:1273-1290`, `:1359-1368`) tras un
incidente en que un fallo de envío se llevaba el turno entero.

### Eje 3 — Arquitectura de prompt

- `src/ai/prompts/systemPrompt.ts`, 496 líneas de fuente. `BASE_SYSTEM_PROMPT` 17.411 caracteres;
  el prompt renderizado va de 23.528 ch (negocio sin configurar) a 28.561 ch (negocio configurado),
  es decir **6.722 a 8.160 tokens por llamada**.
- Estructura: base + `TONE_DIRECTIVES` (`:213`) + `LANGUAGE_DIRECTIVES` (`:220`) + una de tres
  directivas de foto (`:247`, `:256`, `:266`) + una de dos de comprobante (`:281`, `:292`) +
  `SHIPPING_RATES_DIRECTIVE` (`:304`) + `PRODUCT_IMAGE_DIRECTIVE` (`:312`, 3.344 ch) +
  `CATEGORY_LABELS` (`:352`) + `customInstructions` del negocio marcadas "PRIORIDAD ALTA".
- **Meta-reglas sobre cuál regla gana**: `systemPrompt.ts:482-489` explica que el listado de datos
  del negocio no reemplaza la regla genérica de pedirlos juntos, y que "métodos de pago y fotos
  reales siguen aplicando siempre exactamente igual". Que haya que escribir esto es la señal de que
  el conjunto de reglas superó lo que el modelo aplica de forma confiable — y la conversación
  `ps2evr` t15 demuestra que efectivamente no lo aplica.
- **Regla madre por prosa**: `systemPrompt.ts:24` — *"ningun dato concreto sale de tu memoria"* — es
  exactamente la garantía que el sistema debería dar por construcción (los datos vienen de
  herramientas) y hoy se pide por instrucción, con siete guards detrás para cuando no se cumple.
- Lo que debería ser código y hoy es instrucción: totales y aritmética (`:174-175` prohíbe al modelo
  calcular, pero nada lo impide), orden de recolección de datos de entrega (`:482`), cuándo
  escalar, cuándo mandar fotos.

### Eje 4 — Genericidad multi-negocio

| Hallazgo | Evidencia | Clase | ¿Configurable hoy? |
|---|---|---|---|
| `zonasSinDocumento: ["bogota","soacha"]` decide si se pide cédula | `orders/checkoutState.ts:99`, usado `:129-137` | **MAG.IMP** | No. Constante de módulo |
| `pais: "CO"` fijo al construir los hechos de checkout | `orders/checkoutStateFromDb.ts:95-96` | Colombia | No. `Business` no tiene columna de país |
| Regex de vía colombiana (`cra/cll/kra/dg/mz/vereda` + `#`) decide si una dirección es despachable | `checkoutState.ts:78-80`, duplicado en `agent.ts:588-589` | Colombia | No |
| `barrio` obligatorio como detalle de dirección | `checkoutState.ts:80`, `:108` | Colombia | No |
| `formatCopPrice()` con `toLocaleString("es-CO")` y `Math.round` es el único formateador de precios que ve el modelo | `catalog/products.ts:37-39`, usado `tools.ts:9`, `:628` | Colombia | No. Ignora `product.currency` |
| `Product.currency` tiene default **`"USD"`** mientras todo el resto asume COP | `schema.prisma:367` vs `orders/service.ts:153` | Bug latente | — |
| `PAYMENT_MENTION_PATTERN = /nequi\|bancolombia\|daviplata\|titular\|transferencia\|llave/i` habilita el guard antifraude de pago | `agent.ts:617` | Colombia | No. Un negocio con SPEI/OXXO **no tiene guard** |
| Nequi como ejemplo en prompt, esquema de herramienta, extractor de venta y prompt de visión | `systemPrompt.ts:464`, `tools.ts:449`, `extractSale.ts:28`, `visionPrompt.ts:17` | Colombia | No |
| Heurística "10 dígitos que empiezan por 3 = celular; 6-10 sin 3 = cédula" | `agent.ts:545-547`, `:552-580` | Colombia | No. Un celular mexicano se guarda como cédula |
| `CATEGORY_LABELS` es un conjunto cerrado de 5 rubros | `systemPrompt.ts:352-358`, `:411-414` | Core cerrado | Un rubro fuera de los 5 no recibe directiva alguna |
| `COLOR_SYNONYMS`, 13 buckets fijos en español | `catalog/attributeTaxonomy.ts:9-23` | Core, atado al español | No |
| Plantilla de alerta al dueño forzada a idioma `"es"` | `whatsapp/client.ts:228` | Core | No, aunque el follow-up sí es configurable |

Lo que **sí** está bien hecho y es genérico: aliases de categoría por negocio
(`catalog/categoryAliases.ts`), tarifas y reglas de envío por ciudad (`catalog/shippingRates.ts`,
tablas por negocio en `schema.prisma:118-150`), métodos de pago por negocio (`schema.prisma:103-112`),
dialecto del bot (`systemPrompt.ts:220-232`, ya incluye `mexico`).

### Eje 5 — Expansión a México

| Requisito | Estado | Evidencia |
|---|---|---|
| Campo de país por negocio | **No existe** | `schema.prisma:21-86` |
| Moneda y formato de precios | Clavado a COP/`es-CO` | `products.ts:37-39`; sin campo de moneda en `Business` |
| Métodos de pago (SPEI/OXXO/Mercado Pago/CoDi) | El **dato** es configurable; el **guard antifraude no aplica** | `schema.prisma:88-92` (enum `TRANSFERENCIA/TARJETA/EFECTIVO`), `agent.ts:617` |
| Formato de dirección (colonia, C.P.) | No soportado; el validador exige forma colombiana | `checkoutState.ts:78-80` |
| Formato de teléfono / código de país | Sin normalización; el `from` se guarda verbatim | `conversation/service.ts:121-130` |
| Documento de identidad | Lógica `CO` con dos ciudades literales; bloque `MX` escrito y **marcado como no verificado** | `checkoutState.ts:112-126` — *"Pendiente de confirmar con la transportadora mexicana antes de vender alla"* |
| Zona horaria | **No hay manejo de zona horaria en todo el repo** | `index.ts:62-75`, jobs con aritmética UTC |
| Festivos / días hábiles | Solo como prosa del negocio | — |
| Variante de español | Configurable, `mexico` ya existe | `systemPrompt.ts:220-232` |
| Facturación e impuestos | No existe | — |
| Paquetería mexicana | No existe; el catálogo de envíos es genérico y sirve | `shippingRates.ts` |

Conclusión: México necesita tres campos nuevos en `Business` (país, moneda, zona horaria) y sacar
cinco reglas de código a configuración. No es un puerto grande, pero hoy **no se puede vender ahí**
sin tocar código.

### Eje 6 — Plataforma WhatsApp

| Capacidad | Estado | Evidencia |
|---|---|---|
| Ventana de 24 h | Se infiere de la base propia (`WHATSAPP_WINDOW_HOURS`), verificada en **3 de ~8 caminos de salida** | `conversation/service.ts:12`, `:24-33`; verificada en `admin/conversations.ts:113-130`, `jobs/escalationReminder.ts:21-23` |
| Envíos sin verificar la ventana | Respuesta del bot (`whatsapp.ts:738`), cierre por confirmación del dueño (`:339`, `:348`), cierre manual (`admin/conversations.ts:337`), CSAT, fotos de producto | ver columna |
| Plantillas | CRUD completo + estado de aprobación de Meta; **variables `{{1}}` rechazadas a propósito** | `whatsapp/client.ts:147-176`, `admin/business.ts:112-147`, rechazo `:131-134` |
| Opt-in / opt-out (STOP/BAJA, 131050) | **No implementado**. Cero coincidencias en todo el repo | — |
| Calidad del número / límites de mensajería | **No implementado**. `change.field` nunca se lee, así que `account_update` y `phone_number_quality_update` caen al vacío sin log | `whatsapp.ts:374`, `:411` |
| Límites de tasa / backoff / 429 | **No implementado**. `callGraphApi` es un `fetch` pelado **sin timeout** | `whatsapp/client.ts:23-40` |
| Códigos de error de la Cloud API | **Ninguno manejado específicamente**. El cuerpo JSON ni se parsea; todo termina en un `Error` de string | `whatsapp/client.ts:34-37` |
| Estados de entrega | Solo `failed` se persiste (`DeliveryFailure`); `sent`/`delivered`/`read` van a `console.log` y se descartan | `whatsapp.ts:382-409`; `Message` no tiene columna de estado (`schema.prisma:595-607`) |
| Webhooks duplicados | Idempotencia parcial y **tardía**: se resuelve con el `@unique` de `Message.whatsappMessageId` recién en `whatsapp.ts:574-582`, después de descargar media, subir a S3, correr visión y transcripción | `whatsapp.ts:483-517` |
| Helper de idempotencia temprana | Existe y es **código muerto**, cero invocadores | `conversation/service.ts:666-669` |
| Fuera de orden | **No manejado**. `message.timestamp` solo se usa para descartar respuestas viejas | `whatsapp.ts:673-674`, `:723-735` |
| Multimedia entrante | 9 tipos manejados; `document` nunca se descarga; `location` no guarda coordenadas; `interactive` se descarta salvo CSAT; `button`, `order`, `system` caen sin log | `whatsapp.ts:417-557`, `:455-464` |
| Multimedia saliente | Solo imagen y video, por URL prefirmada de S3 a 6 días | `whatsapp/client.ts:200-271`, `media/s3.ts:57-60` |
| Multi-número | Un número por `Business` (columnas escalares) | `schema.prisma:48-51` |
| Embedded Signup | Implementado; **token de 60 días sin refresh, sin almacenar expiración, sin detectar error 190** | `whatsapp/embeddedSignup.ts:6-11`, `admin/whatsappConnect.ts:123` |
| Firma del webhook | **No implementado y hoy imposible**: `express.json()` global descarta el cuerpo crudo | `whatsapp.ts:368`, `index.ts:17` |
| Token de verificación GET | Default `""`; si la variable no está, `?hub.verify_token=` vacío pasa | `config/env.ts:17` |

### Eje 7 — Confiabilidad

- **Lock por conversación**: implementado, correcto y probado (`whatsapp.ts:62-84`,
  `whatsapp.conversationLock.test.ts`). Pero es **en memoria**: la corrección depende de que pm2
  corra en modo fork, afirmado en un comentario (`whatsapp.ts:57-58`) y **no forzado en ningún
  lado** (no hay `ecosystem.config.js`; `scripts/deploy.sh:70` solo hace `pm2 restart`).
- **Tres caminos evaden el lock**: respuestas del dueño (`whatsapp.ts:451`), el panel
  (`admin/conversations.ts:159`, `:219`, `:337`) y los jobs (`escalationReminder.ts:114`, `:165`;
  `followUp.ts:27`). Todos escriben mensajes al cliente.
- **Cola de salida sin política de reintento**: `QueuedOutboundMessage` no tiene contador de
  intentos, ni `nextAttemptAt`, ni columna de error (`schema.prisma:274-288`). Un ítem que falla
  bloquea la cola de ese cliente **para siempre** (`whatsapp.ts:114-117` hace `return`), se reintenta
  en cada mensaje entrante futuro, y no genera `DeliveryFailure`.
- **Se drena solo cuando el cliente escribe**: no hay job periódico (`index.ts:62-75`).
- **DeepSeek**: timeout 60 s con 1 reintento → ~120 s por llamada (`ai/client.ts:10-16`); failover
  solo entre modelos del mismo proveedor, con breaker de 10 min en memoria
  (`ai/modelFailover.ts:19-21`). Una caída total de DeepSeek no tiene plan — está dicho en el propio
  archivo (`:12-13`).
- **Respuesta lenta = cliente sin respuesta**: si el turno tarda más de 10 minutos, la respuesta se
  descarta, se fuerza `humanControl` y se avisa al dueño — **el cliente no recibe nada**
  (`whatsapp.ts:95`, `:723-735`).
- **Sin migraciones al arrancar, sin `/health` que toque la base, sin apagado ordenado**:
  `/health` devuelve `{status:"ok"}` incondicionalmente (`index.ts:20-22`); no hay `SIGTERM` en todo
  `src/`. En cada `pm2 restart` **los turnos en vuelo se pierden sin registro**, y como el webhook ya
  respondió 200 (`whatsapp.ts:369`), Meta no reintenta. Con **103 reinicios** registrados en
  producción, esto no es teórico.
- **15 puntos donde un `await` que falla deja al cliente sin respuesta**, todos cayendo en un
  `catch` que solo hace `console.error` (`whatsapp.ts:741-743`). El peor: `whatsapp.ts:738`, el
  envío de la respuesta ya generada y ya pagada — si falla, no se registra el mensaje, no hay
  `DeliveryFailure`, y ni el cliente ni el dueño ven nada.
- **`handleOwnerReply` tiene dos `sendTextMessage` sin `try/catch`** (`whatsapp.ts:339`, `:348`):
  el pedido ya se creó y el estado ya es `SOLD`, pero si el envío falla el dueño ni siquiera recibe
  su "Listo, le avisé al cliente".

### Eje 8 — Traspaso a humano

- Escala por: `flag_conversation_intent` (`tools.ts:1034`), `ask_owner_about_photo`
  (`tools.ts:1215`), descarte por respuesta vieja (`whatsapp.ts:728`), o acción manual del panel.
  `ask_owner` a secas **no** activa `humanControl` (decisión documentada,
  `conversation/service.ts:534-539`).
- El humano ve la conversación completa en el panel con toma de control ("Tomar control" /
  "Devolver a la IA", `admin/conversations.ts:60`), y cualquier envío manual activa el control
  automáticamente (`:142`).
- **Si el dueño nunca contesta**: dos recordatorios y silencio permanente. Etapa 1 por
  `ownerReminderMinutes` (default 180 min, `schema.prisma:55`), etapa 2 a las 24 h
  (`escalationReminder.ts:32`), y el propio texto dice *"No se manda ningun otro aviso despues de
  este"* (`:131`). Después, nadie responde al cliente, indefinidamente, con el bot mudo.
- `ownerReminderMinutes` **no es editable desde el panel** (`admin/business.ts:31-53` no lo acepta);
  el valor de 5 minutos de MAG.IMP se puso por script (`scripts/seed-magimp-shipping.ts:96`).
- Un `ask_owner` simple nunca entra al watchdog de conversaciones estancadas, porque ese barrido
  exige `humanControl: true` (`conversation/service.ts:595`).

### Eje 9 — Observabilidad y evaluación

Lo que **sí** se puede responder hoy sin leer conversaciones: conteo de conversaciones por estado,
mensajes por día, productos más consultados, CSAT (`analytics/service.ts:5-49`); incidentes del
agente por tipo (`ai/incidents.ts:81-125`); conversaciones estancadas e inalcanzables (`:90-102`);
fallos de entrega (`delivery/failures.ts`); consumo de IA (`ai/usage.ts`); chequeo automático de
conversaciones cada 30 min con 5 detectores (`jobs/conversationHealth.ts:57-99`).

Lo que **no** se puede responder:

- ¿Qué porcentaje de conversaciones termina en pedido sin intervención humana? No hay denominador:
  las conversaciones que mueren en silencio nunca se cierran (`analytics/service.ts:17-18` solo
  cuenta `SOLD + LOST`).
- ¿Bajaron las intervenciones de backstop tras un cambio? `AgentIncident` guarda el tipo pero el
  `BACKSTOP_INTERVENTION` no distingue **cuál** guard intervino (`agent.ts:1098`, `:1347`, `:985`
  usan todos el mismo tipo con el motivo en texto libre).
- ¿Una FAQ aprobada redujo las escalaciones de ese tema? No hay ningún join entre `FaqEntry` y
  `PendingOwnerQuestion`/`AgentIncident`.
- ¿Cuántos tokens cuesta un turno real? `AiUsageLog` lo tiene, pero no hay vista por conversación.
- **No existe un harness de evaluación offline determinista.** `npm test` prueba funciones puras;
  `npm run regression` cuesta dinero, se corre a mano, y su criterio es "cero intervenciones nuevas
  de backstop": una métrica sustituta que mide el parche, no la venta.

### Eje 10 — Datos y privacidad

- Se persiste de clientes finales: nombre, cédula, celular de entrega, dirección, historial completo
  de mensajes, imágenes subidas a S3, análisis de visión de esas imágenes.
- **No hay aviso de tratamiento de datos, ni registro de consentimiento, ni política de retención,
  ni mecanismo de supresión.** No existe ruta de borrado por cliente: lo único que borra es
  `reset-test-data`, que arrasa con todo el negocio (`admin/business.ts:192`).
- Habeas Data (Ley 1581 de 2012, Colombia) exige autorización previa e informada del titular,
  finalidad declarada y canal de consulta/reclamo. Hoy el responsable legal es el negocio cliente,
  y Zaqi es encargado del tratamiento — **sin contrato de encargo ni aviso, ambos quedan
  expuestos**. LFPDPPP (México) exige además aviso de privacidad accesible antes de recolectar.
- **Decisión pendiente del dueño ya identificada** (ver `onix-customer-data-consent-decision-pending`):
  persistir el nombre en silencio vs. avisar vs. preguntar cada vez. Hoy el bot vuelve a preguntar el
  nombre porque el guardado no se inyecta al prompt. Esa decisión bloquea una mejora de experiencia
  y a la vez es el punto de entrada correcto para el aviso de tratamiento.
- **PII en logs de stdout**: teléfono del cliente en cada recibo de entrega (`whatsapp.ts:406`), en
  cada fallo (`:383`), y el objeto completo del mensaje entrante cuando no trae `from` (`:438`).
- Los fixtures de regresión contienen los **números de cuenta reales** del negocio piloto, a
  propósito (`fixtures/README.md`), y la anonimización de datos de cliente es best-effort por regex.

### Eje 11 — Seguridad

| Hallazgo | Severidad | Evidencia |
|---|---|---|
| `POST /webhook` sin verificación de firma; el tenant se resuelve por un campo del cuerpo controlable por el atacante | **Crítica** | `whatsapp.ts:368`, `:376`, `:420` |
| Tokens de WhatsApp por negocio en texto plano en la base; cero cifrado en todo el repo | **Crítica** | `schema.prisma:51`, escrito `admin/whatsappConnect.ts:111` |
| IDOR: un negocio lee la cola de salida de otro pasando un `conversationId` ajeno | **Alta** | `admin/conversations.ts:170-177`; `listQueuedOutbound` filtra solo por conversación (`conversation/service.ts:50-55`) |
| `SESSION_SECRET` con default `"dev-secret-change-me"` y sin `required()` | **Alta** | `config/env.ts:15` vs `:11` |
| Sesiones en `MemoryStore` (sin store configurado): se pierden en cada reinicio y hay fuga de memoria | Alta | `auth/sessionMiddleware.ts:7-17`, `package.json` sin `connect-pg-simple` |
| Código de recuperación de contraseña con `Math.random()`, guardado en texto plano, comparado con `!==`, y **legible desde dos APIs** (`/admin/api/owner-log` y el panel de plataforma) | **Alta** | `auth/service.ts:14-16`, `:29-32`, `:60`, `:41`; lectura `admin/dashboard.ts:33-36`, `platformAdmin.ts:92-122` |
| Sin `regenerate()` de sesión en ningún login (fijación de sesión) | Media | `auth.ts:55-57`, `:84`, `:100-102` |
| Rol `EMPLOYEE` puede sobrescribir la conexión de WhatsApp del negocio, editar catálogo, cerrar ventas y cancelar pedidos: `requireOwner` falta en esas rutas | **Alta** | `admin/whatsappConnect.ts:43`, `admin/catalog.ts:32-140`, `admin/orders.ts:40`, `:111`; la UI solo lo esconde con CSS (`public/admin/index.html:99`) |
| Subida de archivos sin `fileFilter`, 50 MB, extensión y `Content-Type` derivados del cliente → XSS almacenado en el origen del bucket | **Alta** | `admin/shared.ts:3`, `media/s3.ts:29`, `:37` |
| Sin CSRF, sin CORS explícito, sin `helmet`, sin CSP/HSTS | Media | `index.ts:17-38`; mitigado parcialmente por `sameSite:"lax"` |
| Credenciales de admin de plataforma en texto plano por variable de entorno, comparadas con `!==`, sin rate limit en su endpoint | Media | `config/env.ts:28-31`, `platformAdmin.ts:11-17` |
| Sin bloqueo de cuenta ni política de contraseña en signup (acepta 1 carácter) | Media | `auth.ts:20-37`, `team.ts:19-30` |
| TOCTOU en el consumo de la clave de activación (sin transacción) | Baja | `auth.ts:25`, `:39`, `:50` |
| Sin auditoría de acciones del panel: ningún modelo registra quién cambió qué | Media | no existe `AuditLog` en `schema.prisma` |

Lo que **sí** está bien: aislamiento por `businessId` correcto en prácticamente todas las rutas
(`admin/shared.ts:5-7` + patrón `findFirst({where:{id, businessId}})`), cero SQL crudo en todo
`src/`, bcrypt con costo 12, secretos nunca devueltos al navegador (`admin/business.ts:26`, `:80`).

### Eje 12 — Costo y rendimiento

- **Carga fija por llamada al modelo: ≈12.069 tokens** (prompt renderizado 8.160 + esquemas de las
  21 herramientas 3.909). Medido con `buildSystemPrompt` y `JSON.stringify(catalogTools)`.
- Un turno hace **1 a 6 llamadas** (5 iteraciones + la de recuperación, `agent.ts:1414`, `:1655`).
  Un turno con 3 llamadas cuesta ~36.000 tokens de entrada solo en carga fija, **antes** de la
  historia de la conversación (hasta 20 mensajes) y los resultados de herramientas.
- Cosas que consumen iteración sin producir respuesta: `tool_choice` forzado en la iteración 0
  (`agent.ts:1420`), la intercepción de FAQ que obliga a llamar `ask_owner` dos veces
  (`agent.ts:1540-1554`), y la llamada final sin herramientas que existe porque el presupuesto se
  agota.
- Llamadas extra escondidas en `finalizeTurn`: `get_shipping_rates` cuando el texto menciona envío
  (`agent.ts:1084-1090`), más las herramientas que disparan G1-G4.
- `get_faq` devuelve la lista completa sin límite ni truncado (`tools.ts:930-939`,
  `catalog/faq.ts:10-12`). Con 12 entradas cuesta cientos de tokens; con 100 son miles, en cada
  llamada, siempre fuera de caché. La misma clase de problema ya se midió y se mitigó para productos
  (`LIST_DESCRIPTION_MAX_CHARS = 150`, `tools.ts:600-613`) y no se generalizó.
- **Qué escala mal con 50-500 negocios**: el lock en memoria (un solo proceso), los `setInterval` sin
  bloqueo distribuido (dos instancias mandan todo dos veces, `index.ts:62-75`), las sesiones en
  memoria, `listActiveProducts` completo por cada backstop de fotos (`agent.ts:1310`), y `get_faq`
  sin recuperación por relevancia.
- **Falta el dato real**: tokens y costo por conversación viven en `AiUsageLog` en producción y no
  se pudieron leer en esta sesión.

### Eje 13 — Panel de administración

Lo que el dueño ya puede hacer solo: catálogo completo con variantes y fotos, detección de colores
por IA, alias de categoría, FAQ y aprobación de sugerencias aprendidas, métodos de pago, tarifas y
reglas de envío por ciudad, modalidades de pago del envío, identidad y tono del bot, instrucciones
libres con mejora asistida, banderas de comportamiento de fotos, conexión de WhatsApp por Embedded
Signup, plantillas (crear, listar, borrar), seguimiento posventa, equipo, y bandeja en vivo con toma
de control, notas y etiquetas por cliente, analítica de 7/30/90 días y consumo de IA.

Lo que **no** puede y hoy exige desarrollador o base de datos:

| Falta | Evidencia |
|---|---|
| **Horario de atención** (no existe ni el campo) | `schema.prisma:30-86` |
| `ownerReminderMinutes` (existe en la base, no en la API ni en la UI) | `admin/business.ts:31-53` |
| Moneda y país del negocio (no existen como campo) | `schema.prisma:21-86` |
| Asignación de conversaciones a un miembro del equipo | no hay `assignedTo` en ningún modelo |
| Difusión / campañas a segmentos | no existe ruta ni modelo |
| Importación/exportación masiva de productos (CSV) | no existe |
| Edición de un pedido tras crearlo (ítems, dirección, total) | solo despachar y cancelar (`admin/orders.ts:40`, `:111`) |
| Borrado de un cliente (supresión de datos) | solo `reset-test-data` (`admin/business.ts:192`) |
| Cambio de contraseña estando logueado | no existe ruta |
| Asignación de rol a un miembro del equipo | `PUT /api/team/:id` solo escribe `active` (`team.ts:46`) |
| Exportación desde el servidor | el CSV de analítica se arma en el navegador (`admin.js:2815-2840`) |
| Registro de auditoría | no existe |

### Eje 14 — Capacidades de producto ausentes

Campañas y difusión: **no**. Plantillas: sí, pero sin variables. Segmentación: etiquetas de cliente
sí, segmentos accionables no. Embudos: estados de conversación sí, embudo configurable no.
Carrito y pago en chat: **no** (existe el plan aprobado de Wompi, sin ejecutar). Catálogo nativo de
WhatsApp: **no**. Bandeja multiagente: bandeja compartida sí, asignación no. Horarios de atención:
**no**. Reportes: básicos sí, exportación de servidor no. Integraciones y API pública: **no**.
Multicanal (Instagram/Messenger/web): **no**.

### Eje 15 — Composición y orden del pipeline de respuesta

`finalizeTurn` (`agent.ts:1068-1372`), en orden de ejecución real:

| # | Etapa | Línea | Qué hace | ¿Diseñado o acumulado? |
|---|---|---|---|---|
| 1 | `stripInternalLeaks` | `:1069` | Quita fugas de tool-call y estado interno | Saneamiento, correcto |
| 2 | `guardAgainstPaymentHallucination` | `:1070` | **Reemplaza la respuesta entera** | Acumulado |
| 3 | `void buildCheckoutState(...)` | `:1074` | Solo `console.log`, fire-and-forget | Observación |
| 4 | `get_shipping_rates` si el texto dice "envío" | `:1084-1090` | **Llamada extra a herramienta dentro del finalize** | Acumulado |
| 5 | `guardAgainstShippingCostHallucination` | `:1092` | Detecta, no reescribe | Acumulado |
| 6 | `guardAgainstOrderTotalMismatch` | `:1093` | Detecta y **avisa al dueño** | Acumulado |
| 7 | `VARIANT_DENIAL_PATTERN` → `text.replace` | `:1096-1103` | Reescribe dentro de la frase | Acumulado (2026-09-15) |
| 8 | `applyClaimBackstops` ×4 | `:1104-1168` | **Pegan texto al final** y disparan herramientas | Acumulado |
| 9 | `flag_conversation_intent` si el cliente pide humano | `:1170-1172` | Efecto lateral | Acumulado |
| 10 | Guardado de nombre por regex | `:1174-1190` | Efecto lateral | Acumulado |
| 11 | Guardado de contacto por regex | `:1192-1221` | Efecto lateral | Acumulado |
| 12 | Backstop de media | `:1223-1372` | Envía fotos o **pega una retractación** | Acumulado, 5 capas |

Problemas de composición, no de cada etapa por separado:

- La etapa 2 puede **descartar la respuesta a una segunda pregunta del cliente** y la pregunta que el
  flujo necesitaba hacer, porque reemplaza el mensaje entero por la lista de métodos de pago.
- Las etapas 8 y 12 **pegan texto al final** de un mensaje que casi siempre termina en una pregunta.
  El resultado es "¿cuál prefieres?" seguido de una lista que responde otra cosa.
- Las etapas 2 y 8 pueden ejecutarse en el mismo turno: primero se reemplaza todo el texto, luego se
  le pega una lista de catálogo al reemplazo.
- La etapa 4 hace una llamada de red dentro de la función que se suponía "final".
- El orden es el orden en que se escribieron. **Cero pruebas cubren la composición**:
  `agent.claimBackstopGuards.test.ts` (12 pruebas) prueba los guards por separado, no encadenados.

### Eje 16 — Control del loop

- Presupuesto: 5 iteraciones (`agent.ts:1414`) más una llamada de recuperación sin herramientas
  (`:1655`), con incidente `LOOP_EXHAUSTED` (`:1653`). Que ese camino de recuperación exista y esté
  probado (`agent.loopExhaustion.test.ts`) es la señal de que el presupuesto no alcanza.
- `tool_choice` forzado: `shouldForceAttributeFilter` se activa con **OR** — cualquier color **o**
  cualquier palabra de categoría configurada en el mensaje del cliente (`agent.ts:1436-1438`).
  Sigue igual que en la auditoría anterior. "el negro que ya pedí" en pleno checkout fuerza
  `find_products_by_attributes` en la iteración 0, gasta una llamada y puede reencuadrar la
  conversación sobre el producto equivocado. Solo debería forzarse mientras no haya producto elegido
  — que es justamente el estado que no existe.
- `shouldForcePhotoEscalation` (`:1449-1454`) sí está bien acotado: exige que el último mensaje sea
  media del cliente **y** una racha ≥2 de fotos sin resolver. Es el uso correcto de forzar.
- Consumidores de iteración: el `tool_choice` forzado, la intercepción de FAQ antes de `ask_owner`
  (obliga a llamar `ask_owner` dos veces, `:1540-1554`), y las herramientas de lectura que el modelo
  encadena.

### Eje 17 — Aprendizaje y base de conocimiento

Este es el diferenciador real y está a mitad de camino.

| Punto | Estado | Evidencia |
|---|---|---|
| Fuente del candidato | Solo `ask_owner` resuelto por WhatsApp. La rama `PHOTO_PRODUCT` retorna antes y **nunca** registra candidato | `whatsapp.ts:280`, `:269` |
| Pregunta usada | La del cliente, no la del bot. **Correcto** | `catalog/learnedFaq.ts:36`, `:73-86` |
| Umbral | `MIN_OCCURRENCES_TO_SUGGEST = 2`, cuenta **cuántos clientes preguntaron**, no cuántas veces el dueño confirmó la misma respuesta | `learnedFaq.ts:96`, aplicado `admin/faq.ts:40` |
| Normalización del borrador | **No existe**. El texto crudo de WhatsApp se guarda verbatim y se le pide al dueño que lo reescriba a mano | `learnedFaq.ts:31`, `:68-70` |
| Deduplicación | Solapamiento de ≥2 tokens **por substring**, no por palabra entera — más laxo que la búsqueda de productos, que sí usa token entero. Al fusionar, **la respuesta nueva se descarta**: gana la primera para siempre | `learnedFaq.ts:15-20`, `:61-64` |
| Retroalimentación | **No existe**. `FaqEntry` no tiene contador de uso ni vínculo al candidato de origen | `schema.prisma:233-241` |
| Caducidad | **No existe**. Ni `updatedAt` ni fecha de revisión. Una FAQ de "envío gratis" queda para siempre | `schema.prisma:233-241` |
| Escala de `get_faq` | Volcado completo, sin búsqueda ni tope | `tools.ts:930-939`, `catalog/faq.ts:10-12` |
| Dónde se intercepta | Antes de `ask_owner`, dentro del loop: cuesta una iteración y obliga a dos llamadas a `ask_owner` | `agent.ts:1540-1554` |
| **La fuente que hoy se pierde** | Cuando el dueño responde a mano desde el panel, no se llama `recordAskOwnerResolution` (su **único** invocador en todo `src/` es `whatsapp.ts:280`) y además `clearPendingOwnerQuestionsForConversation` **borra la fila** | `admin/conversations.ts:145-162`, `conversation/service.ts:495-497` |

El último punto es el más caro: `humanControl` es más volumen y mejor contexto que la escalación
sola, y hoy no solo no se aprende — se destruye la evidencia.

### Eje 18 — Salidas de la conversación

- `LOST` se escribe en **un solo lugar**: el modelo llamando `close_conversation` con
  `outcome: "LOST"` (`tools.ts:1274-1359`, aplicado `:1352`). Ningún job, ningún timer, ninguna ruta
  del panel lo escribe.
- Las conversaciones que se apagan solas **quedan abiertas para siempre** en el estado al que
  llegaron. `getOrCreateOpenConversation` reutiliza esa misma fila para todo mensaje futuro de ese
  cliente (`conversation/service.ts:132-141`), así que la conversación de 163 mensajes de `y1iz5l`
  va a seguir creciendo.
- La tasa de conversión solo cuenta `SOLD + LOST` como denominador
  (`analytics/service.ts:17-18`): **el abandono nunca aparece como pérdida**. Es la métrica que hoy
  le mostraría a un negocio una conversión falsamente alta.
- El watchdog de estancadas solo mira conversaciones con `humanControl: true`
  (`conversation/service.ts:595`): una conversación abandonada que manejaba el bot es invisible para
  todos los jobs.
- `CustomerStage.INACTIVO` existe en el enum (`schema.prisma:446`) y **nada lo asigna nunca**.
- Reactivación: solo posventa, y solo si el negocio configuró plantilla de seguimiento
  (`jobs/followUp.ts:8`, filtra `status: "SOLD"`). No hay reactivación de carritos abandonados ni de
  `QUOTED`/`NEGOTIATING`. Esa ausencia está correctamente resuelta respecto de la ventana de 24 h
  (siempre usa plantilla aprobada), pero el alcance es mínimo.

### Eje 19 — Ritmo y forma de la respuesta

Todo este eje está en cero.

| Capacidad | Estado |
|---|---|
| Agrupación de ráfagas (debounce) | **No implementado**. El lock serializa pero no fusiona: N mensajes seguidos = N turnos completos = N respuestas (`whatsapp.ts:62-84`) |
| Indicador de "escribiendo" | **No implementado**. No existe `typing_indicator` en el repo |
| Marcar como leído (visto azul) | **No implementado** |
| Partir mensajes largos | **No implementado**. Se manda un solo payload sin chequeo de longitud (`whatsapp.ts:737-738`) |
| Retardo humano antes de responder | **No implementado**. La única pausa es 1.200 ms **entre fotos**, y existe por colisión de renderizado, no por ritmo (`tools.ts:57-61`) |

Es lo que hace que un agente se sienta persona, es barato de implementar, y ningún guard lo cubre.

---

## 6. Árbol de causa raíz

Las 14 clases de falla del capítulo 4 y los 19 ejes del capítulo 5 cuelgan de **cinco** causas
estructurales. Ninguna se cierra con un parche más, y cada una explica por qué generó los parches
que generó.

### C1 — La transacción no tiene máquina de estados: el modelo es el estado

**Qué es:** no existe ningún lugar del sistema que sepa qué producto eligió el cliente, qué variante,
qué datos ya entregó y qué falta, mientras la venta está en curso.
`checkoutStateFromDb.ts:41-46` lo documenta literalmente.

**Síntomas que cuelgan:** F3 (repreguntar datos ya dados), F4 (pedir "de a uno" contra la regla
core), F5 (repetición casi idéntica), F13 (el cliente que vuelve repite todo), la variante olvidada,
el resumen prematuro, el `tool_choice` mal disparado del eje 16, y la imposibilidad de medir del
eje 9.

**Por qué generó parches:** si el sistema no puede saber el estado, solo puede leer lo que el modelo
escribió. De ahí salen `ASK_NAME_PATTERN`, `ASK_ID_PATTERN`, `ASK_PHONE_PATTERN`,
`ASK_DELIVERY_DATA_PATTERN`, `extractNameFromAnswer`, `extractDeliveryDataFromAnswer`,
`extractAddressFromAnswer`, `looksLikeIdOrPhone` y los detectores de `conversationHealth.ts`.

**Por qué los parches no la cierran:** todos infieren el estado a posteriori, y una inferencia sobre
prosa en español es un conjunto abierto contra un conjunto finito de reglas. Cada ajuste arregla un
caso y abre el opuesto — está escrito en el propio repo, en `learnedFaqQuality.ts`, y nunca se
generalizó a los otros 30 regex.

### C2 — Efectos laterales decididos leyendo la prosa que el modelo acaba de escribir

**Qué es:** cinco guards (G1-G5) disparan acciones reales —WhatsApp al dueño, envío de fotos,
pegado de datos de pago— porque una expresión regular encontró una frase en el texto generado. Dos
más (G6, G7) reescriben la respuesta por el mismo criterio.

**Síntomas:** F2 (promesa de foto sin envío, y su opuesto: fotos no pedidas), F6 (bucle de
identificación por foto), el mensaje autocontradictorio del eje 15, las cuatro veces registradas en
que se mandaron fotos sin que nadie las pidiera.

**Por qué generó parches:** cada falso positivo se apagó con un supresor
(`OFFER_OR_PENDING_CONFIRMATION_PATTERN`, `OPEN_CLARIFYING_QUESTION_PATTERN`,
`NON_PRODUCT_PHOTO_PATTERN`, `CUSTOMER_PHOTO_NEGATION_PATTERN`) y cada falso negativo se apagó
ampliando el patrón original. Cinco capas sobre una sola promesa.

**Por qué los parches no la cierran:** el detector y el supresor son la misma clase de herramienta
sobre el mismo texto ambiguo. G7, agregado el 2026-09-15 —un día después de la auditoría que
explicaba esto— es la prueba empírica de que el ciclo no se detiene solo.

### C3 — No hay prueba determinista de conversación completa: producción es la suite

**Qué es:** 361 pruebas que pasan en 35 segundos y no ejercitan una sola conversación de varios
turnos. Cuatro archivos llaman `generateReply`, todos de un turno.

**Síntomas:** los 55 commits sobre `agent.ts`; los comentarios-bitácora que describen incidentes con
fecha; que un cambio desplegado "de golpe rompió tres conversaciones en veinte minutos"
(`checkoutStateFromDb.ts:8-9`); que las 12 etapas de `finalizeTurn` nunca se hayan probado
compuestas.

**Por qué generó parches:** sin una red barata, el único lugar donde un cambio se valida es una
conversación real. Un incidente real produce un arreglo urgente; un arreglo urgente sin prueba
produce el siguiente incidente.

**Por qué los parches no la cierran:** `npm run regression` cuesta dinero, se corre a mano y mide el
parche, no la venta. Mientras validar cueste plata, se va a validar poco; mientras se valide poco,
producción sigue siendo la suite.

**Nota favorable:** el andamiaje para resolverlo **ya existe**.
`agent.loopExhaustion.test.ts:5-15` demuestra que `deepseek.chat.completions.create` se puede
sustituir directamente, gratis, contra una base local con un negocio de prueba. Falta el formato de
conversación grabada y las aserciones, no la infraestructura.

### C4 — La plataforma (WhatsApp) se trata como un canal de envío, no como un sistema con reglas

**Qué es:** el código habla con la Cloud API como si fuera un `fetch` a un endpoint propio. Sin
firma, sin códigos de error, sin límites de tasa, sin estados de entrega, sin ventana verificada en
todos los caminos, sin opt-out, sin calidad de número, sin ciclo de vida del token.

**Síntomas:** los 15 puntos donde un `await` fallido deja al cliente sin respuesta; el webhook sin
firma; el token que va a morir a los 60 días sin aviso; la cola sin reintentos; los 103 reinicios
que perdieron turnos en vuelo sin registro; `sent/delivered/read` descartados.

**Por qué generó parches:** cada incidente de plataforma se arregló donde apareció —un `try/catch`
acá, una cola allá, un `STALE_REPLY_MINUTES` más allá— sin una capa que sea dueña de "mandar un
mensaje de WhatsApp de forma confiable".

**Por qué los parches no la cierran:** la confiabilidad de entrega es una propiedad de una capa, no
de un `try/catch` por sitio de llamada. Mientras haya ocho lugares que llaman `sendTextMessage`
directo, va a haber ocho comportamientos distintos ante el mismo error de Meta.

### C5 — Lo específico de un negocio y de un país vive dentro del núcleo

**Qué es:** `zonasSinDocumento: ["bogota","soacha"]`, `formatCopPrice`, el patrón de pago con
`nequi|bancolombia|daviplata`, la heurística de cédula/celular colombiana, el regex de vía
colombiana, el conjunto cerrado de 5 rubros.

**Síntomas:** que Aurora Joyas —el segundo negocio, mismo país— produjera la conversación `igmt9z`;
que un negocio mexicano quede sin guard antifraude de pago; que un celular mexicano se guarde como
cédula; que el rubro 6 no reciba ninguna directiva.

**Por qué generó parches:** la regla del piloto era cierta cuando se escribió y el piloto era el
único cliente. Cada vez que apareció un caso nuevo se agregó una constante más al mismo archivo core.

**Por qué los parches no la cierran:** no hay lugar donde poner la configuración. `Business` no tiene
país, ni moneda, ni zona horaria, ni reglas de documento. Mientras el destino natural sea una
constante de módulo, ahí va a seguir cayendo.

**Causa transversal (C0):** ninguna de las cinco se detecta sola, porque no hay línea base.
No existe hoy un número contra el cual comparar ninguna mejora: ni tasa de resolución sin humano,
ni intervenciones de backstop por guard, ni costo por conversación. Por eso cada cambio se juzga por
la última conversación que alguien leyó a mano.

---

## 7. Inventario de deuda: los 41 patrones con nombre y los guards

Criterio de clasificación, según la regla de diseño acordada:

- **A — Valida un argumento contra la base antes de ejecutar.** Se queda.
- **B — Saneamiento de salida (fugas, formato).** Se queda; es barato y no decide nada.
- **C — Lee el mensaje del CLIENTE para extraer un dato.** Clase intermedia: legítima como
  intención, mal ubicada. Debe ser una herramienta que el modelo llama con el dato ya extraído y que
  el sistema valida, no un regex que corre después de la respuesta.
- **D — Lee la prosa que generó el MODELO para adivinar qué pasó.** Se va. Es la clase que no puede
  converger.

| Clase | Cuántos | Cuáles (ubicación) | Causa raíz que tapa | ¿Desaparece al arreglarla? |
|---|---|---|---|---|
| **A** | 2 | `close_conversation.paymentMethodLabel` (`agent.ts:1489`), `send_product_media.productId` (`agent.ts:1556`) | — | No: son el modelo a seguir |
| **B** | 6 | `TOOL_CALL_LEAK_PATTERN` (`:862`), `INTERNAL_STATE_PATTERN` (`:868`), `stripMarkdownEmphasis` (`:853`), `LIST_MARKER_PATTERN` (`:768`), `KEYCAP_DIGIT_PATTERN` (`:776`), `MEDIA_CAPTION_PATTERN` (`:51`) | Fuga de formato | No: se quedan |
| **C** | 13 | `SELF_INTRO_NAME_PATTERN` (`:280`), `HUMAN_REQUEST_PATTERN` (`:291`), `CHAT_NOISE_PATTERN` (`:463`), `ASK_ID_PATTERN` (`:525`), `ASK_PHONE_PATTERN` (`:526`), `ASK_DELIVERY_DATA_PATTERN` (`:531`), `MONEY_NEAR_PATTERN` (`:548`), `ID_LABEL_PATTERN` (`:549`), `PHONE_LABEL_PATTERN` (`:550`), `STREET_WORD_PATTERN` (`:588`), `NAME_PARENTHETICAL_SUFFIX_PATTERN` (`:786`), `ASK_NAME_PATTERN` (`:272`), `looksLikeIdOrPhone` (`:755`) | **C1** (el estado no existe, hay que adivinarlo del texto) | Sí, en su forma actual: pasan a ser validación de argumento de herramienta |
| **D** | 14 | `PHOTO_REQUEST_PATTERN` (`:154`), `CUSTOMER_PHOTO_REQUEST_PATTERN` (`:163`), `CUSTOMER_PHOTO_NEGATION_PATTERN` (`:165`), `PHOTO_CLAIM_PATTERN` (`:173`), `OPEN_CLARIFYING_QUESTION_PATTERN` (`:182`), `NON_PRODUCT_PHOTO_PATTERN` (`:200`), `FAKE_MEDIA_TAG_PATTERN` (`:203`), `MEDIA_TAG_STRIP_PATTERN` (`:204`), `OFFER_OR_PENDING_CONFIRMATION_PATTERN` (`:216`), `ESCALATION_CLAIM_PATTERN` (`:224`), `PAYMENT_OPTIONS_CLAIM_PATTERN` (`:233`), `SHIPPING_MODALITY_CLAIM_PATTERN` (`:239`), `CATALOG_CHECK_CLAIM_PATTERN` (`:249`), `VARIANT_DENIAL_PATTERN` (`:257`) | **C2** | **Sí, completa** |
| **D** (adicionales) | 4 | `PAYMENT_MENTION_PATTERN` (`:617`), `SHIPPING_MENTION_PATTERN` (`:661`), `ORDER_TOTAL_MENTION_PATTERN` (`:723`), `PHOTO_ID_CLARIFY_PATTERN` (`:263`) | **C2** + cifras no deterministas | Sí, al hacer que las cifras las inserte el sistema |
| **Observabilidad** | 8 | los regex de `jobs/conversationHealth.ts:29-99` | Ninguna: son detectores *post hoc* | Se quedan como métrica, nunca como reparación |
| **Calidad de FAQ** | 4 | `learnedFaqQuality.ts` | — | Se quedan |
| **Checkout** | 2 | `checkoutState.ts:78-80` | **C5** | Pasan a configuración por negocio |

**Total que desaparece al cerrar C1 y C2: 18 patrones de la clase D más la reubicación de los 13 de
la clase C.** Son 31 de 41.

Otros parches no-regex, con la causa que tapan:

| Parche | Ubicación | Tapa | ¿Desaparece? |
|---|---|---|---|
| `STALE_REPLY_MINUTES = 10` y su descarte | `whatsapp.ts:95`, `:723-735` | C4 (latencia sin control) | No, pero deja de disparar |
| Llamada final sin herramientas por loop agotado | `agent.ts:1655-1661` | C1 (el modelo da vueltas porque no sabe dónde está) | Sí |
| Intercepción de FAQ antes de `ask_owner` | `agent.ts:1540-1554` | C2 (escalar de más) | Se mueve fuera del loop |
| `honorOrRetractMediaPromise` | `agent.ts:984-993` | C2 | Sí |
| `alertOwnerOfDegradedReply` | `agent.ts:966` | C4 | No: es observabilidad correcta |
| `ACK_QUIET_MINUTES = 15` | `whatsapp.ts:89` | Duplicación de acuse | No |
| `LIST_DESCRIPTION_MAX_CHARS = 150` | `tools.ts:600-613` | Costo | No: es la mitigación correcta, falta generalizarla a `get_faq` |
| Meta-regla "cuál regla gana" en el prompt | `systemPrompt.ts:482-489` | C1 + C3 | Sí, al pasar el orden de recolección a código |

---

## 8. Qué de la documentación previa sigue vigente

### Sigue vigente (verificado contra el código de hoy)

- **`ONIX-AUDITORIA-ARQUITECTURA.md`, diagnóstico central**: el modelo es la máquina de estados.
  Confirmado y reforzado: `checkoutStateFromDb.ts:41-46` lo vuelve a documentar el 2026-09-15.
- **Fallo A** (el pedido en curso no existe): vigente, sin cambio.
- **Fallo B** (guards con efectos reales por regex): vigente y **empeorado**: eran 4, hoy son 5
  disparadores de efecto más 2 reescritores.
- **Fallo C** (composición no probada ni ordenada): vigente, 12 etapas, sin prueba de composición.
- **Fallo D** (sin prueba determinista de flujo completo): vigente, 0.
- **Fallo E** (`tool_choice` forzado demasiado amplio): vigente, sigue en OR (`agent.ts:1436-1438`).
- **Fallo F** (presupuesto de iteraciones al límite): vigente, 5 + recuperación.
- **Fallo G** (`zonasSinDocumento` en core): vigente, `checkoutState.ts:99`.
- **Fallo H** (sin agrupación de ráfagas): vigente.
- **Fallo I** (prompt por acumulación, con meta-reglas): vigente, ahora medido: 8.160 tokens.
- **Fallo J** (cierre sin venta poco desarrollado): vigente, y peor de lo descrito: la métrica de
  conversión no cuenta el abandono.
- **Capítulo 5 (FAQ aprendida)**: los 8 puntos siguen todos abiertos, incluido el 8
  (`humanControl` desperdiciado), que además **borra** la evidencia.
- **Diferenciadores** (visión, round-trip de `ask_owner`, FAQ aprendida del dueño): confirmados en
  el código; el de `ask_owner` está a medias, porque el round-trip solo funciona por WhatsApp y no
  cuando el dueño contesta desde el panel.

### Cambió desde el 2026-09-14

- Regex con nombre en `agent.ts`: 36 → **35**; regex totales: 49 → **57**.
- **Se agregó un guard nuevo de clase D** (`VARIANT_DENIAL_PATTERN`, `agent.ts:257`, `:1096-1103`)
  con efecto de reescritura, el mismo día del hallazgo que pedía no agregar más.
- `checkoutStateFromDb` ahora lee los ítems del `Order` creado (`:47-52`) — útil para postventa, no
  cierra el hueco.
- El panel muestra los hallazgos del chequeo automático (commit `c924c47`) — mejora real de
  observabilidad.

### Nunca se implementó

- **Fase 0 (línea base)** del plan anterior: no existe ninguna de las dos métricas propuestas.
- **Fases 1 a 8** del plan anterior: ninguna.
- **Fase 3 (PQR / aprendizaje desde `humanControl`)** de la hoja de ruta: abierta, y ahora se sabe
  que además destruye datos.
- El plan de checkout con Wompi: aprobado, sin ejecutar.
- El soporte de GIF: diferido.

### Documentación que cubre otra cosa

`ONIX-RELIABILITY-PLAN.md` (522 líneas) y `ONIX-ROBUSTNESS-AUDIT.md` (480 líneas) listan fallos
individuales y sus parches. Sus fases marcadas DONE se verifican en el código (validación de
`paymentMethodLabel`, bloqueo de `send_product_media`, renombrado de los archivos `*Paid.ts`). Las
fases pendientes de ese plan **ya no son la respuesta correcta**: proponen más validaciones puntuales
sobre la misma arquitectura. Deben subordinarse al plan maestro, no ejecutarse en paralelo.

`ONIX-CONVERSATIONS-GROUPING-PLAN.md` y `ONIX-CRM-REORG-PLAN.md`: implementados, sin conflicto.
`design/ONIX-REDESIGN-PLAN.md`: rediseño visual, ortogonal a todo lo anterior.

---

## 9. Riesgos que pueden hundir el producto en los próximos 90 días

Ordenados por probabilidad × impacto.

| # | Riesgo | Probabilidad | Impacto | Evidencia | Mitigación mínima |
|---|---|---|---|---|---|
| R1 | **El token de WhatsApp del piloto expira a los 60 días y el bot queda mudo sin aviso** | **Alta** (es una fecha, no un evento) | El piloto deja de funcionar; nadie se entera hasta que un cliente reclama | `whatsapp/embeddedSignup.ts:6-11`; sin columna de expiración, sin detección del error 190 | Guardar la fecha de expiración, alertar a 7 días, o pasar a token de System User permanente |
| R2 | **Webhook sin firma**: cualquiera que conozca un `phone_number_id` puede inyectar mensajes de cliente falsos, gastar el presupuesto de IA del negocio y disparar creación de pedidos | Media | Fuga de gasto, pedidos falsos, y un incidente de seguridad frente a un cliente | `whatsapp.ts:368`, `:376`, `:420`; `index.ts:17` | Capturar el cuerpo crudo solo en esa ruta y verificar HMAC |
| R3 | **Pérdida silenciosa de mensajes en cada reinicio** (103 registrados) | **Alta** | Clientes sin respuesta, sin rastro; el dueño no puede ni saber que pasó | `index.ts` sin `SIGTERM`; `whatsapp.ts:369` responde 200 antes de procesar | Apagado ordenado + registro de turnos perdidos |
| R4 | **Bloqueo o caída de calidad del número de WhatsApp** por ausencia de opt-out y de monitoreo de calidad, con plantillas de marketing habilitadas | Media | Pérdida del canal completo del negocio; en Meta esto no se apela rápido | Sin manejo de STOP/BAJA ni de 131050; `change.field` nunca leído (`whatsapp.ts:374`) | Opt-out por palabra clave + leer los webhooks de calidad |
| R5 | **Tokens en texto plano + IDOR + sin auditoría**: un incidente de acceso a la base compromete el WhatsApp de todos los clientes a la vez | Baja-Media | Terminal para la marca | `schema.prisma:51`; `admin/conversations.ts:170-177` | Cifrado de tokens en reposo y cierre del IDOR |
| R6 | ~~Costo por conversación fuera de control~~ → **rebajado con datos reales**: USD 0,0127 por conversación, caché al 88,3 %. Queda el riesgo acotado de `VISION_ESCALATION` (Anthropic, 21 % del costo con 1 % de las llamadas, nunca cachea) | Baja | Acotado | capítulo 3 bis | Tope por negocio a las escalaciones de visión; medir por negocio antes de subir de plan |
| R7 | **Incumplimiento de Habeas Data / LFPDPPP**: sin aviso, sin consentimiento, sin retención, sin supresión | Media | Sanción de la SIC y, más probable, un cliente empresarial que exige el contrato de encargo y no lo hay | no existe ruta de supresión; `admin/business.ts:192` | Aviso de tratamiento, contrato de encargo, ruta de supresión por cliente |
| R8 | **Un segundo negocio real reproduce `igmt9z`**: el bot vende sin que el negocio tenga configurado lo necesario | **Alta** | Cada negocio nuevo empieza con una conversación quemada | `configHealth.ts:22-46` informa pero no bloquea | Compuerta de configuración: sin métodos de pago, no se entra al flujo de cierre |
| R9 | **Cola de salida envenenada**: un ítem que falla bloquea los mensajes de ese cliente para siempre, sin alerta | Media | Un cliente deja de recibir todo | `whatsapp.ts:114-117`; `schema.prisma:274-288` sin contador de intentos | Contador de intentos + dead-letter + alerta |
| R10 | **Dos instancias de pm2**: el lock en memoria deja de funcionar y vuelven las respuestas duplicadas y los recordatorios dobles | Baja | Vergüenza pública, difícil de diagnosticar | `whatsapp.ts:57-58` (afirmado en comentario, no forzado); `index.ts:62-75` | Fijar `exec_mode: fork` en un `ecosystem.config.js` versionado |

---

## 10. Decisiones pendientes del dueño

Ninguna de estas la resuelve esta auditoría.

| # | Decisión | Opciones | Consecuencia |
|---|---|---|---|
| D1 | Consentimiento para persistir datos del cliente final | (a) persistir en silencio, (b) aviso único al primer contacto, (c) preguntar cada vez | Bloquea inyectar el nombre guardado al prompt. Hoy el bot vuelve a preguntar el nombre por esto. (b) es lo que exige la ley colombiana y es un mensaje extra por conversación |
| D2 | ~~Lectura de la base de producción~~ | **Resuelta 2026-09-15**: autorizada la lectura agregada de solo lectura. Datos en el capítulo 3 bis | — |
| D3 | Alcance de México | (a) ahora, (b) después de Colombia estable, (c) nunca | Cambia si la Fase de configuración por negocio incluye país/moneda/zona horaria desde el principio o no |
| D4 | Modelo de precios frente al costo real por conversación | — | Sin la medición de R6 no se puede decidir |
| D5 | Rol `EMPLOYEE`: qué puede hacer | (a) solo bandeja, (b) bandeja + catálogo, (c) todo menos equipo y WhatsApp | Define dónde va `requireOwner` en las rutas que hoy no lo tienen |
| D6 | Retención de conversaciones y media en S3 | (a) indefinida, (b) 12 meses, (c) 24 meses | Costo de S3 y exposición legal |

---

## 11. Brecha de mercado

Verificado con búsqueda web en esta sesión; cada afirmación tiene fuente. Ya existe un artefacto
publicado de comparación ("Onix vs. el mercado",
`https://claude.ai/artifact/SJ1Ttx48SxASn7vRACPszM`, última actualización 2026-09-10): **debe
actualizarse en su lugar, no duplicarse.** Está desactualizado en el eje más importante, porque es
anterior al lanzamiento global de Meta Business Agent.

### 11.1 El hecho que cambia el tablero

**Meta lanzó globalmente su propio agente el 3 de junio de 2026 y empezó a cobrarlo el 1 de agosto
de 2026.** *Meta Business Agent* responde preguntas, recomienda productos, agenda citas, califica
prospectos y deriva a un humano, sobre WhatsApp, Instagram DM, Messenger y Business Suite. Se
alimenta de "información del negocio, FAQs, sitios web y archivos", acepta APIs y webhooks propios,
y puede pasar el control entre el agente y tu app.
(https://techcrunch.com/2026/06/03/metas-ai-agent-for-whatsapp-business-is-now-available-globally/ ·
https://developers.facebook.com/documentation/meta-business-agent/overview)

- Precio: **USD 2,00 por millón de tokens**, tarifa global única. Un mensaje típico ≈20-25k tokens,
  o sea **4-5 centavos de dólar por mensaje**. Meta factura directo al negocio.
  (https://socialday.live/features/meta-business-agent-billing-starts-1-august-at-2-per-million-tokens)
- En la app de WhatsApp Business (sin código) viene incluido en los planes Premium.
- Estuvo **dos años en piloto en India, México y Brasil** antes del lanzamiento global: México es
  uno de los tres mercados donde Meta tiene más datos locales. Eso afecta directamente el plan de
  expansión.

**Consecuencia directa para el diagnóstico:** "una IA que contesta tu WhatsApp" dejó de ser un
producto vendible por sí solo. Meta lo regala en la app y lo cobra a 4 centavos por mensaje en la
API. Todo posicionamiento de Onix construido sobre esa frase está muerto.

**Dónde Meta es débil, y es la apertura de Onix:** las conversaciones se quedan en la
infraestructura de Meta y se usan para entrenar sus modelos; el nivel autoservicio no corre flujos
propios ni automatizaciones avanzadas; **no procesa transacciones**; y los disparadores de traspaso
a humano **los decide Meta y no son configurables** — el agente se silencia y suelta el hilo.
(https://www.wati.io/en/blog/meta-business-agent/ ·
https://www.sigserve.com/blog-meta-business-agent-handoff.html)

### 11.2 Matriz de capacidades

| Competidor | Precio de entrada | Unidad de cobro | Agente IA | Difusión/campañas | Catálogo y carrito nativos | Pago en chat CO/MX | Bandeja de equipo | API pública | Multicanal |
|---|---|---|---|---|---|---|---|---|---|
| **Meta Business Agent** | **USD 0** (app) / **$2 por 1M tokens** (API) | Token | Autónomo | n/a | **Sí, es la capa nativa** (carrusel, multiproducto, carrito) | **No** (WhatsApp Pay nativo solo IN/BR/SG) | Traspaso automático, **no configurable** | Sí (conectores + webhooks) | WA + IG + Messenger |
| **Wati** | USD 59/mes | Asiento + contacto + recargo 15-25% sobre Meta | Autónomo (KnowBot, modelo propio opcional) | **Sí, núcleo** | Sí (catálogo WA) | No | Sí, 3-10 asientos | Sí | WhatsApp |
| **Zoko** | USD 49,99/mes + $0,015/conversación | Conversación + agente IA + resolución | Autónomo, desagregado y medido (Sello cobra 3% del pedido) | **Sí, núcleo** | Sí, atado a Shopify | No (checkout Shopify) | Agentes ilimitados | Sí | WA + FB + IG (+$9,99) |
| **Yalo** | Solo cotización | Custom | Autónomo ("Oris", carritos pre-armados) | Sí | **Sí, con pago** | Negociado, no publicado | Sí | Sí | WA, app, **voz**, WeChat |
| **ManyChat** | USD 17/mes (WA exige Pro $39) | Contacto activo | **Híbrido**, flujos con IA adentro | Sí | Limitado | No | Limitada | Sí (fuerte en Meta Ads) | **IG, TikTok, Messenger, Telegram, WA** |
| **Cliengo** | USD 45/mes (**sin API de WhatsApp**; HSM desde $259) | Conversación | Autónomo, **entrenado en español LATAM** | Desde $259 | No | No | 2-5 operadores | Sí | Multicanal + widget web |
| **Aivo** (hoy Engageware) | Solo cotización | Custom | Autónomo + voz | Sí | Limitado | No | Sí (Aivo Live) | Sí | Omnicanal + voz |
| **Intercom (Fin)** | USD 29/asiento + **$0,99 por resolución** | Asiento + resolución | Autónomo | Sí | No | No | **El mejor** | **El mejor** | Chat, email, voz, WA, SMS |
| **Treble.ai** (LATAM) | ~USD 99/mes | Suscripción | Campañas primero | **Sí, es el producto** | No | No | Limitada | Sí | **Solo WhatsApp** |
| **Onix (hoy)** | COP 36.000/mes (~USD 9) | Plan fijo | **Autónomo** | **No** | Catálogo propio, **no usa las primitivas nativas de WA** | **No** (plan Wompi aprobado, sin ejecutar) | Roles sí, **asignación no** | **No** | **Solo WhatsApp** |

### 11.3 Table stakes: lo que Onix necesita solo para poder venderse

| Capacidad | Por qué es table stakes | Onix |
|---|---|---|
| Agente LLM autónomo | Todos lo tienen, incluido el gratuito de Meta | **Sí** |
| Traspaso a humano | Universal | **Sí** |
| Bandeja de equipo con **asignación** | Wati 3-10 asientos, Cliengo 2-5, Zoko ilimitados; Wati vende precisamente esto como el techo de Meta | **Parcial**: roles sí, asignación no (no existe `assignedTo`) |
| **Difusión y campañas con plantillas** | Wati y Zoko lo tratan como *el* producto | **No.** Es la razón más citada por la que un comprador descarta una herramienta de WhatsApp |
| Analítica y reportes | Universal | **Sí** |
| **Catálogo, carrusel y carrito nativos de WhatsApp** | Meta los regala a nivel de protocolo | **No los usa** |
| **API pública e integraciones** | Wati 10k-20M llamadas/mes, Zoko API en todos los planes | **No** |
| **Sincronización con Shopify/WooCommerce** | Zoko es nativo Shopify; Wati lo vende a $4,99 | **No**: carga manual de productos |
| **Multicanal, al menos Instagram DM** | Meta lo da gratis en los tres canales | **No** |
| Español LATAM de calidad | Cliengo y Yalo lo venden explícitamente | **Sí** |
| Transcripción de notas de voz | Ya es estándar de categoría | **Sí** |
| **Cumplimiento: opt-in, verificación de negocio, URL de privacidad, IA acotada al negocio** | Desde el 15 de enero de 2026 Meta **prohíbe los chatbots de IA de propósito general** en la Business Platform; la IA de tarea específica sigue permitida | **Parcial.** Onix está del lado correcto de la norma, pero su prompt debe mantenerse acotado al negocio: un Onix que conteste "¿qué clima hace?" es una violación de términos (https://respond.io/blog/whatsapp-general-purpose-chatbots-ban) |

### 11.4 Diferenciadores reales

| Capacidad | Evidencia | Veredicto |
|---|---|---|
| **Preguntarle al dueño por WhatsApp en medio de la conversación y retomar con la respuesta** | **Cero competidores lo tienen.** El patrón del mercado es escalar a una bandeja aparte y soltar el hilo; el agente de Meta se silencia con disparadores no configurables | **El diferenciador más fuerte y más defendible.** Es exactamente lo correcto para un negocio colombiano de 1 a 5 personas, cuya base de conocimiento vive en la cabeza del dueño y no en un centro de ayuda |
| **FAQ que se aprende de la respuesta real del dueño** | **Cero competidores.** Lo más cercano es "knowledge gaps" de Intercom, que solo redacta borradores de artículos para que un humano los apruebe. Wati y Meta reentrenan con archivos y URLs que vos subís — cosa que un negocio pequeño nunca hace | **Fuerte.** Foso acumulativo: el producto mejora por cliente sin trabajo de configuración, que es justo la fricción de onboarding que mata al SaaS para pymes |
| **Checkout en chat con rieles LatAm** (Nequi/PSE/Wompi/contraentrega; SPEI/OXXO/Mercado Pago) | WhatsApp Pay nativo **no existe en Colombia ni México**; Zoko depende de Shopify; el agente de Meta **no procesa transacciones** | **Fuerte y con ventana de tiempo.** Dos integraciones (Wompi + Mercado Pago) cubren los dos mercados |
| **Visión sobre fotos que manda el cliente** | Capacidad emergente de categoría, **ningún competidor de esta lista la anuncia como funcionalidad**; el estado del agente de Meta no se pudo verificar | **Real pero se angosta.** Venderlo ahora, no construir la estrategia de 2027 sobre esto |
| **Confirmación de pago por el dueño con botones Sí/No** | Nadie lo modela. Es el comportamiento real del comercio pyme colombiano: captura del comprobante, el dueño la mira | **Diferenciador silencioso.** Se combina directamente con la visión (leer el comprobante) y con contraentrega, donde por definición no hay API de pago |
| **Precio por debajo de USD 45/mes con API de WhatsApp incluida** | Cliengo cobra $259 para habilitar la API de WhatsApp; Wati arranca en $59 más recargo | **Oportunidad, con un agujero con forma de Meta adentro** |
| **El negocio es dueño de sus conversaciones** | Las conversaciones del agente de Meta se quedan en su infraestructura y se usan para entrenar sus modelos | **Argumento de venta frente a Meta específicamente** |

### 11.5 Economía de la plataforma en 2026 (afecta el precio de Onix)

De la página de precios de Meta
(https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing):

- **Cobro por mensaje desde el 1 de julio de 2025**, ya no por conversación. Solo se cobra la
  plantilla **entregada**.
- **Ventana de servicio de 24 h: todos los mensajes que no son plantilla son gratis adentro.**
  Las plantillas de *utility* también son gratis dentro de la ventana abierta.
- **Free Entry Point**: un usuario que llega por un anuncio Click-to-WhatsApp habilita **72 horas
  de mensajería gratuita de cualquier tipo** si el negocio responde dentro de las primeras 24 h. Es
  el camino de adquisición más barato de todo el modelo y hoy Onix no lo explota.
- **Se eliminó la cuota de 1.000 conversaciones gratis al mes.**
- **Los niveles de volumen se agregan a nivel de portafolio de negocios**, no por número: para un
  revendedor multi-tenant, agrupar a todos los clientes bajo un portafolio **baja la tarifa de
  todos**. Es una ventaja estructural de Zaqi como Tech Provider que hoy no se está usando.
- Colombia subió tarifas de *utility* y *authentication* desde el 1 de octubre de 2025; México bajó
  las de *marketing*.
- **Límites de mensajería a nivel de portafolio desde octubre de 2025**, con base de 100.000/día
  para negocios verificados. La calificación de calidad cae cuando la tasa de opt-out supera ~2 %
  (https://chatarmin.com/en/blog/whats-app-messaging-limits) — y Onix **no tiene opt-out**.

**No verificado, no usar sin comprobar**: las tarifas exactas por mensaje para Colombia y México.
La tabla por país no se pudo leer y las fuentes secundarias se contradicen. Hay que sacar el tarifario
vivo desde Business Manager antes de publicar cualquier número de economía unitaria.

### 11.6 Rieles de pago para el checkout en chat

- **Colombia: Wompi (grupo Bancolombia) resuelve todo con una sola integración** — tarjetas, PSE,
  Nequi, Daviplata, botón Bancolombia y efectivo (Baloto/Efecty). Comisión plana **2,65 % + $700 COP
  + IVA**, solo sobre transacciones exitosas. Además tiene enlaces de pago sin código que ya
  funcionan por WhatsApp hoy
  (https://mentoracolombia.com/pasarelas-de-pago-colombia-2026-comisiones-wompi-bold-mercadopago/).
  Nequi tiene API propia si hiciera falta (https://www.nequi.com.co/negocios/apis).
- **México: Mercado Pago es el espejo exacto de Wompi** — Checkout API cubre tarjetas, **SPEI** y
  **OXXO** en una sola integración; ~3,49 % + $4,00 MXN + 16 % de IVA sobre la comisión
  (https://www.mercadopago.com.mx/developers/es/docs/checkout-api-orders/overview).
- **CoDi: no construir.** Banxico reconoce que no despegó y está reestandarizando
  (https://www.banxico.org.mx/sistemas-de-pago/codi-avances-banco-mexico.html).
- **Contraentrega no tiene API** ni la va a tener: es un problema de logística y conciliación. El
  flujo actual de "el dueño confirma" es el patrón correcto para ese caso.

Dos integraciones cubren los dos mercados objetivo.

### 11.7 Lectura estratégica

El problema de Onix **no es falta de funcionalidad**: tiene más que varios de los competidores de su
rango de precio. El problema es doble:

1. **Hacia adentro**: la transacción no tiene máquina de estados, y eso se paga en cada turno
   (capítulos 4 a 7 de este documento).
2. **Hacia afuera**: el terreno donde Onix competía —"una IA que atiende tu WhatsApp"— lo ocupó Meta
   en junio de 2026, gratis. Lo que queda defendible es exactamente lo que Meta no puede hacer:
   **transaccionar en Colombia y México**, **preguntarle al dueño y retomar**, y **aprender de lo
   que el dueño contesta**. Los tres son, además, las tres cosas que este diagnóstico encontró a
   medio construir.
