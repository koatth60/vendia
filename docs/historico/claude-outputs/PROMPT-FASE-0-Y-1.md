# Prompts de ejecución — Fase 0 y Fase 1 del plan maestro

Dos prompts separados. **Una sesión nueva y limpia para cada uno.** No los pegues juntos: la Fase 0
es instrumentación chica y la Fase 1 es el trabajo que rompe el ciclo; mezclarlas en una sesión hace
que la segunda herede contexto que no necesita.

Modelo recomendado para las dos: **Sonnet 5**. Son trabajos acotados, con criterios de aceptación
verificables y pruebas que dicen si quedaron bien — exactamente el perfil donde Sonnet 5 rinde. No
hace falta Opus acá; guardalo para las fases 2, 4 y 7, donde hay juicio de diseño sobre el flujo de
la venta.

Antes de empezar, verificá que tengas Postgres local corriendo y que `npm test` pase en verde. Las
dos fases dependen de eso.

---

## PROMPT 1 — Fase 0: línea base

> Copiá desde acá hasta la línea de cierre.

---

Vas a ejecutar la **Fase 0 del plan maestro de Onix**. El plan está en `ONIX-PLAN-MAESTRO.md`
(sección 2) y la evidencia que lo justifica en `ONIX-DIAGNOSTICO-2026-09.md` (capítulo 3 bis).
Leé esas dos secciones antes de tocar nada; no leas los documentos completos, son largos.

**Contexto en una frase:** hoy no existe ningún número contra el cual comparar una mejora de Onix, y
la tasa de conversión que el panel le muestra al dueño del negocio está mal calculada por 52 puntos.

**Objetivo:** dejar instrumentada la línea base, sin cambiar una sola respuesta que reciba un
cliente.

### Alcance exacto

1. **`AgentIncident.guard`** — migración aditiva en `prisma/schema.prisma`: campo `guard String?`.
   Después, cada llamada a `recordAgentIncident` desde `src/ai/agent.ts` pasa el nombre del guard que
   intervino. Hoy los 18 incidentes de producción comparten el mismo `kind`
   (`BACKSTOP_INTERVENTION`) con el motivo en texto libre, así que no se puede saber cuál guard se
   activó. Los sitios a instrumentar son, como mínimo: `agent.ts:1098` (negación de variantes),
   `agent.ts:1347` (promesa de foto sin producto identificado), `agent.ts:985`
   (`honorOrRetractMediaPromise`), y el `applyClaimBackstops` de `agent.ts:934` — ese último ya
   recibe el nombre del guard en `ClaimBackstopGuard.name`, así que solo hay que propagarlo.
   No hagas backfill de las filas viejas.

2. **Denominador correcto de la conversión** — `src/analytics/service.ts:17-18` calcula la conversión
   sobre `SOLD + LOST`. Como el 61 % de las conversaciones muere en `NEW` y nunca se cierra, ese
   denominador miente: muestra 78,9 % cuando la real es 26,8 %. Cambialo a "conversaciones con
   intención de compra", definidas como las que llegaron al menos a `QUOTED`, `NEGOTIATING`, `SOLD` o
   `LOST`. Dejá la métrica vieja disponible también, con otro nombre, para poder comparar.

3. **Métricas P1-P7 en el panel** — sección nueva "Línea base" dentro de la pestaña de salud del bot.
   Las siete métricas están definidas en la tabla de la sección 2 del plan maestro. Las que se pueden
   calcular retroactivamente sobre los datos que ya existen (P1 conversión, P2 turnos hasta el cierre,
   P6 latencia entrante→saliente desde los timestamps de `Message`, P7 costo por conversación desde
   `AiUsageLog`) se calculan y se muestran ya. P5 (intervenciones por 100 turnos, abierta por guard)
   se muestra desde el momento en que el campo nuevo empiece a poblarse.

   La UI del panel va en esta misma fase — es regla del repositorio: toda funcionalidad configurable
   o visible por negocio ships con su pantalla en la misma fase. Respetá las reglas de estilo de
   `CLAUDE.md`: ningún color literal fuera de `public/admin/css/tokens.css`, iconos SVG inline nunca
   emoji, cifras con la clase `.onix-num`.

### Reglas duras

- **No corras `npm run regression` ni `npm run test:paid`.** Cuestan dinero real y la decisión es del
  dueño. Nada de esta fase los necesita.
- **No agregues ninguna expresión regular nueva.** Si creés que hace falta una, parás y preguntás.
- `npm test` tiene que seguir pasando en verde al terminar. Corrélo una vez al final, no en cada
  edición.
- `npx tsc --noEmit` una vez después del lote de cambios, no después de cada edición.
- Seguí las reglas de tokens de `CLAUDE.md`: `Grep` y `Read` con `offset`/`limit` en vez de volcar
  archivos grandes. `public/admin/index.html` y `public/admin/js/admin.js` son enormes.
- No despliegues. No toques producción.

### Criterios de aceptación

- La migración corre limpia sobre una base local.
- Un incidente nuevo generado en una prueba queda con `guard` poblado.
- El panel muestra las dos conversiones (la vieja y la corregida) y la diferencia es visible.
- `npm test` en verde, `npx tsc --noEmit` sin errores.
- Ninguna respuesta al cliente cambia: esta fase es invisible desde WhatsApp.

Al terminar, decime qué números da la línea base con los datos reales que ya hay en la base local o,
si no tenés datos, qué consulta habría que correr contra producción para obtenerlos.

---
*(fin del prompt 1)*

---

## PROMPT 2 — Fase 1: suite determinista de conversación completa

> Copiá desde acá hasta la línea de cierre. Usalo en una sesión nueva, después de terminar la Fase 0.

---

Vas a ejecutar la **Fase 1 del plan maestro de Onix**. El diseño completo está en
`ONIX-PLAN-MAESTRO.md`, sección 3 — leé esa sección entera antes de escribir código, incluidos el
formato de fixture, las cuatro reglas de aserción y la lista de cobertura obligatoria. Leé también el
capítulo 4 de `ONIX-DIAGNOSTICO-2026-09.md` (taxonomía de fallas), que es de dónde salen las
conversaciones que hay que cubrir.

**Contexto en una frase:** hoy la única prueba real de Onix es producción; `npm test` corre 361
pruebas de funciones puras en 35 segundos y no ejercita una sola conversación de varios turnos. Esta
fase es la que cambia ese régimen, y sin ella ninguna de las fases siguientes se puede validar.

**Objetivo:** una suite que reproduzca conversaciones reales contra un modelo mockeado con respuestas
grabadas, asertando sobre el estado final y la secuencia de llamadas a herramientas, que corra dentro
de `npm test`, gratis, en segundos.

### Punto de partida que ya existe

`src/ai/agent.loopExhaustion.test.ts:1-45` ya demuestra el patrón completo: sustituye
`deepseek.chat.completions.create` sobre la instancia mutable de `src/ai/client.ts`, siembra un
negocio y un cliente de prueba en Postgres local, y limpia al terminar. **No inventes un andamiaje
nuevo: partí de ese archivo.** Lo que falta es el formato de conversación grabada, el motor de
reproducción y las aserciones.

Las conversaciones fuente están en `src/ai/regression/fixtures/conversations.json` (37 reales
anonimizadas) y el catálogo de los dos negocios en `fixtures/catalog.json`.

### Alcance exacto

Creá esta estructura:

```
src/ai/replay/
  fixtures/*.json       una conversacion por archivo
  seed.ts               siembra negocio + catalogo desde fixtures/catalog.json
  replay.ts             motor de reproduccion
  replay.test.ts        un test por fixture, corre dentro de npm test
scripts/record-replay.ts  graba respuestas del modelo contra DeepSeek real (costo unico)
```

Empezá por **cuatro** fixtures, no por treinta, y validá el diseño con esos antes de escalar:

| Fixture | Conversación fuente | Qué tiene que demostrar |
|---|---|---|
| `aurora-sin-config` | `igmt9z` (LOST, Aurora Joyas) | El bot prometió datos bancarios 3 veces sin que el negocio tuviera métodos de pago configurados, y terminó diciéndole a la clienta que escribiera "al WhatsApp del negocio directo" |
| `foto-no-converge` | `y1iz5l` (163 mensajes, NEW) | Mandó las mismas 3 fotos dos veces y nunca identificó el producto |
| `datos-repetidos` | `ps2evr` (SOLD, 65 mensajes) | Pidió ciudad y barrio en los turnos 9, 11 y 52, y pidió los datos "de a uno" cuando la clienta ya había mandado el bloque completo |
| `cierre-feliz` | `bf5c4k` (SOLD) | El camino que **sí** funciona, para que las fases siguientes no lo rompan |

### Reglas de aserción — esto es lo que decide si la suite sirve o es frágil

1. **Nunca asertes sobre el texto exacto que genera el modelo.** Cambia de redacción constantemente y
   eso no es una regresión.
2. Asertá sobre: estado final de la conversación, secuencia de nombres de herramientas llamadas, y
   efectos laterales contados (mensajes enviados, fotos enviadas, escalaciones creadas).
3. Se permite asertar presencia o ausencia de bloques deterministas (un total, unos datos de pago)
   porque a partir de la Fase 3 los va a insertar el sistema con texto fijo.
4. `textMustNotContain` cubre la clase "el bot dijo una cifra que no debía".

### Lo importante sobre el resultado esperado

**Las tres primeras conversaciones tienen que FALLAR** cuando escribas su prueba. Eso es el
resultado correcto, no un problema: confirma que la prueba mide el defecto real y no describe el
comportamiento actual. Si te pasan en verde, la aserción está mal escrita — revisala en vez de
celebrarla. `cierre-feliz` sí tiene que pasar.

### Sobre la grabación — parás y preguntás antes

`scripts/record-replay.ts` tiene que llamar a DeepSeek **de verdad** una vez por conversación para
grabar las respuestas. Eso cuesta plata real (del orden de centavos, según `AiUsageLog`: el costo
total de 10 días de producción fueron USD 0,71).

**No lo corras por tu cuenta.** Escribí el script, dejalo listo, y **parás y le preguntás al dueño**
cuánto y cuándo. Mientras tanto, para desarrollar el motor de reproducción, escribí las respuestas
del modelo a mano en los fixtures: son JSON, y para validar el diseño alcanza con inventarlas.

### Reglas duras

- **No corras `npm run regression` ni `npm run test:paid`.**
- **Ningún archivo de prueba que llame a DeepSeek de verdad puede llamarse `*.test.ts`.** Si lo hace,
  `npm test` lo descubre y factura en cada corrida. Va con nombre `*Paid.ts` y se agrega a
  `npm run test:paid`. Esto ya pasó tres veces en este repositorio; está documentado en `CLAUDE.md`.
- La suite nueva **no puede hacer una sola llamada de red**. Verificalo con un `fetch` mockeado que
  tire error si alguien lo llama.
- `npm test` completo tiene que seguir corriendo en menos de 90 segundos con la suite nueva incluida.
- **No cambies `src/ai/agent.ts`, `src/ai/tools.ts` ni el prompt en esta fase.** Si para que la
  prueba corra hace falta un cambio mínimo en el código de producción (por ejemplo exportar una
  función para poder inspeccionarla), parás y lo consultás antes de hacerlo. La Fase 1 es
  exclusivamente andamiaje de pruebas.
- Reglas de tokens de `CLAUDE.md`: `Grep` y `Read` con `offset`/`limit`. `agent.ts` tiene 1.666
  líneas y `conversations.json` 267 KB — no los vuelques enteros.
- No despliegues.

### Criterios de aceptación

- `npm test` corre la suite nueva, en verde para `cierre-feliz` y en rojo para las otras tres, con
  mensajes de fallo que digan **qué** estado o qué secuencia de herramientas esperaba.
- Cero llamadas de red durante `npm test`, verificado.
- El README de `src/ai/replay/` explica en diez líneas cómo agregar una conversación nueva y cómo
  regrabar las respuestas.
- `npx tsc --noEmit` sin errores.

Cuando termines, decime cuánto tarda `npm test` ahora, qué falla exactamente en cada uno de los tres
fixtures rojos, y cuántas conversaciones más conviene agregar antes de empezar la Fase 2.

---
*(fin del prompt 2)*
