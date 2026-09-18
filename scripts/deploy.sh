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

# Salud real: se pregunta al PUERTO, no al log. El log es ruidoso (cada acuse de WhatsApp escribe una
# linea) y "Server listening" se sale de la ventana en segundos, asi que grepearlo daba falsas alarmas -
# paso en el despliegue de d0a3eb2, con el proceso perfectamente arriba. Se reintenta hasta 30s porque
# arrancar tarda mas que el sleep de antes.
esta_arriba() {
  for _ in $(seq 1 15); do
    if curl -sf -o /dev/null "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1"       || [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1")" = "403" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "==> Reiniciando"
# E23 (2026-09-18): son DOS procesos, `vendia` (web) y `vendia-worker`. `startOrRestart` sobre el
# ecosystem reinicia los que ya existen y ARRANCA los que no -- que es lo que hace falta la primera vez
# que este commit llega al servidor, donde `vendia-worker` todavia no existe. Un `pm2 restart vendia`
# suelto dejaria al worker sin levantar: el bot recibiria mensajes y no contestaria ninguno.
pm2 startOrRestart ecosystem.config.js --update-env >/dev/null
systemctl reload nginx

# Verificacion real, no un "exit 0" optimista: si el proceso no levanto, el despliegue fallo y hay que
# enterarse ahora, no cuando escriba un cliente.
if esta_arriba; then
  echo "==> OK: $NUEVA arriba (anterior: $ANTERIOR)"
else
  echo "==> FALLO: el puerto 3000 no responde despues de 30s. Volve con ./scripts/rollback.sh" >&2
  exit 1
fi
