import crypto from "node:crypto";
import express from "express";
import type { Request, RequestHandler } from "express";

// Fase 8, punto 1 del plan maestro (2026-09-15): hasta ahora POST /webhook aceptaba cualquier cuerpo
// que llegara al puerto. Meta firma cada entrega con HMAC-SHA256 del cuerpo CRUDO usando el app
// secret, y esa firma viaja en X-Hub-Signature-256. Verificarla es lo unico que distingue una entrega
// real de Meta de un POST que cualquiera arme a mano contra el dominio publico.
//
// El cuerpo crudo importa byte a byte: JSON.stringify(req.body) NO reproduce los bytes originales
// (orden de claves, escapes unicode, espacios), asi que firmar sobre el objeto ya parseado da un
// digest distinto y la verificacion nunca coincidiria. Por eso captureRawBody corre antes que
// express.json() y guarda el Buffer tal cual llego.

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}

// Solo se monta en /webhook (ver src/index.ts). express.raw deja el Buffer en req.body y marca
// req._body, asi que el express.json() global de mas abajo no vuelve a parsear esta request; el JSON
// lo parseamos aca a mano para que la ruta siga recibiendo el objeto que siempre recibio.
export function captureRawBody(): RequestHandler[] {
  const raw = express.raw({ type: "application/json", limit: "5mb" });
  const parse: RequestHandler = (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      const text = req.body.toString("utf8");
      try {
        req.body = text ? JSON.parse(text) : {};
      } catch {
        // Un cuerpo que no es JSON valido no puede venir de Meta. Se deja como objeto vacio y la ruta
        // lo ignora igual que siempre; la firma, ademas, ya va a fallar.
        req.body = {};
      }
    }
    next();
  };
  return [raw, parse];
}

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: "sin-app-secret" | "sin-cuerpo-crudo" | "sin-cabecera" | "formato-invalido" | "no-coincide" };

export function checkWebhookSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): SignatureCheck {
  // Sin secret no hay nada contra que verificar. Es una falla de configuracion, no un ataque: se
  // reporta distinto para que el rechazo (cuando se active) no tumbe la recepcion entera por un .env
  // incompleto.
  if (!appSecret) return { valid: false, reason: "sin-app-secret" };
  if (!rawBody) return { valid: false, reason: "sin-cuerpo-crudo" };
  if (!header) return { valid: false, reason: "sin-cabecera" };
  if (!header.startsWith(SIGNATURE_PREFIX)) return { valid: false, reason: "formato-invalido" };

  const received = Buffer.from(header.slice(SIGNATURE_PREFIX.length), "hex");
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  // timingSafeEqual exige largos iguales: una firma truncada o con hex invalido se descarta antes,
  // porque si no tira TypeError en vez de devolver false.
  if (received.length !== expected.length) return { valid: false, reason: "formato-invalido" };
  return crypto.timingSafeEqual(received, expected) ? { valid: true } : { valid: false, reason: "no-coincide" };
}

export function signatureHeaderOf(req: Request): string | undefined {
  const value = req.get(SIGNATURE_HEADER);
  return value ?? undefined;
}

// Usado solo por las pruebas y por quien quiera reproducir una firma valida a mano.
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  return SIGNATURE_PREFIX + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
}
