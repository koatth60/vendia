# Operar el servidor sin la maquina del dueno

Hasta el 2026-09-17 desplegar era `ssh vendia "cd /opt/vendia && ./scripts/deploy.sh <rama>"`. El host
`vendia` apunta a `100.79.86.116`, una direccion de Tailscale que solo existe dentro de esa red: desde
una sesion en la nube, desde otra computadora o desde un runner de CI no resuelve a nada. Por eso
desplegar era imposible fuera de la maquina del dueno.

Ahora hay un segundo camino, que no necesita ni la llave ni Tailscale.

## El camino nuevo: GitHub Actions

El workflow `.github/workflows/deploy.yml` corre en un runner de GitHub y entra al droplet por su IP
publica. Se dispara a mano, nunca solo.

```bash
git push origin redesign/completo                        # primero el codigo
gh workflow run deploy.yml -f accion=redesign/completo    # despues el despliegue
gh run watch                                              # seguir la corrida
gh run view --log                                         # leer lo que dijo el servidor
```

Las otras acciones no cambian nada y sirven para mirar:

| accion | que hace |
| --- | --- |
| `<nombre-de-rama>` | `git pull` de esa rama, migraciones, `pm2 restart`, verificacion del puerto 3000 |
| `estado` | estado de pm2, commit desplegado, commit anterior, disco |
| `logs` | ultimas 120 lineas de pm2, sin seguir |
| `rollback` | vuelve al commit anterior al ultimo despliegue |

El workflow no compila ni prueba nada: corre `scripts/deploy.sh`, el mismo de siempre. Las pruebas son
el workflow `test.yml`, que ya corre en cada push. **Mirar que `Tests` este en verde antes de
desplegar**, porque el despliegue no lo comprueba por su cuenta.

## Por que esto no es una consola de root en manos de GitHub

La llave que usa el runner (`DEPLOY_SSH_KEY`) es nueva y exclusiva de CI. No es la del dueno. En el
servidor esta anotada en `/root/.ssh/authorized_keys` con un comando forzado:

```
command="/opt/vendia/scripts/ci-deploy.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA... github-actions-deploy
```

Con un comando forzado, sshd ignora lo que el cliente pida ejecutar y corre siempre ese script. Lo que
el cliente escribio llega como texto en `SSH_ORIGINAL_COMMAND`, y `scripts/ci-deploy.sh` lo compara
contra su propia lista: `estado`, `logs`, `rollback`, o algo que de verdad parezca un nombre de rama
(`^[A-Za-z0-9._/-]{1,100}$`). Cualquier otra cosa sale con codigo 64 sin tocar nada.

Si alguien se roba la llave, no consigue un shell: consigue poder desplegar una rama del repositorio.
Para revocarla basta borrar esa linea del `authorized_keys`; el acceso del dueno por Tailscale sigue
intacto porque es otra llave y otra linea.

## Lo que sigue necesitando la maquina del dueno

- `ssh vendia` para cualquier cosa que no este en la lista de arriba (mirar la base, editar `.env`,
  instalar paquetes).
- Las variables de entorno de produccion. `.env` vive solo en el servidor y no esta en el repositorio.

## Secretos del repositorio que esto usa

| secreto | contenido |
| --- | --- |
| `DEPLOY_HOST` | `64.227.8.255`, la IP publica del droplet. No la de Tailscale, que el runner no ve. |
| `DEPLOY_SSH_KEY` | la clave privada ed25519 exclusiva de CI |
| `DEPLOY_KNOWN_HOSTS` | las claves de host del droplet, para que el runner no acepte cualquier servidor |

## Que etapas del plan quedan bloqueadas por esto (verificado el 2026-09-18)

Se midio desde una sesion en la nube, no se supuso: el puerto 22 del droplet **no responde**, `vendia`
no resuelve (es una IP de Tailscale, existe solo en la red del dueno) y no hay ninguna variable de
produccion en el entorno de la sesion. O sea que desde la nube se puede desplegar y mirar `estado` y
`logs`, pero **no consultar la base de produccion**.

Cinco etapas del plan dependen justamente de eso y no se pueden cerrar sin la maquina del dueno:

| etapa | que necesita de produccion |
| --- | --- |
| `E06` | correr `scripts/e06-clasificar-duplicadas.ts` contra la base y leer `~/.pm2/pm2.log` entero |
| `E11` | 48 h de `shadowFindings` reales antes de encender la bandera |
| `E17` | 48 h de errores 131053 para comparar contra la linea base |
| `E26` | 48 h de log de firma invalida, y despues tocar `.env` |
| `E64` | 48 h de trafico y la decision de encender el validador que puede BLOQUEAR un mensaje |

**Propuesta, sin implementar:** agregarle a `ci-deploy.sh` una accion de **solo lectura** (por ejemplo
`diagnostico`) que corra un script del repositorio contra la base y devuelva su salida por el log del
workflow. Destrabaria `E06` sin darle a CI ninguna capacidad de escritura. No se hizo porque amplia el
alcance de CI sobre produccion y esa decision es del dueno.

**Regla que no se negocia, anotada el 2026-09-18 a pedido del dueno:** ningun agente borra nada en
produccion. Ni catalogos, ni pedidos, ni clientes, ni conversaciones. Si algo pareciera necesitar un
borrado, se anota y se espera.

## `diagnostico`: leer la base de produccion desde la nube (2026-09-18)

La propuesta de la seccion anterior **quedo implementada**. `ci-deploy.sh` acepta una accion mas:

```bash
gh workflow run deploy.yml -f accion=diagnostico      # ultimos 7 dias
gh workflow run deploy.yml -f accion=diagnostico:14   # ultimos 14
gh run watch && gh run view --log                     # aca sale la clasificacion
```

Corre `scripts/e06-clasificar-duplicadas.ts` contra la base de produccion y devuelve su salida por el
log del workflow. **Solo lee**: ese script no tiene un INSERT, ni un UPDATE, ni manda ningun mensaje,
asi que se puede correr con el bot andando.

**La lista es de UN solo script, a proposito.** No es "corre lo que le pasen por SSH": agregar otro
diagnostico es un cambio al repositorio, que se revisa como cualquier otro. El argumento se valida
contra `^[0-9]{1,3}$` antes de llegar a ningun lado.

### Como se activa

`ci-deploy.sh` vive en `/opt/vendia/scripts/`, que es el mismo checkout que `deploy.sh` actualiza con
`git pull`. O sea que **el script se actualiza solo en el proximo despliegue** y no hay que tocar el
servidor a mano. Como `ci-deploy.sh` termina en `exec`, reemplazarlo mientras corre no rompe nada: el
proceso ya fue sustituido por `deploy.sh`.

Hasta que se despliegue una rama que lo incluya, `accion=diagnostico` se interpreta como nombre de
rama y falla — es el comportamiento viejo, no un error nuevo.
