import { prisma } from "../db/client";

// Chat-style transcript of everything sent to / received from the business owner (alerts, sale
// confirmations, ask_owner escalations, and the owner's replies). This is platform-admin-only data -
// the business owner already sees their side of these messages live in their own WhatsApp app, so
// there's no need (and no endpoint) to expose this to the business's own /admin panel.
export async function recordOwnerMessage(
  businessId: string,
  data: {
    direction: "OUT" | "IN";
    body: string;
    success?: boolean;
    errorMessage?: string | null;
    conversationId?: string | null;
    wamid?: string | null;
  }
) {
  return prisma.ownerMessageLog.create({
    data: {
      businessId,
      direction: data.direction,
      body: data.body,
      success: data.success ?? true,
      errorMessage: data.errorMessage ?? null,
      // `success` solo dice que Meta acepto el envio. Guardar el wamid es lo que le da al acuse de
      // entrega real (webhook de estados de Meta) una fila donde aterrizar: sin el, el acuse llegaba,
      // no matcheaba contra ningun `Message` (los avisos al dueno no son mensajes de una conversacion)
      // y se descartaba. Ver recordMessageDeliveryStatus en conversation/service.ts.
      wamid: data.wamid || null,
      // Opcional a proposito: solo lo pasa quien despues necesita PROBAR por conversacion que el aviso
      // salio (src/ai/requiredEffects.ts). El resto de los avisos siguen igual que siempre.
      conversationId: data.conversationId ?? null,
    },
  });
}

export async function listOwnerMessages(businessId: string, limit = 200) {
  return prisma.ownerMessageLog.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// Wraps a send attempt to the owner and logs the outcome - success or the real error - so a failure
// shows up in the platform admin's conversation view instead of only a pm2 log line. Rethrows so
// existing fallback logic (template -> plain text, buttons -> plain text) at each call site is
// unaffected.
export async function trackOwnerSend<T>(businessId: string, body: string, send: () => Promise<T>): Promise<T> {
  try {
    const result = await send();
    await recordOwnerMessage(businessId, { direction: "OUT", body, success: true });
    return result;
  } catch (error) {
    await recordOwnerMessage(businessId, {
      direction: "OUT",
      body,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
