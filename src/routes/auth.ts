import { Router } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../db/client";
import { hashPassword, verifyPassword, requestPasswordReset, resetPasswordWithCode } from "../auth/service";
import { env } from "../config/env";

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Prueba de nuevo en unos minutos." },
});

const PLAN_TIERS = ["BASICO", "EMPRENDEDOR", "NEGOCIO"] as const;

// La clave de activacion dejo de ser obligatoria el 2026-09-17. Quien la tiene entra activado en el
// acto; quien no, igual crea su cuenta y entra a su panel en modo espera, con el bot apagado hasta
// que Zaqi la active desde la consola de plataforma.
//
// No hay tabla de "solicitudes pendientes" y no debe haberla: una cuenta esperando activacion ES un
// Business con active=false. La bandeja del panel de plataforma sale de un SELECT sobre ese campo,
// asi que no existe el estado intermedio donde la cuenta esta inactiva y su solicitud se perdio, ni
// al reves.
/**
 * E28 (2026-09-18). Se REGENERA el identificador de sesion en cada login, antes de escribir nada en
 * ella. Sin esto, quien ya tenia una cookie en ese navegador (una sesion anonima, o la del usuario
 * anterior en una maquina compartida) se queda con el MISMO identificador despues de que otro entra:
 * es fijacion de sesion de manual.
 *
 * Tambien guarda de que version de la fila se emitio esta sesion, que es lo que requireAuth compara
 * despues para poder cortarla.
 */
async function abrirSesion(
  req: { session: import("express-session").Session & Partial<import("express-session").SessionData> },
  datos: { businessId: string; role: "OWNER" | "EMPLOYEE"; email: string; sessionVersion: number; teamMemberId?: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.businessId = datos.businessId;
  req.session.role = datos.role;
  req.session.email = datos.email;
  req.session.sessionVersion = datos.sessionVersion;
  if (datos.teamMemberId) req.session.teamMemberId = datos.teamMemberId;
}

authRouter.post("/signup", authLimiter, async (req, res) => {
  const { businessName, email, password, contactPhone, activationKey, planTier } = req.body;

  if (!businessName || !email || !password) {
    res.status(400).json({ error: "Faltan campos obligatorios" });
    return;
  }

  const code = String(activationKey ?? "").trim();

  // Una clave escrita mal no se ignora en silencio: quien cree estar entrando activado tiene que
  // enterarse ahi mismo, no tres dias despues preguntando por que su bot no contesta.
  let key = null;
  if (code) {
    key = await prisma.activationKey.findUnique({ where: { code } });
    if (!key || key.used) {
      res.status(400).json({ error: "La clave de activación no es válida o ya fue usada" });
      return;
    }
  }

  const existing = await prisma.business.findUnique({ where: { email } });
  if (existing) {
    res.status(400).json({ error: "Ya existe una cuenta con ese email" });
    return;
  }

  // Con clave manda la clave: es la que Zaqi emitio para un plan concreto y ya esta cobrada. Sin
  // clave el plan es lo que el cliente pidio, y queda como propuesta hasta que se active.
  const requestedTier = PLAN_TIERS.includes(planTier) ? planTier : "BASICO";
  const passwordHash = await hashPassword(password);

  const business = await prisma.business.create({
    data: {
      name: businessName,
      email,
      passwordHash,
      contactPhone: contactPhone || null,
      planTier: key ? key.planTier : requestedTier,
      active: Boolean(key),
    },
  });

  if (key) {
    await prisma.activationKey.update({
      where: { id: key.id },
      data: { used: true, usedByBusinessId: business.id, usedAt: new Date() },
    });
  }

  await abrirSesion(req, {
    businessId: business.id,
    role: "OWNER",
    email: business.email,
    sessionVersion: business.sessionVersion,
  });
  res.status(201).json({
    id: business.id,
    name: business.name,
    email: business.email,
    planTier: business.planTier,
    active: business.active,
  });
});

authRouter.post("/request-key", async (req, res) => {
  const { businessName, email, phone, planTier } = req.body;
  if (!businessName || !email || !phone) {
    res.status(400).json({ error: "Faltan campos obligatorios" });
    return;
  }
  const tier = ["BASICO", "EMPRENDEDOR", "NEGOCIO"].includes(planTier) ? planTier : "BASICO";

  await prisma.keyRequest.create({
    data: { businessName, email, phone, planTier: tier },
  });

  res.status(201).json({ ok: true });
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Faltan email o contraseña" });
    return;
  }

  if (env.platformAdmin.email && env.platformAdmin.password && email === env.platformAdmin.email && password === env.platformAdmin.password) {
    req.session.platformAdmin = true;
    res.json({ isPlatformAdmin: true });
    return;
  }

  // Una cuenta sin activar entra igual y ve su panel en modo espera. Antes se le devolvia
  // "Credenciales inválidas", que es mentira y deja al cliente probando contrasenas que si eran
  // correctas. El bot apagado no depende de este login: depende de active=false, que el servidor
  // comprueba donde importa (conectar WhatsApp).
  const business = await prisma.business.findUnique({ where: { email } });
  if (business) {
    const valid = await verifyPassword(password, business.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Credenciales inválidas" });
      return;
    }
    await abrirSesion(req, {
      businessId: business.id,
      role: "OWNER",
      email: business.email,
      sessionVersion: business.sessionVersion,
    });
    res.json({
      id: business.id,
      name: business.name,
      email: business.email,
      planTier: business.planTier,
      active: business.active,
    });
    return;
  }

  // Un empleado desactivado sigue sin entrar. Que su negocio este esperando activacion ya no lo
  // bloquea: ve el mismo panel en modo espera que su dueno.
  const member = await prisma.teamMember.findUnique({ where: { email }, include: { business: true } });
  if (!member || !member.active) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }
  const validMember = await verifyPassword(password, member.passwordHash);
  if (!validMember) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }
  await abrirSesion(req, {
    businessId: member.business.id,
    role: "EMPLOYEE",
    email: member.email,
    sessionVersion: member.sessionVersion,
    teamMemberId: member.id,
  });
  res.json({
    id: member.business.id,
    name: member.business.name,
    email: member.email,
    planTier: member.business.planTier,
    active: member.business.active,
  });
});

authRouter.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: "Falta el email" });
    return;
  }

  await requestPasswordReset(String(email));

  // Misma respuesta exista o no la cuenta, para no revelar que emails estan registrados
  res.json({ ok: true });
});

authRouter.post("/reset-password", authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    res.status(400).json({ error: "Faltan campos obligatorios" });
    return;
  }
  if (String(newPassword).length < 8) {
    res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
    return;
  }

  const ok = await resetPasswordWithCode(String(email), String(code), String(newPassword));
  if (!ok) {
    res.status(400).json({ error: "Código inválido o expirado" });
    return;
  }

  res.json({ ok: true });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.status(204).send();
  });
});

authRouter.get("/me", async (req, res) => {
  if (!req.session.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const business = await prisma.business.findUnique({ where: { id: req.session.businessId } });
  if (!business) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  res.json({
    id: business.id,
    name: business.name,
    email: req.session.email ?? business.email,
    planTier: business.planTier,
    whatsappConnected: Boolean(business.whatsappPhoneNumberId),
    active: business.active,
    role: req.session.role ?? "OWNER",
  });
});
