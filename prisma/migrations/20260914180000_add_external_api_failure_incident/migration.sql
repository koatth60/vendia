-- Nuevo tipo de incidente: una API externa rechazo o fallo una llamada.
-- Esos caminos atrapan el error y siguen (para no romper la conversacion del cliente), asi que
-- sin una fila en AgentIncident un fallo total y permanente se ve igual que "nunca hizo falta".
ALTER TYPE "AgentIncidentKind" ADD VALUE 'EXTERNAL_API_FAILURE';
