import "dotenv/config";
import { prisma } from "../src/db/client";

// PONER A MANO EL TOKEN DE WHATSAPP DE UN NEGOCIO.
//
// El flujo del panel (/admin/api/whatsapp/connect) NO sirve para esto: espera un `code` de Embedded
// Signup y lo cambia el mismo por un token, y ademas devuelve 409 si el negocio ya esta conectado
// (ver src/routes/admin/whatsappConnect.ts). Un token de System User -- el permanente, el que no
// caduca -- no entra por ahi. Este script es el unico camino.
//
// El token se pasa por VARIABLE DE ENTORNO, nunca como argumento: los argumentos quedan en el
// historial del shell y en `ps`, la variable no.
//
//   ssh vendia "cd /opt/vendia && TOKEN='EAAG...' NEGOCIO='Boutique Alondra' npx tsx scripts/poner-token.ts"
//
// No imprime el token en ningun momento, ni entero ni en pedazos.

async function main() {
  const token = (process.env.TOKEN ?? "").trim();
  const nombre = (process.env.NEGOCIO ?? "").trim();

  if (!nombre) { console.error("Falta NEGOCIO. Ejemplo: NEGOCIO='Boutique Alondra'"); process.exit(1); }
  if (!token) { console.error("Falta TOKEN."); process.exit(1); }
  // Un token de Meta arranca con EAA. Se valida la forma, no el contenido: pegar media cadena o el
  // texto de otra cosa es el error mas facil de cometer y el mas dificil de diagnosticar despues,
  // porque el sintoma es un 190 identico al de un token vencido.
  if (!token.startsWith("EAA")) { console.error("Ese valor no parece un token de Meta (no empieza con EAA)."); process.exit(1); }

  const negocio = await prisma.business.findFirst({ where: { name: nombre }, select: { id: true, name: true, whatsappPhoneNumberId: true } });
  if (!negocio) { console.error(`No existe ningun negocio llamado "${nombre}".`); process.exit(1); }

  await prisma.business.update({ where: { id: negocio.id }, data: { whatsappAccessToken: token } });

  console.log(`Token actualizado en "${negocio.name}" (phoneNumberId ${negocio.whatsappPhoneNumberId ?? "sin configurar"}).`);
  console.log(`Largo recibido: ${token.length} caracteres. El valor no se imprime.`);
  console.log("\nAhora reinicia para que los procesos lo tomen:  pm2 restart vendia vendia-worker --update-env");
  process.exit(0);
}

void main();
