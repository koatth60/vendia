import { prisma } from "../db/client";

// E29 (2026-09-18). AUDITORIA DE LA CONSOLA DE PLATAFORMA.
//
// La consola de plataforma puede activar y desactivar negocios, cambiar su plan y su techo de gasto, y
// leer los mensajes del dueno. Hasta hoy no quedaba rastro de NADA de eso: ni de quien entro, ni de que
// toco, ni de cuando. Con clientes que pagan, "alguien desactivo el negocio de Milena el martes" no
// tenia forma de responderse.
//
// UNA SOLA TABLA PARA DOS COSAS, y es a proposito: el bloqueo por intentos se calcula contando los
// LOGIN_FAILED recientes de esa IP. Una segunda tabla de "intentos" tendria que mantenerse en sincronia
// con esta, y el dia que se desincronicen el bloqueo dejaria de coincidir con lo que dice la auditoria.
// El registro de lo que paso ES el contador.

/** Entrar, fallar al entrar, y cada accion que cambia algo de un negocio. */
export type PlatformAction =
  | "LOGIN_OK"
  | "LOGIN_FAILED"
  | "LOGIN_BLOCKED"
  | "LOGOUT"
  | "BUSINESS_UPDATED";

/** Ventana del bloqueo por intentos. Misma que el limitador de authRouter, para no tener dos numeros. */
export const VENTANA_INTENTOS_MS = 15 * 60 * 1000;

/**
 * Intentos fallidos desde una misma IP antes de bloquear. Mas alto que el limite del limitador de tasa
 * (10) seria inutil; mas bajo lo haria inalcanzable. Son dos defensas distintas sobre el mismo numero:
 * el limitador vive en memoria y se pierde al reiniciar - hubo trece reinicios en un dia - y este vive
 * en la base y no.
 */
export const INTENTOS_ANTES_DE_BLOQUEAR = 10;

/**
 * Deja constancia. Best-effort a proposito, igual que recordAgentTurn: si la auditoria falla, se loguea
 * y la peticion sigue.
 *
 * La excepcion es el camino del login fallido, que SI espera a que esto termine: ahi la fila no es solo
 * auditoria, es el contador del bloqueo, y un contador que no se escribio es un intento que no se conto.
 */
export async function recordPlatformAction(entrada: {
  action: PlatformAction;
  /** El correo TAL COMO SE INTENTO, exista o no: en un intento fallido es el unico dato que hay. */
  actorEmail?: string | null;
  ip?: string | null;
  businessId?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    await prisma.platformAuditLog.create({
      data: {
        action: entrada.action,
        actorEmail: entrada.actorEmail ?? null,
        ip: entrada.ip ?? null,
        businessId: entrada.businessId ?? null,
        detail: entrada.detail ?? null,
      },
    });
  } catch (error) {
    console.error("[ZAQI ALERT] No se pudo registrar una accion de plataforma:", error);
  }
}

/**
 * Cuantos intentos fallidos lleva esa IP en la ventana. El bloqueo se lee de la base y no de memoria
 * justamente para que reiniciar el proceso no sea la forma de saltearlo.
 */
export async function intentosFallidosRecientes(ip: string | null): Promise<number> {
  if (!ip) return 0;
  return prisma.platformAuditLog.count({
    where: {
      action: "LOGIN_FAILED",
      ip,
      createdAt: { gte: new Date(Date.now() - VENTANA_INTENTOS_MS) },
    },
  });
}

/**
 * Registra TODA peticion que cambia algo en la consola de plataforma, sin que haya que acordarse de
 * ponerlo en cada ruta.
 *
 * POR QUE MIDDLEWARE Y NO UNA LLAMADA POR RUTA: una llamada por ruta es una regla que alguien tiene que
 * cumplir, y la ruta que se agregue manana no la va a cumplir. Aca no hay forma de agregar una ruta que
 * cambie algo y quede sin auditar -- que es la unica version de esto que sirve.
 *
 * NUNCA SE GUARDA EL CUERPO. `PATCH /businesses/:id/whatsapp` recibe el token de acceso de Meta: un
 * registro de auditoria que copiara el cuerpo seria una tabla llena de credenciales en texto plano, o
 * sea un agujero mas grande que el que vino a cerrar. Se guarda que se hizo y sobre que, no con que.
 */
export function auditarCambiosDePlataforma(
  req: { method: string; originalUrl?: string; path: string; ip?: string },
  res: { statusCode: number; on: (evento: string, cb: () => void) => void },
  next: () => void,
): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const ruta = req.path;
  res.on("finish", () => {
    // Solo lo que salio bien. Un 400 o un 404 no cambio nada, y llenar la tabla con esos haria que la
    // pregunta "quien toco este negocio" deje de poder responderse de un vistazo.
    if (res.statusCode >= 400) return;
    void recordPlatformAction({
      action: "BUSINESS_UPDATED",
      ip: req.ip ?? null,
      businessId: ruta.match(/\/businesses\/([^/]+)/)?.[1] ?? null,
      detail: `${req.method} ${ruta}`,
    });
  });
  next();
}

/**
 * El bloqueo se levanta solo al vencer la ventana: no hay un desbloqueo manual y no hace falta, porque
 * no hay forma de que un bloqueo quede pegado. Un desbloqueo manual seria una puerta mas.
 */
export async function estaBloqueadaPorIntentos(ip: string | null): Promise<boolean> {
  return (await intentosFallidosRecientes(ip)) >= INTENTOS_ANTES_DE_BLOQUEAR;
}
