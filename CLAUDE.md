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

# Rediseño del panel (dirección A) — reglas de estilo

El sistema vive en `public/admin/css/tokens.css`. El plan y el estado de cada
fase están en `design/ONIX-REDESIGN-PLAN.md`.

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
  `grep -nEi '#[0-9a-f]{3,8}\b|rgba?\(' public/admin/css/admin.css` debe salir vacío.
- Un cambio de CSS nunca justifica correr `npm run regression` ni `npm run test:paid`
  (llaman a DeepSeek de verdad y cuestan plata). `src/ai/*` no se toca en ninguna fase.
