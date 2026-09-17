# Los planes de Onix — qué es cada uno y cuál manda

Índice corto, para no volver a abrir once documentos buscando cuál es el vigente.
Revisado el 2026-09-17.

---

## El plan que manda

**`ONIX-PLAN-INFRAESTRUCTURA.md`** — *Onix Pro: plan de confiabilidad e infraestructura.*

Cuando alguien dice "el plan", es este. Junta la auditoría de código del 2026-09-16 con el encargo
de arquitectura del dueño del 2026-09-17 (*Master Audit & Incremental Reliability Plan*), y de ahí
salen sus principios de gobierno, el ciclo de trabajo, la Fase A y la Fase 3B.

Su objetivo, en una frase: pasar de *"un LLM que sabe vender y usa herramientas"* a *"un sistema de
ventas determinístico donde el LLM conversa pero no puede romper las reglas del negocio"*.

Once fases en tres bloques. **Ninguna empezada.** La Fase A (auditoría, sin cambios de código) va
primero; después el Bloque I es bloqueante. La Fase 3B se puede adelantar y es la de mejor relación
entre riesgo eliminado y tamaño del cambio.

No cubre, y lo dice expresamente: las Fases 12, 13 y 14 del plan maestro.

---

## El índice de lo que falta

**`ONIX-PENDIENTES.md`** — el registro más fiable del repositorio. Todo lo que sabemos que falta y
**no** se está trabajando ahora, más una sección de "cerrado recientemente" para no reabrir cosas
por error.

Es el que hay que leer junto al plan maestro, porque ese no lleva estado propio.

---

## Planes con trabajo abierto

**`ONIX-PLAN-MAESTRO.md`** — 15 fases (0–14). Las 0 a 11 se dan por hechas; quedan tres:

- **Fase 12 — Cerrar el ciclo de aprendizaje.** La FAQ que aprende sola. **No es de pagos.** Hoy,
  cuando el dueño responde a mano desde el panel, esa respuesta se tira: el `PendingOwnerQuestion`
  se borra en vez de marcarse resuelto. Siete sub-ítems, ninguno hecho. El detalle más completo de
  esta fase no está acá sino en el capítulo 5 de `ONIX-AUDITORIA-ARQUITECTURA.md`.
- **Fase 13 — Checkout en chat.** Wompi (Colombia) y Mercado Pago (México). Bloqueada por la
  regresión de `saleStateEnabled`, y además necesita decisiones del dueño que no son técnicas:
  cuenta, contrato y comisión.
- **Fase 14 — Table stakes de venta.** Difusión con plantillas y segmentos, asignación de
  conversaciones a un miembro del equipo, y las **primitivas nativas de WhatsApp: mensajes de
  catálogo, multiproducto y carrusel** — esto es "el catálogo en Meta".

**`design/ONIX-REDESIGN-PLAN.md`** — el rediseño del panel, y es el contrato entre el diseño y el
código. Hechas: Fase 0 (tokens y tema), Fase 1 (esqueleto), la auditoría responsive y la Fase 2
(Inicio). **Faltan siete:** CRM, Catálogo, Bot, Negocio y Analytics, Auth, Landing en oscuro y
Marca. Tiene además tres decisiones esperando al dueño: la construcción del logo, si se publican
las cifras del hero de la landing, y el tema por defecto.

**`ONIX-RELIABILITY-PLAN.md`** — Fases 0 a 5 cerradas; **la Fase 6 sigue entera**: el Track A
(herramientas, reescritura del prompt base, condicionales), el Track B completo (optimizador de
`customInstructions`, sin empezar) y el Track C sin priorizar. Contiene la razón por la que la
reescritura del prompt no se toca: sus "nunca" son reglas distintas atadas a incidentes reales.

**`ONIX-CRM-REORG-PLAN.md`** — Fases 0 a 5 hechas. Queda la paginación por cursor de la Bandeja y
del hilo, omitida a propósito. Guarda además todo el análisis del **multicanal diferido**, que no
está documentado en ningún otro lado.

**`ONIX-PLAN-CATALOGO-Y-MEDIOS.md`** — el plan del agente, del que salió la presentación de
catálogo que ya corre en producción. Fases B y D cerradas; la **Fase C quedó en modo sombra**:
implementada pero no activa, y activarla es una decisión aparte. Es la fuente de la tabla de
admisión de efectos requeridos que cita `CLAUDE.md`, y el código la referencia en 27 archivos.

---

## Auditorías: no son planes, pero tienen cosas que no están en otro lado

**`ONIX-DIAGNOSTICO-2026-09.md`** — el diagnóstico de septiembre, con datos reales de producción.
Su sección 8 es el árbitro de vigencia de los demás documentos. Único lugar donde viven los diez
riesgos a 90 días, el inventario de patrones y guards, el costo medido por conversación y el
capítulo de mercado.

**`ONIX-AUDITORIA-ARQUITECTURA.md`** — auditoría del 2026-09-14, reemplazada como plan por el plan
maestro. Se conserva por su capítulo 5: ocho puntos sobre autoaprendizaje, los ocho abiertos, y es
el insumo directo y más detallado de la Fase 12.

---

## Terminados

**`ONIX-ROBUSTNESS-AUDIT.md`** — fases A–G implementadas el 2026-09-13. El diagnóstico posterior lo
declara superado: sus pendientes "ya no son la respuesta correcta". Su encabezado todavía dice que
nada está implementado; es falso y quedó sin actualizar.

**`ONIX-CONVERSATIONS-GROUPING-PLAN.md`** — agrupar las conversaciones por cliente, implementado y
desplegado el 2026-09-13. Su encabezado todavía dice "aprobado, no iniciado"; también quedó sin
actualizar.

Estos dos se pueden archivar cuando el dueño quiera. No se borran sin más porque el código los cita
en comentarios que explican por qué está hecho así.
