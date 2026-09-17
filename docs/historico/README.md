# Histórico

Documentos cuyo trabajo ya está en producción, y salidas de sesiones anteriores. **No se borran**:
el código los cita en comentarios que explican por qué está hecho así, y de vez en cuando hace falta
volver a leer por qué se decidió algo.

Nada de acá está en curso. El plan vigente es `ONIX-PLAN-INFRAESTRUCTURA.md`, en la raíz; `PLANES.md`
dice cuál es cuál.

---

## Planes terminados

**`ONIX-ROBUSTNESS-AUDIT.md`** — auditoría de robustez del 2026-09-13, con su plan de fases A a G.
Todas implementadas ese mismo día (D y E, sin validar contra una conversación real).
`ONIX-DIAGNOSTICO-2026-09.md` lo dio por superado: lo que quedaba abierto acá "ya no es la respuesta
correcta". Lo citan comentarios del código.

**`ONIX-CONVERSATIONS-GROUPING-PLAN.md`** — agrupar la Bandeja por cliente en vez de por
conversación, más la limpieza de etiquetas. Implementado y desplegado el 2026-09-13
(`listCustomerThreadsForBusiness`, en `src/conversation/service.ts`). Cinco archivos del código lo
citan.

---

## `claude-outputs/`

Salidas de sesiones de trabajo anteriores, guardadas tal como quedaron. **Ojo: acá hay copias viejas
de archivos que siguen vivos en otro lado.** No son la versión buena:

- `ONIX-REDESIGN-PLAN.md` — 204 líneas. El vigente es `design/ONIX-REDESIGN-PLAN.md`, con 240.
- `tokens.css` — 257 líneas. El vigente es `public/admin/css/tokens.css`, con 359.

Lo que sí tiene valor propio:

- **`PROMPT-AUDITORIA-MAESTRA.md`** — el encargo original del dueño (*Master Audit & Incremental
  Reliability Plan*). Su resultado está fusionado en `ONIX-PLAN-INFRAESTRUCTURA.md`, pero este es el
  pedido tal como se escribió.
- `PROMPT-FASE-0-Y-1.md` — los prompts de arranque de esas dos fases.
- Las capturas del rediseño en oscuro (`auth-dark.png`, `charts-dark.png`, `landing-dark.png`).
