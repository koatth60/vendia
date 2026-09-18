import { drainPendingBursts } from "../routes/whatsapp";
import { PENDING_BURST_INTERVAL_MS } from "../conversation/pendingBursts";

// E08 de ONIX-PLAN.md: quien mira el reloj de las rafagas guardadas.
//
// Antes el reloj era un `setTimeout` por rafaga dentro del proceso, asi que el reinicio se llevaba el
// reloj junto con la rafaga. Ahora el reloj es este job y la rafaga esta en la base: el proceso que
// arranque -- este u otro -- la encuentra vencida y la contesta.
//
// No espera los turnos que arranca. Son llamadas a generateReply, de segundos a minutos: esperarlas
// dejaria a todas las demas conversaciones haciendo fila detras de la mas lenta, que es exactamente
// lo que la version con timers NO hacia. Lo unico que se serializa es el reclamo, que es un UPDATE.
export { PENDING_BURST_INTERVAL_MS };

let pasadaEnCurso = false;

export async function runPendingBurstJob(): Promise<void> {
  // El intervalo es de un segundo y una pasada podria tardar mas que eso si la base esta lenta. Sin
  // esta guarda, las pasadas se apilarian; con ella, la que encuentra otra corriendo se saltea (la
  // rafaga sigue vencida un segundo mas tarde, no se pierde nada).
  if (pasadaEnCurso) return;
  pasadaEnCurso = true;
  try {
    const turnos = await drainPendingBursts();
    // Los errores de cada turno ya se reportan adentro (ver drainDuePendingBursts); esto solo evita
    // un rechazo sin manejar si alguno se escapara.
    void Promise.allSettled(turnos);
  } finally {
    pasadaEnCurso = false;
  }
}
