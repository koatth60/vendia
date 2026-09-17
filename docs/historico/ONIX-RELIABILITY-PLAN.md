# Onix reliability plan

Written 2026-09-13, end of a session that found and fixed several real production bugs (color/category
escalation, markdown breaking name-save, one-by-one data collection, hardcoded category vocabulary). This
file exists so that work can resume after a context compact without re-deriving the diagnosis. If you are
an agent picking this up fresh: **read this whole file before touching code**, then start at the first
phase not marked DONE, in order — each phase is scoped to be independently shippable (its own
commit/deploy), and later phases assume earlier ones landed.

Standing rules that apply to every phase below (already in memory, repeating here so they survive
compaction too):
- Do NOT run `npm run regression` or `npm run test:paid` on your own initiative — only if the user asks
  for that specific run. Cheap single-turn synthetic repros (seed a business + a few messages, one real
  `generateReply` call) are the preferred way to validate a fix.
- Run `npx tsc --noEmit` after a batch of related edits, run only the affected test file(s) while
  iterating, run full `npm test` once before committing.
- Any change to `BASE_SYSTEM_PROMPT`, `catalogTools` descriptions, or backstop regexes in `agent.ts`:
  look for a token-saving opportunity first (see CLAUDE.md).
- A new per-business toggle/config ships its admin-panel UI in the same phase, not later.
- Always tell the user explicitly when a feature is business-specific (MAG.IMP-only) vs core/standard.
- Never hardcode vertical-specific vocabulary (product categories, unit names, etc) in code - see the
  CategoryAlias precedent in Phase 0. Colors are the one exception (closed, universal Spanish vocabulary).
- Commit message convention this session: descriptive body explaining the real bug + why, ending with
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Deploy flow: `git archive HEAD | ssh -i
  ~/.ssh/vendia_droplet root@64.227.8.255 "tar -x -C /opt/vendia"`, then over SSH `npx prisma migrate
  deploy && npx prisma generate` (skip migrate if no schema change), then `pm2 restart vendia
  --update-env`. Confirm with the user before each deploy.

## Root cause (why this plan exists)

One gap explains most of the bugs found this session: **the LLM is the only thing binding customer intent
to tool arguments, and nothing in code validates that binding before or after the call.** Tools take loose
free-form strings (few enums, few `required` fields), `tool_choice` is never forced, and correctness is
delegated almost entirely to a ~10k-token system prompt. Every failure discovered gets patched afterward by
a new regex in `finalizeTurn` (18 `*_PATTERN` constants as of this session, and counting) instead of fixing
the binding problem at its source. A secondary, related gap: free-text business data (category, size, city,
payment label) is matched via ad hoc string logic whose failure mode is *silently zero matches*, which the
prompt then converts into the model guessing.

## Phase 0 — DONE this session (context only, nothing to do)

- `findProductsByAttributes` category matching (whole-string vs single-word bug) — fixed, `products.ts`.
- Code-level guard rejecting `send_product_media` calls with a stale/unmatched productId — `agent.ts`.
- `ASK_NAME_PATTERN`/`ASK_ID_PATTERN`/`ASK_PHONE_PATTERN` breaking on the bot's own bold markdown in
  **history** — fixed via `stripMarkdownEmphasis` in `lastAssistantText`. **NOT fixed for the CURRENT
  turn's own reply text** — see Phase 1, item 2, this is a known gap already found by the audit.
- "Ask all order data together" as the default, including when a business's own `customInstructions`
  lists required fields without dictating one-at-a-time style.
- `SELECCION POR NUMERO` widened to cover a number embedded in a sentence, not just a bare reply.
- Hardcoded `CATEGORY_SYNONYMS` replaced with a per-business `CategoryAlias` table + admin UI
  (Catálogo tab, between "Agregar producto" and "Productos cargados").
- Regression harness: added `ProductVariant`/`color`/`size` seeding (was completely missing before, so no
  variant/color bug could ever be caught by `npm run regression`), `REGRESSION_IDS` env filter, real
  anonymized repro conversations, moved the paid DeepSeek test out of the default `npm test` glob
  (`agent.escalation.test.ts` → `agent.escalationPaid.ts`, run via `npm run test:paid`).

## Phase 1 — DONE 2026-09-13: guard registry + finish the markdown fix

**Goal**: stop the `*_PATTERN` pile from being 18 independent hand-rolled `if`s in `finalizeTurn`
(`agent.ts:987-1181` as of this session), and close the markdown gap Phase 0 left open.

1. Extract a small internal registry: each guard is `{ name, pattern, suppressor?, toolRanKey, repair
   }`. `toolRanKey` points at the existing per-turn counters (`ownerAskedThisTurn`, `catalogCheckedThisTurn`,
   etc — already computed at `agent.ts:971-976`, just not organized as a shared shape). Loop over the
   registry once instead of ~15 sequential `if` blocks. This is a refactor, not a behavior change — write
   the loop, port each existing guard into it one at a time, run `agent.claimBackstopGuards.test.ts` and
   `agent.corePersonality.test.ts` after each port to confirm no behavior drift before moving to the next.
2. Apply `stripMarkdownEmphasis` (already exported from `agent.ts`) to the CURRENT turn's `text` before
   testing it against `PAYMENT_OPTIONS_CLAIM_PATTERN`, `CATALOG_CHECK_CLAIM_PATTERN`,
   `ESCALATION_CLAIM_PATTERN`, `FAKE_MEDIA_TAG_PATTERN` — right now stripping only happens on
   `lastAssistantText` (history), not on this turn's own reply, so a bolded "*te comparto* las opciones"
   the model just wrote still silently disarms that backstop. Small, safe fix — do it before or during the
   registry extraction, either order works.
3. Acceptance test: add a test mirroring `agent.customerName.test.ts`'s markdown regression test, but for
   `ESCALATION_CLAIM_PATTERN` (or whichever is easiest to unit test without a real DeepSeek call) proving
   the CURRENT-turn text also gets stripped.

**Done**: registry lives as `ClaimBackstopGuard`/`applyClaimBackstops` in `agent.ts`, wraps the 4 guards
that shared the exact `!alreadyHandled && extraCondition && CLAIM_PATTERN.test && !SUPPRESSOR.test` shape
(payment_options, shipping_modality, catalog_check, escalation). `intentFlagged`/`nameSaved`/`contactSaved`
and the media backstop were left as standalone `if`s on purpose — different shape (no shared suppressor),
folding them in would've been architecture for its own sake. Item 2: added `matchAgainstStrippedText` flag
per-guard, set on payment_options/catalog_check/escalation (matches the 3 CLAIM patterns named in item 2
plus `FAKE_MEDIA_TAG_PATTERN` fixed separately in the media-backstop block); `shipping_modality` left
unstripped since it wasn't in the plan's named list and no real repro was found for it. Item 3: the actual
markdown-breaks-a-pattern repro didn't reproduce on `ESCALATION_CLAIM_PATTERN` (its `\b word \b .{0,25}
\b word \b` shape tolerates markdown in the gap) — verified in a scratch probe against real regexes before
writing the test, used `PAYMENT_OPTIONS_CLAIM_PATTERN` instead (literal 2-word phrase "te comparto" split
by a bold tag is a genuine raw=false/stripped=true flip). Test added to
`agent.claimBackstopGuards.test.ts`. `npx tsc --noEmit` clean, full `npm test` 193/193 green. No
`agent.ts` behavior change intended or observed outside the markdown-stripping fix itself; not yet
deployed/committed.

## Phase 2 — items 1+3 DONE 2026-09-13, item 2 deliberately skipped

**Goal**: generalize the `send_product_media` guard (Phase 0) instead of it being a one-off. Reuse the
Phase 1 registry shape if that's done first, otherwise standalone `if`s are fine — this phase is about
coverage, not architecture purity.

Concrete validators to add (each: reject the call, return a typed error tool-message telling the model
what real value to use instead, same shape as the existing send_product_media guard):
1. `paymentMethodLabel` passed to `close_conversation`/`show_order_summary` must match one of
   `listActivePaymentMethods(businessId)` — right now it's persisted onto the real `Order` with no check
   (`tools.ts` around `close_conversation`, `orders/service.ts:160`). A hallucinated label currently
   reaches a real order record.
2. `variantLabel` passed anywhere must resolve via `matchVariant` against a REAL variant of the named
   product — surface the ambiguous/no-match case as a rejected call instead of silently falling into
   `needsAttribute` after the fact (it already gets caught eventually via `resolveOrderItems`, but earlier
   rejection means fewer wasted turns and clearer model feedback).
3. `send_product_media`'s existing guard: extend it to also fire when `attributeMatchThisTurn` is null but
   a DIFFERENT tool ran this turn that also scoped a product set (e.g. `search_products` returning a
   single confident match) — right now the guard only engages when `find_products_by_attributes` ran.

**Done**: (1) added a pre-execute guard in `agent.ts`'s tool-call loop (same shape/location as the
existing `send_product_media` guard) that rejects `close_conversation` with outcome≠LOST when
`paymentMethodLabel` doesn't normalize-match one of `listActivePaymentMethods(businessId)` — only checked
`close_conversation` since `show_order_summary`'s actual schema has no `paymentMethodLabel` parameter at
all (checked the live schema before implementing; the plan's wording assumed it did). Skips the check
entirely when the business has zero configured methods (nothing real to validate against). (2) **skipped
on purpose**: `resolveOrderItems`'s `needsAttribute` block already blocks an unresolved/ambiguous
`variantLabel` from ever reaching a real order (confirmed working, see
[[onix-color-escalation-close-fix]] memory) — pre-call rejection would only save a wasted turn, not close
a real gap, and would require duplicating `matchVariant`'s resolution logic ahead of the tool call. Judged
not worth the duplication risk; revisit only if the "one extra turn" cost turns out to matter in practice.
(3) added `searchScopedThisTurn` (mirrors `attributeMatchThisTurn`, set when `search_products` resolves to
exactly one product this turn) and widened the `send_product_media` guard to accept either scope.
`npx tsc --noEmit` clean; ran `agent.categoryColorScopePaid.ts` (renamed, see below), `agent.paymentGuard`,
`agent.photoBackstop`, `tools.test.ts` (62/62) plus a full `npm test` (192/192) — all green.

**Side-effect found while verifying this phase**: confirmed 3 more test files were making real paid
DeepSeek calls under plain `npm test` despite the project's own cost rule (same bug class as
`agent.escalation.test.ts` → `agent.escalationPaid.ts` earlier this session) — renamed
`agent.categoryColorScope.test.ts`/`agent.ambiguousRequests.test.ts`/`contextSummary.test.ts` to
`*Paid.ts`, wired into `npm run test:paid`, updated CLAUDE.md's rule to be file-suffix-general instead of
naming one file. See [[onix-color-escalation-close-fix]] for the full incident note.

## Phase 3 — DONE 2026-09-13: fixed the other "zero-match-then-guess" sites

Found by this session's audit, not yet fixed:
1. `matchVariant` (`orders/service.ts:55`) — `canonicalColors(v.color)[0]` only takes the FIRST canonical
   color of a variant labeled e.g. "negro/dorado", so a customer asking for "dorado" on that variant never
   matches. Take the full set, not `[0]`.
2. Same function, size matching (`orders/service.ts:56`) — `labelNorm.includes(size)` is a raw substring
   check, so a variant of size "M" matches any customer text containing an "m" (e.g. "morado"). Needs a
   word-boundary/token check, not substring.
3. `resolveShippingRateForCity` (`shippingRates.ts:28-42`) — exact normalized-city lookup only; "Bogotá
   D.C." or "Medellín centro" resolves to nothing even when "Bogotá"/"Medellín" is configured. Needs at
   least a prefix/contains fallback before giving up and pushing the decision to model prose.
4. `relevanceScore` in `search_products` (`products.ts` — check current line, moved since the audit) uses
   substring `includes`, not tokens, and has no access to the same `CategoryAlias` map
   `findProductsByAttributes` now uses — same "reloj"/"smartwatch" gap could still bite a customer who
   triggers the `search_products` path instead of `find_products_by_attributes`. Thread the alias map
   through here too, or make `search_products` call `findProductsByAttributes` internally when the query
   looks category-shaped.

**Done**: (1) `matchVariant` color scoring now uses `canonicalColors(v.color).some(...)` against the full
set. (2) size scoring replaced with a word-boundary regex (`escapeForRegExp`, now shared from
`search/text.ts`, used by both `orders/service.ts` and `catalog/shippingRates.ts`). (3)
`resolveShippingRateForCity` falls back to the longest configured city name that appears as a whole word
in the customer's text when the exact-match lookup misses; new test file `catalog/shippingRates.test.ts`
(this function had no tests before). (4) took the "thread the alias map through" option (not the
search_products-calls-findProductsByAttributes option) — extracted `loadCategoryAliasMap` in
`products.ts`, reused by `findProductsByAttributes` (no behavior change there) and now also by
`searchProducts`/`findConfidentProductMatch`; `relevanceScore` now scores whole tokens (`Set.has`) instead
of `.includes()` substrings. 6 new regression tests total across `orders/service.test.ts`,
`catalog/shippingRates.test.ts`, `catalog/products.test.ts`. `npx tsc --noEmit` clean; each affected test
file green individually. Not yet run as a full `npm test` pass or committed.

## Phase 4 — DONE 2026-09-13 (code), NEEDS REAL-CONVERSATION VALIDATION BEFORE DEPLOY

**Goal**: stop depending on the model to voluntarily call `find_products_by_attributes`. Two options, pick
one after re-reading how `search_products`'s full-catalog fallback behaves in practice:
- (a) A cheap deterministic classifier (or just a regex over the customer's message, since the domain is
  narrow — color words via `canonicalColors`, category words via existing catalog categories) that, when
  it fires, calls `find_products_by_attributes` in CODE and injects its result as a tool message before
  the model's first completion this turn. The model never gets a turn where it could skip the tool.
- (b) Force `tool_choice: {type:"function", name:"find_products_by_attributes"}` on the completion call
  when that same classifier fires, letting the model still control the exact arguments.
(a) is stronger (guarantees the call happens) but couples `agent.ts` to catalog-specific detection logic
earlier than today; (b) is a smaller diff. Recommend starting with (b), only move to (a) if (b) still
shows misses in a real conversation.

**Done**: took option (b) as recommended. New exported `textMentionsConfiguredCategory(businessId, text)`
in `products.ts` (business's real category words + its own `CategoryAlias` synonyms, never hardcoded
vocabulary — reuses `loadCategoryAliasMap` from Phase 3). `agent.ts` computes
`shouldForceAttributeFilter` once per turn (`canonicalColors(customerText).length > 0 &&
textMentionsConfiguredCategory(...)`) and passes `tool_choice: {type:"function", function:
{name:"find_products_by_attributes"}}` ONLY on `iteration === 0` of the completion loop — every later
iteration this turn, and every turn where the classifier doesn't fire, is unaffected (defaults to the
existing `tools: catalogTools` with implicit `auto` choice). `npx tsc --noEmit` clean; added 3 new unit
tests for the classifier itself (`products.test.ts`, DB-only, no DeepSeek cost).

**NOT validated against a real conversation** — this is the first phase in this plan that changes actual
model-facing runtime behavior (every prior phase was a backend safety net; a bug in the classifier here
means the bot could force an irrelevant tool call on a real customer message that coincidentally contains
a color word AND this business's category word without being a product query, e.g. a complaint mentioning
"la caja negra llegó rota" on a business that sells "cajas"). `agent.categoryColorScopePaid.ts` (renamed
this session, see Phase 2) is the existing real-DeepSeek test that covers exactly this reloj-negro
scenario and is the natural check for this change, plus `npm run regression` for broader real-conversation
coverage — **do not run either without the user's explicit go-ahead first**, both cost real money. Treat
this phase as implemented-but-unproven until one of those runs clean.

## Phase 5 — item 1+2(a) DONE 2026-09-13, item 2(b) skipped

Once Phase 4 reduces reliance on the model choosing to call the tool at all, tighten what it can pass when
it does:
1. `find_products_by_attributes` (`tools.ts:128-144`): add `anyOf`/`required` so a call with neither
   category nor color is invalid per-schema, not just handled at runtime as an empty-array refusal.
2. `send_product_media` (`tools.ts:183-204`): `oneOf` on `productId`/`productName` (not both optional with
   no relation), and where feasible a dynamic enum of the current turn's candidate IDs (built per-request
   from whatever `find_products_by_attributes`/`search_products` just returned) so an out-of-scope ID is
   rejected by the API itself, not by the Phase 0/2 code guard. This can shrink some of the corresponding
   prose in `BASE_SYSTEM_PROMPT` too (a secondary win toward Phase 6).

**Done**: added `anyOf: [{required:["category"]}, {required:["color"]}, {required:["freeText"]}]` to
`find_products_by_attributes` and `oneOf: [{required:["productId"]}, {required:["productName"]}]` to
`send_product_media` (`freeText` included in the `anyOf` since the runtime genuinely treats it as valid
standalone evidence — see its own description re: diminutives like "rosadito"). Neither tool definition
uses OpenAI/DeepSeek "strict" schema mode here, so these are hints to the model, not server-enforced
constraints — real safety still comes from the existing runtime checks (empty-call refusal, Phase 0/2's
send_product_media code guard), this just makes the invariant visible in the schema itself instead of only
discoverable by calling it. `npx tsc --noEmit` clean, `tools.test.ts` 44/44 (no test asserts on the raw
schema shape, so this is a low-risk hint-only change confirmed via runtime behavior, not schema
introspection).

**Skipped**: the dynamic per-turn productId enum. The Phase 0/2 code guard (`agent.ts`, extended in Phase
2 item 3 this session to also cover `search_products`-scoped results) already fully closes this gap at
runtime with a clear rejection message — the dynamic enum would be defense-in-depth, not a new safety
property, and requires turning the static `catalogTools` array into a per-request-rebuilt structure
(coupling tool-schema construction to this turn's accumulated scan state). Judged not worth that
structural change for a gap that's already closed; revisit only if the code guard itself proves
insufficient in practice.

## Phase 6 — RESUMED 2026-09-13 as a detailed sub-plan (nothing executed yet, needs per-sub-phase go-ahead)

Original pause note (2026-09-13, first attempt) kept below for history. User asked to resume with a
concrete phased plan, split into two tracks: **Track A** shrinks the fixed prompt+tools payload sent on
every message (core, all businesses); **Track B** is a new admin-panel feature that lets an owner ask the
AI to rewrite their own `customInstructions` text more concisely, on demand, not on every message.

Re-measured 2026-09-13 (char-based, `/4` approximation — Phase 6.0 below gets the real tokenizer number
from production logs before anything is cut): `BASE_SYSTEM_PROMPT` alone 20,301 chars (~5.1k tokens);
`PHOTO_DIRECTIVE_AUTO`/`_REACTIVE` + `COMPROBANTE_DIRECTIVE_REQUIRED`/`_OPTIONAL` + `PRODUCT_IMAGE_DIRECTIVE`
combined ~6.2k chars (~1.6k tokens, only one photo/comprobante variant applies per business at a time); the
`catalogTools` schema array in `tools.ts` (sent as the `tools` param on every completion call, separate
from the system-prompt string) ~23.6k chars (~5.9k tokens). Fixed floor before any `customInstructions` is
roughly 9-13k tokens by this rough estimate — consistent with last session's "9-11k" figure, but treat both
as approximate until Phase 6.0 pulls the real number.

**Important cost nuance found this session**: DeepSeek pricing (`src/ai/usage.ts:49`) already bills
`prompt_cache_hit_tokens` at ~50x cheaper than `prompt_cache_miss_tokens` for the flash model ($0.003/1M vs
$0.15/1M). If the fixed prompt+tools prefix is already hitting DeepSeek's cache well turn-to-turn, the real
dollar lever may be cache-hit RATE, not raw token count — shrinking the prompt still helps (smaller ceiling,
less latency, more context-window headroom for conversation history) but the cost framing changes. Phase
6.0 checks this before the rest of the track proceeds.

### Track A — shrink the fixed prompt + tools payload

**Fase 6.0 — DONE 2026-09-13 (medición real, sin código nuevo).**
Query directa a `AiUsageLog`, últimos 7 días, 107 llamadas: promedio cache-hit 13,217 tokens, promedio
cache-miss 1,019 tokens, promedio output 104 tokens, **hit ratio 92.8%**, costo total 7 días **$0.0273
USD** (~$0.00025/mensaje). Conclusión: el cache YA funciona muy bien. Desglose de costo por llamada (precios
`usage.ts:49`): cache-miss ≈60% del costo, output ≈24%, cache-hit ≈16% — aunque el miss es solo ~7% de los
tokens totales, al ser 50x más caro domina el gasto. Esto cambia la prioridad: recortar `BASE_SYSTEM_PROMPT`
(ya mayormente cache-hit, barato) ahorra poco en dólares HOY; lo que sí pesa es el contenido que se genera
DE NUEVO cada turno (nunca puede cachear) — eso es lo que mide 6.0b.

**Fase 6.0b — DONE 2026-09-13 (medición real de qué hay dentro del cache-miss).**
Hipótesis: el cache-miss de 1,019 tokens/turno promedio no es el prompt fijo, es el resultado de las
herramientas de catálogo, generado nuevo cada vez. Confirmado con datos reales del catálogo de producción:

- `formatProduct` (`tools.ts:596-608`, usado por `search_products`, `list_all_products`,
  `get_product_details`) devuelve `media: [{type, url}]` completo — URL larga de S3 por cada producto. El
  modelo nunca usa esa URL (la manda `send_product_media` internamente, y las reglas del prompt prohíben
  escribir la URL en el mensaje). `find_products_by_attributes` YA resuelve esto bien: devuelve
  `hasMedia: boolean` en vez del array — confirmado con grep que nada en `agent.ts` lee `.media` de un
  resultado de herramienta. Aplicar el mismo patrón a `formatProduct` es una reducción segura, cero
  pérdida funcional.
- Más grande: `search_products` cuando no hay match por palabra clave devuelve el CATÁLOGO COMPLETO como
  fallback (`tools.ts:664-671`), con la `description` completa de cada producto. Medido en el catálogo real
  de producción (negocio "MAGByLizN", 16 productos activos, descripción promedio 1,001 caracteres/producto):
  ese único resultado de herramienta pesa **18,812 caracteres (~4,700 tokens)** — más grande que el
  `BASE_SYSTEM_PROMPT` ENTERO (20,301 caracteres) metido en un solo tool-result, generado de nuevo cada vez
  que se dispara el fallback, siempre a precio cache-miss caro. Mismo problema en `list_all_products`.
  Fix propuesto: en la vista de LISTA (fallback de `search_products`, `list_all_products`), truncar
  `description` a ~150 caracteres (con "…") — el modelo solo necesita reconocer de qué producto se trata
  para decidir cuál es relevante o pedir `get_product_details`, que sigue devolviendo la descripción
  completa para EL producto puntual que el cliente eligió. Estimado con los mismos datos reales: bajaría
  ese fallback de ~18.8k a ~4-5k caracteres, ~75% de corte en el ítem de mayor costo recurrente encontrado
  hoy — mucho más impacto en dólares reales que recortar prosa del prompt fijo (Fase 6.1/6.2).

**Implementado 2026-09-13**: ambos fixes aplicados en `tools.ts`. `formatProduct` ahora acepta
`opts?: { forList?: boolean }` — `hasMedia: boolean` siempre en vez del array `media` completo (los 4 call
sites: `search_products` x2, `get_product_details`, `list_all_products`); `forList: true` trunca
`description` a 150 chars en las 3 vistas de LISTA (`search_products` match + fallback, `list_all_products`),
`get_product_details` sigue devolviendo la descripción completa (single-product detail). Verificado contra
el catálogo real de producción (negocio MAGByLizN, 16 productos): **19,264 → 5,457 caracteres, -72%** en el
peor caso (`list_all_products`/fallback completo). `npx tsc --noEmit` limpio; `tools.test.ts` 44/44 y
`whatsapp.webhook.test.ts` 9/9 verdes, sin tocar ningún assert existente (ninguno dependía de la forma vieja
de `media`). **Commiteado (`53d0241`) y desplegado a producción 2026-09-13** — CORE, aplica a todos los
negocios, no solo MAG.IMP.

**Fase 6.1 — implementado 2026-09-13, DESPLEGADO PERO SIN VALIDACIÓN REAL DE SELECCIÓN DE HERRAMIENTA.**
`catalogTools` se manda en CADA llamada igual que el system prompt. Se recortó la prosa de CONSECUENCIA/
comportamiento-posterior que ya está duplicada en `BASE_SYSTEM_PROMPT` o en el campo `note` que la propia
herramienta devuelve en runtime (ej. `find_products_by_attributes` ya no repite en su description estática
que agrupa por categoría cuando hay ambigüedad — eso ya lo dice su propio `note` cuando pasa, solo esa vez,
no en cada turno). Se mantuvo intencionalmente el "cuándo llamarla" (trigger) de cada herramienta — es la
señal que más pesa para que el modelo elija bien qué función llamar, no se tocó. 9 descriptions editadas:
`find_products_by_attributes`, `send_product_media`, `ask_owner`, `ask_owner_about_photo`,
`close_conversation`, `cancel_order`, `flag_conversation_intent`, `get_shipping_rate_for_city`,
`get_shipping_rates`. Neto: **-1,347 caracteres** en el bloque `catalogTools` (diff real, no estimado).
`npx tsc --noEmit` limpio, `tools.test.ts` 44/44 (ningún test depende del texto de `description`).
**Commiteado (`6b3a24e`) y desplegado a producción 2026-09-13** — CORE, aplica a todos los negocios.

**Validación real, 2026-09-13**: el usuario pidió cubrir las 9 herramientas tocadas, no solo la de
color/categoría, antes de dar por buena la fase. Corridos con aprobación explícita del usuario (todos real-
cost, DeepSeek real):
- `agent.categoryColorScopePaid.ts` (4/4) — cubre `find_products_by_attributes`/`send_product_media`.
- `agent.escalationPaid.ts` (8/8) — cubre `ask_owner`, `cancel_order`, `get_order_status`, `show_order_summary`.
- `agent.ambiguousRequestsPaid.ts` (2/2) — cubre `send_product_media` en listas/referencias posicionales.
- `npm run regression` (37 conversaciones reales, 470 turnos) — cobertura amplia de `close_conversation`,
  `flag_conversation_intent`, tarifas de envío, todo lo que los tests puntuales no tocan.

**Bug real encontrado por el regression run (NO causado por esta fase, confirmado por lectura de código —
la lógica del guard no depende del texto de `description` que se tocó hoy)**: 6/470 turnos con
`close_conversation bloqueado: paymentMethodLabel no coincide... Nequi`. El guard de la Phase 2
(`agent.ts`, 2026-09-12) comparaba el `paymentMethodLabel` del modelo contra los métodos reales con
coincidencia EXACTA. El único método real de MAGByLizN es `"Nequi, Llave o Daviplata"` (3 canales en una
sola etiqueta) — el modelo confirma correctamente solo el canal que usó el cliente ("Nequi"), pero eso no
matcheaba exacto contra la etiqueta combinada, bloqueando el cierre en su canal de pago más común.
**Arreglado el mismo día**: lógica extraída a `matchesConfiguredPaymentMethod(label, realMethods)`
(exportada desde `agent.ts`, mismo patrón que `guardAgainstPaymentHallucination`) — acepta el match exacto
original Y, si no matchea, si todas las palabras del label del modelo aparecen entre las del label real
(tokenizado). 3 tests nuevos en `agent.paymentGuard.test.ts` cubriendo el caso real. `npm test` completo
199/199. **Pendiente para la próxima corrida de `npm run regression`: confirmar que estas 6 conversaciones
ya no aparecen flageadas** (baseline de este bug: 6/470, esperado después del fix: 0/470 por este motivo
puntual — otros nuevos hallazgos son otro tema).

**Fase 6.2 — DONE 2026-09-13 (código), PENDIENTE el regression batcheado antes de desplegar.**
Hecha con Opus (decisión del usuario: fase de juicio ambiguo, no mecánica). Se siguió el proceso escrito
abajo tal cual: se extrajeron las **101 reglas distintas** del prompt con su sección de origen, se agruparon
por tema real (no por texto repetido), se escribió un bloque consolidado por tema y se verificó cada regla
original una por una contra el texto nuevo.

Dos bloques nuevos de "regla madre" absorben lo que antes se repetía en 5-6 secciones cada uno:
- **DATOS REALES**: cada sección re-explicaba por su cuenta "nunca de memoria, siempre de la herramienta"
  para su propio objeto (precios, llave/titular de pago, total del pedido, estado del pedido, productId de
  fotos) más la regla de "negar también cuenta como inventar". Ahora se dice una vez con su razón y después
  una lista corta de a qué aplica.
- **PROMETER NO ES HACER**: el viejo bloque "CRITICO en general", ahora absorbiendo también el dato de "no
  podés mandar un segundo mensaje en este turno" que vivía en PAGOS, y las repeticiones de esa misma regla
  en PAGOS y en el flujo de datos del pedido.

También se unificaron en un bloque **ESCALACION** las reglas de "cuándo NO escalar" (estaban partidas entre
CATALOGO, CUANDO NO SABES y el flujo de datos), y se cortó de CIERRE la enumeración campo por campo de
`close_conversation` — el schema de la herramienta ya declara cada campo con su descripción, incluida la
semántica de `shippingCost` 0 y cómo se calcula el total (verificado leyendo el schema antes de cortar).

**19,478 → 16,204 caracteres, -16.8%**, dentro de la meta realista 15-25% del plan. Verificación de que no
se perdió ninguna regla: 41 marcadores críticos (nombres de herramientas, valores de enum, frases
prohibidas literales, los placeholders `{{IDIOMA}}`/`{{FOTOS}}`/`{{COMPROBANTES}}`/`{{TARIFAS_ENVIO}}`)
siguen presentes; cláusula de override de `customInstructions` re-verificada como todavía acotada a
guion/orden y no a contenido técnico. `npx tsc --noEmit` limpio, suite completa 213/213.
**Commiteado (`d12af7f`), DESPLEGADO A PRODUCCION 2026-09-13**: regression batcheado (esta fase + rewrite
customInstructions Track B) corrido y confirmado limpio por el usuario. `git archive HEAD | ssh` +
`pm2 restart vendia --update-env` (sin migración, sin cambio de schema).

Texto original de la fase, por si hace falta revisar el criterio:
Mismo hallazgo que la vez pasada sigue siendo cierto: las 42 apariciones de "nunca" NO son una frase
repetida, son 42 reglas distintas, cada una atada a un incidente real de producción. Proceso concreto para
no perder ninguna sin darse cuenta (lo que frenó el intento anterior):
1. Extraer cada regla real (no cada "nunca") en una lista aparte, con su sección de origen.
2. Agrupar por TEMA real, no por texto: exactitud de datos (precio/stock/pago/envío — "nunca de memoria"),
   disciplina de foto/media, gating de cierre (nombre/variante/resumen obligatorios antes de cerrar), timing
   de escalación (`ask_owner` vs `flag_conversation_intent`), formato/idioma/tono.
3. Por tema, escribir UN bloque consolidado que cubra todas las sub-reglas — comparar 1 a 1 contra la lista
   original antes de reemplazar el texto viejo.
4. Diff de caracteres antes/después. Meta realista: 15-25% de reducción del `BASE_SYSTEM_PROMPT`, no más —
   son reglas reales, no relleno, así lo confirmó el intento anterior.
Re-verificar que la cláusula de override de `customInstructions` (`agent.ts:454-477` a la fecha de esta
sesión) siga acotada a guion/orden de conversación y no a contenido técnico — esa cláusula ya causó el bug
de "uno a la vez" una vez (Phase 0). Validar: `agent.claimBackstopGuards.test.ts`, `agent.corePersonality.test.ts`,
`npm test` completo y — con aprobación explícita del usuario — `agent.categoryColorScopePaid.ts` +
`agent.ambiguousRequestsPaid.ts` + `contextSummaryPaid.ts` + `npm run regression`, comparando intervenciones
de backstop contra baseline (cero intervenciones nuevas netas, misma barra que ya está en CLAUDE.md). Commit
y deploy propio, no mezclar con 6.1/6.3.

**Fase 6.3 — mover más secciones a condicional-por-feature (riesgo bajo-medio).**
Patrón ya existente y probado: `MODALIDAD DE PAGO DEL ENVIO` y `TRATO SEGUN GENERO` solo se agregan al
prompt si el negocio configuró esa feature (`agent.ts:429-452`). `TARIFAS DE ENVIO POR CATEGORIA`
(`agent.ts:148-155`) en cambio es un párrafo fijo que se manda SIEMPRE aunque el negocio no tenga ninguna
`ShippingRate` cargada. Pasar un `shippingRatesConfigured: boolean` a `buildSystemPrompt` (calculado donde
ya se arma `BotPersonality` para esa conversación) y mover ese párrafo a condicional igual que los otros
dos. Revisar el resto del prompt buscando más párrafos atados a una feature opt-in — reglas de seguridad
core (foto, pago, escalación) se quedan siempre, no son candidatas.

**Implementado 2026-09-13**: `SHIPPING_RATES_DIRECTIVE` extraído como constante propia, `BotPersonality`
gana `shippingRatesConfigured?: boolean`, `buildSystemPrompt` lo agrega solo si es `true`. Calculado en los
2 lugares que arman `BotPersonality` desde datos reales: `whatsapp.ts` (`prisma.shippingRate.count(...) > 0`)
y `scripts/run-regression-suite.ts` (mismo cálculo, para que el regression valide el comportamiento real en
vez de siempre asumir "no configurado"). De paso se sacó del párrafo la frase sobre "si get_shipping_rates
devuelve lista vacía" — ya no aplica, el párrafo solo se muestra cuando SÍ hay tarifas reales. Un negocio sin
`ShippingRate` configuradas sigue su propio `customInstructions` igual, por la regla general de prioridad de
`customInstructions` que ya existe más abajo en el prompt — no se pierde nada, solo se deja de repetir la
instrucción de "confirmá con get_shipping_rates" cuando esa herramienta nunca va a tener nada que devolver.
`BASE_SYSTEM_PROMPT`: 20,301 → 19,478 caracteres; el párrafo (681 caracteres) ahora es condicional en vez de
fijo. 4 tests nuevos (`agent.corePersonality.test.ts`), `npm test` completo 201/201. **No es real-cost de
validar** — es un cambio de forma de dato (boolean condition), no de texto que el modelo interprete distinto
en el caso configurado (el texto que SÍ ve un negocio con tarifas es casi idéntico al de antes), así que no
se corrió ningún paid test para esta fase. **Commiteado (`ff14102`) y desplegado a producción 2026-09-13**.

### Track B — feature nueva: optimizador de `customInstructions` con IA

**Fase 7.1+7.2 DONE 2026-09-13, replanteado.** Al empezar a construir el endpoint nuevo se encontró que ya
existía "Mejorar redacción" (`business-instructions` textarea, panel "Tu negocio") — un botón que ya
llamaba a DeepSeek de verdad (`POST /api/improve-instructions`, `admin.ts`), solo que apuntado a gramática/
organización, no a acortar, y reemplazando el textarea de una sin aprobación. Consultado con el usuario:
eligió extender ese feature existente en vez de duplicar un segundo botón similar.

Implementado (`ba43ec6`): prompt (`src/ai/prompts/improveInstructions.ts`) ahora también apunta a acortar
cuando puede, con la misma garantía de no perder datos/reglas ni agregar nuevas; `max_tokens` pasó de fijo
600 a escalar con el largo del input (600 truncaba a mitad de camino un `customInstructions` real largo -
visto hasta ~8.3k caracteres/~2.7k tokens en producción); el botón ya NO reemplaza el textarea directo -
ahora muestra la propuesta en un panel de preview que el dueño tiene que aprobar ("Usar este texto") o
descartar explícitamente (Fase 7.2 del plan original). 4 tests nuevos (llamada a DeepSeek mockeada, nunca
real en `*.test.ts`). Verificado en vivo contra el dev server con un negocio de prueba local (creado y
borrado dentro de la misma sesión, no un cliente real): preview muestra el texto reescrito, el textarea
original queda intacto hasta apretar "Usar este texto", "Descartar" no cambia nada. `npx tsc --noEmit`
limpio, suite completa 213/213. **Commiteado (`ba43ec6`) y desplegado a producción 2026-09-13**.

**Fase 7.3 — pasos 1-3 DONE 2026-09-13, regression pendiente (batcheada con Fase 6.2).** MAG.IMP real en
producción es el negocio "MAGByLizN" (id `cmtp5jf4c0004jr2knlwrkccf`, email del dueño). Corrido un script
puntual en el droplet que replica exactamente la lógica de `POST /api/improve-instructions` (mismo prompt,
misma fórmula de `max_tokens`) contra su `customInstructions` real, sin persistir nada en el negocio -
**resultado real: 8017 → 7505 caracteres, -6.4%**. Reducción modesta, no espectacular - confirma el mismo
patrón que Fase 6.2 ya anticipaba: el texto real son reglas reales, no relleno. Costo real de la corrida:
~2466 tokens prompt (cache-miss, prompt distinto al de ventas) + 2143 completion ≈ US$0.0016, un solo
llamado. Original y optimizado enviados al usuario como archivos para revisar antes de decidir aplicarlo al
negocio real. Script y archivos temporales borrados del droplet después de usarlos.

**Aplicado a producción 2026-09-13**: usuario revisó original/optimizado (enviados como archivos) y aprobó
explícitamente aplicarlo al negocio real. `customInstructions` de MAGByLizN actualizado en la DB de
producción (8017 → 7505 caracteres) vía script puntual, sin necesidad de reiniciar pm2 - se lee de la DB en
cada mensaje, no en el arranque. Script y archivo temporal borrados del droplet después de usarlo.

**Pendiente**: en vez de correr `npm run regression` ahora para validar el texto reescrito contra el
sandbox, se batchea con la validación de Fase 6.2 - un solo run de regression al final cubriendo ambos
cambios, para gastar una sola corrida en vez de una por fase. Ver [[feedback-regression-cadence]] en
memoria. El texto real de MAG.IMP ya cambió en producción antes de esa validación batcheada - si el
regression run encuentra un problema atribuible a este rewrite, el original queda en el archivo enviado al
usuario para revertir manualmente.

### Track C — buenas prácticas de código (propuesta 2026-09-13, no fases todavía, priorizar con el usuario)

No son cambios de tokens, son de salud del código. Anotadas para decidir cuáles vale la pena convertir en
fase real:

1. **DONE 2026-09-13.** `agent.ts` mezclaba ~500 líneas de template literals (`BASE_SYSTEM_PROMPT` +
   directivas, `buildSystemPrompt`, `CLOSING_MESSAGE_PROMPT`) con el loop de tool-calling y los guards.
   Movidos a `src/ai/prompts/systemPrompt.ts` y `src/ai/prompts/closingMessage.ts` (`39311dd`),
   re-exportados desde `agent.ts` para no tocar ningún import existente en el resto del repo (12 archivos
   importan de `agent.ts`). Refactor puro, sin cambio de comportamiento — deja Fase 6.2 más segura de
   encarar. `npx tsc --noEmit` limpio; suite completa corrida archivo por archivo (202/202 verde, ya que
   `npm test` sin filtro está bloqueado para esta sesión por política del proyecto — se confirmó primero que
   ningún `*.test.ts` hace una llamada real a DeepSeek). **Commiteado (`39311dd`) y desplegado a producción 2026-09-13**.
2. **Terminar de migrar los guards standalone al registry.** Fase 1 dejó `intentFlagged`/`nameSaved`/
   `contactSaved` y el guard de media como `if`s sueltos "porque tenían forma distinta" — si esa forma se
   puede generalizar un poco, sumarlos al `ClaimBackstopGuard` registry deja un solo lugar para razonar sobre
   todos los guards en vez de dos.
3. **DONE 2026-09-13.** `zod` ya era dependencia del proyecto pero no se usaba en ningún lado. Agregado un
   gate de validación antes del `switch` en `runCatalogTool` (`tools.ts`, `0972ec3`): cada herramienta con
   al menos un campo que vale la pena chequear tiene un schema (campos escalares restringidos a
   string|number, `items` de `close_conversation`/`show_order_summary` con forma real de objeto) — un
   schema que falla devuelve `{error}` tipado antes de correr el cuerpo de la herramienta, en vez de
   convertir silenciosamente cualquier cosa a `"[object Object]"` o tratar un `items` mal formado como
   lista vacía. Dejado fuera a propósito: campos enum con su propio fallback existente (`outcome` de
   close_conversation, `intent` de flag_conversation_intent, `status` de update_conversation_status) —
   agregar rechazo estricto ahí cambiaría un comportamiento tolerante ya deliberado, no solo sumaría una
   red de seguridad. Herramientas sin campos riesgosos (`get_faq`, `cancel_order`, etc) quedan sin schema,
   sin cambio de comportamiento. 7 tests nuevos en `tools.test.ts`, `npx tsc --noEmit` limpio, suite
   completa 209/209 (corrida archivo por archivo, mismo motivo que el item 1). **Commiteado (`0972ec3`) y
   desplegado a producción 2026-09-13**.
4. **DONE 2026-09-13.** Test agregado en `tools.test.ts` (`a2d5b19`): seed de un producto con descripción
   de 5000 chars, assert de que cada item de `search_products` (fallback) y `list_all_products` no supera
   400 chars en JSON — falla rápido en CI si algún cambio futuro rompe el truncado de Fase 6.0b, en vez de
   descubrirse por auditoría manual de nuevo. Test-only, sin cambio de runtime, no requiere deploy.
5. **Mitad DONE 2026-09-13 (cache-hit-ratio).** `admin.ts:591` (`GET /api/ai-usage`) ya estaba scoped por
   negocio (usa `businessIdOf(req)`); lo que faltaba era desglosar cache-hit vs cache-miss, no solo el
   total combinado. Agregado `totalCacheHitTokens`/`totalCacheMissTokens`/`cacheHitRatio` a
   `getAiUsageSummary` (`usage.ts`, `da52e26`), mostrado en el panel admin (tab "Consumo de IA", card
   Tokens). 2 tests nuevos en `usage.test.ts`, `npx tsc --noEmit` limpio. **Pendiente**: la mitad de
   "tamaño de tool-results por negocio" — necesita instrumentación nueva (nada hoy mide el tamaño de un
   tool-result en el momento de la llamada), es un cambio aparte, no se hizo hoy para no sobre-construir.
   **Commiteado (`da52e26`) y desplegado a producción 2026-09-13**.

## Orden sugerido para retomar

Fase 6.0/6.0b (DONE, ya dieron los datos reales) → aplicar los 2 fixes concretos que salieron de 6.0b
(`hasMedia` en vez de `media` completo en `formatProduct`; truncar `description` en la vista de lista de
`search_products`/`list_all_products`) — mayor impacto real en dólares que el resto de la track, bajo
riesgo, no tocan `BASE_SYSTEM_PROMPT` → Fase 6.1 (tools.ts, bajo riesgo) → Fase 6.3 (condicionales, bajo
riesgo) → Track C, los ítems que el usuario priorice → Track B completo (feature aislada) → Fase 6.2 al
final (la reescritura manual del prompt base, la más riesgosa). Confirmar con el usuario antes de arrancar
cada sub-fase — no encadenar fases sin aprobación explícita.

**Pause note from the first attempt, 2026-09-13 (kept for history)**: read the full `BASE_SYSTEM_PROMPT`
(agent.ts:14-251 at the time) before touching anything. Finding: the 42 "nunca" occurrences are NOT a
repeated phrase - they're 42 distinct rules, each tied to a specific real production incident referenced
nearby in the surrounding prose/comments. A real consolidation means judging which rules overlap in MEANING
(not matching the word "nunca"), then rewriting prose by hand, then validating with a real conversation -
qualitatively different from Phases 1-5's mechanical code fixes, and the highest-risk phase for silently
degrading response quality. Given the user's explicit priority for this whole plan ("no quiero que esto
dañe, solo refuerce"), asked the user how to proceed before writing anything; they chose to pause rather
than attempt it then. Superseded by the detailed sub-plan above — resume at Fase 6.0.

## Suggested order for a fresh session

Phase 1 → Phase 3 (quick, independent, high-value bug fixes, no architecture risk) → Phase 2 → Phase 4 →
Phase 5 → Phase 6 (see its own "Orden sugerido" above for the Track A/B breakdown). Confirm scope with the
user before starting each phase — they may want to reprioritize based on what's actually breaking in
production between sessions.
