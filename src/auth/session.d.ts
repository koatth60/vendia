import "express-session";

declare module "express-session" {
  interface SessionData {
    businessId?: string;
    role?: "OWNER" | "EMPLOYEE";
    email?: string;
    platformAdmin?: boolean;
    // E28 (2026-09-18). Quien es el titular de esta sesion y con que version de su fila se emitio.
    //
    // teamMemberId se guarda para no tener que buscar al empleado por email en cada peticion: el email
    // es unico, pero la clave de la fila es el id, y buscar por la clave es lo que hace que el chequeo
    // de requireAuth cueste una lectura indexada y no una consulta.
    teamMemberId?: string;
    // Version de sesion vigente cuando se hizo el login. requireAuth la compara contra la fila; si la
    // fila subio (porque al miembro lo desactivaron o lo borraron), esta cookie deja de servir.
    sessionVersion?: number;
  }
}
