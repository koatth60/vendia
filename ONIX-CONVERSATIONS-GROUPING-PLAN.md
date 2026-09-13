# Plan: agrupar conversaciones por cliente + revisión de etiquetas

Fecha: 2026-09-13. Estado: **aprobado, no iniciado**.

## Problema

Panel de administración (`Conversaciones`) muestra una fila por `Conversation`, no por
cliente. Un cliente que vuelve a escribir después de que su venta cerró (status
SOLD/LOST) crea una `Conversation` nueva (`getOrCreateOpenConversation`,
[src/conversation/service.ts:14](src/conversation/service.ts:14)), así que el mismo
nombre aparece repetido en la lista (Fabiola, Carlos, Ximena...). Del lado del cliente
en WhatsApp se ve como un solo chat siempre - la confusión es solo del panel.

## Decisión de diseño

**No tocar el modelo de datos.** Una `Conversation` por ciclo de venta sigue siendo
correcto: `Order.conversationId` es `@unique`, el resumen de contexto/historial del bot
vive por conversación, y jobs/analytics/embudo filtran por `status notIn [SOLD, LOST]`.
Convertir esto en una sola fila eterna por cliente rompería todo eso.

El arreglo es de **presentación**: agrupar la lista y el hilo por cliente, sin cambiar
cómo se crean/cierran conversaciones. Lógica de negocio, prompts de Onix y esquema
Prisma quedan intactos.

## Decisiones tomadas

1. **Historial**: hilo continuo con separadores por ciclo cerrado
   (`──── Venta cerrada · 11 sep · Pedido #123 ────`), no una vista aparte de
   "conversaciones anteriores". Carga perezosa: solo el ciclo activo al abrir, un
   ciclo anterior por cada scroll-up / clic en "ver más".
2. **Distintivo de recurrente**: texto discreto junto a la hora (ej. "3 compras"), no
   un badge de color más - la fila ya tiene suficientes.
3. **Mensaje del dueño a una venta ya cerrada**: entra a esa conversación cerrada
   (comportamiento actual, sin cambio). Si el cliente responde, ahí sí nace el ciclo
   nuevo.
4. **Badge de intent huérfano** (`flag_conversation_intent` deja el intent puesto
   hasta que la conversación cierra, aunque el dueño ya resolvió el PQR desde el
   panel): se agrega una ✕ en el badge para quitarlo a mano. Explícito, no se
   auto-borra por accidente al devolver el chat al bot.

## Fase 1 - Backend: fila por cliente

`src/conversation/service.ts`

- `listCustomerThreadsForBusiness(businessId)`: agrupa `Conversation` por `customerId`.
  Cada fila: `customerId`, nombre/teléfono/tags, `activeConversationId` (la que no está
  SOLD/LOST; si no hay ninguna abierta, la más reciente), `status`/`intent`/
  `humanControl` de esa conversación, `lastMessage` y `updatedAt` globales del cliente,
  `unreadCount` sumado de todas sus conversaciones, `orderCount`, y `cycles:
  [{id, status, updatedAt}]` liviano para que el front pueda parchear sin refetch.
- `formatConversationRow` se conserva sin cambios (la usan los emits existentes). Se
  agrega `formatCustomerRow` aparte.

## Fase 2 - Backend: hilo unido

- `getCustomerThreadForBusiness(businessId, customerId, { before?: conversationId })`:
  mensajes del ciclo activo (o del ciclo pedido con `before`), cada mensaje con su
  `conversationId`; además `cycles` con metadata de cierre (fecha, pedido, total) para
  pintar los separadores.
- Carga perezosa por lo mismo que hoy limita el hilo: `getConversationForBusiness`
  firma una URL S3 por cada media - unir 5 ciclos de golpe multiplicaría esas firmas.
- Abrir el hilo pone `unreadCount = 0` en **todas** las conversaciones del cliente (hoy
  solo en la que se abre).
- Nuevos endpoints en `src/routes/admin.ts`: `GET /api/customers`,
  `GET /api/customers/:id/thread`. Los `/api/conversations/*` actuales (handoff,
  mensajes, close-sale, extract-sale-details) **no cambian** - todos siguen operando
  sobre un `conversationId`, que sigue siendo `activeConversationId`.

## Fase 3 - Realtime

`src/realtime/events.ts`

- Agregar `customerId` al payload de `message:new` (hoy solo lleva `conversationId`;
  sin esto el front necesitaría un mapa frágil conversationId→customerId).
- `conversation:new` para un cliente que ya tiene fila en la lista = **actualiza** esa
  fila en vez de insertar una nueva. Este es el bug visible de hoy.

## Fase 4 - Frontend (`public/admin/index.html`)

- Fila pasa a `data-customer-id` + `data-active-conversation-id`,
  `onclick="openCustomer(customerId)"`.
- `openConversation` se convierte en `openCustomer`: pinta el hilo unido con
  separadores, deja `currentConversationId = activeConversationId`.
- Enviar mensaje, tomar el chat, cerrar venta, extraer detalles de venta: sin cambios -
  todos siguen leyendo `currentConversationId`.
- `bumpConversationRow` / `setRowUnreadCount` pasan a operar por `customerId`, con un
  mapa local `conversationId → customerId` para traducir eventos de socket que llegan
  con `conversationId`; `loadConversations()` sigue de respaldo si la fila no está en
  el DOM.
- Contador de la pestaña `Conversaciones` pasa a ser clientes únicos, no filas.
- `pollConversation` sigue apuntando solo al ciclo activo (más barato que repolear el
  hilo completo).

## Fase 5 - Revisión y arreglo de etiquetas (hallazgo 2026-09-13)

Encontrado mientras se revisaba el render de la lista:

| # | Problema | Ubicación |
|---|---|---|
| 1 | `flag_conversation_intent` prende `intent` y `humanControl` en la misma llamada → toda fila con un intent muestra 2 badges; con `SOLICITA_AGENTE` sale el emoji 🙋 **dos veces** (badge de intent + badge de "en vivo") | [src/ai/tools.ts:964-965](src/ai/tools.ts:964) |
| 2 | Badge "🙋 En vivo" (humanControl) usa el mismo texto que el indicador "● En vivo" de socket conectado, arriba a la derecha - dos conceptos distintos, misma etiqueta | [public/admin/index.html:2266](public/admin/index.html:2266) |
| 3 | Colores hardcodeados (`#fee2e2`, `#fef3c7`, `#e0e7ff`, `#92400e`, `#991b1b`, `#3730a3`) en vez de las variables del tema - ya hay deriva de la paleta declarada en `:root` | [public/admin/index.html:2266-2267](public/admin/index.html:2266), [2431](public/admin/index.html:2431) |
| 4 | Los 4 estados de embudo en curso (NEW/INTERESTED/QUOTED/NEGOTIATING) comparten un solo gris (`.status-NEW, .status-INTERESTED, .status-QUOTED, .status-NEGOTIATING`) - el avance del embudo es invisible en la lista | [public/admin/index.html:286](public/admin/index.html:286) |
| 5 | Los 4 intents (PQR/DEVOLUCION/NO_RECIBIDO/SOLICITA_AGENTE) comparten un solo rojo - "pide asesor" no es una queja, no debería verse igual que un PQR | [public/admin/index.html:2226](public/admin/index.html:2226) |
| 6 | Hasta 4 badges apilados en una fila (no leídos + en vivo + intent + estado) → filas de doble alto, visible en la captura original (fila de Ximena) | [public/admin/index.html:2265-2268](public/admin/index.html:2265) |

Arreglos (presentación, sin tocar lógica de negocio):

- Un solo badge de estado por fila, por prioridad `intent > humanControl > embudo`. El
  estado de embudo completo se ve siempre en el encabezado del chat (donde sí hay
  espacio), no repetido en la fila de la lista.
- "🙋 En vivo" → "✋ Tú atiendes" (humanControl). El emoji 🙋 queda reservado solo para
  el intent "Pide asesor".
- Intents: PQR / Devolución / No recibido en rojo (`--danger` / `--danger-light`); Pide
  asesor en ámbar (`--warn` / `--warn-light`) - ya no es una queja, es una solicitud.
- Embudo con progresión de color: Nuevo (gris) → Interesado (azul) → Cotizado (ámbar) →
  Negociando (naranja) → Vendido (verde) → Perdido (rojo).
- Badge de intent lleva una ✕ para que el dueño lo quite a mano una vez resuelto
  (decisión 4 arriba) - llama a un nuevo endpoint `PUT /api/conversations/:id/intent`
  con `intent: null`, reusando `setConversationIntent`.
- Variables CSS nuevas `--info` / `--info-light` (formaliza el azul ya usado suelto en
  tags de cliente) para el estado "Interesado" del embudo. Cero hex hardcodeado nuevo.

## Fase 6 - Tests

- `src/conversation/service.test.ts`: cliente con 2 ciclos SOLD + 1 abierto → 1 fila,
  `unreadCount` sumado de los 3, `activeConversationId` apunta al abierto; cliente con
  todo cerrado → `activeConversationId` es el ciclo más reciente.
- `npx tsc --noEmit` y `npm test` una sola vez al final del lote completo (no después
  de cada edición individual, por la regla de eficiencia del repo).

## Explícitamente fuera de alcance

`src/ai/*`, `src/routes/whatsapp.ts`, `getOrCreateOpenConversation`, jobs de
recordatorio/follow-up, `src/analytics/service.ts`, esquema Prisma. Cero migración,
cero cambio de prompt de Onix → no mueve el costo de tokens por mensaje, no requiere
`npm run regression` ni `npm run test:paid`.
