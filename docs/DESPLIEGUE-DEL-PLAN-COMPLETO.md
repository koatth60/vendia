# Desplegar el plan completo

Rama: `redesign/completo-gto08b`. Escrito el 2026-09-18.

16 etapas del plan y 15 migraciones contra un servidor que hoy corre `b7ec408`. **No van de una sola
vez**: se despliegan en cuatro pasos, cada uno con su etiqueta y su ventana de observación, para que un
problema tenga tres o cuatro sospechosos y no dieciséis. Volver atrás está escrito en
[`ROLLBACK.md`](ROLLBACK.md) y el respaldo ya está tomado.

---

## Antes de tocar nada

- [ ] `npx tsc --noEmit` limpio.
- [ ] `npm test`: **1076 pruebas, 1074 pasan, 0 fallan**, 2 `# TODO` (`igmt9z-aurora-sin-config` y
      `y1iz5l-foto-no-converge`, conocidos desde el 2026-09-15).
- [ ] El workflow `Tests` de GitHub en verde para el commit que se va a desplegar.
- [ ] El respaldo de producción existe y su `sha256` empieza con `eaf00b86afc7c222e602`
      (ver `ROLLBACK.md`).

## Variables de entorno

**No hace falta ninguna nueva.** `SESSION_SECRET` y `TOKEN_ENCRYPTION_KEY` ya están en el servidor —sin
ellas el proceso no arranca, y perder `TOKEN_ENCRYPTION_KEY` obliga a reconectar WhatsApp en cada
negocio.

Dos opcionales, las dos **con el valor correcto por omisión**:

| Variable | Si falta | Para qué está |
|---|---|---|
| `ONIX_ROL` | El proceso hace HTTP **y** jobs, igual que siempre | `ecosystem.config.js` la pone: `web` en `vendia`, `worker` en `vendia-worker` (E23) |
| `WEBHOOK_SIGNATURE_ENFORCE` | La firma se verifica y **sólo se registra** | Encenderla es `E26`, que está esperando 48 h de log y revisar el `appSecret` de cada negocio |

`PLATFORM_ADMIN_PASSWORD` sigue en texto plano en el `.env`. El proceso arranca igual y **avisa en el
log**; pasarla a `PLATFORM_ADMIN_PASSWORD_HASH` es parte de `E29` y se puede hacer después.

## El despliegue va en cuatro pasos, no de una

**Por qué.** De una sola vez son 46 commits y 16 etapas: si algo se rompe, hay 16 sospechosos y
averiguar cuál cuesta más que el arreglo. La rama es lineal, así que no hace falta cherry-pick ni ramas
nuevas — se despliegan **commits intermedios de la misma rama**, en orden, con una ventana de
observación entre uno y otro. Cada paso tiene su etiqueta, ya empujadas:

| Paso | Etiqueta | Qué entra | Migraciones | Qué puede romper |
|---|---|---|---|---|
| 1 | `paso-1-infra-y-panel` | CI, `E48`, `E49` (rediseño de Bandeja/Clientes/Pedidos), `E13b`, `E14`, `E15`, `E30`, `E46`, `E28` | 2 | El panel y los jobs. **No** toca cómo entra un mensaje ni qué dice el bot |
| 2 | `paso-2-pedidos` | `E41`, `E31` (máquina de estados + `OrderEvent`), `E32` (el stock vuelve al cancelar) | +1 | Marcar enviado y cancelar desde el panel |
| 3 | `paso-3-cola-de-entrada` | `E20`/`E21` (todo mensaje entra por `InboundEvent`), `E22`, `E23` (1/2), `E24`, `E29`, `E76`, `E33` (1/2), `E36`, respaldos | +6 | **El paso grande**: cambia el camino de TODOS los mensajes entrantes |
| 4 | `paso-4-agente-y-catalogo` | `E23` (2/2) web+worker, `E33` (2/2), `E37`, `E38`, `E35`, `E34`, `E45` | +6 | Lo único que cambia **cómo habla** el agente (`E34`) y **qué cifra cobra** (`E37`, `E38`) |

Entre paso y paso: **30 minutos de tráfico real como mínimo**, mirando lo de "La primera hora". Si algo
aparece, el sospechoso son las 3 o 4 etapas de ESE paso, no las dieciséis.

### Cómo se despliega cada paso

Desde la máquina del dueño (la única con la red de Tailscale):

```bash
ssh vendia
```

```bash
cd /opt/vendia
git fetch origin --tags
git checkout paso-1-infra-y-panel     # y en cada ronda, la etiqueta del paso siguiente
npm ci
npx prisma generate
npx prisma migrate deploy             # aplica sólo las migraciones hasta ese punto
pm2 startOrRestart ecosystem.config.js --update-env
systemctl reload nginx
```

> **Lo que pasó el 2026-09-18 en el paso 1, para que no vuelva a pasar.** El proceso `vendia` de
> producción **no se había creado desde `ecosystem.config.js`**: estaba definido como
> `bash -c "node --import tsx src/index.ts"`. Al correr `pm2 startOrRestart ecosystem.config.js`, pm2
> le pegó encima el `interpreter: node --import tsx` del archivo **conservando su script**, así que Node
> intentó ejecutar `/usr/bin/bash` como si fuera JavaScript: `SyntaxError: Invalid or unexpected token`
> sobre la primera línea de un ELF. El proceso quedó en `errored` unos 4 minutos. Se arregló creando el
> proceso desde el archivo, que es lo que debió ser siempre:
>
> ```bash
> pm2 delete vendia && pm2 start ecosystem.config.js && pm2 save
> ```
>
> Desde ese `pm2 save`, la definición viva **sí** sale de `ecosystem.config.js`, así que
> `startOrRestart` es correcto de acá en adelante — incluido el paso 4, que agrega `vendia-worker`.

**`pm2 startOrRestart` y no `pm2 restart vendia`**, sobre todo en el paso 4: es el que agrega
`vendia-worker`, que no existe todavía en el servidor. Un `restart` a secas lo dejaría sin levantar — y
el worker es quien contesta: el bot recibiría mensajes y no respondería ninguno. En los pasos 1 a 3 el
`ecosystem.config.js` todavía tiene una sola entrada, así que ahí `startOrRestart` se comporta como el
`restart` de siempre.

Sin la red del dueño, el workflow acepta la etiqueta igual que una rama:
`gh workflow run deploy.yml -f accion=paso-1-infra-y-panel` (corre el mismo `scripts/deploy.sh`).

### Volver atrás desde cada paso

Siempre hay **dos destinos posibles**: el paso anterior, o producción tal como está hoy.

| Desde | A producción (`produccion-antes-del-plan-completo`) | Al paso anterior |
|---|---|---|
| Paso 1 | `git checkout` y listo. Ninguna compensación | — |
| Paso 2 | `git checkout` + **mapear los estados de pedido** (`ROLLBACK.md`) | Mismo mapeo |
| Paso 3 | Lo de arriba + **`SET DEFAULT 'USD'` en `Product.currency`** | Sólo el `SET DEFAULT` |
| Paso 4 | Lo de arriba + `pm2 delete vendia-worker` | `pm2 delete vendia-worker` |

Las tablas y columnas nuevas se quedan donde están en todos los casos: el código viejo las ignora. El
detalle de cada compensación, con su SQL, está en [`ROLLBACK.md`](ROLLBACK.md).

## Apenas termina

```bash
pm2 list                                   # vendia (web) y vendia-worker, los dos online
curl -s localhost:3000/health | head -40   # seis componentes, cada uno con su estado
curl -s localhost:3000/metrics | head -20
pm2 logs --lines 80 --nostream | grep -iE 'ZAQI ALERT|error'
```

Y la prueba que de verdad cuenta: **mandarle un mensaje al bot desde un WhatsApp propio** y ver que
contesta. Con los dos procesos separados, el camino nuevo es webhook (`web`) → `InboundEvent` →
consumidor (`worker`) → respuesta; si algo de esa cadena quedó mal, esto lo muestra en segundos.

## La primera hora

```sql
-- Mensajes entrando y quedándose sin respuesta. Cualquiera de los dos > 0 sostenido: volver atrás.
SELECT count(*) FROM "InboundEvent" WHERE "processedAt" IS NULL AND "receivedAt" < now() - interval '5 minutes';
SELECT count(*) FROM "InboundEvent" WHERE "failedAt" IS NOT NULL;

-- Que los jobs estén corriendo de verdad, y uno solo por vez.
SELECT name, "lockedUntil", "lastRunAt" FROM "JobLease" ORDER BY "lastRunAt" DESC NULLS LAST;

-- Y que nadie esté cancelando pedidos de más (E34).
SELECT "fulfillmentStatus", count(*) FROM "Order" GROUP BY 1;
```

## Lo que cambia para la dueña, y conviene avisarle

- **Catálogo** tiene dos pestañas nuevas: **Promociones** (E37) y **Combos** (E38). Un descuento
  cargado ahí ya viene aplicado en el precio que cotiza el bot **y** en el que se cobra: no hay que
  pedírselo en las instrucciones, y conviene borrar de ahí lo que se haya escrito sobre promociones.
- **Pedidos** tiene "Datos del envío y el pago" (E35): transportadora, guía, entrega estimada y estado
  del pago. Cargado ahí, el bot contesta "¿dónde va mi pedido?" solo.
- **Cancelar por el chat pasa a ser de dos turnos** (E34): la primera vez que una clienta pide
  cancelar, el bot pregunta y **no cancela**; recién cancela cuando ella confirma en otro mensaje.
- La **Bandeja** carga de a 15 conversaciones y un chat largo abre por el final (E45). Cuando entra
  movimiento y ya se bajaron varias páginas, aparece un aviso *"Hay movimiento en la Bandeja"* en vez
  de recargar y perder el lugar.

## Lo que NO entra en este despliegue

`E26` (la firma del webhook deja de ser opcional) necesita mirar 48 h de log en modo registro y
verificar el `appSecret` de los tres negocios. Es lo primero que conviene hacer **después** de que esto
esté estable.
