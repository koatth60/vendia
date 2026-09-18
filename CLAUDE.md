# Working efficiently in this repo

Token usage in this project is dominated by tool output (file reads, test runs, curl/logs), not by
response prose. Follow these to keep sessions cheap:

1. Don't re-read a file right after Edit/Write — the tool result already confirms the change.
2. Use `Read` with `offset`/`limit`, or `Grep`, instead of dumping a whole file — several files here
   (`public/admin/index.html`, `src/routes/whatsapp.ts`, `src/routes/admin.ts`) are large.
3. Run only the affected test file(s) while iterating (`node --import tsx --test src/path/to.test.ts`).
   Run the full `npm test` suite once, right before committing — not after every small change.
4. Don't dump raw API responses (curl to Meta's Graph API, etc). Pipe through `node -e` or `jq` and
   print only the fields that matter.
5. Read logs (`pm2 logs`, deploy output) with `tail -N` or `grep`, never the whole file.
6. Run `npx tsc --noEmit` once after a batch of related edits, not after every individual edit.
7. For broad/unfamiliar-code exploration, delegate to an Explore subagent instead of reading many
   files directly into the main context - it returns a summary, not the raw contents.

# Onix prompt/tool changes (the bot's own token cost, not this session's)

Onix (the WhatsApp bot in `src/ai/agent.ts` + `src/ai/tools.ts`) sends a large fixed prompt+tools
payload to DeepSeek on every customer message. Keep this lean going forward:

- On every change to `BASE_SYSTEM_PROMPT`, `catalogTools` descriptions, or the backstop-guard
  regexes in `agent.ts`, look for a token-saving opportunity first (duplicate phrasing, prose that
  could be conditional per business, wording that's already stated elsewhere the model sees on every
  real call) before just appending more text.
- Validate any such change with `npm run regression` (replays real anonymized production
  conversations against the live `generateReply` + real DeepSeek API - real cost, run once, not in a
  loop; `REGRESSION_IDS=id1,id2 npm run regression` replays only specific conversations, cheaper while
  iterating on a fix for one known case) before merging: zero net new backstop interventions vs. the
  pre-change baseline. Follow with one run of `npm run test:paid` (runs
  `src/ai/agent.escalationPaid.ts`, also real DeepSeek calls).
- Neither of the above is part of `npm test` or CI - they cost real money per run, so run them
  deliberately, not while iterating. Any test file that calls the real DeepSeek API must be named
  `*Paid.ts`, never `*.test.ts` — Node's default test-file discovery (`npm test`) picks up every
  `*.test.ts` with no path filter, so a real-cost test left under that name runs (and bills) on every
  plain `npm test`. Confirmed twice on 2026-09-13: first `agent.escalation.test.ts` (renamed to
  `agent.escalationPaid.ts`), then three more files found doing the same thing
  (`agent.categoryColorScope.test.ts`, `agent.ambiguousRequests.test.ts`, `contextSummary.test.ts` →
  `agent.categoryColorScopePaid.ts`, `agent.ambiguousRequestsPaid.ts`, `contextSummaryPaid.ts`). All 4
  `*Paid.ts` files are wired into `npm run test:paid`. Before adding any new test that calls
  `generateReply`/DeepSeek for real, name it `*Paid.ts` from the start and add it to that script.
- Third occurrence, 2026-09-14: renaming the source file is NOT enough. `dist/` still held
  `dist/routes/whatsapp.webhook.test.js` from an old `npm run build`, and `npm test` had no path
  filter, so it discovered the stale COMPILED copy and billed DeepSeek on every plain `npm test`
  (that run hung for 10 minutes with zero output). The `test` script is now scoped to a glob
  (`node --import tsx --test "src/**/*.test.ts"`) - never remove that argument. A bare directory
  (`--test src`) does NOT work on Node 22: it also runs `src/index.ts` and dies on EADDRINUSE :3000. `dist/` is build output that
  production does not use (prod runs the source through tsx); if it ever gets rebuilt, the compiled
  `*.test.js` files under it are dead weight, not a test suite.
- Fourth occurrence, 2026-09-18, and el que cerró la clase entera. `src/routes/whatsapp.test.ts`
  tenía una prueba con el comentario `// Real DeepSeek call (no mocking)` escrito arriba, y se llamaba
  `.test.ts` igual: `npm test` la corría y la pagaba en cada push. Estuvo escondida un tiempo porque el
  archivo moría al importar (el cliente de Groq se construía al tope del módulo, ver
  `src/ai/transcription.ts`) - la falla de CI tapaba el gasto. Al arreglar Groq se destapó: esa corrida
  llevaba 7 min 50 s de `npm test` cuando se canceló.
  **Ojo con la lectura fácil de ese número, que en esta misma sesión se escribió mal primero:** esos
  minutos NO eran "la prueba colgada facturando". La corrida siguiente, ya con la key inválida y sin
  poder facturar nada, tardó todavía MÁS. El tiempo era de llamadas a DeepSeek que salen a internet y
  están condenadas a fallar (timeout de 60s + reintento + failover de modelo). Eso se cerró aparte, con
  `DEEPSEEK_BASE_URL` (ver abajo). El gasto y la lentitud eran dos problemas distintos que se disfrazaban
  de uno.
  **La lección: las tres veces anteriores se cerraron con una regla de nombres, que es algo que hay que
  acordarse de cumplir. La cuarta se cerró sacando la plata del medio.** El workflow `Tests` ya no
  recibe `secrets.DEEPSEEK_API_KEY`: recibe una key inválida a propósito. No puede facturar porque no
  tiene con qué pagar. Tiene que ser un valor NO VACÍO (`src/ai/client.ts` construye el cliente al
  importar y el SDK tira si la key viene vacía), y con uno inválido la llamada muere en 401 al instante
  en vez de colgarse. Si mañana otro `*.test.ts` vuelve a llamar de verdad, CI se pone rojo en segundos
  y gratis. **Nunca volver a poner el secreto de verdad en `test.yml`.**
  La regla de nombres sigue en pie, pero ahora es la comodidad (saber qué corre con `npm run
  test:paid`), no la garantía.
  De paso quedó medido cómo se averigua cuál prueba llama de verdad sin adivinar: correr el archivo con
  la key inválida. Las que pasan no llaman; la que falla, sí.
- **`npm test` no sale a internet, y eso es parte del trato.** Junto con la key inválida, el workflow
  define `DEEPSEEK_BASE_URL: http://127.0.0.1:9` (puerto discard, nadie escuchando en el runner): la
  conexión muere en el acto con ECONNREFUSED. `src/config/env.ts` tiene el default de producción
  (`https://api.deepseek.com`), así que la variable solo existe para apagarlo en pruebas y en producción
  nadie la define.
  **Es una garantía, no una optimización, y eso se midió.** La hipótesis al agregarla era que explicaba
  por qué la suite tarda 4 min 19 s local y 12 min 49 s en CI: llamadas a DeepSeek condenadas a fallar
  que igual salen a internet. **Era falsa.** Con la variable puesta, la corrida siguiente tardó 12 min
  53 s — cuatro segundos MÁS. La diferencia local/CI es otra cosa (runner más lento, Postgres en
  contenedor) y sigue sin diagnosticar; no vale la pena perseguirla mientras CI esté verde.
  Lo que la variable sí da es que `npm test` no pueda alcanzar la API de verdad ni aunque una prueba
  traiga su propia key. Eso, junto con la key inválida, es el cinturón y los tirantes.
  **La lección de método, que costó dos correcciones en una sola sesión:** un número medido en un lado
  no explica un número medido en el otro hasta que se cambia UNA cosa y se vuelve a medir. Acá se
  escribió la explicación en tres archivos antes de tener la segunda medición, y estaba mal.

# Rediseño del panel (dirección A) — reglas de estilo

El sistema vive en `public/admin/css/tokens.css`. Las fases del rediseño que
faltan son las etapas `E47` a `E55` de `ONIX-PLAN.md`.

- **Ningún color literal fuera de `tokens.css`.** Ni un hex, ni un `rgba()`, ni
  `white`. Siempre `var(--onix-*)`. Esta es la regla que hace que claro y oscuro
  sean el mismo CSS y no dos hojas de estilo.
- Si una regla parece necesitar `[data-theme]` fuera de `tokens.css`, el problema
  es que falta un token: agregalo ahí, no bifurques la regla.
- El chrome (barra lateral, barra superior, subnavegación) se escribe una vez y
  se reutiliza. Nunca copiar y pegar entre secciones.
- Iconos: SVG inline, trazo 1.6px, grilla de 18px. **Nunca emoji.**
- Números y cifras: clase `.onix-num` (monoespaciada, `tabular-nums`).
- Gráficos: series desde `--onix-series-*` (validadas para daltonismo en los dos
  temas). Un valor de 0 no dibuja barra. Dos o más series llevan leyenda siempre.
  Nunca dos ejes Y.
- No redondear paddings, radios ni tamaños del diseño a múltiplos de 4.
- Antes de cada commit de CSS:
  `grep -nEi '#[0-9a-f]{3,8}\b|rgba?\(' public/admin/css/admin.css public/admin/css/auth.css` debe
  salir vacío. Desde `E48` (2026-09-18) esto ya no depende de que alguien se acuerde: el workflow
  `Tests` lo corre como paso propio, junto con `npx tsc --noEmit`, y los dos van **antes** de
  `npm test` para que el error aparezca en segundos y no después de la suite. `auth.css` entra al
  grep: el día que se prendió tenía 3 literales, los mismos que `admin.css`.
- Un cambio de CSS nunca justifica correr `npm run regression` ni `npm run test:paid`
  (llaman a DeepSeek de verdad y cuestan plata). `src/ai/*` no se toca en ninguna fase.

# Regla permanente: estructura, nunca parche

Decisión del dueño del proyecto, 2026-09-15, después de una semana de "arreglamos un parche y
rompimos otro". Aplica a todo cambio en Onix (`src/ai/*`, `src/catalog/*`, `src/orders/*`,
`src/whatsapp/*`) y está por encima de cualquier prisa.

**Antes de proponer o implementar un arreglo, respondé esta pregunta:**

> ¿Después de este cambio, el modelo tiene MENOS decisiones que puede equivocar, o más reglas
> que puede desobedecer?

Menos decisiones = estructura. Más reglas = parche. **Un parche no se implementa.** Se dice
que no alcanza y se propone el cambio estructural, aunque sea más grande y tarde más.

Son parche, sin excepción:

- Agregar texto al `BASE_SYSTEM_PROMPT` pidiéndole al modelo que se acuerde de algo.
- Una expresión regular nueva sobre la prosa ya generada para deducir qué quiso hacer el modelo.
- Confiar en que el modelo llame una herramienta, sin verificar que la haya llamado.
- Forzar `tool_choice` como única defensa. Medido en producción el 2026-09-15: DeepSeek
  devolvió texto sin `tool_calls` con `tool_choice` forzado, dos veces, y el bot inventó
  productos que no existen en el catálogo.

**Sacar los datos de las manos del modelo pero dejarle la decisión no es media garantía: es
cero garantía con mejor apariencia.** Es el error exacto de las Fases 3 y 5 del plan maestro.
Los bloques fijos funcionaban perfecto en los turnos donde el modelo colaboraba, y no existían
en los turnos donde no llamaba ninguna herramienta.

**Cada fase termina quitándole al modelo al menos una decisión concreta.** Una fase que no
puede nombrar cuál quitó es un parche disfrazado y hay que devolverla.

## Efectos requeridos: regla de admisión

El mecanismo de efectos requeridos (declarar el efecto esperado, verificarlo contra la base
antes de responder, reintentar, caer a código, escalar) está descrito en la Parte I de
`ONIX-PLAN.md`. Un efecto entra a la tabla solo si cumple las tres:

1. **Disparador determinista** — se calcula desde estado de la base o metadatos estructurados
   del mensaje (`mediaType`, quién habla). Nunca desde interpretar prosa, ni del cliente ni del
   modelo. Un disparador leído de la prosa es el guard de clase D que la Fase 5 vino a borrar.
2. **Verificable con una consulta** — se responde con un `SELECT`, no con una opinión.
3. **Con fallback sin modelo** — el servidor tiene que poder hacerlo solo, con datos de la base.

El reintento es mitigación, no garantía. La garantía la da el fallback, porque no tiene al
modelo adentro.

# El norte: un agente con catálogo, no un chatbot

Decisión del dueño del proyecto, 2026-09-16. Va junto con la regla de arriba y la condiciona.

**La imagen que hay que tener en la cabeza:** un vendedor con el catálogo del negocio en la
mano. El cliente pregunta, el vendedor revisa el catálogo y contesta con lo que hay. No se
inventa productos, no se inventa precios, no dice "no hay" sin mirar. Pero conversa como una
persona: recomienda, pregunta, ofrece fotos, maneja una objeción, cierra.

Onix tiene que ser eso, para **cualquier** negocio: se le cargan categorías, productos, fotos,
descripciones y preguntas frecuentes, y con eso vende.

## Qué se le fuerza y qué no

- **Hechos** — precios, stock, qué productos existen, qué colores hay, qué dice la FAQ.
  Se fuerzan SIEMPRE. El modelo nunca es la fuente; el servidor se los da.
- **Efectos con plata** — crear el pedido, avisarle al dueño, cancelar. Se fuerza que ocurran
  y se verifica contra la base que ocurrieron. El servidor es la herramienta con la que el
  agente comprueba si algo salió o hay que reintentarlo.
- **Conversación** — qué decir, cómo decirlo, cuándo preguntar, cuándo insistir, cómo manejar
  una objeción. **Acá no se fuerza nada.** Cada regla que se mete en esta categoría convierte
  al agente en un chatbot con un adorno de IA encima.

## La regla que devuelve libertad

> **Cada hecho que el servidor se lleva, es una directiva del prompt que se puede borrar.**

El error histórico fue hacer solo la mitad: se agregaban garantías en código y se dejaban las
directivas viejas que existían para suplirlas. Por eso el prompt llegó a 568 líneas de "cuando
el cliente diga X, hacé Y". Toda fase que garantice un hecho tiene que terminar borrando la
directiva que ese hecho vuelve innecesaria.

## La medida

**Las líneas de `src/ai/prompts/systemPrompt.ts` tienen que ir BAJANDO mientras los errores se
mantienen en cero.** 568 el 2026-09-16. Si sube y no hay errores, nos estamos convirtiendo en
chatbot sin que nadie lo decida. Antes de agregar texto al prompt, hay que poder decir qué
línea se borra a cambio.

# Desplegar: `ssh vendia` solo funciona desde la maquina del dueno

`ssh vendia` resuelve a una IP de Tailscale. Desde una sesion en la nube, otra computadora o CI no
existe. Si `ssh` falla con timeout o "Could not resolve", no es el servidor: es que no estas en esa red.

Camino que funciona desde cualquier lado, con `gh`:

```bash
git push origin <rama>
gh workflow run deploy.yml -f accion=<rama>   # o: estado | logs | rollback
gh run watch && gh run view --log
```

Corre el mismo `scripts/deploy.sh` de siempre. No prueba nada por su cuenta: mirar que el workflow
`Tests` este en verde antes de disparar el despliegue. Detalle completo en
`docs/DESPLIEGUE-DESDE-LA-NUBE.md`.
