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
  loop) before merging: zero net new backstop interventions vs. the pre-change baseline. Follow with
  one run of `node --import tsx --test src/ai/agent.escalation.test.ts` (also real DeepSeek calls).
- Neither of the above is part of `npm test` or CI - they cost real money per run, so run them
  deliberately, not while iterating.
