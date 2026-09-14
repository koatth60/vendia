-- Nuevo tipo de incidente: la respuesta del bot tardo demasiado en generarse y se descarto sin mandarla.
-- Con el proveedor de IA degradado la respuesta sale fuera de contexto (2026-09-14: 30 minutos tarde) y
-- mandarla es peor que no mandarla. Sin una fila aca, "se descarto" seria invisible.
ALTER TYPE "AgentIncidentKind" ADD VALUE 'STALE_REPLY_DISCARDED';
