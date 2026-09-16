# Onix — pendientes

Todo lo que sabemos que falta y **no** se está trabajando ahora. Si algo se cierra, se saca
de acá; si aparece algo nuevo, se agrega el mismo día que se descubre.

Última revisión: 2026-09-16.

---

## 1. Bloqueador de fase

### La regresión de `saleStateEnabled`

`Business.saleStateEnabled` está en `false` en los tres negocios **a propósito**: cuando se
encendió, el bot dejó de cerrar ventas. La regresión nunca se diagnosticó, se esquivó
apagando la bandera.

Desde el 2026-09-16 `SaleState` se llena igual con la bandera apagada (proyección del
servidor), pero la bandera sigue controlando qué herramientas ve el modelo
(`buildTools`, `src/ai/tools.ts:557`) y qué variante del prompt recibe
(`systemPrompt.ts:464`), que es justo lo que rompió el cierre.

**Bloquea la Fase 13**, que genera el enlace de pago desde `SaleState`. Es una sesión de
diagnóstico, no de construcción: hay que encontrar por qué con la bandera encendida el bot
no llama `close_conversation`.

---

## 2. Piezas del plan de catálogo y medios

Ver `ONIX-PLAN-CATALOGO-Y-MEDIOS.md`.

- **Pieza 6 — estado por cliente.** Cerrada el 2026-09-16: el estado comercial del cliente
  (`src/orders/customerCommerceState.ts`) entra a cada turno como dato estructurado, con los
  pedidos abiertos de **cualquier** conversación. Ver la sección 12 del plan.

- **La pregunta de confirmación determinista antes de cancelar.** Queda abierta **a propósito**.
  El plan la pedía como "cuando el mensaje del cliente es sobre cancelar y hay un pedido abierto,
  la pregunta de confirmación se hace de forma determinista", y esa condición es una lectura de
  prosa: viola la regla de admisión de efectos requeridos (sección 6 del plan). Hoy la
  confirmación la sostiene una directiva del prompt (`CANCELAR UN PEDIDO`), o sea el modelo.

  **El diseño que sí cumpliría la regla, para cuando el dueño lo decida:** invertir el disparador.
  El servidor no necesita saber que el cliente pidió cancelar; le alcanza con garantizar que nunca
  se cancela en el mismo turno en que se pide. Disparador: la llamada a `cancel_order` sobre un
  pedido abierto (un evento estructurado, no prosa). La primera llamada no cancela: escribe
  `Order.cancelRequestedAt` (columna nueva, aditiva y nullable) y devuelve el pedido para que el
  agente pregunte. Una llamada posterior cancela **solo** si `cancelRequestedAt` es anterior al
  arranque del turno actual, o sea si hubo un mensaje del cliente en el medio; la solicitud se
  limpia al final de cualquier turno que no la use, así que no queda una autorización vieja
  esperando. Verificable con un `SELECT`, y el fallback no tiene modelo adentro: si nada pasa, el
  pedido sigue vivo, que es el estado seguro.

  **Por qué no entró en la fase de la Pieza 6:** cambia el contrato de `cancel_order` —hoy la
  primera llamada cancela— y con él lo que espera una prueba existente
  (`src/ai/tools.test.ts`, "cancel_order cancels a pending order and notifies the owner", que
  afirma `{ canceled: true }` en la primera llamada). Cambiar esa prueba para acomodar el cambio
  es exactamente lo que este repositorio no admite sin que el dueño lo decida primero.

---

## 3. Fases del plan maestro

Ver `ONIX-PLAN-MAESTRO.md`, sección 4.

- **Fase 12 — ciclo de aprendizaje.** Siete sub-items. El primero es el que vale: cuando el
  dueño responde a mano desde el panel, esa respuesta hoy se tira (se borra el
  `PendingOwnerQuestion` en vez de marcarlo resuelto). Es más volumen y mejor contexto que la
  escalación por WhatsApp, y es el subsistema que ya rinde: 12 de 24 entradas de FAQ salieron
  de ahí. Conviene partirla en dos sesiones: el ítem 1 solo, y después los otros seis.
- **Fase 13 — checkout Wompi/Mercado Pago.** Bloqueada por la sección 1. Además necesita
  decisiones del dueño que no son técnicas: cuenta de Wompi, contrato, comisión
  (2,65 % + $700 COP + IVA).
- **Fase 14 — table stakes.** Difusión con plantillas y segmentos, asignación de
  conversaciones a un miembro del equipo (`assignedTo` no existe en ningún modelo), y
  primitivas nativas de WhatsApp (catálogo, multiproducto, carrusel). Se cruza con el trabajo
  de interfaz.

---

## 4. Defectos conocidos, chicos

- **El descarte por `humanControl`.** `service.ts:457` pone la bandera durante el turno y
  `routes/whatsapp.ts` descarta la respuesta si quedó en `true` mientras se generaba.
  Resultado: los turnos donde corre `ask_owner_about_photo` o `flag_conversation_intent`
  dejan al cliente sin ninguna respuesta. Medido el 2026-09-16: bajo volumen (1 de 2
  conversaciones, y esa no necesitaba respuesta). Real pero chico.
- **`tsconfig` compila los archivos de prueba.** `npm run build` los incluye y los deja en
  `dist/`. Dos consecuencias: rompió el despliegue del 2026-09-16 por cuatro huérfanos de un
  rename viejo, y una copia compilada de un test de costo real en `dist/` ya facturó a
  DeepSeek una vez (ver `CLAUDE.md`). El build de producción no tiene por qué compilar
  pruebas.
- **No hay forma de probar un cambio de prompt.** La suite de replay (`src/ai/replay/`) mockea
  `deepseek.chat.completions.create` y devuelve respuestas grabadas (`toChatCompletion` en
  `replay.ts`): el prompt se arma, se manda y se descarta. Por construccion, **ningun cambio en
  `src/ai/prompts/systemPrompt.ts` puede mover un fixture**. Hoy el unico instrumento que valida
  una edicion del prompt es `npm run regression`, que llama a DeepSeek de verdad y cuesta plata,
  asi que cada cambio de prompt o se paga o se despliega a ciegas. Descubierto el 2026-09-16 al
  borrar directivas: el prompt de esa fase nombraba la suite de replay como red de seguridad, y
  no lo es. Vale la pena un modo de replay que compare el prompt renderizado contra una version
  aprobada (snapshot), que es gratis y detecta cambios no intencionales, aunque no diga como
  reacciona el modelo.

- **`scripts/` no pasa por el chequeo de tipos.** `tsconfig.json` tiene `"include": ["src"]`, asi
  que `npx tsc --noEmit` da limpio con scripts rotos. El 2026-09-16 se descubrio pagando una
  corrida de regresion: `generateReply` paso a devolver `{ text, blocks }` y los dos llamadores de
  `scripts/` quedaron sin actualizar (`run-regression-suite.ts`, `record-replay.ts`). Se arreglaron,
  pero la causa sigue: cualquier cambio de firma vuelve a romperlos en silencio hasta que alguien
  pague una corrida.

- **Advertencia `MemoryStore` en el log de arranque.** El panel usa `PgSession`
  (`src/auth/sessionMiddleware.ts:23`), así que las sesiones sí persisten. La advertencia sale
  de otro lado y no está explicada.
- **`"Contra entrega total"` no está cargada como forma de pago.** El guard de
  `close_conversation` la rechaza correctamente, pero si el negocio la ofrece de verdad hay
  que agregarla en el panel, sección Pagos.
- **La confirmación vencida desaparece del panel.** Al vencer, la fila sale de la tarjeta
  "Ventas esperando que confirmes el pago" porque esa consulta filtra por
  `pendingConfirmationAskedAt`. Queda como `AgentIncident` y como conversación en control
  manual, así que no se pierde, pero deja de verse donde uno la busca.

---

## 5. Los siete defectos diferidos del plan maestro

Están detallados en la memoria (`onix-pendientes-post-15-fases`). Resumen:

1. Pedidos duplicados por cliente (`getOrderByConversationId` chequea por conversación, nunca
   por cliente).
2. `productId` semántico: el modelo manda fotos del producto equivocado cuando no hubo
   búsqueda nueva ese turno. Fixture `y1iz5l` en `knownFailing`.
3. F1: el modelo escribe "ya le avisé al equipo" sin llamar `ask_owner`. Fixture `igmt9z` en
   `knownFailing`.
4. **Medios por enlace de S3** (error 131053): se le manda a Meta una URL prefirmada y a veces
   Meta no la puede descargar. El arreglo es subir el archivo al endpoint `/media` de Meta y
   mandar el id. Sigue apareciendo en los logs.
5. Fase 4 sin pruebas. Lo más crítico sin probar es el escape por `ownerQuestionTimeoutHours`.
6. `SaleState.customerName` queda en `null` aunque `Customer.name` sí se guarda.
7. `address` mezcla ciudad, barrio y calle en un solo campo.

---

## 5b. Datos mal cargados en el catálogo (lo arregla el dueño desde el panel, no el código)

Encontrado el 2026-09-16 mirando el turno de las 22:25:16 UTC.

- **"Smartwatch serie 12 mini"** — la línea 7 de su descripción dice `Cargador les (WhatsApp,`.
  Es un pegado de dos columnas que quedó entreverado al cargar el producto. Hay que reescribir
  esa línea desde el panel.

No se limpia desde el código, y es a propósito: una descripción es texto que escribió el
negocio, y un limpiador automático tendría que adivinar qué quiso decir. Eso es lectura de
prosa, que es exactamente la clase de arreglo que este repositorio no admite. Vale la pena
revisar el resto de las descripciones de ese negocio por el mismo pegado.

---

## 5-bis. Dos límites conocidos del precio acordado (2026-09-16)

Los dos se dejaron así a propósito y ninguno bloquea la fase. Van anotados para no
redescubrirlos.

1. **La primera pregunta de precio le llega a la dueña en una sola línea.** Sale por el canal de
   alerta al dueño (`sendOwnerAlert`), que la manda como plantilla aprobada, y el cuerpo de una
   plantilla de Meta rechaza saltos de línea: `src/whatsapp/client.ts` los colapsa a espacios
   (error #132018). La lista numerada de productos con su precio queda corrida en un renglón. Las
   respuestas siguientes del servidor (repregunta, propuesta, confirmación) sí van como texto plano
   y conservan el formato. Arreglarlo bien es darle a esa alerta su propia plantilla con varios
   parámetros, o mandar la plantilla corta y el detalle como texto aparte cuando la ventana esté
   abierta.

2. **El panel muestra la venta abierta, y "abierta" quiere decir `SaleState.items`.** Eso lo
   escribe el servidor cuando corre `set_order_item` o `show_order_summary`; antes del primer
   resumen, una conversación no tiene ítems anotados y el bloque de precio especial sale vacío.
   Para ese caso el camino que ya existe es "Cerrar venta", que arma el pedido a mano. Bajar el
   momento en que la venta queda anotada es un cambio de otra fase.

---

## 6. Cerrado recientemente

Para no volver a abrirlos por error.

- **2026-09-16** — Comprobante de pago: el dueño queda avisado y se le insiste hasta que
  responda, con escalera de canales y tope de plantillas (`d2087a7`, `301ee87`).
- **2026-09-16** — Catálogo y fotos: los compone el servidor, no el modelo (`472ac09`).
- **2026-09-16** — El reloj de los recordatorios: `ownerReminderMinutes` se cumple de verdad
  y un despliegue ya no atrasa nada (`301ee87`).
- **2026-09-16** — Tope de subida alineado con los límites reales de WhatsApp.
- **2026-09-16** — El precio acordado: un descuento que la dueña autoriza es un dato en la base
  y es el que se cobra, no una frase en el chat que el agente tenía que recordar.
