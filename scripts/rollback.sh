#!/usr/bin/env bash
# Vuelve Onix al commit que estaba corriendo ANTES del ultimo despliegue. Corre EN EL SERVIDOR.
#
#   ssh vendia "cd /opt/vendia && ./scripts/rollback.sh"
#
# Lo que NO hace, a proposito: revertir migraciones. Todas las migraciones de este repositorio agregan
# columnas con default o tablas nuevas, asi que el codigo viejo convive con el esquema nuevo sin
# enterarse - una columna de mas no molesta a nadie. Revertir un esquema automaticamente, en cambio,
# puede borrar datos de clientes. Si alguna vez hace falta, se hace a mano y mirando.
set -euo pipefail

ANTERIOR_FILE=".deploy-previous"

cd "$(dirname "$0")/.."

if [ ! -f "$ANTERIOR_FILE" ]; then
  echo "No hay $ANTERIOR_FILE: este servidor todavia no desplego con scripts/deploy.sh." >&2
  echo "Version actual: $(git rev-parse --short HEAD)" >&2
  echo "Para volver a mano: git reset --hard <commit> && pm2 restart vendia" >&2
  exit 1
fi

DESTINO="$(cat "$ANTERIOR_FILE")"
ACTUAL="$(git rev-parse HEAD)"

if [ "$DESTINO" = "$ACTUAL" ]; then
  echo "Ya estas en $DESTINO, no hay nada que revertir."
  exit 0
fi

echo "==> Volviendo de $ACTUAL a $DESTINO"
git reset --hard "$DESTINO"
npx prisma generate >/dev/null

pm2 restart vendia --update-env >/dev/null
sleep 6
systemctl reload nginx

if pm2 logs vendia --lines 20 --nostream --no-color 2>&1 | grep -q "Server listening"; then
  # El destino pasa a ser el "anterior" del proximo rollback, para no quedar rebotando entre dos.
  echo "$ACTUAL" > "$ANTERIOR_FILE"
  echo "==> OK: $DESTINO arriba. Volver a $ACTUAL: ./scripts/rollback.sh"
else
  echo "==> FALLO: el proceso no levanto ni siquiera con la version anterior. Mirar pm2 logs vendia." >&2
  exit 1
fi
