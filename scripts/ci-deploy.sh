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
#   diagnostico[:N]   clasifica las respuestas duplicadas de los ultimos N dias (7 por defecto).
#                     SOLO LEE la base; no cambia nada ni manda ningun mensaje.
set -euo pipefail

cd /opt/vendia

PEDIDO="${SSH_ORIGINAL_COMMAND:-estado}"

case "$PEDIDO" in
  estado)
    pm2 list | grep -E 'vendia|name|status' || true
    echo "commit: $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"
    echo "anterior: $(cat .deploy-previous 2>/dev/null || echo 'sin registro')"
    df -h / | tail -1
    exit 0
    ;;
  logs)
    exec pm2 logs --lines 120 --nostream
    ;;
  rollback)
    exec ./scripts/rollback.sh
    ;;
  diagnostico|diagnostico:*)
    # Solo lectura. Corre el clasificador de E06 contra la base de produccion y devuelve su salida por
    # el log del workflow. Existe porque cinco etapas del plan (E06, E11, E17, E26, E64) necesitan mirar
    # datos reales, y desde una sesion en la nube no hay forma de llegar a la base: el puerto 22 del
    # droplet no responde fuera de la red del dueno.
    #
    # La lista es de UN solo script, a proposito. No es "corre lo que le pasen": agregar otro es un
    # cambio al repositorio, que se revisa. Y ese script no tiene ni un INSERT, ni un UPDATE, ni manda
    # un mensaje - se puede correr con el bot andando.
    DIAS="${PEDIDO#diagnostico}"
    DIAS="${DIAS#:}"
    DIAS="${DIAS:-7}"
    if ! printf '%s' "$DIAS" | grep -qE '^[0-9]{1,3}$'; then
      echo "ci-deploy: diagnostico espera una cantidad de dias, no '$DIAS'" >&2
      exit 64
    fi
    exec npx tsx scripts/e06-clasificar-duplicadas.ts "$DIAS"
    ;;
esac

# Cualquier otra cosa se interpreta como nombre de rama, y solo si de verdad parece uno. Sin esta
# validacion, "main; rm -rf /" llegaria a deploy.sh como argumento.
if ! printf '%s' "$PEDIDO" | grep -qE '^[A-Za-z0-9._/-]{1,100}$'; then
  echo "ci-deploy: pedido rechazado" >&2
  exit 64
fi

exec ./scripts/deploy.sh "$PEDIDO"
