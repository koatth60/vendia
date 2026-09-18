import "dotenv/config";
import { prisma } from "../src/db/client";

// CONECTAR UNA LÍNEA DE WHATSAPP A UN NEGOCIO DE PRUEBAS (2026-09-18).
//
// Para probar de verdad hace falta que el bot conteste por WhatsApp a un teléfono real. Este script
// pega la línea (el `phone_number_id` de Meta y su token) contra un negocio, DESPUÉS de verificar con
// Meta que esas credenciales funcionan -- guardar un token que no sirve deja al negocio "conectado" y
// mudo, que es peor que no conectarlo.
//
// El token se guarda por Prisma y no por SQL a propósito: la extensión de src/db/client.ts lo cifra al
// escribirlo. Un token en texto plano en la base es un token filtrado.
//
//   PHONE_NUMBER_ID=... TOKEN=... NEGOCIO="Boutique Alondra" npx tsx scripts/conectar-linea-de-pruebas.ts
//
// De dónde salen esos dos valores (developers.facebook.com → app "Onix by Zaqi Solutions" →
// WhatsApp → Configuración de la API):
//   - "Identificador de número de teléfono" del número de PRUEBA que Meta regala. No es el número
//     visible, es el id largo.
//   - El token temporal de esa misma pantalla (dura 24 h), o el permanente de un usuario del sistema.
//
// Y en esa pantalla hay que agregar el teléfono que va a escribirle como destinatario permitido: el
// número de prueba de Meta sólo le puede escribir a los que estén en esa lista.

const NOMBRE = process.env.NEGOCIO;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TOKEN = process.env.TOKEN;

async function main() {
  if (!NOMBRE || !PHONE_NUMBER_ID || !TOKEN) {
    console.error('Uso: PHONE_NUMBER_ID=... TOKEN=... NEGOCIO="Boutique Alondra" npx tsx scripts/conectar-linea-de-pruebas.ts');
    process.exit(64);
  }

  const negocio = await prisma.business.findFirst({ where: { name: NOMBRE }, select: { id: true, name: true, contactPhone: true } });
  if (!negocio) {
    console.error(`No existe ningun negocio llamado "${NOMBRE}".`);
    process.exit(65);
  }

  // PRIMERO SE VERIFICA, DESPUÉS SE GUARDA. Meta responde con el número mostrado y su nombre: si el
  // token no sirve o el id es de otra línea, esto falla acá y la base no se toca.
  const respuesta = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const cuerpo = (await respuesta.json()) as {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    error?: { message?: string; code?: number };
  };
  if (!respuesta.ok || cuerpo.error) {
    console.error(`Meta rechazo las credenciales (${respuesta.status}): ${cuerpo.error?.message ?? "sin detalle"}`);
    console.error("Nada se guardo. Revisa el PHONE_NUMBER_ID y que el token no haya vencido.");
    process.exit(1);
  }

  await prisma.business.update({
    where: { id: negocio.id },
    data: {
      whatsappPhoneNumberId: PHONE_NUMBER_ID,
      whatsappAccessToken: TOKEN,
      whatsappConnectionBrokenAt: null,
      // El token de la pantalla de pruebas de Meta dura 24 h. Se anota para que el aviso de vencimiento
      // (E19) lo agarre en vez de que el bot se quede mudo sin explicacion.
      whatsappTokenExpiresAt: process.env.TOKEN_PERMANENTE ? null : new Date(Date.now() + 24 * 60 * 60 * 1000),
      whatsappTokenExpiryNotifiedAt: null,
    },
  });

  console.log(`\nLinea conectada a "${negocio.name}"`);
  console.log(`  numero:    ${cuerpo.display_phone_number} (${cuerpo.verified_name ?? "sin nombre"})`);
  console.log(`  calidad:   ${cuerpo.quality_rating ?? "n/d"}`);
  console.log(`  dueno:     ${negocio.contactPhone ?? "(sin telefono: no le van a llegar alertas a nadie)"}`);
  if (!process.env.TOKEN_PERMANENTE) {
    console.log(`  token:     temporal, vence en 24 h (pasa TOKEN_PERMANENTE=1 si es de usuario del sistema)`);
  }
  console.log(`\nAhora escribile "hola" a ese numero desde ${negocio.contactPhone ?? "tu telefono"} para abrir la ventana de 24 h.`);
  process.exit(0);
}

void main();
