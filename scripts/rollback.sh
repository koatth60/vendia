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

echo "==> Volviendo de $ACTUAL a $DESTINO"
git reset --hard "$DESTINO"
npx prisma generate >/dev/null

pm2 restart vendia --update-env >/dev/null
systemctl reload nginx

if esta_arriba; then
  # El destino pasa a ser el "anterior" del proximo rollback, para no quedar rebotando entre dos.
  echo "$ACTUAL" > "$ANTERIOR_FILE"
  echo "==> OK: $DESTINO arriba. Volver a $ACTUAL: ./scripts/rollback.sh"
else
  echo "==> FALLO: el proceso no levanto ni siquiera con la version anterior. Mirar pm2 logs vendia." >&2
  exit 1
fi
