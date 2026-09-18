import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db/client";

/**
 * E28 (2026-09-18). Antes esto solo miraba que la cookie tuviera un businessId, o sea que una sesion
 * seguia valiendo hasta que expirara sola. Borrar o desactivar a un miembro del equipo NO le cerraba la
 * sesion: seguia entrando al panel del negocio, con su token de WhatsApp y sus conversaciones, hasta
 * que se le venciera la cookie. Quitarle el acceso a alguien tiene que surtir efecto cuando se aprieta
 * el boton, no cuando el navegador se aburre.
 *
 * Ahora la cookie lleva la version de sesion que tenia su fila al momento del login, y aca se compara
 * contra la de la base. Desactivar o borrar sube esa version, asi que todas las cookies emitidas antes
 * dejan de valer de golpe. Es un contador, no una lista de sesiones que haya que mantener.
 *
 * Cuesta una lectura por peticion, por clave primaria. Se acepta a sabiendas: el control de acceso no
 * puede depender de un dato que quedo congelado en una cookie.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const sesionInvalida = () => {
    // destroy() puede no existir: los harnesses de prueba inyectan un objeto de sesion plano, y un
    // TypeError aca convertiria un 401 legitimo en un 500.
    if (typeof req.session?.destroy === "function") req.session.destroy(() => undefined);
    res.status(401).json({ error: "Tu sesión ya no es válida. Volvé a entrar." });
  };

  // Un empleado se valida contra SU fila: puede estar desactivado o borrado aunque el negocio siga bien.
  if (req.session.role === "EMPLOYEE") {
    if (!req.session.teamMemberId) return sesionInvalida();
    const miembro = await prisma.teamMember.findUnique({
      where: { id: req.session.teamMemberId },
      select: { active: true, sessionVersion: true, businessId: true },
    });
    if (
      !miembro ||
      !miembro.active ||
      miembro.businessId !== req.session.businessId ||
      miembro.sessionVersion !== (req.session.sessionVersion ?? 0)
    ) {
      return sesionInvalida();
    }
    next();
    return;
  }

  const negocio = await prisma.business.findUnique({
    where: { id: req.session.businessId },
    select: { sessionVersion: true },
  });
  if (!negocio || negocio.sessionVersion !== (req.session.sessionVersion ?? 0)) {
    return sesionInvalida();
  }
  next();
}
