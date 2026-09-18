#!/usr/bin/env bash
# Puerta de entrada de GitHub Actions al servidor. Es el unico comando que la llave de CI puede correr:
# en /root/.ssh/authorized_keys esa llave esta anclada con command="/opt/vendia/scripts/ci-deploy.sh".
#
# Existe para que tener la llave de CI no sea lo mismo que tener una consola de root. El runner manda
# una sola palabra; todo lo que no este en esta lista se rechaza antes de tocar nada.
#
#   <nombre-de-rama>  despliega esa rama
#   estado            pm2 + version desplegada, sin cambiar nada
#   logs              ultimas 120 lineas de pm2, sin cambiar nada
#   rollback          vuelve al commit anterior al ultimo despliegue
set -euo pipefail

cd /opt/vendia

PEDIDO="${SSH_ORIGINAL_COMMAND:-estado}"

case "$PEDIDO" in
  estado)
    pm2 describe vendia | grep -Ei 'status|uptime|restarts|exec mode' || true
    echo "commit: $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"
    echo "anterior: $(cat .deploy-previous 2>/dev/null || echo 'sin registro')"
    df -h / | tail -1
    exit 0
    ;;
  logs)
    exec pm2 logs vendia --lines 120 --nostream
    ;;
  rollback)
    exec ./scripts/rollback.sh
    ;;
esac

# Cualquier otra cosa se interpreta como nombre de rama, y solo si de verdad parece uno. Sin esta
# validacion, "main; rm -rf /" llegaria a deploy.sh como argumento.
if ! printf '%s' "$PEDIDO" | grep -qE '^[A-Za-z0-9._/-]{1,100}$'; then
  echo "ci-deploy: pedido rechazado" >&2
  exit 64
fi

exec ./scripts/deploy.sh "$PEDIDO"
