#!/usr/bin/env bash
# Despliegue del droplet, en un solo comando:
#
#   bash /opt/vendia/scripts/deploy.sh [rama]
#
# Existe porque la red de la oficina bloquea el puerto 22 hacia el droplet, asi
# que el deploy no se puede hacer por SSH desde afuera: se corre desde la
# consola web de DigitalOcean, que entra por el backend de DO. El servidor si
# alcanza a GitHub (llave de despliegue en /root/.ssh/github_deploy), asi que
# el codigo baja por git en vez de subirse por SSH.
#
# Solo corre los pasos caros cuando de verdad hicieron falta: reinstala
# dependencias si cambio package-lock.json, regenera Prisma si cambio el
# esquema y aplica migraciones si aparecieron nuevas. Un cambio de CSS no
# reinstala node_modules.
set -euo pipefail

BRANCH="${1:-redesign/completo}"
APP_DIR="/opt/vendia"
PM2_NAME="vendia"

cd "$APP_DIR"

echo "==> Bajando $BRANCH"
BEFORE="$(git rev-parse HEAD)"
git fetch origin "$BRANCH"
git checkout -f -B "$BRANCH" "origin/$BRANCH"
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "    Ya estaba en $AFTER - no hay nada nuevo."
else
  echo "    $BEFORE -> $AFTER"
fi

changed() { git diff --name-only "$BEFORE" "$AFTER" | grep -q "$1"; }

if [ "$BEFORE" != "$AFTER" ] && changed '^package-lock\.json$'; then
  echo "==> Cambiaron las dependencias: npm ci"
  npm ci
  echo "==> npm ci borro node_modules, hay que regenerar Prisma"
  npx prisma generate
elif [ "$BEFORE" != "$AFTER" ] && changed '^prisma/schema\.prisma$'; then
  echo "==> Cambio el esquema: prisma generate"
  npx prisma generate
fi

# El cliente de Prisma vive en node_modules; si por lo que sea no esta, el
# proceso arranca y se cae en bucle con "Cannot find module '.prisma/client'".
if [ ! -d node_modules/.prisma/client ]; then
  echo "==> Falta el cliente de Prisma: prisma generate"
  npx prisma generate
fi

if [ "$BEFORE" != "$AFTER" ] && changed '^prisma/migrations/'; then
  echo "==> Hay migraciones nuevas: prisma migrate deploy"
  npx prisma migrate deploy
fi

echo "==> Compilando"
npm run build

echo "==> Reiniciando $PM2_NAME"
PID_BEFORE="$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).find(x=>x.name==='$PM2_NAME');console.log(p?p.pid:'')})")"
pm2 restart "$PM2_NAME" --update-env

# Un "online" inmediato no dice nada: si arranca y se cae, pm2 lo relanza y
# sigue diciendo online con un pid distinto cada vez. Por eso se mira dos veces
# separadas y se compara el pid.
sleep 6
PID_1="$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).find(x=>x.name==='$PM2_NAME');console.log(p?p.pid:'')})")"
sleep 6
PID_2="$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).find(x=>x.name==='$PM2_NAME');console.log(p?p.pid:'')})")"

echo
if [ -n "$PID_1" ] && [ "$PID_1" = "$PID_2" ]; then
  echo "OK - $PM2_NAME estable en el pid $PID_1 (antes: ${PID_BEFORE:-ninguno})"
  echo "     commit desplegado: $(git log --oneline -1)"
else
  echo "ATENCION - el pid cambio entre las dos lecturas ($PID_1 -> $PID_2)."
  echo "           Eso es un bucle de reinicio. Ultimos errores:"
  pm2 logs "$PM2_NAME" --lines 25 --nostream --err
  exit 1
fi
