import { Router } from "express";
import { prisma } from "../../db/client";
import { env } from "../../config/env";
import {
  exchangeCodeForToken,
  subscribeAppToWaba,
  registerPhoneNumber,
  getPhoneNumberInfo,
} from "../../whatsapp/embeddedSignup";
import { businessIdOf } from "./shared";

export const whatsappConnectRouter = Router();

// El front necesita el appId y el configId para abrir el popup de Facebook. Los dos son publicos (el
// SDK los expone en el navegador igual), asi que servirlos aca no filtra nada - el secret se queda en
// el servidor y nunca sale de exchangeCodeForToken.
whatsappConnectRouter.get("/api/whatsapp/connect-config", (_req, res) => {
  res.json({
    appId: env.facebook.appId,
    configId: env.facebook.configId,
    // Sin esto el panel muestra el boton y el cliente se come un popup que falla sin explicacion.
    ready: Boolean(env.facebook.appId && env.facebook.configId && env.facebook.appSecret),
  });
});

// Estado actual, para que el panel sepa si mostrar "Conectar" o "Ya conectado".
whatsappConnectRouter.get("/api/whatsapp/connection", async (req, res) => {
  const business = await prisma.business.findUnique({
    where: { id: businessIdOf(req) },
    select: { whatsappPhoneNumberId: true, whatsappBusinessAccountId: true, whatsappPhoneNumber: true, whatsappAccessToken: true },
  });
  res.json({
    connected: Boolean(business?.whatsappPhoneNumberId && business?.whatsappAccessToken),
    phoneNumberId: business?.whatsappPhoneNumberId ?? null,
    wabaId: business?.whatsappBusinessAccountId ?? null,
    phoneNumber: business?.whatsappPhoneNumber ?? null,
  });
});

// El popup de Embedded Signup devuelve tres cosas: un `code` de un solo uso, y el par
// phone_number_id / waba_id que el cliente eligio. Los tres hacen falta: el code da el token, y los
// otros dos dicen SOBRE QUE cuenta vale ese token.
whatsappConnectRouter.post("/api/whatsapp/connect", async (req, res) => {
  const code = String(req.body?.code ?? "").trim();
  const phoneNumberId = String(req.body?.phoneNumberId ?? "").trim();
  const wabaId = String(req.body?.wabaId ?? "").trim();
  // PIN de verificacion en dos pasos. Se pide al cliente solo si su numero ya tenia uno; para un
  // numero nuevo se genera uno y queda como el suyo.
  const pin = String(req.body?.pin ?? "").trim() || "000000";

  if (!code || !phoneNumberId || !wabaId) {
    res.status(400).json({ error: "Faltan datos del registro (code, phoneNumberId o wabaId)" });
    return;
  }

  const businessId = businessIdOf(req);

  try {
    const { accessToken, expiresInSeconds } = await exchangeCodeForToken(code);

    // Orden importante: suscribir la app ANTES de guardar. Si la suscripcion falla, el negocio no
    // queda marcado como conectado con un webhook que nunca va a disparar - el sintoma mas confuso
    // posible, porque todo "se ve" bien y el bot simplemente no contesta nunca.
    await subscribeAppToWaba(wabaId, accessToken);

    // El registro puede fallar legitimamente si el numero ya tenia PIN propio (error 133005). No es
    // motivo para tirar toda la conexion: la WABA ya quedo suscrita y el token sirve. Se guarda igual
    // y se le avisa al dueno que falta ese paso.
    let registered = true;
    let registerError: string | null = null;
    try {
      await registerPhoneNumber(phoneNumberId, accessToken, pin);
    } catch (error) {
      registered = false;
      registerError = error instanceof Error ? error.message : String(error);
      console.error(`No se pudo registrar el numero ${phoneNumberId} en Cloud API:`, registerError);
    }

    let phoneNumber: string | null = null;
    try {
      phoneNumber = (await getPhoneNumberInfo(phoneNumberId, accessToken)).displayPhoneNumber;
    } catch (error) {
      console.error("No se pudo leer el numero conectado (no bloqueante):", error);
    }

    await prisma.business.update({
      where: { id: businessId },
      data: {
        whatsappPhoneNumberId: phoneNumberId,
        whatsappBusinessAccountId: wabaId,
        whatsappAccessToken: accessToken,
        whatsappPhoneNumber: phoneNumber,
      },
    });

    res.json({
      ok: true,
      connected: true,
      phoneNumber,
      registered,
      registerError,
      // En dias, que es como lo va a leer una persona - no en segundos.
      tokenExpiresInDays: expiresInSeconds ? Math.round(expiresInSeconds / 86400) : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Fallo la conexion de WhatsApp por Embedded Signup:", message);
    res.status(502).json({ error: message });
  }
});
