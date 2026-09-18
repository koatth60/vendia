import { Router } from "express";
import { prisma } from "../../db/client";
import {
  listConversationsForBusiness,
  getConversationForBusiness,
  setHumanControl,
  clearAgentRequestFlag,
  clearConversationIntent,
  markConversationOwnerQuestionsResolved,
  recordMessage,
  saveCustomerContactInfo,
  updateConversationStatus,
  getWindowState,
  queueOutboundMessage,
  listQueuedOutbound,
  cancelQueuedOutbound,
} from "../../conversation/service";
import {
  sendToCustomer,
  listApprovedTemplates,
  formatForWhatsapp,
  type WhatsappCredentials,
} from "../../whatsapp/outbound";
import { generateClosingMessage } from "../../ai/agent";
import { extractSaleDetails } from "../../ai/extractSale";
import {
  resolveOrderItems,
  createOrder,
  askForCsat,
  getOrderByConversationId,
  type OrderItemInput,
} from "../../orders/service";
import { uploadMedia } from "../../media/s3";
import { toOggOpus, extractPeaks } from "../../media/voiceNote";
import { getServerSaleEvidence } from "../../orders/saleState";
import {
  getAgreedPrices,
  setAgreedPrices,
  clearAgreedPrice,
  agreedUnitPriceOf,
  validateProposedPrices,
} from "../../orders/agreedPrices";
import { upload, businessIdOf, isUnsupportedImageType, MAX_FILES_PER_MESSAGE } from "./shared";

export const conversationsRouter = Router();

conversationsRouter.get("/api/conversations", async (req, res) => {
  const conversations = await listConversationsForBusiness(businessIdOf(req));
  res.json(conversations);
});

// Grouped-by-customer view of the Conversaciones list (see ONIX-CONVERSATIONS-GROUPING-PLAN.md) - one
// row per customer instead of one per Conversation, so a customer whose last sale already closed
// doesn't reappear as a second, unrelated-looking row the next time they write in. The underlying data
// model is untouched: /api/conversations/:id and everything under it still operate on a single
// Conversation id (the customer row's activeConversationId).

conversationsRouter.get("/api/conversations/:id", async (req, res) => {
  const conversation = await getConversationForBusiness(businessIdOf(req), String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  res.json(conversation);
});

conversationsRouter.put("/api/conversations/:id/handoff", async (req, res) => {
  const active = Boolean(req.body?.active);
  const businessId = businessIdOf(req);
  const conversation = await setHumanControl(businessId, String(req.params.id), active, "PANEL_TOGGLE");
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  if (active) await clearAgentRequestFlag(businessId, String(req.params.id));
  res.json({ id: conversation.id, humanControl: conversation.humanControl });
});

// Lets the owner dismiss an intent badge (PQR/Devolución/No recibido/Pide asesor) from the panel once
// they've resolved it - flag_conversation_intent is the only thing that sets it, and previously nothing
// short of the whole conversation closing ever cleared it.
conversationsRouter.put("/api/conversations/:id/intent", async (req, res) => {
  const conversation = await clearConversationIntent(businessIdOf(req), String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  res.json({ id: conversation.id, intent: conversation.intent });
});

type UploadFolder = "images" | "videos" | "documents" | "audio";

// A que carpeta de S3 va cada archivo. Lo declarado solo elige la carpeta; lo que decide si el
// archivo se acepta y con que tipo se guarda son sus bytes, adentro de uploadMedia (y, para el audio,
// el hecho de que ffmpeg pueda convertirlo).
function folderForUpload(declaredMimetype: string): UploadFolder {
  if (declaredMimetype.startsWith("image/")) return "images";
  if (declaredMimetype.startsWith("video/")) return "videos";
  if (declaredMimetype.startsWith("audio/")) return "audio";
  return "documents";
}

function mediaTypeForFolder(folder: UploadFolder): "IMAGE" | "VIDEO" | "DOCUMENT" | "AUDIO" {
  if (folder === "images") return "IMAGE";
  if (folder === "videos") return "VIDEO";
  if (folder === "audio") return "AUDIO";
  return "DOCUMENT";
}

function placeholderForFolder(folder: UploadFolder, filename: string): string {
  if (folder === "images") return "[Foto]";
  if (folder === "videos") return "[Video]";
  if (folder === "audio") return "[Audio]";
  return `[Documento] ${filename}`;
}

conversationsRouter.post("/api/conversations/:id/messages", upload.array("files", MAX_FILES_PER_MESSAGE), async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  // El panel manda "files" (varios). El singular "file" queda aceptado porque la ruta es publica para
  // cualquier cliente que ya la use, y porque un solo archivo es el caso mas comun.
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  if (!text && files.length === 0) {
    res.status(400).json({ error: "Falta el texto o el archivo" });
    return;
  }
  const gif = files.find((f) => isUnsupportedImageType(f.mimetype));
  if (gif) {
    res.status(400).json({ error: "Formato GIF no soportado todavía - usa JPG, PNG o video." });
    return;
  }

  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.whatsappPhoneNumberId || !business.whatsappAccessToken) {
    res.status(400).json({ error: "Este negocio no tiene WhatsApp conectado" });
    return;
  }

  // Real incident (2026-09-14): a manual message sent 33h after the customer's last message got a real
  // wamid back from WhatsApp (looked sent) and only failed hours later via the async status webhook -
  // the owner had no way to know until she checked "Salud del bot". Checking the window BEFORE the send
  // catches this instead of letting it fail invisibly; see getWindowState for why a wamid is not proof.
  const windowState = await getWindowState(String(req.params.id));
  if (!windowState.windowOpen) {
    // Con `queue: true` el panel no pierde lo que el dueno ya escribio: queda guardado y el webhook lo
    // entrega solo en cuanto el cliente conteste (ver QueuedOutboundMessage). Sin eso, la unica salida
    // era mandar una plantilla generica y acordarse de reescribir el mensaje a mano mas tarde - que es
    // justo lo que no paso en el caso de David (2026-09-14).
    if (String(req.body?.queue ?? "") === "true" && text && files.length === 0) {
      const queued = await queueOutboundMessage(businessId, String(req.params.id), formatForWhatsapp(text), "PANEL");
      await setHumanControl(businessId, String(req.params.id), true, "PANEL_QUEUE");
      await clearAgentRequestFlag(businessId, String(req.params.id));
      res.status(202).json({ ok: true, queued: true, id: queued.id });
      return;
    }
    res.status(409).json({
      error: "Pasaron mas de 24h desde el ultimo mensaje del cliente - WhatsApp ya no entrega mensajes libres. Usa una plantilla aprobada para reabrir la conversacion.",
      windowClosed: true,
    });
    return;
  }

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };

  // Antes esto corria DESPUES del envio: durante esos segundos la conversacion seguia en automatico, y
  // un mensaje del cliente que entrara justo ahi recibia respuesta del bot encima de la del dueno.
  // Tomar el control primero cierra esa ventana; si el envio falla, la conversacion queda en manos del
  // humano, que es el lado seguro del error.
  await setHumanControl(businessId, String(req.params.id), true, "PANEL_MESSAGE");
  await clearAgentRequestFlag(businessId, String(req.params.id));

  const formattedText = formatForWhatsapp(text);
  // Un mensaje de audio no admite pie de foto: la API de Meta no tiene ese campo para `audio` y
  // rechaza el mensaje entero si se manda. Entonces, cuando el primer archivo es un audio, el texto
  // sale antes como su propio mensaje en vez de perderse.
  const textoVaSuelto = formattedText.length > 0 && files.length > 0 && folderForUpload(files[0].mimetype) === "audio";
  if (textoVaSuelto) {
    const suelto = await sendToCustomer({
      businessId,
      conversationId: String(req.params.id),
      credentials,
      to: conversation.customer.phoneNumber,
      content: { kind: "text", text: formattedText },
      onWindowClosed: "fail",
      recordAs: { text: formattedText },
    });
    if (!suelto.delivered) {
      res.status(502).json({ error: suelto.failure?.message ?? "No se pudo enviar el mensaje" });
      return;
    }
  }
  if (files.length > 0) {
    // Uno por uno y en orden: WhatsApp entrega un mensaje por archivo, y mandarlos en paralelo los
    // desordena en el telefono del cliente. El texto viaja como pie del PRIMERO, igual que en WhatsApp:
    // repetirlo en cada archivo seria mandarle el mismo mensaje tres veces.
    let enviados = 0;
    for (const [indice, file] of files.entries()) {
      const folder = folderForUpload(file.mimetype);
      const type = mediaTypeForFolder(folder);
      // El texto es pie del PRIMER archivo, salvo que ese primero sea un audio: ahi ya salio solo.
      const caption = indice === 0 && formattedText && !textoVaSuelto ? formattedText : undefined;
      // El nombre que puso el sistema operativo del que sube. Se usa tal cual para mostrarlo, nunca
      // para decidir el tipo ni para armar la ruta en S3 (la clave la genera uploadMedia con un UUID).
      const filename = String(file.originalname || "archivo").slice(0, 120);
      try {
        // El audio no se guarda ni se manda como llego. WhatsApp muestra la burbuja de nota de voz
        // solo si el archivo es Ogg/Opus, y el navegador no puede grabar eso (graba Opus dentro de
        // WebM, o AAC dentro de MP4). ffmpeg cambia el envoltorio antes de tocar S3, asi que lo que
        // se guarda y lo que se manda son el mismo archivo que el cliente va a escuchar.
        const bytes = folder === "audio" ? await toOggOpus(file.buffer) : file.buffer;
        const declarado = folder === "audio" ? "audio/ogg" : file.mimetype;
        // La onda se calcula una vez, aca, y viaja con el mensaje: el panel no tiene que descargarse el
        // audio de S3 para dibujarla (ver extractPeaks).
        const picos = folder === "audio" ? await extractPeaks(bytes) : null;
        const { key, url } = await uploadMedia(bytes, declarado, folder);
        const media = await sendToCustomer({
          businessId,
          conversationId: String(req.params.id),
          credentials,
          to: conversation.customer.phoneNumber,
          content:
            type === "IMAGE"
              ? { kind: "image", url, caption }
              : type === "VIDEO"
                ? { kind: "video", url, caption }
                : type === "AUDIO"
                  ? { kind: "audio", buffer: bytes, contentType: "audio/ogg" }
                  : { kind: "document", url, filename, caption },
          // La ventana ya se verifico arriba y la ruta decidio que hacer si estaba cerrada (409 o cola). Si
          // se cerro en el medio, se propaga el error como antes en vez de mandar una plantilla que el dueno
          // no pidio.
          onWindowClosed: "fail",
        });
        if (!media.delivered) throw new Error(media.failure?.message ?? "No se pudo enviar el archivo");
        await recordMessage(
          businessId,
          String(req.params.id),
          "ASSISTANT",
          caption || placeholderForFolder(folder, filename),
          media.wamid || undefined,
          { s3Key: key, type, filename: type === "DOCUMENT" ? filename : undefined, peaks: picos }
        );
        enviados += 1;
      } catch (error) {
        // Los anteriores YA salieron y ya estan en el hilo: decir "no se pudo enviar" a secas seria
        // mentir sobre lo que recibio el cliente. El mensaje dice cuantos llegaron y cual fallo.
        const detalle = error instanceof Error ? error.message : String(error);
        res.status(502).json({
          error:
            enviados === 0
              ? `No se pudo enviar "${filename}": ${detalle}`
              : `Se enviaron ${enviados} de ${files.length} archivos. "${filename}" fallo: ${detalle}`,
          sent: enviados,
          total: files.length,
        });
        return;
      }
    }
  } else {
    const sent = await sendToCustomer({
      businessId,
      conversationId: String(req.params.id),
      credentials,
      to: conversation.customer.phoneNumber,
      content: { kind: "text", text: formattedText },
      onWindowClosed: "fail",
      recordAs: { text: formattedText },
    });
    if (!sent.delivered) throw new Error(sent.failure?.message ?? "No se pudo enviar el mensaje");
  }
  // E56: si habia una pregunta escalada esperando y la duena la contesto ESCRIBIENDOLE al cliente
  // desde el panel, ese par pregunta/respuesta entra al ciclo de aprendizaje, igual que cuando
  // contesta por WhatsApp. Antes este camino -- el de mas volumen y mejor contexto -- tiraba el dato.
  // Solo con texto real: un envio que fue puro archivo no responde nada que se pueda guardar.
  await markConversationOwnerQuestionsResolved(
    String(req.params.id),
    formattedText.trim() ? { businessId, answer: formattedText } : undefined
  );

  res.status(201).json({ ok: true });
});

// Deja al dueno sacar de la cola algo que ya no quiere mandar (se arrepintio, o el tema se resolvio por
// telefono) - si no, el mensaje se entregaria solo semanas despues, cuando el cliente vuelva a escribir
// por cualquier otra cosa.
//
// Fase 8, punto 3 (IDOR): esta era la unica de las seis rutas del archivo que usaba req.params.id sin
// pasarlo por getConversationForBusiness. cancelQueuedOutbound ya filtraba por negocio, pero la
// respuesta devolvia listQueuedOutbound(req.params.id) con el id crudo: con la sesion del negocio A y
// el id de una conversacion del negocio B se leia la cola de salida de B. Ahora la conversacion se
// valida primero, igual que en el resto del archivo, y un id ajeno da 404.
conversationsRouter.delete("/api/conversations/:id/queued/:queuedId", async (req, res) => {
  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  const cancelled = await cancelQueuedOutbound(businessId, String(req.params.queuedId));
  if (!cancelled) {
    res.status(404).json({ error: "Ese mensaje en cola ya no existe" });
    return;
  }
  res.json({ ok: true, queuedOutbound: await listQueuedOutbound(businessId, String(req.params.id)) });
});

// The only way to reach a customer once their 24h window has closed (see the check above) - an
// approved template, same mechanism sendOwnerAlert and runFollowUpJob already use. Re-validates the
// template against Meta's own approved list instead of trusting the name/language the client sent, so
// this can't be used to fire an arbitrary/unapproved template through the business's number.
conversationsRouter.post("/api/conversations/:id/send-template", async (req, res) => {
  const templateName = String(req.body?.templateName ?? "").trim();
  const language = String(req.body?.language ?? "").trim();
  if (!templateName || !language) {
    res.status(400).json({ error: "Falta el nombre o el idioma de la plantilla" });
    return;
  }

  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.whatsappPhoneNumberId || !business.whatsappAccessToken) {
    res.status(400).json({ error: "Este negocio no tiene WhatsApp conectado" });
    return;
  }
  if (!business.whatsappBusinessAccountId) {
    res.status(400).json({ error: "Falta configurar el WhatsApp Business Account ID de este negocio" });
    return;
  }

  const approved = await listApprovedTemplates(business.whatsappAccessToken, business.whatsappBusinessAccountId);
  const template = approved.find((t) => t.name === templateName && t.language === language);
  if (!template) {
    res.status(400).json({ error: "Esa plantilla no está aprobada para este negocio" });
    return;
  }

  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };
  const sent = await sendToCustomer({
    businessId,
    conversationId: String(req.params.id),
    credentials,
    to: conversation.customer.phoneNumber,
    content: { kind: "template", name: templateName, language },
  });
  if (!sent.delivered) throw new Error(sent.failure?.message ?? "No se pudo enviar la plantilla");
  // Records the template's real wording, not just its name - the thread should read like a normal
  // message the customer actually saw, same as every other outbound bubble.
  await recordMessage(businessId, String(req.params.id), "ASSISTANT", template.bodyText || `[Plantilla: ${templateName}]`, sent.wamid || undefined);
  await setHumanControl(businessId, String(req.params.id), true, "PANEL_TEMPLATE");
  await clearAgentRequestFlag(businessId, String(req.params.id));
  // Una plantilla no es la respuesta del dueno a nada: cierra la pregunta, pero no se aprende de ella.
  await markConversationOwnerQuestionsResolved(String(req.params.id));

  res.status(201).json({ ok: true });
});

// For sales the owner closes herself (chatting directly with the customer, bypassing the bot entirely) -
// close_conversation only ever runs as an AI tool call, so a manually-closed sale otherwise never creates
// an Order and never shows up in Pedidos. This is the deterministic equivalent for that path: no AI
// involved, so no risk of the model skipping or mishandling it.
// Prefills the close-sale form by reading the conversation with AI - read-only, no side effects. The
// owner still reviews/edits every field and clicks "Confirmar venta" herself before anything is created,
// so a bad extraction just means editing a field, not a wrong order silently going through.
// EL PRECIO ACORDADO (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 12) - EL CAMINO SIN MODELO.
//
// La regla de admision de efectos requeridos exige un fallback que el servidor pueda hacer SOLO, con
// datos de la base. Este es: la duena fija el precio acordado desde el panel, sobre la venta abierta, sin
// pasar por el chat y sin que intervenga el agente ni la interpretacion de ninguna respuesta. Si el
// camino de WhatsApp falla (no cita, escribe raro, no confirma), este existe y no puede fallar por las
// mismas razones, porque no tiene un modelo ni una prosa adentro.
//
// Los productos NO los elige el panel: salen de la venta abierta que el servidor ya tiene anotada
// (SaleState.items, escrito por set_order_item/show_order_summary contra el catalogo real) y se
// revalidan contra el catalogo en cada lectura.
async function openSaleItemsForPanel(businessId: string, conversationId: string) {
  const evidencia = await getServerSaleEvidence(conversationId);
  const { items, needsAttribute } = await resolveOrderItems(
    businessId,
    evidencia.items.map((i) => ({ productId: i.productId, variantId: i.variantId ?? undefined, quantity: i.quantity })),
    conversationId
  );
  // needsAttribute: una linea sin color/talla resuelto no tiene precio propio que fijar. Se devuelve
  // aparte para que el panel lo diga en vez de perderla en silencio (ver resolveOrderItems.arch.test.ts).
  return { items, needsAttribute };
}

conversationsRouter.get("/api/conversations/:id/agreed-prices", async (req, res) => {
  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  const { items, needsAttribute } = await openSaleItemsForPanel(businessId, conversation.id);
  const acordados = await getAgreedPrices(conversation.id);
  const catalogo = await prisma.product.findMany({
    where: { businessId, id: { in: items.map((i) => i.productId) } },
    select: { id: true, price: true, currency: true },
  });
  const precioDeLista = new Map(catalogo.map((p) => [p.id, Number(p.price)]));
  res.json({
    needsAttribute,
    items: items.map((item) => ({
      productId: item.productId,
      variantKey: item.variantId ?? "",
      productName: item.productName,
      variantLabel: item.variantLabel ?? null,
      quantity: item.quantity,
      // El de catalogo va aparte del vigente a proposito: el vigente ya trae el acordado aplicado, y sin
      // el de lista la duena no ve cuanto esta descontando.
      listPrice: precioDeLista.get(item.productId) ?? item.unitPrice,
      agreedPrice: agreedUnitPriceOf(item, acordados),
      currency: item.currency,
    })),
  });
});

conversationsRouter.put("/api/conversations/:id/agreed-prices", async (req, res) => {
  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  const { items } = await openSaleItemsForPanel(businessId, conversation.id);
  const catalogo = await prisma.product.findMany({
    where: { businessId, id: { in: items.map((i) => i.productId) } },
    select: { id: true, price: true },
  });
  const precioDeLista = new Map(catalogo.map((p) => [p.id, Number(p.price)]));

  const enviados: unknown[] = Array.isArray(req.body?.prices) ? req.body.prices : [];
  const aEscribir: { productId: string; variantKey: string; unitPrice: number; currency: string }[] = [];
  const aBorrar: { productId: string; variantKey: string }[] = [];

  for (const raw of enviados) {
    if (!raw || typeof raw !== "object") continue;
    const fila = raw as Record<string, unknown>;
    const productId = String(fila.productId ?? "");
    const variantKey = String(fila.variantKey ?? "");
    const item = items.find((i) => i.productId === productId && (i.variantId ?? "") === variantKey);
    // Un producto que no esta en la venta abierta no se acepta: el panel no abre una puerta que el chat
    // no tiene. Los productos los pone el servidor, tambien por este camino.
    if (!item) {
      res.status(400).json({ error: "Ese producto no está en la venta abierta de esta conversación" });
      return;
    }
    if (fila.unitPrice === null || fila.unitPrice === "" || fila.unitPrice === undefined) {
      aBorrar.push({ productId, variantKey });
      continue;
    }
    const unitPrice = Number(fila.unitPrice);
    // LAS MISMAS validaciones que el camino de WhatsApp, y literalmente la misma funcion: mayor que cero
    // y menor o igual al precio de catalogo. Un solo lugar donde esta escrito que es un precio valido.
    const validacion = validateProposedPrices(
      [
        {
          productId,
          variantKey,
          productName: item.productName,
          variantLabel: item.variantLabel ?? null,
          quantity: item.quantity,
          unitPrice: precioDeLista.get(productId) ?? item.unitPrice,
          currency: item.currency,
        },
      ],
      [unitPrice]
    );
    if (!validacion.ok) {
      res.status(400).json({
        error:
          validacion.reason === "no_positivo"
            ? `El precio de "${item.productName}" tiene que ser mayor que cero`
            : `El precio de "${item.productName}" no puede ser mayor al del catálogo`,
      });
      return;
    }
    aEscribir.push({ productId, variantKey, unitPrice, currency: item.currency });
  }

  if (aEscribir.length > 0) await setAgreedPrices(conversation.id, aEscribir, "ADMIN_PANEL");
  for (const fila of aBorrar) await clearAgreedPrice(conversation.id, fila.productId, fila.variantKey);
  res.json({ ok: true, guardados: aEscribir.length, borrados: aBorrar.length });
});

conversationsRouter.get("/api/conversations/:id/extract-sale-details", async (req, res) => {
  const businessId = businessIdOf(req);
  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }
  try {
    const details = await extractSaleDetails(businessId, String(req.params.id));
    res.json(details);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "No se pudo leer la conversación" });
  }
});

conversationsRouter.post("/api/conversations/:id/close-sale", async (req, res) => {
  const businessId = businessIdOf(req);
  const rawItems: unknown[] = Array.isArray(req.body?.items) ? req.body.items : [];
  const shippingAddress = req.body?.shippingAddress ? String(req.body.shippingAddress).trim() : null;
  const paymentMethodLabel = req.body?.paymentMethodLabel ? String(req.body.paymentMethodLabel).trim() : null;
  const notes = String(req.body?.notes ?? "").trim();
  const shippingCost = req.body?.shippingCost !== undefined && req.body?.shippingCost !== "" ? Number(req.body.shippingCost) : null;
  const idNumber = req.body?.idNumber ? String(req.body.idNumber).trim() : undefined;
  const deliveryPhone = req.body?.deliveryPhone ? String(req.body.deliveryPhone).trim() : undefined;
  const customerMessage = String(req.body?.customerMessage ?? "").trim();

  // El panel manda filas estructuradas {productId, variantId?, quantity} desde el selector de catalogo
  // (Fase de correccion, 2026-09-15) - resuelve por id, no por nombre, asi que no hay puntaje ni empate
  // posible. El string "NxNombre" solo se acepta por compatibilidad de despliegue (un cliente viejo del
  // panel todavia en cache del navegador durante el rollout) y reusa la regex que ya existia aca.
  const parsedItems: OrderItemInput[] = rawItems
    .map((raw): OrderItemInput | null => {
      if (typeof raw === "string") {
        const line = raw.trim();
        if (!line) return null;
        const match = line.match(/^(\d+)\s*x\s*(.+)$/i);
        return match ? { productName: match[2].trim(), quantity: Number(match[1]) } : { productName: line, quantity: 1 };
      }
      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        const productId = typeof obj.productId === "string" && obj.productId ? obj.productId : undefined;
        const variantId = typeof obj.variantId === "string" && obj.variantId ? obj.variantId : undefined;
        const productName = typeof obj.productName === "string" ? obj.productName.trim() : undefined;
        if (!productId && !productName) return null;
        const quantity = Math.max(1, Math.floor(Number(obj.quantity) || 1));
        return { productId, variantId, productName, quantity };
      }
      return null;
    })
    .filter((item): item is OrderItemInput => item !== null);
  if (parsedItems.length === 0) {
    res.status(400).json({ error: "Agrega al menos un producto" });
    return;
  }

  const conversation = await getConversationForBusiness(businessId, String(req.params.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.whatsappPhoneNumberId || !business.whatsappAccessToken) {
    res.status(400).json({ error: "Este negocio no tiene WhatsApp conectado" });
    return;
  }
  const credentials: WhatsappCredentials = {
    phoneNumberId: business.whatsappPhoneNumberId,
    accessToken: business.whatsappAccessToken,
  };

  // EL PRECIO ACORDADO (2026-09-16): el pedido que cierra el panel lleva el precio que la duena autorizo
  // para esta conversacion, no el de lista. Es la misma lectura que usa el resumen del bot.
  const { items, unresolved, needsAttribute } = await resolveOrderItems(businessId, parsedItems, conversation.id);
  // Chequeo separado de `unresolved` a proposito (bug de produccion, 2026-09-15): un producto con
  // variantes sin color/talla elegido caia aca antes, ni entraba a `items` ni a `unresolved`, y la ruta
  // solo miraba esas dos listas - la linea desaparecia del pedido sin ningun error visible.
  if (needsAttribute.length > 0) {
    res.status(400).json({
      error: `Falta elegir color/talla de: ${needsAttribute.join(", ")}`,
    });
    return;
  }
  if (items.length === 0) {
    res.status(400).json({ error: "Ningún producto coincidió con el catálogo - revisa los nombres" });
    return;
  }
  if (unresolved.length > 0) {
    res.status(400).json({
      error: `No pude asociar estos productos con confianza al catálogo, revisa el nombre: ${unresolved.join(", ")}`,
    });
    return;
  }

  if (idNumber || deliveryPhone) {
    await saveCustomerContactInfo(businessId, conversation.customer.id, { idNumber, deliveryPhone });
  }

  if (await getOrderByConversationId(conversation.id)) {
    res.status(400).json({ error: "Esta conversación ya tiene un pedido registrado." });
    return;
  }

  const itemsSummary = items.map((i) => `${i.quantity}x ${i.productName}`).join(", ");
  const summary = notes ? `${itemsSummary} — Nota: ${notes}` : itemsSummary;
  const order = await createOrder({
    businessId,
    customerId: conversation.customer.id,
    conversationId: conversation.id,
    summary,
    items,
    shippingAddress,
    paymentMethodLabel,
    shippingCost,
  });
  await updateConversationStatus(businessId, conversation.id, "SOLD");

  const text =
    formatForWhatsapp(customerMessage) ||
    (await generateClosingMessage(businessId, conversation.id, business, {
      customerName: conversation.customer.name,
      summary: order.summary,
      shippingAddress: order.shippingAddress,
      paymentMethodLabel: order.paymentMethodLabel,
      shippingCost: order.shippingCost != null ? Number(order.shippingCost) : null,
      totalAmount: Number(order.totalAmount),
      currency: order.currency,
      // Fase 4 (2026-09-17): como y cuando se paga, ya resuelto en el pedido. El prompt de cierre pedia
      // "elegi la variante de la plantilla segun la modalidad real" sin pasarle nunca la modalidad.
      shippingModality: order.shippingModality,
      amountOnDelivery: order.amountOnDelivery != null ? Number(order.amountOnDelivery) : null,
    }));
  const sent = await sendToCustomer({
    businessId,
    conversationId: conversation.id,
    credentials,
    to: conversation.customer.phoneNumber,
    content: { kind: "text", text },
    // El dueno acaba de cerrar la venta a mano desde el panel; si la ventana esta cerrada, el mensaje de
    // cierre queda en cola y sale solo cuando el cliente vuelva a escribir, igual que la respuesta del
    // dueno por WhatsApp. No se pierde el texto.
    onWindowClosed: "queue",
    queueOrigin: "PANEL",
    recordAs: { text },
  });
  if (!sent.delivered) {
    console.error("No se pudo entregar el mensaje de cierre de la venta manual:", sent.failure?.message);
  }
  await askForCsat(credentials, order.id, conversation.customer.phoneNumber);
  await markConversationOwnerQuestionsResolved(conversation.id);

  res.json({ ok: true, orderId: order.id });
});
