import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../db/client";
import { sendAlertToOwner, type WhatsappCredentials } from "../whatsapp/outbound";
import { recordOwnerMessage } from "../delivery/ownerLog";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Fase 8, punto 6 del plan maestro (2026-09-15): Math.random no es un generador criptografico. Su
// estado interno se puede reconstruir observando unas pocas salidas, asi que un codigo de
// recuperacion sacado de ahi es predecible desde afuera - y ese codigo cambia la contrasena de la
// cuenta. crypto.randomInt viene del generador del sistema operativo y ademas no tiene el sesgo del
// modulo.
export function generateResetCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

// El codigo se guarda HASHEADO, igual que una contrasena. Antes quedaba en texto plano en
// Business.passwordResetCode: cualquiera con lectura a la base podia tomar un codigo vivo y cambiar
// la contrasena del negocio antes que su dueno.
//
// bcrypt y no sha256 a proposito: seis digitos son 900.000 posibilidades, que un sha256 recorre en
// milisegundos si la base se filtra. El costo de bcrypt es lo unico que hace que eso no sea gratis.
export async function hashResetCode(code: string): Promise<string> {
  return bcrypt.hash(code, 12);
}

// bcrypt.compare compara el digest completo sin cortar al primer byte distinto: no filtra por tiempo
// cuantos caracteres del codigo acerto quien lo intenta.
export async function verifyResetCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

// Sends the reset code over the business's own WhatsApp number to its registered contactPhone -
// reuses infra already built for owner escalation instead of adding a separate email provider.
// Silently no-ops if the business doesn't exist or isn't WhatsApp-connected yet, so the caller can
// always return the same generic response and avoid leaking which emails are registered.
export async function requestPasswordReset(email: string): Promise<void> {
  const business = await prisma.business.findUnique({ where: { email } });
  if (!business || !business.whatsappPhoneNumberId || !business.whatsappAccessToken || !business.contactPhone) {
    return;
  }

  const code = generateResetCode();
  await prisma.business.update({
    where: { id: business.id },
    data: { passwordResetCode: await hashResetCode(code), passwordResetExpiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };
  const resetText = `Tu código para restablecer tu contraseña es: ${code}. Válido por 10 minutos, ignora este mensaje si no lo pediste tú.`;
  const result = await sendAlertToOwner(business.id, credentials, business.contactPhone, resetText);
  // Fase 8, punto 6: lo que se registra NO lleva el codigo. OwnerMessageLog se lee desde
  // /admin/api/owner-log (el panel del propio negocio, donde entra tambien un empleado) y desde la
  // consola de plataforma: escribir el codigo ahi lo convertia en un codigo valido legible por dos
  // caminos distintos que no son el WhatsApp del dueno. Queda el rastro del envio, que es para lo que
  // sirve el registro, sin el secreto.
  await recordOwnerMessage(business.id, {
    direction: "OUT",
    body: "[Código de restablecimiento de contraseña enviado por WhatsApp]",
    success: result.delivered,
    errorMessage: result.failure?.message ?? null,
  });
  if (!result.delivered) {
    console.error("No se pudo enviar el código de restablecimiento por WhatsApp:", result.failure?.message);
  }
}

// Hash de un valor que no es el codigo de nadie. Se compara contra el cuando no hay codigo vigente,
// para que "email que no existe", "nunca pidio un codigo" y "codigo equivocado" tarden lo mismo: si
// no, el tiempo de respuesta dice cuales de los emails probados son cuentas reales con un
// restablecimiento en curso.
const DUMMY_CODE_HASH = bcrypt.hashSync("000000", 12);

export async function resetPasswordWithCode(email: string, code: string, newPassword: string): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { email } });
  const stillValid = Boolean(
    business?.passwordResetCode && business.passwordResetExpiresAt && business.passwordResetExpiresAt >= new Date()
  );
  const matches = await verifyResetCode(code.trim(), stillValid ? business!.passwordResetCode! : DUMMY_CODE_HASH);
  if (!business || !stillValid || !matches) {
    return false;
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.business.update({
    where: { id: business.id },
    data: { passwordHash, passwordResetCode: null, passwordResetExpiresAt: null },
  });
  return true;
}

// Mismo motivo que generateResetCode: este codigo tambien da acceso, asi que tampoco puede salir de
// Math.random.
export function generateActivationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += "-";
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}
