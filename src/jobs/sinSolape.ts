// E23, primera parte (2026-09-18). Un job no se pisa a si mismo.
//
// Todos los jobs se registran como `setInterval(() => { runX().catch(...) }, MS)`. setInterval NO
// espera a que la pasada anterior termine: si una tarda mas que su intervalo, arranca otra encima.
//
// El caso concreto que nombra el plan: saleConfirmationChaser corre cada 60 SEGUNDOS y recorre negocios
// en un bucle secuencial, mandando WhatsApps. Una pasada lenta - un negocio con muchas conversaciones
// vencidas, o Meta respondiendo despacio - se solapa con la siguiente, las dos encuentran la MISMA
// conversacion vencida, y al cliente le llegan dos mensajes identicos. No es hipotetico: es lo que pasa
// cuando una pasada supera su intervalo, y el unico motivo por el que no paso mas seguido es que hoy
// hay pocos negocios.
//
// ALCANCE, dicho para que nadie lo lea de mas: esto protege contra que UN proceso se pise a si mismo.
// NO protege contra dos procesos corriendo el mismo job - eso necesita que el trabajo se tome de la
// base con FOR UPDATE SKIP LOCKED, que es el resto de E23 y depende de E21. Hoy lo unico que impide dos
// procesos es `instances: 1` en ecosystem.config.js, y eso sigue igual.

export interface Guardia {
  /** La tarea envuelta. Se saltea si la pasada anterior sigue corriendo. */
  correr: () => Promise<void>;
  /** Cuantas pasadas se saltearon por solape. Si esto crece, el intervalo quedo corto. */
  salteadas: () => number;
  /** Si hay una pasada en curso ahora mismo. */
  enCurso: () => boolean;
}

/**
 * E24 (2026-09-18). TODOS los guards, sin que nadie tenga que acordarse de registrarlos.
 *
 * `/health` necesita poder decir QUE job esta mal, no solo que algo lo esta. Si cada job tuviera que
 * anotarse en una lista aparte, el job que se agregue manana no se anotaria, y `/health` diria "todo
 * bien" sin saber que existe. Registrarse es parte de crearse.
 */
const guardias = new Map<string, Guardia>();

export function todasLasGuardias(): { nombre: string; salteadas: number; enCurso: boolean }[] {
  return [...guardias.entries()].map(([nombre, g]) => ({
    nombre,
    salteadas: g.salteadas(),
    enCurso: g.enCurso(),
  }));
}

export function sinSolape(nombre: string, tarea: () => Promise<void>): Guardia {
  let corriendo = false;
  let salteadas = 0;

  const guardia: Guardia = {
    correr: async () => {
      if (corriendo) {
        salteadas += 1;
        // Ruidoso a proposito: que un job tarde mas que su intervalo es una señal de que el intervalo
        // quedo corto o de que algo se puso lento, y eso hay que verlo antes de que duplique mensajes.
        console.error(
          `[ZAQI ALERT] el job de ${nombre} todavia estaba corriendo cuando le tocaba de nuevo: se saltea esta pasada (${salteadas} salteadas en total)`,
        );
        return;
      }
      corriendo = true;
      try {
        await tarea();
      } finally {
        // finally y no despues del await: si la tarea tira, la bandera TIENE que soltarse igual. Sin
        // esto, un solo error dejaria el job trabado para siempre - un candado que no se suelta es peor
        // que no tener candado.
        corriendo = false;
      }
    },
    salteadas: () => salteadas,
    enCurso: () => corriendo,
  };

  guardias.set(nombre, guardia);
  return guardia;
}
