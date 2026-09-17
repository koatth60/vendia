# Histórico

Documentos cuyo trabajo ya está en producción, o que fueron reemplazados por un plan posterior.
**No se borran**: el código los cita por nombre en decenas de comentarios que explican por qué está
hecho así, y de vez en cuando hace falta volver a leer por qué se decidió algo.

**Nada de acá está en curso.** El plan vigente es `ONIX-PLAN.md`, en la raíz del repositorio, y es
el único. Si un comentario del código nombra uno de estos archivos, el archivo está acá y sirve para
entender la decisión original; lo que hay que hacer de ahora en adelante está en `ONIX-PLAN.md`.

---

## Reemplazados por `ONIX-PLAN.md` el 2026-09-17

Los ocho se unificaron en un solo plan por etapas. El Anexo de `ONIX-PLAN.md` dice de cuál de estos
salió cada etapa, y su sección final lista lo que se decidió NO hacer, para que no se reabra por
error.

**`ONIX-PLAN-INFRAESTRUCTURA.md`** — *Onix Pro: plan de confiabilidad e infraestructura*
(2026-09-17). Era el plan que mandaba. Once fases en tres bloques, ninguna empezada. Sus principios
de gobierno son la Parte I de `ONIX-PLAN.md`, casi textuales.

**`ONIX-PLAN-MAESTRO.md`** — 15 fases (0 a 14), del 2026-09-15. Las 0 a 11 se implementaron entre el
2026-09-15 y el 2026-09-17. Las tres que quedaban (aprendizaje, checkout, table stakes) son los
Bloques 8 y 11 del plan nuevo.

**`ONIX-PENDIENTES.md`** — el registro de lo que faltaba, revisado por última vez el 2026-09-16.
Varias de sus entradas ya estaban cerradas cuando se archivó (el enlace de S3 a Meta, "Contra
entrega total", el typecheck de `scripts/`, la causa de `saleStateEnabled`). Su diseño de la
cancelación determinista sobrevive entero como la etapa `E34`.

**`ONIX-RELIABILITY-PLAN.md`** — fases 0 a 5 cerradas y desplegadas el 2026-09-13. El diagnóstico de
septiembre declaró superadas sus fases pendientes: proponían más validaciones puntuales sobre la
misma arquitectura.

**`ONIX-PLAN-CATALOGO-Y-MEDIOS.md`** — el plan del agente, del que salió la presentación de catálogo
que corre en producción. Es la fuente original de la tabla de admisión de efectos requeridos, que
`CLAUDE.md` y `ONIX-PLAN.md` citan, y el código lo referencia en 27 archivos. Su Fase C quedó en
modo sombra; activarla es la etapa `E64`.

**`ONIX-CRM-REORG-PLAN.md`** — fases 0 a 5 hechas. Guarda todo el análisis del multicanal diferido,
que no está documentado en ningún otro lado (etapa `E75`).

**`ONIX-DIAGNOSTICO-2026-09.md`** — el diagnóstico del 2026-09-15, con datos reales de producción.
Único lugar donde viven los diez riesgos a 90 días, el inventario completo de los 41 patrones con
nombre clasificados en clases A/B/C/D, y el capítulo 11 de mercado (Meta Business Agent, la matriz
de competidores, los rieles de pago de Colombia y México). **Si hace falta saber por qué un regex de
`agent.ts` es de clase D, está acá.**

**`PLANES.md`** — el índice que decía cuál plan mandaba. Ya no hace falta: manda uno solo.

**`ONIX-REDESIGN-PLAN.md`** — el rediseño del panel, versión buena (240 líneas), traída desde
`design/`. Fases 0, 1, responsive y 2 hechas. Las siete que faltan son `E47` a `E55`. **Ojo:** hay
una copia VIEJA de 204 líneas en `claude-outputs/`; esta es la buena.

---

## Planes terminados antes de la unificación

**`ONIX-ROBUSTNESS-AUDIT.md`** — auditoría de robustez del 2026-09-13, con su plan de fases A a G.
Todas implementadas ese mismo día (D y E, sin validar contra una conversación real). El diagnóstico
posterior lo dio por superado.

**`ONIX-CONVERSATIONS-GROUPING-PLAN.md`** — agrupar la Bandeja por cliente en vez de por
conversación, más la limpieza de etiquetas. Implementado y desplegado el 2026-09-13
(`listCustomerThreadsForBusiness`, en `src/conversation/service.ts`). Cinco archivos lo citan.

---

## `claude-outputs/`

Salidas de sesiones de trabajo anteriores, guardadas tal como quedaron. **Ojo: acá hay copias viejas
de archivos que siguen vivos en otro lado.** No son la versión buena:

- `ONIX-REDESIGN-PLAN.md` — 204 líneas. La buena es la de esta misma carpeta, con 240.
- `tokens.css` — 257 líneas. El vigente es `public/admin/css/tokens.css`, con 359.

Lo que sí tiene valor propio:

- **`PROMPT-AUDITORIA-MAESTRA.md`** — el encargo original del dueño (*Master Audit & Incremental
  Reliability Plan*). Su resultado está fusionado en `ONIX-PLAN.md`, pero este es el pedido tal como
  se escribió.
- `PROMPT-FASE-0-Y-1.md` — los prompts de arranque de esas dos fases.
- Las capturas del rediseño en oscuro (`auth-dark.png`, `charts-dark.png`, `landing-dark.png`).
