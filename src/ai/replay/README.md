# Reglas permanentes de las pruebas

Dos reglas. Las dos están acá porque ya se rompieron, no como precaución teórica.

## 1. Un fixture es una grabación real: no se edita

Regla que ya se rompió dos veces (y1iz5l antes, igmt9z después): un fixture es
una grabación real, nunca se edita el texto de `modelResponses` para que una
aserción pase. Si una aserción prueba algo que no le toca a esta fase, se acota
la aserción o se separa en otro turno de expectativa — nunca se toca lo que el
modelo dijo.

## 2. Ninguna prueba de `npm test` alcanza un servicio externo real

Ninguna prueba que corra bajo `npm test` puede llamar a S3, a WhatsApp, a
DeepSeek ni a Anthropic. Ni para "probar el camino feliz", ni una sola vez, ni
con un archivo chiquito.

Cuando haga falta probar la lógica que rodea a una de esas llamadas, **se extrae
la validación a una función pura y se prueba ahí**. El patrón ya está en el
repositorio: `resolveUploadType` en `src/media/s3.ts` decide si un archivo se
acepta y con qué tipo se guarda, y `uploadMedia` la llama antes de tocar S3. La
prueba ejerce `resolveUploadType`, nunca `uploadMedia`.

Las pruebas que sí gastan plata contra DeepSeek van en archivos `*Paid.ts`
(nunca `*.test.ts`) y se corren a mano con `npm run test:paid`. Ver CLAUDE.md.

Por qué la regla es absoluta y no "con cuidado" — pasó tres veces:

1. Una prueba de `generateReply` con credenciales reales de WhatsApp le mandó un
   mensaje de verdad a la dueña de un negocio en producción (2026-09-13). Usar
   credenciales falsas o el negocio sembrado de la suite de regresión.
2. Cuatro archivos `*.test.ts` llamaban a la API real de DeepSeek, así que
   `npm test` facturaba en cada corrida — uno de esos `npm test` quedó colgado
   10 minutos sin salida (2026-09-13). Y renombrar el archivo fuente no alcanzó:
   `dist/` todavía tenía la copia compilada de un `npm run build` viejo y el
   corredor la encontraba igual (2026-09-14). Por eso el script `test` está
   acotado al glob `"src/**/*.test.ts"` — no le saques ese argumento.
3. Una prueba de la validación de subidas llamó a `uploadMedia` de verdad y
   dejó un archivo basura de 76 bytes en el bucket de producción, bajo
   `audio/`. No se pudo borrar: el IAM no tiene `s3:ListBucket` y la prueba
   había descartado la clave (2026-09-15, Fase 8 punto 7). De ahí salió
   `resolveUploadType`.

El costo de romper la regla no es una prueba en rojo: es un mensaje que le llega
a un cliente real, una factura, o un objeto que queda para siempre en un bucket.
Nada de eso lo atrapa la suite — por definición, la suite es lo que lo causó.
