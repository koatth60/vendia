# Respaldos de la base

## Por que este documento existe

`scripts/backupDb.ts` estaba en el repositorio desde antes del 2026-09-18 y hacia exactamente lo
correcto: `pg_dump` en formato custom, subido a S3. **No lo llamaba nadie.** Cero referencias en todo el
repositorio: ni un cron, ni un job, ni un script de `npm`. Alguien lo escribio y quedo ahi.

Eso es peor que no tenerlo, porque da la sensacion de que hay respaldos.

Y no habia **ninguna** forma de volver atras: existia el volcado y no existia la restauracion. Un volcado
que nunca se restauro no es un respaldo, es un archivo.

El plan (`ONIX-PLAN.md`) no menciona respaldos ni una sola vez — se busco `backup`, `pg_dump`,
`restore` y `respaldo`. Todas las etapas del plan hacen que el sistema falle menos. El respaldo es lo
unico que hace que un error **no sea irreversible**.

## Como funciona ahora

**Automatico.** `src/jobs/backup.ts` corre adentro del proceso, se revisa cada hora y hace un volcado si
el ultimo tiene mas de 20 horas. Vive en el proceso y no en un cron del servidor a proposito: asi se
despliega con el codigo, se prueba con el codigo, y no depende de que alguien se acuerde de configurar
la maquina.

**Por que se revisa cada hora y no una vez al dia:** `setInterval` se reinicia con el proceso. Con un
intervalo diario, cada despliegue empujaba el respaldo un dia entero mas adelante — y el 2026-09-17 hubo
trece despliegues en un dia, o sea que podia no hacerse nunca.

**Por que 20 horas y no 24:** para que no se corra un poco cada dia hasta terminar siempre a la misma
mala hora.

**Como sabe si ya respaldo:** mira la fecha del ultimo objeto en `s3://<bucket>/backups/`. El respaldo
MISMO es el registro de que se hizo, asi que no hay una columna que mantener en sincronia con la
realidad — y por lo tanto no hay nada que se pueda desincronizar.

**Si falta AWS,** el job no explota: escribe `[ZAQI ALERT] No hay respaldo de la base` y sigue. Ruidoso
a proposito: un respaldo que no corre tiene que doler al leer los logs.

## A mano

```bash
npm run backup:db     # volcado ahora mismo, sin esperar al job
npm run restore:db    # lista los respaldos disponibles, del mas nuevo al mas viejo
```

## Restaurar

```bash
npm run restore:db -- vendia-db-2026-09-18T12-00-00-000Z.dump
```

Eso **no restaura nada**: imprime que archivo es, sobre que base iria, y que `pg_restore --clean` borra
los objetos del esquema antes de recrearlos. Para que ocurra de verdad hay que repetirlo agregando
`--si-estoy-seguro`.

Son dos cosas — nombrar el archivo Y confirmar — justamente para que no exista la forma de restaurar sin
querer. **La restauracion es destructiva:** todo lo que haya en la base destino desde ese respaldo se
pierde.

## Verificado el 2026-09-18

No solo se escribio el codigo: se hizo la ida y vuelta completa.

1. `pg_dump` de la base de pruebas (4 negocios) -> archivo de 99 KB en formato custom.
2. `pg_restore --clean --if-exists --no-owner` sobre una base **vacia**.
3. Consulta sobre la base restaurada: los 4 negocios estaban.

## Lo que queda por decidir (es tuyo, no del codigo)

- **Retencion.** Los respaldos viejos **no se borran**, y no es un olvido: es la decision `D10` del plan
  y la toma el dueno. Hasta entonces se acumulan, que en S3 cuesta centavos y es el lado seguro del
  error. Ningun agente borra nada.
- **Respaldo fuera de AWS.** Hoy el respaldo vive en el mismo proveedor que los medios. Si se pierde la
  cuenta de AWS, se pierden las dos cosas.
- **Probar la restauracion contra un volcado de produccion.** Lo de arriba se verifico contra la base de
  pruebas. Contra produccion hay que hacerlo al menos una vez, en una base aparte, antes de necesitarlo.
