#!/usr/bin/env bash
# Despliegue de Onix. Corre EN EL SERVIDOR, desde /opt/vendia.
#
# Lo unico que agrega sobre "git pull && pm2 restart" es lo que faltaba el 2026-09-17: dejar anotado
# desde donde se vino, para que volver atras sea un comando y no un ejercicio de memoria a las 2 AM.
#
#   ssh vendia "cd /opt/vendia && ./scripts/deploy.sh [rama]"
set -euo pipefail

RAMA="${1:-redesign/completo}"
ANTERIOR_FILE=".deploy-previous"

cd "$(dirname "$0")/.."

ANTERIOR="$(git rev-parse HEAD)"
echo "==> Version actual: $ANTERIOR"

git fetch origin "$RAMA"
git pull --ff-only origin "$RAMA"

NUEVA="$(git rev-parse HEAD)"
if [ "$ANTERIOR" = "$NUEVA" ]; then
  echo "==> Ya estaba en $NUEVA, no hay nada que desplegar"
  exit 0
fi

# Se escribe DESPUES del pull y antes de tocar nada que corra: si el pull falla, el archivo sigue
# apuntando al despliegue anterior bueno, que es lo correcto.
echo "$ANTERIOR" > "$ANTERIOR_FILE"

echo "==> Migraciones"
npx prisma migrate deploy
npx prisma generate >/dev/null

echo "==> Reiniciando"
pm2 restart vendia --update-env >/dev/null
sleep 6
systemctl reload nginx

# Verificacion real, no un "exit 0" optimista: si el proceso no levanto, el despliegue fallo y hay que
# enterarse ahora, no cuando escriba un cliente.
if pm2 logs vendia --lines 20 --nostream --no-color 2>&1 | grep -q "Server listening"; then
  echo "==> OK: $NUEVA arriba (anterior: $ANTERIOR)"
else
  echo "==> FALLO: el proceso no reporto 'Server listening'. Volve con ./scripts/rollback.sh" >&2
  exit 1
fi
