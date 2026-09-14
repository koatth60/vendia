import { env } from "../config/env";

// Embedded Signup: el cliente conecta su propio WhatsApp desde el panel, sin que nadie pegue tokens a
// mano (que es como se hacia antes - ver platformAdmin.ts). El popup de Facebook devuelve un `code` de
// un solo uso; este modulo lo cambia por un token y deja la cuenta lista para recibir mensajes.
//
// Por que el token que sale de aca NO es el que conviene usar para siempre: la configuracion de
// Embedded Signup de Zaqi emite tokens de system-user que expiran a los 60 dias. Sirven para el
// apretado de manos (suscribir la app, registrar el numero). Para las llamadas del dia a dia conviene
// el System User token permanente del portafolio de Zaqi contra la WABA ya compartida - si no, cada
// cliente se cae solo a los 60 dias sin que nadie lo note.
const GRAPH = "https://graph.facebook.com/v21.0";

export interface ConnectedWhatsapp {
  accessToken: string;
  expiresInSeconds: number | null;
}

async function graph(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${GRAPH}${path}`, init);
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Meta Graph API: ${message}`);
  }
  return body;
}

// El `code` del popup se cambia por un token del lado del SERVIDOR, nunca en el navegador: hace falta
// el app secret, y mandarlo al front lo dejaria expuesto a cualquiera que abra el inspector.
export async function exchangeCodeForToken(code: string): Promise<ConnectedWhatsapp> {
  if (!env.facebook.appId || !env.facebook.appSecret) {
    throw new Error("Faltan FACEBOOK_APP_ID o FACEBOOK_APP_SECRET en el servidor");
  }
  const params = new URLSearchParams({
    client_id: env.facebook.appId,
    client_secret: env.facebook.appSecret,
    code,
  });
  const body = await graph(`/oauth/access_token?${params.toString()}`);
  if (!body.access_token) throw new Error("Meta no devolvio un access_token para ese codigo");
  return {
    accessToken: body.access_token,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : null,
  };
}

// Sin esto la WABA del cliente queda conectada pero MUDA: Meta no le manda los mensajes entrantes a
// nuestro webhook, asi que el bot nunca se entera de que alguien escribio.
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  await graph(`/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// Registra el numero en Cloud API. El PIN es el de verificacion en dos pasos: para un numero nuevo que
// nunca lo configuro, cualquier PIN de 6 digitos sirve y queda como el suyo. Si el cliente YA tenia un
// PIN puesto, este llamado falla con error 133005 y hace falta el suyo de verdad - por eso se deja
// pasar como parametro opcional en vez de hardcodear uno.
export async function registerPhoneNumber(phoneNumberId: string, accessToken: string, pin: string): Promise<void> {
  await graph(`/${phoneNumberId}/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
}

// Para mostrarle al dueno QUE numero quedo conectado, en vez de un id opaco.
export async function getPhoneNumberInfo(
  phoneNumberId: string,
  accessToken: string
): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null }> {
  const body = await graph(`/${phoneNumberId}?fields=display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return {
    displayPhoneNumber: body.display_phone_number ?? null,
    verifiedName: body.verified_name ?? null,
  };
}
