import { prisma } from "../src/db/client";

async function main() {
  const [businessName, phoneNumberId, accessToken] = process.argv.slice(2);

  if (!businessName || !phoneNumberId || !accessToken) {
    console.error(
      "Uso: npx tsx scripts/set-whatsapp.ts <nombre_negocio> <phone_number_id> <access_token>"
    );
    process.exit(1);
  }

  const business = await prisma.business.findFirst({
    where: { name: { contains: businessName, mode: "insensitive" } },
  });

  if (!business) {
    console.error(`No se encontró ningún negocio que coincida con "${businessName}"`);
    process.exit(1);
  }

  await prisma.business.update({
    where: { id: business.id },
    data: { whatsappPhoneNumberId: phoneNumberId, whatsappAccessToken: accessToken },
  });

  console.log(`Listo: ${business.name} (${business.id}) actualizado con nuevo número de WhatsApp.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
