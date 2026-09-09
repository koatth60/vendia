import bcrypt from "bcryptjs";
import { prisma } from "../db/client";
import { sendTextMessage, type WhatsappCredentials } from "../whatsapp/client";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateResetCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
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
    data: { passwordResetCode: code, passwordResetExpiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };
  try {
    await sendTextMessage(
      credentials,
      business.contactPhone,
      `Tu código para restablecer tu contraseña de Vendia es: ${code}\n\nVálido por 10 minutos. Si no lo pediste vos, ignorá este mensaje.`
    );
  } catch (error) {
    console.error("No se pudo enviar el código de restablecimiento por WhatsApp:", error);
  }
}

export async function resetPasswordWithCode(email: string, code: string, newPassword: string): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { email } });
  if (
    !business ||
    !business.passwordResetCode ||
    !business.passwordResetExpiresAt ||
    business.passwordResetExpiresAt < new Date() ||
    business.passwordResetCode !== code.trim()
  ) {
    return false;
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.business.update({
    where: { id: business.id },
    data: { passwordHash, passwordResetCode: null, passwordResetExpiresAt: null },
  });
  return true;
}

export function generateActivationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += "-";
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
