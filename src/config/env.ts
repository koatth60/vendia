import "dotenv/config";
import { parsearRol } from "./rol";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  // E23: que hace ESTE proceso. Ver src/config/rol.ts.
  rol: parsearRol(process.env.ONIX_ROL),
  databaseUrl: required("DATABASE_URL"),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  // El default es el de siempre: en produccion nadie define esta variable y no cambia nada. Existe para
  // que las pruebas puedan apuntar el cliente a una direccion muerta y que `npm test` no salga a
  // internet. Ver el comentario de src/ai/client.ts.
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // Fase 8, punto 5: antes caia a "dev-secret-change-me". Ese valor esta en el repositorio, asi que
  // cualquiera podia firmar una cookie de sesion valida para cualquier negocio: el control de acceso
  // entero descansaba en un secreto publico. `required()` para que el proceso no arranque sin el, en
  // vez de arrancar inseguro y en silencio.
  sessionSecret: required("SESSION_SECRET"),
  // Fase 8, punto 2: clave para cifrar Business.whatsappAccessToken en reposo (ver
  // src/crypto/secretBox.ts). Es `required()` a proposito: si fuera opcional, un despliegue sin la
  // variable volveria a guardar los tokens en texto plano sin que nadie lo note, que es exactamente el
  // estado que esta fase vino a cerrar. Se lee tambien desde process.env en secretBox, esta entrada
  // existe para que el proceso muera al arrancar y no a la primera escritura.
  tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
  },
  // Embedded Signup (Tech Provider). appId y configId son PUBLICOS: viajan al navegador del cliente
  // dentro del SDK de Facebook, asi que no son secreto. appSecret NO: solo se usa del lado del
  // servidor para cambiar el `code` que devuelve el popup por un access token, y nunca se manda al
  // front ni se guarda por negocio. Ver [[zaqi-meta-tech-provider-setup]].
  facebook: {
    appId: process.env.FACEBOOK_APP_ID ?? "",
    appSecret: process.env.FACEBOOK_APP_SECRET ?? "",
    configId: process.env.FACEBOOK_CONFIG_ID ?? "",
  },
  // Fase 8, punto 1: el rechazo por firma invalida arranca APAGADO a proposito. Se despliega primero
  // en modo registro (se loguea "firma invalida" y la entrega se procesa igual), y recien cuando 48h
  // de logs confirmen que las entregas reales de Meta validan bien se prende esta bandera en un cambio
  // aparte. Al reves, un error de configuracion del app secret dejaria al bot sin recibir nada y sin
  // que nadie se entere, porque Meta no reintenta indefinidamente.
  webhookSignature: {
    enforce: process.env.WEBHOOK_SIGNATURE_ENFORCE === "true",
  },
  platformAdmin: {
    email: process.env.PLATFORM_ADMIN_EMAIL ?? "",
    // E29 (2026-09-18): si el hash esta, es lo unico que se usa y la de texto plano se ignora. La de
    // texto plano sigue existiendo para que cambiar esto no deje al dueno afuera de su propia consola
    // en el despliegue siguiente - ver src/auth/platformPassword.ts, que es donde vive la decision.
    passwordHash: process.env.PLATFORM_ADMIN_PASSWORD_HASH ?? "",
    password: process.env.PLATFORM_ADMIN_PASSWORD ?? "",
  },
  aws: {
    region: process.env.AWS_REGION ?? "",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.AWS_S3_BUCKET ?? "",
  },
};
