# Onix — Diagnóstico de la aplicación y plan de reorganización hacia un CRM

Fecha: 2026-09-13
Estado: Fases 0, 1, 2 y 3 implementadas (ver "Estado de ejecución" al final). Faltan 4 y 5.
Alcance: panel de administración (frontend) + capa de rutas (backend). No toca el agente, los prompts,
las tools, el webhook de WhatsApp ni la lógica de negocio existente.

---

## Parte 1 — Diagnóstico

### 1.1 Qué hay hoy

**Frontend: cuatro superficies separadas, servidas como estáticos por el mismo Express.**

| Superficie | Archivos | Tamaño | Para quién |
|---|---|---|---|
| Landing pública | `public/index.html`, `privacidad.html`, `terminos.html`, `pago-demo.html` | ~27 KB | visitantes |
| Autenticación | `public/login.html`, `signup.html`, `forgot-password.html` | ~31 KB | clientes nuevos |
| Panel del cliente | `public/admin/index.html` | **204 KB, 3.977 líneas, un solo archivo** | el negocio que compra Onix |
| Panel de plataforma | `public/vendia-admin/index.html` + `login.html` | ~23 KB | Zaqi (interno) |

El panel del cliente es un único archivo con tres bloques pegados: CSS en las líneas 13–455,
markup en 456–1085, y JavaScript en 1086–3975 (152 funciones globales, estado en variables globales,
HTML generado con template strings y unos 200 `onclick=` inline). No hay build, ni módulos, ni
dependencias de frontend.

**Backend: capas limpias, pero un router gigante.**

```
src/routes/admin.ts         983 líneas, ~60 endpoints en un solo router
src/routes/auth.ts          signup / login / logout / me / reset de contraseña
src/routes/platformAdmin.ts negocios, claves de activación, log del dueño
src/routes/whatsapp.ts      webhook entrante + estados de entrega
src/{ai,catalog,conversation,orders,analytics,delivery,jobs,media,realtime,search,whatsapp}/
```

El patrón `routes → service → prisma` está bien aplicado y el aislamiento multi-tenant por
`businessId` es consistente en cada consulta. Eso no hay que rehacerlo.

### 1.2 Los problemas de organización

**P1 — La app está organizada por tabla de base de datos, no por el trabajo del usuario.**
Diez pestañas planas: Tu negocio, Catálogo, Pagos, WhatsApp, FAQ, Conversaciones, Pedidos, Analytics,
Consumo IA, Equipo. Eso es el esquema de Prisma con botones. Un CRM se organiza alrededor de tres
objetos: el cliente, la conversación y la venta. Hoy el cliente no tiene lugar propio en ninguna parte.

**P2 — La entidad Cliente existe en la base de datos y no existe en la interfaz.**
`Customer` guarda `name`, `phoneNumber`, `idNumber`, `deliveryPhone`, `tags`, y se relaciona con
`Conversation[]` y `Order[]`. En el panel aparece únicamente como fila lateral dentro de
Conversaciones. No hay lista de clientes, ni buscador, ni ficha, ni historial de compras por persona.
Los datos que el propio bot recolecta con `save_customer_contact_info` (cédula, teléfono de entrega)
se guardan y nunca se muestran en ninguna pantalla.

**P3 — La configuración del bot está repartida en cinco pestañas.**
Personalidad e instrucciones están en "Tu negocio"; los métodos de pago en "Pagos"; el seguimiento
post-venta y las plantillas en "WhatsApp"; las políticas en "FAQ"; los sinónimos de categoría dentro de
"Catálogo". Todo eso es una sola tarea mental: *configurar cómo se comporta mi bot*.

**P4 — "Tu negocio" es un cajón de sastre.**
En un mismo scroll conviven: nombre y descripción, foto de perfil de WhatsApp, categoría del negocio,
nombre del asistente, tono, modo de fotos, exigir comprobante, trato por género, modalidades de pago del
envío, dialecto, saludo, prohibiciones, instrucciones libres, datos de contacto del dueño y una zona de
peligro que borra conversaciones, clientes y pedidos.

**P5 — El mismo objeto se guarda desde dos pestañas distintas.**
`saveBusiness()` se invoca desde "Tu negocio" (línea 516) y desde "WhatsApp" (línea 817). Ambos botones
mandan el formulario completo de Business. Si el usuario tiene las dos pestañas con datos distintos en
memoria, el último botón que apriete gana.

**P6 — La información más accionable está escondida en la pestaña de facturación.**
El chequeo de configuración (¿tienes teléfono de contacto? ¿método de pago activo? ¿plantilla aprobada?)
y la salud del bot (conversaciones estancadas, respuestas degradadas, intervenciones de respaldo) viven
al final de "Consumo de IA", debajo de la tabla de costo por día. Es lo primero que un dueño debería ver
y está en el último lugar donde va a mirar.

**P7 — No hay pantalla de inicio.**
Al entrar, el usuario cae en un formulario de configuración. No hay una vista de "qué necesita mi
atención hoy".

**P8 — Hay datos vivos en el backend sin ninguna interfaz.**

- `ShippingRate` y `ShippingCityRule`: el agente los consulta con `get_shipping_rates` y
  `get_shipping_rate_for_city`, pero **no existe ninguna pantalla para editarlos**. Se cargaron con
  `scripts/seed-magimp-shipping.ts`. Esto contradice la regla del proyecto de que toda funcionalidad core
  configurable por negocio se entrega con su interfaz de administración en la misma fase.
- `DeliveryFailure`: el backend emite `delivery:failed` por socket a la sala del negocio, y el panel del
  cliente **no escucha ese evento**. Un fallo crítico (una escalación que el dueño nunca recibió) hoy sólo
  se ve desde el panel interno de plataforma.
- `OwnerMessageLog`: la conversación bot ↔ dueño sólo se puede leer desde `/vendia-admin`. El dueño no
  puede ver sus propias alertas.
- `AgentIncident`: se muestra sólo como tres contadores de 7 días. No hay lista ni detalle.
- `PendingOwnerQuestion`: no hay bandeja de "el bot te está esperando"; sólo llega por WhatsApp y, si el
  dueño no contesta, lo único que ocurre es el recordatorio automático.

**P9 — Cero navegación cruzada.**
Un pedido no lleva a su conversación. Una conversación no lleva a su pedido. Un producto no lleva a
quién lo consultó. Un cliente no lleva a sus compras. Todo se navega volviendo a la pestaña correcta y
buscando a ojo.

**P10 — Cero búsqueda y casi cero paginación.**
No hay buscador en conversaciones, clientes, productos ni pedidos (sólo "Cargar más" en pedidos).
`GET /admin/api/customers` trae **todas** las conversaciones del negocio, con el último mensaje incluido
en cada una, y las agrupa en memoria. Con volumen bajo funciona; con 500 clientes y decenas de miles de
mensajes se degrada en cada carga de pestaña.

**P11 — El archivo único es un techo de mantenimiento.**
Cada funcionalidad nueva engorda el mismo archivo de 4.000 líneas. El propio `CLAUDE.md` del repo ya
advierte que hay que leerlo con `offset`/`limit` porque es demasiado grande. Con 152 funciones globales y
estado global compartido, cada cambio tiene más superficie de colisión que el anterior.

**P12 — Marca inconsistente.**
La ruta interna sigue siendo `/vendia-admin`, la clave de `localStorage` es `vendia-admin-tab`, y el
README dice "Vendia". El producto se llama Zaqi Solutions / Onix desde el 2026-09-10.

**P13 — Permisos binarios.**
Sólo existe dueño contra empleado. En el frontend se resuelve escondiendo elementos con la clase
`owner-only` (el backend sí valida de verdad con `requireOwner`, eso está bien). Para vender a negocios
con equipos reales va a hacer falta, más adelante, algo más fino: quién atiende a qué cliente, quién puede
cerrar ventas, quién sólo lee.

### 1.3 Lo que está bien y no se toca

- Separación `routes → service → prisma`, con `businessId` en toda consulta.
- Realtime ya montado: `realtimeEvents` desacoplado + Socket.IO autenticado con la misma cookie de sesión
  y una sala por negocio. El CRM se cuelga de ahí sin inventar nada nuevo.
- La agrupación por cliente (`listCustomerThreadsForBusiness`, ONIX-CONVERSATIONS-GROUPING-PLAN.md) ya es
  exactamente el cimiento de la ficha de cliente.
- El modelo de datos está sano para un CRM: falta poco (notas, etapa, actividad, algunos índices).
- La cobertura de tests del backend es buena y sirve de red de seguridad para todo este trabajo.

---

## Parte 2 — Plan

### 2.1 Principio rector

Se reorganiza **la presentación y la navegación**. El backend cambia sólo de dos maneras:

1. **Moviendo** endpoints existentes a routers por dominio, conservando exactamente los mismos paths.
2. **Agregando** endpoints y columnas nuevas, todas opcionales o con valor por defecto.

Criterio de aceptación para "no afectamos la lógica existente": la suite `npm test` actual debe seguir
pasando **sin editar ningún test existente**. Ninguna fase toca `src/ai/*`, así que ninguna requiere
`npm run regression` ni `npm run test:paid`.

### 2.2 Nueva arquitectura de información

Se pasa de diez pestañas horizontales a cinco secciones en una barra lateral fija:

**1. Inicio** *(nuevo)* — qué necesita tu atención hoy.
- Bandeja de acción: conversaciones esperando a un humano, preguntas del bot sin responder, pedidos
  pendientes de envío, fallos de entrega críticos, sugerencias de FAQ pendientes de aprobar.
- Indicadores: ventas del mes, tasa de conversión, conversaciones activas, CSAT.
- Chequeo de configuración (traído desde Consumo de IA).

**2. CRM** — tres vistas del mismo dato.
- **Bandeja**: las conversaciones en vivo (lo que hoy es la pestaña Conversaciones), con buscador.
- **Clientes** *(nuevo)*: lista con búsqueda y filtros, y la ficha completa de cada cliente.
- **Pedidos**: lo de hoy, más filtros y enlace directo al cliente y a la conversación.

**3. Catálogo** — productos, variantes, medios y sinónimos de categoría, con buscador.

**4. Bot** — todo lo que define cómo se comporta el asistente.
- Personalidad (nombre, tono, dialecto, saludo, trato, modo de fotos)
- Reglas e instrucciones (instrucciones libres, prohibiciones, "Mejorar redacción")
- Preguntas frecuentes, con las sugerencias aprendidas
- Métodos de pago
- **Envíos** *(nuevo)*: tarifas y reglas por ciudad, más modalidades de pago del envío
- WhatsApp: plantillas y seguimiento post-venta
- **Salud del bot** *(nuevo)*: incidentes, fallos de entrega, conversación bot ↔ dueño

**5. Negocio** — identidad, foto de perfil, contacto del dueño, equipo, plan y consumo de IA, zona de
peligro.

Cada vista pasa a ser una ruta con hash (`#/crm/clientes/:id`), de modo que los enlaces cruzados sean
posibles, el botón "atrás" del navegador funcione y el estado sobreviva a un refresco.

### 2.3 La ficha de cliente (la pieza nueva central)

Pantalla dividida. A la izquierda, el hilo de WhatsApp completo agrupado por ciclos de venta (ya existe).
A la derecha, la ficha:

- **Identidad**: nombre editable, teléfono de WhatsApp, cédula, teléfono de entrega, dirección, correo.
- **Etiquetas**: las actuales, con un catálogo de etiquetas del negocio (color y autocompletado).
- **Etapa del cliente**: campo nuevo a nivel de persona, distinto del `status` que hoy vive por
  conversación (Nuevo / Activo / Comprador / Recurrente / Inactivo).
- **Métricas**: total comprado, número de pedidos, ticket promedio, primera y última compra, días sin
  contacto.
- **Pedidos**: lista con enlace a cada uno.
- **Notas internas**: campo nuevo, nunca se le manda al cliente.
- **Línea de tiempo**: mensajes, pedidos, escalaciones al dueño y cambios de etapa en orden cronológico.
- **Tareas y recordatorios**: fase posterior.

### 2.4 Cambios de datos (todos aditivos)

```prisma
enum CustomerStage { NUEVO ACTIVO COMPRADOR RECURRENTE INACTIVO }

model Customer {
  // ...campos actuales intactos, incluido tags String[]
  email         String?
  address       String?
  stage         CustomerStage @default(NUEVO)
  source        String?
  lastContactAt DateTime?
  assignedToId  String?          // TeamMember, para reparto de cartera
  notes         CustomerNote[]
  @@index([businessId, updatedAt])
}

model CustomerNote { id, businessId, customerId, authorType, authorId, body, createdAt }
model CustomerTag  { id, businessId, label, color, @@unique([businessId, label]) }
model CustomerTask { id, businessId, customerId, title, dueAt, doneAt, assignedToId }  // fase 6
```

`tags String[]` se queda exactamente como está; `CustomerTag` sólo aporta color y autocompletado, no
reemplaza nada. Índices que además hacen falta para que la lista escale:
`Customer(businessId, updatedAt)`, `Message(conversationId, createdAt)`,
`Conversation(customerId, updatedAt)`.

`totalSpent` y el resto de métricas se calculan al vuelo desde `Order` en la fase 2; si más adelante pesa,
se desnormaliza.

### 2.5 Backend: reorganización sin cambiar contratos

`src/routes/admin.ts` (983 líneas) se parte en `src/routes/admin/`, manteniendo el prefijo `/admin/api`:

```
src/routes/admin/index.ts           monta los demás, exporta adminRouter (mismo nombre que hoy)
                  business.ts       negocio, foto de perfil, mejorar instrucciones, reset de datos
                  catalog.ts        productos, variantes, medios, sinónimos
                  payments.ts       métodos de pago
                  shipping.ts       NUEVO: tarifas y reglas por ciudad
                  faq.ts            FAQ y candidatas aprendidas
                  conversations.ts  conversaciones, mensajes, handoff, cierre de venta
                  customers.ts      AMPLIADO: ficha, notas, línea de tiempo, búsqueda
                  orders.ts         pedidos, envío, cancelación
                  team.ts           equipo
                  insights.ts       analytics, consumo de IA, incidentes, chequeo de configuración
                  whatsappTemplates.ts
```

Mismos paths y mismos handlers: el frontend actual y los tests existentes no se enteran.

**Endpoints nuevos:**

| Método y ruta | Para qué |
|---|---|
| `GET /admin/api/customers?q=&stage=&tag=&cursor=` | lista con búsqueda, filtros y paginación |
| `GET /admin/api/customers/:id` | ficha completa con métricas |
| `PUT /admin/api/customers/:id` | editar identidad y etapa |
| `GET/POST/DELETE /admin/api/customers/:id/notes` | notas internas |
| `GET /admin/api/customers/:id/orders` | pedidos del cliente |
| `GET /admin/api/customers/:id/timeline` | línea de tiempo |
| `GET/POST/PUT/DELETE /admin/api/shipping-rates` | tarifas de envío |
| `GET/POST/DELETE /admin/api/shipping-city-rules` | reglas por ciudad |
| `GET /admin/api/delivery-failures` y `POST /:id/resolve` | fallos de entrega para el dueño |
| `GET /admin/api/owner-log` | conversación bot ↔ dueño, para el propio dueño |
| `GET /admin/api/pending-questions` | lo que el bot está esperando que responda |
| `GET /admin/api/dashboard` | una sola llamada que alimenta la pantalla de Inicio |
| `GET/POST/DELETE /admin/api/customer-tags` | catálogo de etiquetas |

### 2.6 Frontend: de un archivo a módulos, sin framework ni build

```
public/admin/
  index.html            esqueleto: barra lateral + <main id="view">
  css/  tokens.css  base.css  components.css  layout.css
  js/   app.js        enrutador por hash y arranque
        api.js        apiFetch y envoltorios por dominio
        ui.js         escapeHtml, setStatus, modales, formato de moneda y fecha
        realtime.js   socket.io y reparto de eventos
        state.js      sesión, rol, caché ligera
        views/  inicio.js
                crm-bandeja.js  crm-clientes.js  crm-cliente.js  crm-pedidos.js
                catalogo.js
                bot-personalidad.js  bot-reglas.js  bot-faq.js  bot-pagos.js
                bot-envios.js  bot-whatsapp.js  bot-salud.js
                negocio.js  equipo.js
```

Módulos ES nativos (`<script type="module">`, `import`/`export`). Sin bundler, sin dependencias nuevas,
sin cambios en el despliegue: siguen siendo archivos estáticos servidos por el mismo `express.static`.

Consecuencia obligada: los `onclick="..."` inline dejan de funcionar cuando las funciones dejan de ser
globales, así que se reemplazan por delegación de eventos (`data-action` + un listener por vista). Son
alrededor de 200 y el cambio es mecánico, pero hay que ser exhaustivo.

### 2.7 Fases

Cada fase es desplegable por sí sola.

**Fase 0 — Andamiaje, sin cambios visibles.**
Partir CSS y JS del panel en módulos y montar el enrutador por hash, conservando el mismo layout de
pestañas y el mismo comportamiento. Criterio: todo lo que hoy funciona sigue funcionando igual.
Riesgo: es el movimiento más grande, pero es puramente mecánico. Se hace vista por vista, no de un tirón.

**Fase 1 — Nueva navegación.**
Barra lateral con las cinco secciones, redistribución de las pestañas actuales, rutas con deep-link,
separación del guardado de Business para que no haya dos botones que guarden todo el formulario.
Sin funcionalidad nueva.

**Fase 2 — CRM: clientes.**
Migración aditiva (etapa, notas, correo, dirección, `lastContactAt`, índices), endpoints de cliente,
lista con búsqueda y filtros, ficha completa con hilo, pedidos, notas y métricas, y enlaces cruzados
pedido ↔ cliente ↔ conversación.

**Fase 3 — Inicio y salud del bot.**
`GET /dashboard`, bandeja de acción, fallos de entrega en vivo (escuchando el `delivery:failed` que el
backend ya emite), log del dueño, lista de incidentes del agente y el chequeo de configuración movido a
Inicio.

**Fase 4 — Bot: cerrar los huecos de configuración.**
Interfaz de tarifas de envío y reglas por ciudad (la deuda pendiente), catálogo de etiquetas,
reorganización de Personalidad frente a Reglas.

**Fase 5 — Escala y pulido.**
Paginación por cursor real en clientes, conversaciones y mensajes; buscador global; responsive de verdad;
renombrar `/vendia-admin` a `/zaqi-admin` con redirección, limpiar la clave de `localStorage` y actualizar
el README a la marca actual.

**Fase 6 — Opcional, más adelante.**
Tareas y recordatorios por cliente, roles por área, exportación a CSV, segmentos guardados y campañas por
plantilla de WhatsApp a un segmento.

### 2.8 Lo que explícitamente no se toca

`src/ai/*` (agente, prompts, tools y sus backstops), el webhook de WhatsApp, los jobs de seguimiento y
recordatorio, la lógica existente de órdenes y conversaciones, y el esquema actual (sólo se agregan
columnas opcionales y tablas nuevas). Ningún test existente se edita.

### 2.9 Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| La fase 0 rompe algo en silencio al pasar 152 funciones globales a módulos | Migrar vista por vista, dejando el HTML idéntico; revisar pantalla por pantalla antes de pasar a la siguiente |
| Los ~200 `onclick` inline dejan de funcionar | Conversión mecánica a `data-action` + delegación, hecha en el mismo commit que cada vista |
| La ficha de cliente se vuelve lenta si calcula métricas al vuelo | Índices nuevos desde la fase 2; desnormalizar `totalSpent` sólo si hace falta |
| Una migración de Prisma en producción | Todas las columnas nuevas son opcionales o con valor por defecto; se aplican con `migrate deploy` antes del reinicio de PM2 |
| Olvidar recargar Nginx tras reiniciar PM2 | Es un fallo conocido del despliegue de este proyecto: recargar Nginx después de cada `pm2 restart` |

---

## Parte 3 — Estado de ejecución

| Fase | Estado | Commit |
|---|---|---|
| 0 — Andamiaje (extraer CSS/JS, partir `admin.ts`) | Hecha | `64a1b00` |
| 1 — Navegación en 5 secciones | Hecha | `6ede57e` |
| 2 — CRM: clientes | Hecha | `f100447` |
| 3 — Inicio y salud del bot | Hecha | `f100447` |
| 4 — Bot: cerrar huecos de configuración | Pendiente | — |
| 5 — Escala y pulido | Pendiente | — |

Nada está desplegado todavía: las cuatro fases están commiteadas en `master` local, a la espera de la
orden de despliegue.

### Desvíos respecto al plan original

- **Fase 0**: se extrajo el JavaScript a un solo `js/admin.js` en vez de a quince módulos ES con una
  carpeta `views/`. El objetivo real (que el panel deje de ser un archivo HTML de 4.000 líneas con todo
  adentro) se cumple, y la extracción se pudo verificar byte a byte contra el original, cosa que un
  troceado en quince archivos no permitía. Partirlo más fino sigue siendo posible y ya no urge.
- **Fase 1**: la navegación se implementó como dos filas horizontales (secciones + subnav contextual)
  en lugar de una barra lateral fija. Reusa el layout y los breakpoints que ya estaban probados; pasar
  a barra lateral más adelante es puro CSS, sin tocar JavaScript.
- **P5 (dos botones "Guardar cambios")**: revisado con el código delante, no era una pérdida de datos.
  Todos los paneles viven en el mismo DOM, así que cualquiera de los botones guarda el estado actual y
  correcto del formulario completo. Partir el guardado por sección exigiría antes endurecer
  `PUT /api/business`, donde hoy varios campos usan `x || null` y `Boolean(x)`: con un payload parcial,
  omitir un campo lo pondría en null o en false en vez de dejarlo como está. Queda anotado como trabajo
  de backend, no se tocó a ciegas.

### Multicanal (Instagram, Facebook, Mercado Libre)

Requisito que apareció durante la ejecución. Lo ya hecho:

- Enum `Channel` con `Customer.channel` y `Conversation.channel`, ambos con default `WHATSAPP`. El CRM
  ya lee y muestra el canal, así que sumar uno nuevo no obliga a migrar datos.
- La sección del panel se llama **Canales**, no "WhatsApp".

Lo que queda decidido explícitamente **para después**, cuando exista el segundo canal de verdad:

- `Customer.@@unique([businessId, phoneNumber])` sigue siendo la identidad, que es específica de
  WhatsApp. Un cliente de Instagram no tiene teléfono.
- Unificar a la misma persona entre canales (el mismo humano escribiendo por WhatsApp y por Instagram)
  necesita una tabla de identidades por canal, y no tiene sentido diseñarla sin un segundo canal real
  contra el cual validarla.
- El envío sigue acoplado a `whatsapp/client.ts`. Cuando entre el segundo canal habrá que meter una
  capa de canal por debajo de `recordMessage`/`sendTextMessage`; el CRM de arriba no debería enterarse.

### Fase 4 — qué falta exactamente

1. Interfaz de tarifas de envío y reglas por ciudad (`ShippingRate`, `ShippingCityRule`): el agente ya
   las consulta y hoy solo se pueden cargar por script.
2. Administración del catálogo de etiquetas (`CustomerTag`): el modelo y los endpoints ya existen
   (Fase 2), falta la pantalla para crear/renombrar/borrar y elegir color.
3. Separar "Personalidad" de "Reglas e instrucciones" dentro de Bot > Configuración.

### Fase 5 — qué falta exactamente

1. Paginación por cursor en conversaciones y mensajes (la de clientes ya quedó hecha en Fase 2).
2. Buscador global.
3. Renombrar `/vendia-admin` a `/zaqi-admin` con redirección, limpiar la clave `vendia-admin-tab` de
   `localStorage` y actualizar el README a la marca actual.
