# Desplegar el plan completo

Rama: `redesign/completo-gto08b`. Escrito el 2026-09-18.

Lo que hay acá es **un solo despliegue grande** con 15 migraciones y 16 etapas del plan, contra un
servidor que hoy corre `b7ec408`. Volver atrás está escrito en [`ROLLBACK.md`](ROLLBACK.md) y el
respaldo ya está tomado.

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

## El despliegue

Desde la máquina del dueño (la única con la red de Tailscale):

```bash
git push origin redesign/completo-gto08b
ssh vendia
```

```bash
cd /opt/vendia
git fetch origin
git checkout redesign/completo-gto08b
git pull origin redesign/completo-gto08b
npm ci
npx prisma generate
npx prisma migrate deploy        # 15 migraciones, todas aditivas
pm2 startOrRestart ecosystem.config.js --update-env
systemctl reload nginx
```

O, sin la red del dueño, con el workflow: `gh workflow run deploy.yml -f accion=redesign/completo-gto08b`
(corre el mismo `scripts/deploy.sh`, que ya hace `startOrRestart` sobre el ecosystem).

**`pm2 startOrRestart` y no `pm2 restart vendia`**: desde `E23` son dos procesos, y `vendia-worker` no
existe todavía en el servidor. Un `restart` a secas deja al worker sin levantar — y el worker es quien
contesta: el bot recibiría mensajes y no respondería ninguno.

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
