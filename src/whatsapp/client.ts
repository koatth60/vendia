const GRAPH_BASE_URL = "https://graph.facebook.com/v21.0";
const META_APP_ID = process.env.WHATSAPP_APP_ID ?? "";

export interface WhatsappCredentials {
  phoneNumberId: string;
  accessToken: string;
}

export function isBsuid(id: string): boolean {
  return /^[A-Za-z]{2}\.\d+$/.test(id);
}

// DeepSeek writes bold as **text** (Markdown), but WhatsApp only renders *text* (single asterisk) as
// bold - double asterisks show up literally to the customer. Converts before anything goes out.
export function formatForWhatsapp(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

function recipientField(to: string): { to: string } | { recipient: string } {
  return isBsuid(to) ? { recipient: to } : { to };
}

/**
 * ¿Lo que se va a enviar es un id de medio ya subido a Meta, o una URL para que Meta la descargue?
 *
 * Se distingue por la forma y no por un parametro nuevo a proposito: los dos caminos entran por la misma
 * puerta (sendImageMessage/sendVideoMessage reciben "lo que hay que mandar"), asi que ningun llamador
 * tiene que enterarse de cual es cual ni pasar una bandera de mas. Un id de Meta es una cadena de digitos;
 * una URL nunca lo es.
 */
export function isUploadedMediaId(value: string): boolean {
  return value.length > 0 && value.length < 40 && /^\d+$/.test(value);
}

// Meta answers a failed send with a JSON envelope: { error: { message, type, code, error_subcode,
// error_data: { details } } }. `code` is the only stable, machine-readable part of it - the message
// text is prose Meta rewrites whenever it likes, and every caller that branched on it was really
// branching on a string that could change without notice. GraphApiError carries the parsed code so
// src/whatsapp/outbound.ts can decide (retry / template fallback / give up) on the number instead.
export class GraphApiError extends Error {
  readonly status: number | null;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly details: string | null;
  readonly timedOut: boolean;

  constructor(init: {
    message: string;
    status?: number | null;
    code?: number | null;
    subcode?: number | null;
    details?: string | null;
    timedOut?: boolean;
  }) {
    super(init.message);
    this.name = "GraphApiError";
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.subcode = init.subcode ?? null;
    this.details = init.details ?? null;
    this.timedOut = init.timedOut ?? false;
  }
}

interface MetaErrorEnvelope {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

function graphErrorFromBody(status: number, bodyText: string): GraphApiError {
  let parsed: MetaErrorEnvelope | null = null;
  try {
    parsed = JSON.parse(bodyText) as MetaErrorEnvelope;
  } catch {
    parsed = null;
  }
  const metaError = parsed?.error;
  return new GraphApiError({
    message: `WhatsApp API error (${status})${metaError?.code ? ` [${metaError.code}]` : ""}: ${metaError?.message ?? bodyText}`,
    status,
    code: typeof metaError?.code === "number" ? metaError.code : null,
    subcode: typeof metaError?.error_subcode === "number" ? metaError.error_subcode : null,
    details: metaError?.error_data?.details ?? null,
  });
}

// Sin timeout, un `fetch` a Meta que no responde nunca deja el turno colgado para siempre - y como el
// envio corre dentro del lock por conversacion (src/routes/whatsapp.ts), ese cliente deja de recibir
// cualquier respuesta hasta que se reinicie el proceso. Se corta aca y el error se trata como
// reintentable, que es lo que realmente es.
const GRAPH_TIMEOUT_MS = Number(process.env.WHATSAPP_TIMEOUT_MS ?? "") || 15000;

async function callGraphApi(credentials: WhatsappCredentials, body: unknown) {
  const url = `${GRAPH_BASE_URL}/${credentials.phoneNumberId}/messages`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (error) {
    // Un abort por timeout y una caida de red llegan igual de reintentables; se distingue el timeout
    // solo para poder contarlo aparte en los registros.
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GraphApiError({
      message: timedOut
        ? `WhatsApp API sin respuesta despues de ${GRAPH_TIMEOUT_MS} ms`
        : `WhatsApp API inalcanzable: ${error instanceof Error ? error.message : String(error)}`,
      timedOut,
    });
  }

  if (!response.ok) {
    throw graphErrorFromBody(response.status, await response.text());
  }

  return response.json();
}

export async function sendTextMessage(credentials: WhatsappCredentials, to: string, text: string): Promise<string> {
  const result = (await callGraphApi(credentials, {
    messaging_product: "whatsapp",
    ...recipientField(to),
    type: "text",
    text: { body: text },
  })) as { messages?: { id: string }[] };
  return result.messages?.[0]?.id ?? "";
}

// Fase 10 del plan maestro (2026-09-15), eje 19: mismo endpoint /messages que sendTextMessage,
// distinto body - Meta trata "marcar como leido" y "mostrar el indicador de escribiendo" como una
// sola llamada (el indicador queda prendido hasta 25s o hasta que le mandemos el proximo mensaje
// real, lo que pase primero). Sin esto el cliente no tiene ninguna senal de que el mensaje llego
// mientras el bot agrupa la rafaga y genera la respuesta.
export async function markAsReadWithTypingIndicator(credentials: WhatsappCredentials, messageId: string): Promise<void> {
  await callGraphApi(credentials, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });
}

export async function sendInteractiveButtonsMessage(
  credentials: WhatsappCredentials,
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
): Promise<string> {
  const result = (await callGraphApi(credentials, {
    messaging_product: "whatsapp",
    ...recipientField(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
      },
    },
  })) as { messages?: { id: string }[] };
  return result.messages?.[0]?.id ?? "";
}

// LISTA INTERACTIVA. La eleccion vuelve como `interactive.list_reply.id`, o sea el id del producto tal
// cual lo mando el servidor: elegir de una lista deja de pasar por la prosa del cliente y por el
// resolvedor de texto. Es la unica forma de que "el 5" no pueda volver a resolver a un producto que
// tiene un 5 en el nombre.
//
// Limites de Meta, y no son negociables: 10 filas EN TOTAL (sumando todas las secciones), titulo de fila
// 24 caracteres, descripcion 72, texto del boton 20, titulo de seccion 24. Meta rechaza el mensaje
// entero si alguno se pasa, asi que el recorte va aca y no en el llamador.
export const LIST_MAX_ROWS = 10;
const LIST_ROW_TITLE_MAX = 24;
const LIST_ROW_DESCRIPTION_MAX = 72;
const LIST_BUTTON_MAX = 20;
const LIST_SECTION_TITLE_MAX = 24;

export interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveListSection {
  title: string;
  rows: InteractiveListRow[];
}

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export async function sendInteractiveListMessage(
  credentials: WhatsappCredentials,
  to: string,
  bodyText: string,
  buttonText: string,
  sections: InteractiveListSection[]
): Promise<string> {
  const result = (await callGraphApi(credentials, {
    messaging_product: "whatsapp",
    ...recipientField(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: cut(buttonText, LIST_BUTTON_MAX),
        sections: sections.map((section) => ({
          title: cut(section.title, LIST_SECTION_TITLE_MAX),
          rows: section.rows.map((row) => ({
            id: row.id,
            title: cut(row.title, LIST_ROW_TITLE_MAX),
            ...(row.description ? { description: cut(row.description, LIST_ROW_DESCRIPTION_MAX) } : {}),
          })),
        })),
      },
    },
  })) as { messages?: { id: string }[] };
  return result.messages?.[0]?.id ?? "";
}

export interface ApprovedTemplate {
  name: string;
  language: string;
  bodyText: string;
}

export interface WhatsappTemplate extends ApprovedTemplate {
  status: string;
  category: string;
}

interface TemplateComponent {
  type: string;
  text?: string;
}

async function fetchTemplates(accessToken: string, wabaId: string): Promise<WhatsappTemplate[]> {
  const response = await fetch(
    `${GRAPH_BASE_URL}/${wabaId}/message_templates?fields=name,status,language,category,components&limit=200`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error(`WhatsApp API error listing templates (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    data?: { name: string; status: string; language: string; category: string; components?: TemplateComponent[] }[];
  };
  return (body.data ?? []).map((t) => ({
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    bodyText: t.components?.find((c) => c.type === "BODY")?.text ?? "",
  }));
}

// Used to populate a dropdown of real, usable templates in the admin panel (src/routes/admin.ts) -
// instead of the owner having to type the exact template name/language code from memory, which is
// exactly the kind of thing that goes stale/wrong silently (see the follow-up-template field before
// this existed). Only APPROVED templates are usable for sending regardless of what's shown here.
// Includes the template's actual BODY text (not just its internal name) so an owner who has no idea
// what "seguimiento_post_venta" says can see the real wording before picking it - names alone told
// nobody anything, including us.
export async function listApprovedTemplates(accessToken: string, wabaId: string): Promise<ApprovedTemplate[]> {
  const templates = await fetchTemplates(accessToken, wabaId);
  return templates
    .filter((t) => t.status === "APPROVED")
    .map(({ name, language, bodyText }) => ({ name, language, bodyText }));
}

// Every status (PENDING/APPROVED/REJECTED), for the "gestionar plantillas" screen where the owner
// creates their own and tracks Meta's review - the dropdown above only wants the usable ones, this
// wants everything so a pending/rejected one doesn't just silently vanish from view.
export async function listAllTemplates(accessToken: string, wabaId: string): Promise<WhatsappTemplate[]> {
  return fetchTemplates(accessToken, wabaId);
}

// Meta requires the template name to be lowercase letters/digits/underscores only - normalizes
// whatever the owner typed instead of making them learn that rule (accents stripped, spaces and
// anything else collapsed into underscores).
export function normalizeTemplateName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

// Plain static body only (no {{1}} variables) - keeps template creation from the admin panel simple
// and always valid: a variable requires an "example" value in the submission or Meta rejects it, and
// getting that wrong is exactly the kind of silent failure this whole template effort was built to
// avoid. An owner who wants personalized/dynamic templates can still be built for them directly later.
export async function createTemplate(
  accessToken: string,
  wabaId: string,
  data: { name: string; category: "UTILITY" | "MARKETING"; language: string; bodyText: string }
): Promise<{ id: string; status: string }> {
  const response = await fetch(`${GRAPH_BASE_URL}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: data.name,
      language: data.language,
      category: data.category,
      components: [{ type: "BODY", text: data.bodyText }],
    }),
  });
  if (!response.ok) {
    throw new Error(`WhatsApp API error creating template (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as { id: string; status: string };
}

export async function deleteTemplate(accessToken: string, wabaId: string, name: string): Promise<void> {
  const response = await fetch(
    `${GRAPH_BASE_URL}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error(`WhatsApp API error deleting template (${response.status}): ${await response.text()}`);
  }
}

export async function sendTemplateMessage(
  credentials: WhatsappCredentials,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams?: string[]
): Promise<string> {
  const result = (await callGraphApi(credentials, {
    messaging_product: "whatsapp",
    ...recipientField(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams && bodyParams.length > 0
        ? { components: [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }] }
        : {}),
    },
  })) as { messages?: { id: string }[] };
  return result.messages?.[0]?.id ?? "";
}

// SUBIR EL ARCHIVO A META, en vez de darle un link nuestro para que lo descargue (2026-09-17).
//
// Como funcionaba hasta hoy: se le mandaba a Meta la URL firmada de S3 y Meta iba a buscarla. Cuando esa
// descarga falla, Meta responde 131053 ("Downloading media from weblink failed with http code 500") y la
// foto NUNCA llega - pero el envio ya habia devuelto un wamid, asi que la conversacion sigue como si
// hubiera llegado y el error recien aparece horas despues por el webhook de estados. Tres veces en siete
// dias, todas contra clientes reales.
//
// Subiendo los bytes desaparece la clase entera: el archivo viaja una sola vez, el error (si lo hay) es
// SINCRONO y se puede reintentar o degradar en el acto, y el id que devuelve Meta se puede reusar 30
// dias, asi que la misma foto de catalogo no se vuelve a subir en cada envio.
const MEDIA_UPLOAD_TIMEOUT_MS = Number(process.env.WHATSAPP_MEDIA_TIMEOUT_MS ?? "") || 60000;

/** Un id de medio de Meta vive 30 dias; se renueva bastante antes para no cortarlo justo al limite. */
export const WHATSAPP_MEDIA_TTL_DAYS = 25;

export async function uploadMediaToWhatsapp(
  credentials: WhatsappCredentials,
  buffer: Buffer,
  contentType: string,
  filename = "media"
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", contentType);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);

  const response = await fetch(`${GRAPH_BASE_URL}/${credentials.phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.accessToken}` },
    body: form,
    signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Meta rechazo la subida del medio (${response.status}): ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text) as { id?: string };
  if (!parsed.id) throw new Error(`Meta acepto la subida pero no devolvio id: ${text.slice(0, 200)}`);
  return parsed.id;
}

export async function sendImageMessage(
  credentials: WhatsappCredentials,
  to: string,
  imageUrl: string,
  caption?: string
): Promise<string> {
  const result = (await callGraphApi(credentials, {
    messaging_product: "whatsapp",
    ...recipientField(to),
    type: "image",
    // Un id ya subido a Meta o, si no lo hay, el link de siempre. Los dos caminos conviven: el id es el
    // preferido, el link es el respaldo cuando la subida no se pudo hacer.
    image: isUploadedMediaId(imageUrl) ? { id: imageUrl, caption } : { link: imageUrl, caption },
  })) as { messages?: { id: string }[] };
  return result.messages?.[0]?.id ?? "";
}

// Owner-facing alerts (escalations, payment confirmations, password resets) need to reach the owner
// even outside the 24h customer-service session window, which plain text can't do - only an
// approved template can. Tries the template first and falls back to plain text if it's not approved
// yet (or doesn't exist for this business's WABA), so behavior degrades gracefully instead of failing
// silently.
export async function sendOwnerAlert(credentials: WhatsappCredentials, to: string, bodyText: string): Promise<string> {
  // A template body parameter rejects newlines/tabs and 5+ consecutive spaces (Meta error #132018) -
  // the alert text is built from a customer's own message plus a fixed wrapper, both of which routinely
  // contain line breaks. Collapsing them here means the template send actually succeeds instead of
  // silently falling through to the plain-text fallback below on every multi-line alert (confirmed
  // failing in production logs for days before this fix).
  const templateSafeText = bodyText.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  try {
    return await sendTemplateMessage(credentials, to, "onix_owner_alert", "es", [templateSafeText]);
  } catch (error) {
    console.error("No se pudo enviar alerta al dueno via plantilla, probando texto libre:", error);
    return sendTextMessage(credentials, to, bodyText);
  }
}

// Mismo problema que callGraphApi (ver GRAPH_TIMEOUT_MS arriba), y peor: esto corre DENTRO del lock por
// conversacion (withConversationLock en src/routes/whatsapp.ts) mientras se procesa una imagen, video o
// audio entrante. Sin timeout, un `fetch` colgado a Meta deja esa conversacion muda para siempre - el
// lock nunca se libera y ningun mensaje nuevo de ese cliente se procesa hasta reiniciar el proceso.
async function fetchWithTimeout(url: string, init: RequestInit, errorPrefix: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GraphApiError({
      message: timedOut
        ? `${errorPrefix} sin respuesta despues de ${GRAPH_TIMEOUT_MS} ms`
        : `${errorPrefix} inalcanzable: ${error instanceof Error ? error.message : String(error)}`,
      timedOut,
    });
  }
  return response;
}

export async function downloadMedia(
  credentials: WhatsappCredentials,
  mediaId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaResponse = await fetchWithTimeout(
    `${GRAPH_BASE_URL}/${mediaId}`,
    { headers: { Authorization: `Bearer ${credentials.accessToken}` } },
    "WhatsApp API (metadata de medio)"
  );
  if (!metaResponse.ok) {
    throw graphErrorFromBody(metaResponse.status, await metaResponse.text());
  }
  const meta = (await metaResponse.json()) as { url: string; mime_type: string };

  const fileResponse = await fetchWithTimeout(
    meta.url,
    { headers: { Authorization: `Bearer ${credentials.accessToken}` } },
    "WhatsApp API (descarga de medio)"
  );
  if (!fileResponse.ok) {
    throw graphErrorFromBody(fileResponse.status, await fileResponse.text());
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  return { buffer, mimeType: meta.mime_type };
}

export async function sendVideoMessage(
  credentials: WhatsappCredentials,
  to: string,
  videoUrl: string,
  caption?: string
): Promise<string> {
  const result = (await callGraphApi(credentials, {
    messaging_product: "whatsapp",
    ...recipientField(to),
    type: "video",
    video: isUploadedMediaId(videoUrl) ? { id: videoUrl, caption } : { link: videoUrl, caption },
  })) as { messages?: { id: string }[] };
  return result.messages?.[0]?.id ?? "";
}

// Setting the WhatsApp business profile photo isn't a plain POST - it needs the Resumable Upload API
// (separate from the /media endpoint used to send images) to turn the file into a "handle" first, then
// that handle gets attached to the phone number's business profile. Uses the shared Meta app ID (same
// app for every business's WABA), not a per-business credential.
export async function setBusinessProfilePhoto(
  credentials: WhatsappCredentials,
  buffer: Buffer,
  mimeType: string
): Promise<void> {
  if (!META_APP_ID) {
    throw new Error("WHATSAPP_APP_ID no está configurado en el servidor");
  }

  const sessionResponse = await fetch(
    `${GRAPH_BASE_URL}/${META_APP_ID}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mimeType)}&access_token=${credentials.accessToken}`,
    { method: "POST" }
  );
  if (!sessionResponse.ok) {
    throw new Error(`WhatsApp API error creando sesión de subida (${sessionResponse.status}): ${await sessionResponse.text()}`);
  }
  const session = (await sessionResponse.json()) as { id: string };

  const uploadResponse = await fetch(`${GRAPH_BASE_URL}/${session.id}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${credentials.accessToken}`,
      file_offset: "0",
      "Content-Type": mimeType,
    },
    body: buffer,
  });
  if (!uploadResponse.ok) {
    throw new Error(`WhatsApp API error subiendo el archivo (${uploadResponse.status}): ${await uploadResponse.text()}`);
  }
  const uploaded = (await uploadResponse.json()) as { h: string };

  const profileResponse = await fetch(`${GRAPH_BASE_URL}/${credentials.phoneNumberId}/whatsapp_business_profile`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      profile_picture_handle: uploaded.h,
    }),
  });
  if (!profileResponse.ok) {
    throw new Error(`WhatsApp API error actualizando la foto de perfil (${profileResponse.status}): ${await profileResponse.text()}`);
  }
}
