import "dotenv/config";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db/client";

// UN NEGOCIO CLON PARA PROBAR, SIN TOCAR EL DE LA CLIENTA (2026-09-18).
//
// El problema que resuelve, dicho por el dueño: si las conversaciones de prueba se hacen dentro del
// negocio real, a la dueña se le llena la Bandeja de charlas que no son de nadie y le llega spam al
// WhatsApp -- cada pedido le manda su confirmación, cada `ask_owner` le manda su pregunta. Eso no se
// arregla con cuidado: se arregla no usando su negocio.
//
// El clon copia lo que hace que el bot se comporte igual -- catálogo, variantes, fotos, categorías,
// métodos de pago, tarifas de envío, FAQ, personalidad e instrucciones -- y cambia tres cosas:
//
//   1. `contactPhone` vacío: sin teléfono de dueño, NINGUNA alerta sale a ningún lado. Es la misma
//      condición que ya usan las cuatro herramientas que le escriben (ver src/ai/tools.ts).
//   2. Credenciales de WhatsApp falsas: aunque algo intentara enviar, no hay línea que responda.
//   3. Login propio, que este script imprime, para mirar SU Bandeja y no la de ella.
//
// El clon NO copia conversaciones, clientes, pedidos ni nada de la operación real.
//
//   npx tsx scripts/clonar-negocio-de-pruebas.ts                 # clona MAGByLizN
//   ORIGEN="Otro negocio" npx tsx scripts/clonar-negocio-de-pruebas.ts
//
// Volver a correrlo borra el clon anterior y lo rehace con el catálogo de hoy.

const NOMBRE_ORIGEN = process.env.ORIGEN ?? "MAGByLizN";
const CLAVE = process.env.CLAVE ?? "pruebas-onix-2026";
/**
 * Copiar el catalogo DENTRO de un negocio que ya existe, en vez de crear uno nuevo.
 *
 * Es el caso que pidio el dueno: "Boutique Alondra" ya esta creado, ya tiene su telefono de dueno (el
 * suyo) y le vamos a conectar una linea de WhatsApp de prueba. Lo unico que le falta es el catalogo
 * real, para que el bot conteste exactamente como contesta el de la clienta.
 *
 *   DESTINO="Boutique Alondra" npx tsx scripts/clonar-negocio-de-pruebas.ts
 */
const NOMBRE_DESTINO = process.env.DESTINO;

async function main() {
  const origen = await prisma.business.findFirst({
    where: { name: NOMBRE_ORIGEN },
    include: {
      products: { include: { variants: true, media: true } },
      paymentMethods: true,
      shippingRates: true,
      shippingCityRules: true,
      faqEntries: true,
      categoryAliases: true,
    },
  });
  if (!origen) {
    console.error(`No existe ningun negocio llamado "${NOMBRE_ORIGEN}".`);
    process.exit(65);
  }

  const nombreClon = NOMBRE_DESTINO ?? `[PRUEBAS] ${origen.name}`;
  const anterior = await prisma.business.findFirst({ where: { name: nombreClon }, select: { id: true } });
  if (NOMBRE_DESTINO && !anterior) {
    console.error(`No existe ningun negocio llamado "${NOMBRE_DESTINO}". DESTINO es para copiar DENTRO de uno que ya existe.`);
    process.exit(65);
  }
  if (anterior && NOMBRE_DESTINO) {
    // DENTRO de un negocio que ya existe: se le cambia el CATALOGO y la personalidad, y se le respeta
    // todo lo demas -- su linea de WhatsApp, su telefono de dueno y sus conversaciones. Es el caso del
    // negocio de pruebas con linea propia: lo que hace falta es que venda lo mismo, no empezar de cero.
    await prisma.productMedia.deleteMany({ where: { product: { businessId: anterior.id } } });
    await prisma.productVariant.deleteMany({ where: { product: { businessId: anterior.id } } });
    await prisma.product.deleteMany({ where: { businessId: anterior.id } });
    await prisma.paymentMethod.deleteMany({ where: { businessId: anterior.id } });
    await prisma.shippingCityRule.deleteMany({ where: { businessId: anterior.id } });
    await prisma.shippingRate.deleteMany({ where: { businessId: anterior.id } });
    await prisma.faqEntry.deleteMany({ where: { businessId: anterior.id } });
    await prisma.categoryAlias.deleteMany({ where: { businessId: anterior.id } });
    console.log(`(a "${NOMBRE_DESTINO}" se le vacio el catalogo viejo; su linea y sus conversaciones quedan)`);
  } else if (anterior) {
    // El clon se rehace entero: asi el catalogo de prueba nunca queda viejo respecto del real.
    await prisma.message.deleteMany({ where: { conversation: { customer: { businessId: anterior.id } } } });
    await prisma.agentTurn.deleteMany({ where: { businessId: anterior.id } });
    await prisma.agentIncident.deleteMany({ where: { businessId: anterior.id } });
    await prisma.billableChat.deleteMany({ where: { businessId: anterior.id } });
    await prisma.saleState.deleteMany({ where: { conversation: { customer: { businessId: anterior.id } } } });
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customer: { businessId: anterior.id } } } });
    await prisma.deliveryFailure.deleteMany({ where: { businessId: anterior.id } });
    await prisma.ownerMessageLog.deleteMany({ where: { businessId: anterior.id } });
    await prisma.order.deleteMany({ where: { businessId: anterior.id } });
    await prisma.conversation.deleteMany({ where: { customer: { businessId: anterior.id } } });
    await prisma.customer.deleteMany({ where: { businessId: anterior.id } });
    await prisma.business.delete({ where: { id: anterior.id } });
    console.log("(el clon anterior se borro entero)");
  }

  const email = `pruebas+${origen.name.toLowerCase().replace(/[^a-z0-9]/g, "")}@onix.local`;

  const datosDelCatalogo = {
      // Todo lo que hace que el bot conteste igual que en el negocio real.
      customInstructions: origen.customInstructions,
      assistantName: origen.assistantName,
      botTone: origen.botTone,
      botDialect: origen.botDialect,
      botGreeting: origen.botGreeting,
      botNeverSay: origen.botNeverSay,
      description: origen.description,
      businessCategory: origen.businessCategory,
      countryCode: origen.countryCode,
      currency: origen.currency,
      timezone: origen.timezone,
      businessHours: origen.businessHours ?? undefined,
      requiresIdDocument: origen.requiresIdDocument,
      idDocumentExemptZones: origen.idDocumentExemptZones,
      requirePaymentProof: origen.requirePaymentProof,
      autoSendPhotoOnQuote: origen.autoSendPhotoOnQuote,
      offerPhotosBeforeSending: origen.offerPhotosBeforeSending,
      catalogPhotoScope: origen.catalogPhotoScope,
      shippingPaymentModalities: origen.shippingPaymentModalities,
      saleStateEnabled: origen.saleStateEnabled,
      requiredEffectsEnabled: origen.requiredEffectsEnabled,
      ownerReminderMinutes: origen.ownerReminderMinutes,
  };

  const clon =
    anterior && NOMBRE_DESTINO
      ? await prisma.business.update({ where: { id: anterior.id }, data: datosDelCatalogo })
      : await prisma.business.create({
          data: {
            name: nombreClon,
            email,
            passwordHash: await bcrypt.hash(CLAVE, 12),
            active: true,
            // Sin telefono no hay alerta que mandar; con credenciales falsas no hay linea que conteste.
            // Las dos cosas, para que ninguna sola sea el unico seguro.
            contactPhone: null,
            contactName: "Pruebas (sin dueno real)",
            whatsappPhoneNumberId: `pruebas-${randomUUID().slice(0, 8)}`,
            whatsappAccessToken: "token-de-pruebas-que-no-sirve",
            ...datosDelCatalogo,
          },
        });

  for (const producto of origen.products) {
    const creado = await prisma.product.create({
      data: {
        businessId: clon.id,
        name: producto.name,
        description: producto.description,
        price: producto.price,
        currency: producto.currency,
        stock: producto.stock,
        category: producto.category,
        color: producto.color,
        size: producto.size,
        active: producto.active,
      },
    });

    const variantePorId = new Map<string, string>();
    for (const variante of producto.variants) {
      const nueva = await prisma.productVariant.create({
        data: {
          productId: creado.id,
          color: variante.color,
          size: variante.size,
          price: variante.price,
          stock: variante.stock,
          active: variante.active,
        },
      });
      variantePorId.set(variante.id, nueva.id);
    }

    for (const media of producto.media) {
      // La MISMA foto, no una copia: apunta al mismo objeto de S3. Duplicar archivos para probar seria
      // pagar almacenamiento por nada, y el id de WhatsApp no se copia porque es de la otra linea.
      await prisma.productMedia.create({
        data: {
          productId: creado.id,
          variantId: media.variantId ? variantePorId.get(media.variantId) ?? null : null,
          type: media.type,
          url: media.url,
          s3Key: media.s3Key,
        },
      });
    }
  }

  for (const metodo of origen.paymentMethods) {
    await prisma.paymentMethod.create({
      data: {
        businessId: clon.id,
        type: metodo.type,
        label: metodo.label,
        details: metodo.details,
        active: metodo.active,
        settlement: metodo.settlement,
      },
    });
  }

  for (const tarifa of origen.shippingRates) {
    await prisma.shippingRate.create({
      data: {
        businessId: clon.id,
        label: tarifa.label,
        cost: tarifa.cost,
        sortOrder: tarifa.sortOrder,
        paymentModalities: tarifa.paymentModalities,
        cutoffTime: tarifa.cutoffTime,
        sameDayBeforeCutoff: tarifa.sameDayBeforeCutoff,
        deliveryDaysMin: tarifa.deliveryDaysMin,
        deliveryDaysMax: tarifa.deliveryDaysMax,
        noDispatchWeekdays: tarifa.noDispatchWeekdays,
      },
    });
  }

  for (const regla of origen.shippingCityRules) {
    await prisma.shippingCityRule.create({
      data: {
        businessId: clon.id,
        city: regla.city,
        normalizedCity: regla.normalizedCity,
        label: regla.label,
        paymentModalities: regla.paymentModalities,
      },
    });
  }

  for (const faq of origen.faqEntries) {
    await prisma.faqEntry.create({
      data: { businessId: clon.id, question: faq.question, answer: faq.answer, active: faq.active },
    });
  }

  for (const alias of origen.categoryAliases) {
    await prisma.categoryAlias.create({
      data: {
        businessId: clon.id,
        canonical: alias.canonical,
        synonym: alias.synonym,
        normalizedSynonym: alias.normalizedSynonym,
      },
    });
  }

  console.log(`\nNegocio de pruebas listo: ${nombreClon}`);
  console.log(`  id:       ${clon.id}`);
  console.log(`  entrar:   ${NOMBRE_DESTINO ? "con el login que ya tenia" : `${email} / ${CLAVE}`}`);
  console.log(`  copiado:  ${origen.products.length} productos, ${origen.paymentMethods.length} formas de pago, ${origen.shippingRates.length} tarifas, ${origen.shippingCityRules.length} reglas de ciudad, ${origen.faqEntries.length} FAQ`);
  console.log(
    `  alertas:  ${clon.contactPhone ? `van a ${clon.contactPhone}` : "NINGUNA (sin contactPhone: no hay a quien escribirle)"}`,
  );
  console.log(`\nAhora: NEGOCIO="${nombreClon}" npx tsx scripts/simular-cliente.ts "hola"`);
  process.exit(0);
}

void main();
