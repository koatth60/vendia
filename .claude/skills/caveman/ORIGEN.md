# De donde salio esta skill

- Origen: https://github.com/juliusbrussee/caveman, directorio `skills/caveman/`
- Licencia: MIT. `LICENSING.md` del proyecto aclara que `skills/` es MIT; lo que esta bajo BSL-1.1 es
  `engine/`, `rewriter/` y `proxy/`, que NO se copian aca.
- Copiada tal cual el 2026-09-18, sin modificar una linea. Si hay que actualizarla, se vuelve a copiar
  del origen en vez de parchearla aca: un fork silencioso es peor que una version vieja.

## Por que esta vendorizada y no instalada

Lo que se instala con `/plugin` vive en la maquina donde se instalo. Una sesion en la nube arranca de
un contenedor nuevo y no lo ve - verificado el 2026-09-18: `caveman` no existia en el disco de la
sesion y los directorios de plugins sincronizados estaban vacios. Adentro del repositorio la carga
cualquier sesion, local o en la nube, sin instalar nada.

## Que NO cambia

Su propia seccion "Boundaries" lo dice y va en linea con este repositorio: el estilo comprimido es
para el chat. Codigo, comentarios, mensajes de commit, documentacion y textos de PR o de issues se
siguen escribiendo en prosa normal. Tambien se apaga sola para advertencias de seguridad y
confirmaciones de acciones irreversibles.
