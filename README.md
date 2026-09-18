# Onix (Zaqi Solutions)

Asistente de ventas con IA, en formato SaaS multi-negocio. Un negocio se registra, conecta su número de
WhatsApp (más canales, próximamente), carga su catálogo (productos, precios, stock, fotos/videos) y sus
métodos de pago desde un panel web con CRM integrado, y el bot Onix responde a sus clientes usando esos
datos reales.

> El producto y la compañía se llamaban Vendia hasta el rebrand a **Zaqi Solutions** (2026-09-10); el bot
> se llama **Onix**. Referencias sueltas a "Vendia" que aparezcan en código viejo o en `design/` son de
> antes del rebrand.

## Qué hace

- Responde preguntas de clientes sobre productos específicos (precio, stock, características) consultando
  el catálogo real — nunca inventa datos.
- Envía fotos y videos reales del producto por WhatsApp.
- Ofrece los métodos de pago configurados por el negocio (transferencia, tarjeta, efectivo/contraentrega).
- Guía la conversación hasta confirmar el pedido, y marca la venta como cerrada (o perdida) automáticamente.
- Cada negocio puede agregar instrucciones propias de comportamiento para su bot.

## Stack

- **Backend**: Node.js + TypeScript + Express
- **Base de datos**: PostgreSQL vía Prisma (driver adapter `@prisma/adapter-pg`)
- **IA**: DeepSeek (`deepseek-v4-flash`) con tool use; `deepseek-v4-flash-vision-exp` para leer fotos de comprobantes
- **Autenticación**: sesiones (`express-session`) + contraseñas con `bcryptjs`
- **Media**: AWS S3 (bucket privado + URLs firmadas temporales)
- **WhatsApp**: Meta Cloud API
- **Frontend**: HTML/CSS/JS simple, sin framework (panel de administración, login, registro, landing)

## Estructura

```
src/
  ai/            agente de DeepSeek, herramientas del catálogo, respuestas rápidas
  auth/          hash de contraseñas, middleware de sesión
  catalog/       productos, métodos de pago y tarifas de envío (multi-negocio)
  config/        variables de entorno
  conversation/  clientes, conversaciones, mensajes
  crm/           ficha de cliente, tablero de Inicio (ver panel de administración más abajo)
  db/            cliente de Prisma
  media/         subida y firma de URLs de S3
  routes/
    admin/       API del panel de administración, un archivo por dominio (negocio, catálogo, CRM,
                 pedidos, envíos, buscador, ...)
    whatsapp.ts  webhook de WhatsApp
    auth.ts      login/registro/sesión
    platformAdmin.ts  API del panel interno de Zaqi (/zaqi-admin)
  whatsapp/      cliente de la API de WhatsApp
prisma/          schema y migraciones
public/
  admin/         panel de administración del negocio (CRM, catálogo, bot, etc) - index.html + css/ + js/
  zaqi-admin/    panel interno de Zaqi (gestión de negocios, claves de activación)
  (resto)        landing, login, registro
scripts/         utilidades (ej: generar claves de activación)
```

El panel de administración (`public/admin/`) está organizado en 5 secciones - Inicio, CRM, Catálogo, Bot
y Negocio. El diagnóstico y el plan de esa reorganización están en
`docs/historico/ONIX-CRM-REORG-PLAN.md`.

El plan de trabajo vigente, y el único, es [`ONIX-PLAN.md`](ONIX-PLAN.md): 75 etapas numeradas, cada
una desplegable sola. Todo lo demás está archivado en `docs/historico/`.

## Requisitos

- Node.js 22+
- PostgreSQL
- Cuenta de Meta con WhatsApp Cloud API configurado
- API key de DeepSeek
- Bucket de AWS S3 + credenciales de IAM

## Setup local

```bash
npm install
cp .env.example .env   # completar con tus valores reales
npx prisma migrate deploy
npx prisma generate
npm run dev
```

## Variables de entorno

Ver `.env.example`. Resumen:

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | conexión a PostgreSQL |
| `SESSION_SECRET` | firma de las cookies de sesión |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `WHATSAPP_VERIFY_TOKEN` | verificación del webhook (compartido por toda la app en Meta) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` | almacenamiento de fotos/videos |

El número de WhatsApp y el token de acceso **no van en variables de entorno** — cada negocio guarda los
suyos en su propia fila de la tabla `Business` (`whatsappPhoneNumberId`, `whatsappAccessToken`), porque la
app es multi-tenant: un mismo servidor atiende a todos los negocios.

## Scripts

- `npm run dev` — servidor en desarrollo (`tsx watch`)
- `npm run build` / `npm start` — compilar y correr en producción
- `npm run prisma:generate` / `npm run prisma:migrate` — Prisma
- `npx tsx scripts/generate-key.ts <PLAN>` — genera una clave de activación (`BASICO`, `EMPRENDEDOR` o
  `NEGOCIO`) para que un negocio nuevo pueda registrarse

## Despliegue

Corre en un droplet de DigitalOcean con Nginx como proxy reverso y SSL de Let's Encrypt, gestionado con
PM2. El flujo de despliegue usado durante el desarrollo: empaquetar el proyecto (sin `node_modules`,
`.env` ni `dist`) y enviarlo por SSH al servidor, correr las migraciones, y reiniciar con
`pm2 startOrRestart ecosystem.config.js --update-env`.

Desde `E23` (2026-09-18) son **dos procesos** sobre el mismo codigo: `vendia` (rol `web`: HTTP,
WebSocket y el webhook, que solo encola) y `vendia-worker` (rol `worker`: el consumidor de la cola de
entrada y todos los jobs). Por eso el reinicio va sobre el ecosystem y no sobre un nombre: un
`pm2 restart vendia` suelto deja al worker sin levantar y el bot no contesta nada.
