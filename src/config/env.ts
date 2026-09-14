import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-secret-change-me",
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
  platformAdmin: {
    email: process.env.PLATFORM_ADMIN_EMAIL ?? "",
    password: process.env.PLATFORM_ADMIN_PASSWORD ?? "",
  },
  aws: {
    region: process.env.AWS_REGION ?? "",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.AWS_S3_BUCKET ?? "",
  },
};
