import crypto from "node:crypto";

// Fase 8, punto 2 del plan maestro (2026-09-15): Business.whatsappAccessToken vivia en texto plano.
// Acceso de lectura a Postgres (una copia de seguridad extraviada, una credencial de la base filtrada,
// un volcado para depurar) equivalia a control del WhatsApp de TODOS los clientes: con ese token se
// puede leer y escribir en su numero sin tocar nada nuestro.
//
// aes-256-gcm y no aes-256-cbc porque GCM autentica: un ciphertext alterado falla al descifrar en vez
// de devolver basura que el resto del codigo trataria como un token.

const VERSION = "v1";
const SEPARATOR = ".";
const IV_BYTES = 12; // El tamano recomendado para GCM.
const KEY_BYTES = 32; // aes-256.
// Sal fija a proposito: la clave se deriva una sola vez al arrancar y tiene que dar SIEMPRE el mismo
// resultado, o las filas cifradas ayer no se pueden leer hoy. La entropia la aporta la variable de
// entorno, no la sal.
const KEY_SALT = "onix-token-encryption-v1";

let cachedKey: Buffer | null = null;

export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const passphrase = process.env.TOKEN_ENCRYPTION_KEY;
  if (!passphrase) {
    throw new Error("Falta TOKEN_ENCRYPTION_KEY: no se puede cifrar ni descifrar el token de WhatsApp");
  }
  cachedKey = crypto.scryptSync(passphrase, KEY_SALT, KEY_BYTES);
  return cachedKey;
}

// Solo para las pruebas, que cambian la clave entre casos.
export function resetKeyCache(): void {
  cachedKey = null;
}

// Un valor cifrado por esta funcion se reconoce por su prefijo de version, sin adivinar: cualquier
// cosa que no empiece con "v1." es texto plano heredado (ver scripts/encrypt-whatsapp-tokens.ts) y se
// devuelve tal cual.
export function isEncrypted(value: string): boolean {
  return value.startsWith(VERSION + SEPARATOR) && value.split(SEPARATOR).length === 4;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(SEPARATOR);
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const [, ivPart, tagPart, cipherPart] = stored.split(SEPARATOR);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(cipherPart, "base64")), decipher.final()]).toString("utf8");
}
