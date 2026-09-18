#!/usr/bin/env bash
set -euo pipefail

# VOLVER A LA VERSION BUENA DE PRODUCCION, CON UN SOLO COMANDO.
#
# Decision del dueno, 2026-09-18: lo que corria en produccion ese dia es funcional y esta bien, y tiene
# que poder recuperarse sin investigar nada. Este script es ese comando.
#
#   bash scripts/volver-a-produccion.sh
#
# O desde cualquier lado, sin la red del dueno:
#
#   gh workflow run deploy.yml -f accion=volver-a-produccion
#
# QUE HACE, Y POR QUE CADA COSA:
#
#   1. Deja el codigo en la etiqueta `produccion-antes-del-plan-completo` (commit b7ec408).
#   2. Aplica las DOS compensaciones de base que el codigo viejo necesita. Las migraciones del plan son
#      aditivas y no se revierten -- el codigo viejo ignora las tablas y columnas nuevas sin enterarse --
#      pero hay dos cosas que si lo rompen, y las dos se arreglan con una sentencia:
#        a. `Product.currency` perdio su DEFAULT (E33): sin el, el codigo viejo no puede dar de alta
#           ningun producto.
#        b. Los estados de pedido que agrego E31 (PAID, PREPARING, DELIVERED, RETURNED, REFUNDED): el
#           cliente de Prisma viejo no sabe leerlos y falla al traer ese pedido.
#   3. Baja `vendia-worker`, que solo existe desde E23 y el codigo viejo no conoce.
#   4. Verifica que el puerto conteste antes de decir que salio bien.
#
# LO QUE NO HACE: restaurar el volcado de la base. Eso borraria todo lo que entro despues del respaldo
# (mensajes, pedidos, clientes) y casi nunca hace falta. Esta escrito aparte en docs/ROLLBACK.md.

ETIQUETA="produccion-antes-del-plan-completo"
cd "$(dirname "$0")/.."

echo "==> Volviendo a $ETIQUETA"
ANTERIOR=$(git rev-parse --short HEAD)
git fetch origin --tags --quiet
git checkout --quiet "$ETIQUETA"
NUEVA=$(git rev-parse --short HEAD)

# Solo si cambio: npm ci sobre cientos de paquetes tarda, y entre estas versiones las dependencias son
# las mismas (lo unico que cambio en package.json son scripts).
if ! git diff --quiet "$ANTERIOR" "$NUEVA" -- package-lock.json 2>/dev/null; then
  echo "==> Dependencias distintas: npm ci"
  npm ci
fi

echo "==> Compensando lo que el codigo viejo no sabe leer"
set -a
# shellcheck disable=SC1091
. ./.env
set +a
URL="${DATABASE_URL%%\?*}"

psql "$URL" -v ON_ERROR_STOP=1 <<'SQL'
-- E33: sin este default, el codigo viejo no puede insertar un producto.
ALTER TABLE "Product" ALTER COLUMN "currency" SET DEFAULT 'USD';

-- E31: los estados que el codigo viejo no conoce, mapeados a su equivalente mas cercano. Si no hay
-- ninguna fila en esos estados, estos UPDATE no tocan nada.
UPDATE "Order" SET "fulfillmentStatus" = 'PENDING'  WHERE "fulfillmentStatus" IN ('PENDING_PAYMENT', 'PAID', 'PREPARING');
UPDATE "Order" SET "fulfillmentStatus" = 'SHIPPED'  WHERE "fulfillmentStatus" = 'DELIVERED';
UPDATE "Order" SET "fulfillmentStatus" = 'CANCELED' WHERE "fulfillmentStatus" IN ('RETURNED', 'REFUNDED');
SQL

echo "==> Generando el cliente de Prisma de esta version"
npx prisma generate >/dev/null

echo "==> Reiniciando"
# vendia-worker solo existe desde E23. `|| true` porque en una vuelta desde un paso anterior al 4 no
# esta, y eso no es un error.
pm2 delete vendia-worker >/dev/null 2>&1 || true
pm2 startOrRestart ecosystem.config.js --update-env >/dev/null
systemctl reload nginx

# Salud real: se pregunta al PUERTO, no al log (mismo criterio que scripts/deploy.sh).
esta_arriba() {
  for _ in $(seq 1 15); do
    if curl -sf -o /dev/null "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1" \
      || [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1")" = "403" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if esta_arriba; then
  echo "==> OK: produccion volvio a $NUEVA (venia de $ANTERIOR)"
  pm2 list | grep -E 'vendia|status' || true
else
  echo "==> FALLO: el puerto 3000 no responde despues de 30s. Mirar: pm2 logs --lines 120 --nostream" >&2
  exit 1
fi
