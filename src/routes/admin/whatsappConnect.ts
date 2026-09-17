import { Router } from "express";
import { prisma } from "../../db/client";
import { env } from "../../config/env";
import {
  exchangeCodeForToken,
  subscribeAppToWaba,
  registerPhoneNumber,
  getPhoneNumberInfo,
} from "../../whatsapp/embeddedSignup";
import { requireOwner } from "../../auth/requireOwner";
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
    select: {
      whatsappPhoneNumberId: true,
      whatsappBusinessAccountId: true,
      whatsappPhoneNumber: true,
      whatsappAccessToken: true,
      whatsappTokenExpiresAt: true,
      whatsappConnectionBrokenAt: true,
    },
  });
  res.json({
    connected: Boolean(business?.whatsappPhoneNumberId && business?.whatsappAccessToken),
    phoneNumberId: business?.whatsappPhoneNumberId ?? null,
    wabaId: business?.whatsappBusinessAccountId ?? null,
    phoneNumber: business?.whatsappPhoneNumber ?? null,
    tokenExpiresAt: business?.whatsappTokenExpiresAt ?? null,
    connectionBroken: Boolean(business?.whatsappConnectionBrokenAt),
  });
});

// El popup de Embedded Signup devuelve tres cosas: un `code` de un solo uso, y el par
// phone_number_id / waba_id que el cliente eligio. Los tres hacen falta: el code da el token, y los
// otros dos dicen SOBRE QUE cuenta vale ese token.
// Fase 8, punto 4 (decision D5 del diagnostico): esta es la ruta mas grave de las que no tenian
// requireOwner. Un EMPLOYEE puede usar la bandeja y el catalogo; conectar WhatsApp no. Completar este
// flujo reemplaza el phoneNumberId y el token del negocio: en el mejor caso le cambia el numero al
// bot, en el peor apunta el WhatsApp del cliente a una cuenta ajena. No es una accion de uso diario de
// nadie que no sea el dueno.
whatsappConnectRouter.post("/api/whatsapp/connect", requireOwner, async (req, res) => {
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

  // Una cuenta que todavia espera activacion no conecta WhatsApp. Esta es la garantia de que el bot
  // sigue apagado; el aviso del panel es solo como se lo contamos al cliente. Un cartel se puede
  // ocultar desde las herramientas del navegador, esta comprobacion no.
  const pending = await prisma.business.findUnique({
    where: { id: businessId },
    select: { active: true },
  });
  if (!pending?.active) {
    res.status(403).json({
      error: "Tu cuenta todavía no está activada. En cuanto la activemos podrás conectar tu WhatsApp.",
      pendingActivation: true,
    });
    return;
  }

  // Un negocio YA conectado no se puede pisar por accidente. MAG.IMP corre en produccion con clientes
  // reales: si alguien completa este flujo desde su panel con otro numero, le cambia el token y el
  // phoneNumberId, y su bot deja de contestar SIN ningun error visible - el peor modo de falla que
  // existe, porque nadie se entera hasta que un cliente reclama. Sobrescribir tiene que ser una
  // decision explicita (replace:"true"), nunca el resultado de un clic de mas. La guarda vive en el
  // servidor y no en un dialogo del navegador a proposito: un confirm() se pasa de un enter sin leer,
  // y no protege nada si el request llega de otro lado.
  const existing = await prisma.business.findUnique({
    where: { id: businessId },
    select: { whatsappPhoneNumberId: true, whatsappAccessToken: true, whatsappPhoneNumber: true },
  });
  if (existing?.whatsappPhoneNumberId && existing?.whatsappAccessToken && String(req.body?.replace ?? "") !== "true") {
    const label = existing.whatsappPhoneNumber ?? existing.whatsappPhoneNumberId;
    res.status(409).json({
      error: `Este negocio ya tiene WhatsApp conectado (${label}). No se sobrescribe solo: hay que desconectarlo a proposito primero.`,
      alreadyConnected: true,
    });
    return;
  }

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

    // expiresInSeconds llega null si Meta no lo informa - mejor no guardar una fecha inventada que
    // frenar la conexion por eso; jobs/tokenExpiry.ts simplemente no avisa para ese negocio.
    const tokenExpiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;

    await prisma.business.update({
      where: { id: businessId },
      data: {
        whatsappPhoneNumberId: phoneNumberId,
        whatsappBusinessAccountId: wabaId,
        whatsappAccessToken: accessToken,
        whatsappPhoneNumber: phoneNumber,
        whatsappTokenExpiresAt: tokenExpiresAt,
        // Reconectar es la unica forma de arreglar un token vencido/revocado o de reiniciar el aviso de
        // los 7 dias para el nuevo vencimiento - limpiar estos dos es parte de "quedo conectado".
        whatsappTokenExpiryNotifiedAt: null,
        whatsappConnectionBrokenAt: null,
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
