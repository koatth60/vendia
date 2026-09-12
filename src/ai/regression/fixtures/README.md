# Regression fixtures

`conversations.json` — 35 real conversations exported from production on 2026-09-12 (33 MAGByLizN, 2
Aurora Joyas), used to replay real customer turns against `generateReply` and count how often a
code-level backstop had to intervene (see `scripts/run-regression-suite.ts`).

`catalog.json` — the two businesses' real products, payment methods, shipping rates and FAQ entries
(business config, not personal data), used to seed a local test business so the replay sees the same
catalog the real conversation was actually having.

## Anonymization

Customer-identifying content (name, cédula, celular, delivery address) was replaced with fake
placeholders before this file was committed - see `scripts/anonymize-conversations.js` for the exact
passes (structured-field exact match, labeled-field regex, greeting-name pattern, address-shape regex,
and a wholesale replacement for any customer message that looks like a raw "datos de entrega" block).

**This is best-effort regex-based scrubbing, not exhaustive NLP redaction.** It removed every leak the
verification pass could detect (cédula/celular/delivery-address exact matches: 0 residual hits), but a
generic city or neighborhood name mentioned on its own (e.g. "barrio Kennedy") may remain - low
sensitivity on its own, not enough to identify a person, but worth knowing if this file is ever shared
outside the private repo it lives in.

Payment account numbers (Nequi/Bancolombia) are the **business's own** transfer details, not customer
data - deliberately kept real, since the payment-hallucination guard needs the real configured number to
check against.
