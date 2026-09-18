#!/usr/bin/env bash
# Puerta de entrada del despliegue automatico. Es el unico comando que la llave de CI puede correr:
# en /root/.ssh/authorized_keys esa llave esta anclada con command="/opt/vendia/scripts/ci-deploy.sh".
#
# Existe para que tener la llave de CI no sea lo mismo que tener una consola de root en el servidor.
# GitHub Actions manda un nombre de rama y nada mas; todo lo que no parezca un nombre de rama se
# rechaza antes de llegar a deploy.sh.
set -euo pipefail

RAMA="${SSH_ORIGINAL_COMMAND:-redesign/completo}"

if ! printf '%s' "$RAMA" | grep -qE '^[A-Za-z0-9._/-]{1,100}$'; then
  echo "ci-deploy: nombre de rama rechazado" >&2
  exit 64
fi

cd /opt/vendia
exec ./scripts/deploy.sh "$RAMA"
