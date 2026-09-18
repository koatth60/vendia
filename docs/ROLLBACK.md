# Volver atrás

Escrito el 2026-09-18, antes de desplegar el plan completo (`redesign/completo-gto08b`).

Este documento existe para que volver atrás sea una decisión de dos minutos y no una investigación.

---

## Lo que quedó guardado de producción

| Qué | Dónde |
|---|---|
| **El código que corría** | Etiqueta de git `produccion-antes-del-plan-completo` → commit `b7ec408` de `redesign/completo` |
| **La base** | `/opt/vendia/backups/prod-pre-plan-completo-20260918-134427.dump` (569 KB, formato `custom`) |
| **Copia de la base fuera del servidor** | `C:\Users\Koatth\Desktop\respaldos-onix\prod-pre-plan-completo-20260918-134427.dump` |

El `sha256` de los dos archivos empieza con `eaf00b86afc7c222e602`: si no coincide, no es el mismo
respaldo.

Momento del respaldo: **2026-09-18 13:44 UTC**. Todo lo que entre después de esa hora —mensajes,
pedidos, clientes— **no está adentro**. Por eso el orden de preferencia de abajo empieza por volver el
código y deja restaurar la base como último recurso.

---

## Camino 1 — volver el código (lo normal)

Sirve para: el bot contesta mal, algo del panel se rompió, un job hace algo que no debería.

```bash
cd /opt/vendia
git fetch --tags
git checkout produccion-antes-del-plan-completo
npm ci --omit=dev          # solo si cambió package-lock.json
pm2 delete vendia-worker   # E23 lo agregó; el código viejo no lo conoce
pm2 startOrRestart ecosystem.config.js --update-env
systemctl reload nginx
```

**Las migraciones NO se revierten.** Todas las de este plan son aditivas —tablas y columnas nuevas— y
el código viejo las ignora sin enterarse. Hay **dos excepciones** que sí hay que compensar a mano si se
vuelve atrás:

### 1. `Product.currency` perdió su valor por defecto (E33)

El código viejo da de alta productos sin mandar la moneda y contaba con el `DEFAULT 'USD'`. Sin él, ese
`INSERT` falla y **no se puede cargar ningún producto nuevo**. Compensación:

```sql
ALTER TABLE "Product" ALTER COLUMN "currency" SET DEFAULT 'USD';
```

### 2. Los estados nuevos del pedido (E31)

El código viejo sólo conoce `PENDING`, `SHIPPED` y `CANCELED`. Si mientras corrió la versión nueva
algún pedido quedó en un estado que no existía antes, el cliente de Prisma viejo **falla al leerlo**.
Se mapean a su equivalente más cercano:

```sql
UPDATE "Order" SET "fulfillmentStatus" = 'PENDING'   WHERE "fulfillmentStatus" IN ('PENDING_PAYMENT', 'PAID', 'PREPARING');
UPDATE "Order" SET "fulfillmentStatus" = 'SHIPPED'   WHERE "fulfillmentStatus" = 'DELIVERED';
UPDATE "Order" SET "fulfillmentStatus" = 'CANCELED'  WHERE "fulfillmentStatus" IN ('RETURNED', 'REFUNDED');
```

Correrlo **sólo si hay filas en esos estados**; mirar primero:

```sql
SELECT "fulfillmentStatus", count(*) FROM "Order" GROUP BY 1;
```

### Lo que NO hay que tocar

Las tablas y columnas nuevas (`InboundEvent`, `JobLease`, `ModelBreaker`, `Promotion`, `Bundle`,
`BundleItem`, `OrderEvent`, `PlatformAuditLog`, y las columnas nuevas de `Order` y `Business`) se pueden
dejar donde están. Borrarlas sólo agrega riesgo, y si se vuelve a desplegar hacia adelante ya están.

El correo en minúsculas (E29) tampoco se revierte: los índices únicos nuevos conviven con el código
viejo sin molestarlo.

---

## Camino 2 — restaurar la base (último recurso)

Sirve para: datos corrompidos por un defecto de la versión nueva, no para "el bot contestó mal".

**Esto borra todo lo que entró después de las 13:44 UTC del 2026-09-18.** Cada mensaje, cada pedido y
cada cliente de ese rato se pierden. Antes de correrlo hay que sacar un respaldo del estado actual —el
que se va a tirar— porque puede tener datos que después haya que rescatar a mano:

```bash
cd /opt/vendia
set -a; . ./.env; set +a
URL=${DATABASE_URL%%\?*}
pg_dump "$URL" -Fc -f "backups/antes-de-restaurar-$(date -u +%Y%m%d-%H%M%S).dump"

pm2 stop all                                   # que nadie escriba mientras se restaura
pg_restore --clean --if-exists -d "$URL" backups/prod-pre-plan-completo-20260918-134427.dump
pm2 start all
```

Después de restaurar, el código tiene que ser el de la etiqueta: una base vieja con el código nuevo
deja al proceso pidiendo columnas que ahí no existen.

---

## Cómo saber si hay que volver

Mirar, en este orden:

```bash
pm2 list                          # vendia y vendia-worker, los dos en "online" y sin reinicios subiendo
curl -s localhost:3000/health     # el cuerpo dice qué componente está mal, no sólo que algo lo está
pm2 logs --lines 120 --nostream | grep -i 'ZAQI ALERT'
```

Y en la base, la señal que importa de verdad —que a una clienta no le contestó nadie:

```sql
SELECT count(*) FROM "InboundEvent" WHERE "processedAt" IS NULL AND "receivedAt" < now() - interval '5 minutes';
SELECT count(*) FROM "InboundEvent" WHERE "failedAt" IS NOT NULL;
```

Cualquiera de esos dos en más de cero sostenido **es motivo para volver**: significa que hay mensajes
entrando y quedándose sin respuesta, que es el único error que el cliente ve.
