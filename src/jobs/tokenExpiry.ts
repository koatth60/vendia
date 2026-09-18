import { prisma } from "../db/client";
import { sendAlertToOwner, type WhatsappCredentials } from "../whatsapp/outbound";
import { recordOwnerMessage } from "../delivery/ownerLog";

// Fase 7 del plan maestro (2026-09-15): los tokens de Embedded Signup expiran a los 60 dias (ver
// whatsapp/embeddedSignup.ts:6-11) y hasta esta fase nada guardaba esa fecha ni avisaba - un negocio se
// caia solo y nadie se enteraba hasta que un cliente reclamaba que el bot dejo de contestar. Este job
// avisa al dueno por WhatsApp y deja un registro tageado para el equipo de Zaqi (que hoy opera via
// `pm2 logs`, no hay un canal propio de notificaciones entre negocios) TOKEN_EXPIRY_WARNING_DAYS antes
// del vencimiento. whatsappTokenExpiryNotifiedAt evita repetir el aviso en cada corrida; solo se limpia
// al reconectar (whatsappConnect.ts), asi que una unica alerta cubre todo el ciclo hasta la proxima
// expiracion.
export const TOKEN_EXPIRY_WARNING_DAYS = 7;
export const TOKEN_EXPIRY_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export async function runTokenExpiryJob(): Promise<void> {
  const warningCutoff = new Date(Date.now() + TOKEN_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000);
  const businesses = await prisma.business.findMany({
    where: {
      active: true,
      whatsappPhoneNumberId: { not: null },
      whatsappAccessToken: { not: null },
      whatsappTokenExpiresAt: { not: null, lte: warningCutoff },
      whatsappTokenExpiryNotifiedAt: null,
    },
  });

  for (const business of businesses) {
    // E14: un negocio que revienta no puede dejar sin atender a los que siguen. Antes un solo
    // throw abortaba la pasada entera de este job, y como corre por temporizador nadie se entera:
    // los demas negocios simplemente no reciben su vencimiento del token de WhatsApp y no hay error visible en ningun lado.
    // El continue de adentro sigue funcionando porque el try esta DENTRO del bucle, no afuera.
    try {
      const days = daysUntil(business.whatsappTokenExpiresAt!);
      // console.error a proposito (no .log): es el unico canal que hoy llega al equipo de Zaqi, que opera
      // via `pm2 logs`. El tag ZAQI ALERT existe para que sea buscable con grep sin ambiguedad.
      console.error(
        `ZAQI ALERT: token de WhatsApp de "${business.name}" (${business.id}) vence en ${days} dia(s) (${business.whatsappTokenExpiresAt!.toISOString()})`
      );

      // E15: RESERVAR, enviar, confirmar - en ese orden, y no al reves.
      //
      // Antes esto marcaba "ya avise" DESPUES de mandar, pero sin mirar si el envio habia salido. Como
      // la marca es la compuerta de "un aviso por token", un envio fallido significaba que al dueno no
      // se le avisaba NUNCA: el bot se apagaba el dia 60 y nadie se enteraba de por que.
      //
      // La reserva va con updateMany y la condicion "todavia esta en null" DENTRO del WHERE: es una sola
      // sentencia atomica, asi que dos pasadas simultaneas no pueden reservar el mismo negocio. Si
      // devuelve 0, otro ya lo tomo y este se saltea.
      const reserva = await prisma.business.updateMany({
        where: { id: business.id, whatsappTokenExpiryNotifiedAt: null },
        data: { whatsappTokenExpiryNotifiedAt: new Date() },
      });
      if (reserva.count === 0) continue;

      if (business.contactPhone) {
        const credentials: WhatsappCredentials = {
          phoneNumberId: business.whatsappPhoneNumberId!,
          accessToken: business.whatsappAccessToken!,
        };
        const text =
          days > 0
            ? `Tu conexion de WhatsApp vence en ${days} dia(s). Entra al panel y volve a conectar antes de esa fecha para que el bot no deje de contestar.`
            : "Tu conexion de WhatsApp esta por vencer o ya vencio. Entra al panel y volve a conectar para que el bot no deje de contestar.";
        const alert = await sendAlertToOwner(business.id, credentials, business.contactPhone, text);
        await recordOwnerMessage(business.id, {
          direction: "OUT",
          body: text,
          success: alert.delivered,
          errorMessage: alert.failure?.message ?? null,
        });
        if (!alert.delivered) {
          // CONFIRMAR: no salio, asi que se SUELTA la reserva. Sin esto la compuerta queda cerrada sobre
          // un aviso que nunca ocurrio y el ciclo siguiente no reintenta.
          console.error(`No se pudo avisar al dueno del vencimiento de token (business=${business.id}):`, alert.failure?.message);
          await prisma.business.update({
            where: { id: business.id },
            data: { whatsappTokenExpiryNotifiedAt: null },
          });
        }
      }
    } catch (error) {
      console.error(`[ZAQI ALERT] tokenExpiry: fallo el negocio ${business.id}, sigo con los demas:`, error);
    }
  }
}
