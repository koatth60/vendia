// Fase 8, punto 9 del plan maestro (2026-09-15): los registros del proceso llevaban el telefono
// completo de clientes reales. Un registro no es la base de datos: lo lee cualquiera con acceso al
// servidor, se copia a un pegado cuando alguien pide ayuda, y sobrevive en rotaciones y copias que
// nadie inventaria. Un telefono es dato personal y ahi no aporta nada que estos ultimos digitos no
// resuelvan igual.
//
// Se conservan los ultimos 4 digitos, que es lo unico que se usa de verdad al depurar: distinguir de
// cual de dos conversaciones abiertas se esta hablando. Con 4 digitos no se puede llamar a nadie.
const VISIBLE_DIGITS = 4;

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "(sin numero)";
  const value = String(phone);
  if (value.length <= VISIBLE_DIGITS) return "***";
  return `***${value.slice(-VISIBLE_DIGITS)}`;
}
