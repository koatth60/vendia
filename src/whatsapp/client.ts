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

async function callGraphApi(credentials: WhatsappCredentials, body: unknown) {
  const url = `${GRAPH_BASE_URL}/${credentials.phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp API error (${response.status}): ${errorText}`);
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
    image: { link: imageUrl, caption },
  })) as { messages?: { id: string }[] };
  return result.messages?.[0]?.id ?? "";
}

// Owner-facing alerts (escalations, payment confirmations, password resets) need to reach the owner
// even outside the 24h customer-service session window, which plain text can't do - only an
// approved template can. Tries the template first and falls back to plain text if it's not approved
// yet (or doesn't exist for this business's WABA), so behavior degrades gracefully instead of failing
// silently.
export async function sendOwnerAlert(credentials: WhatsappCredentials, to: string, bodyText: string): Promise<string> {
  try {
    return await sendTemplateMessage(credentials, to, "onix_owner_alert", "es", [bodyText]);
  } catch (error) {
    console.error("No se pudo enviar alerta al dueno via plantilla, probando texto libre:", error);
    return sendTextMessage(credentials, to, bodyText);
  }
}

export async function downloadMedia(
  credentials: WhatsappCredentials,
  mediaId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaResponse = await fetch(`${GRAPH_BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${credentials.accessToken}` },
  });
  if (!metaResponse.ok) {
    throw new Error(`WhatsApp API error fetching media metadata (${metaResponse.status}): ${await metaResponse.text()}`);
  }
  const meta = (await metaResponse.json()) as { url: string; mime_type: string };

  const fileResponse = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${credentials.accessToken}` },
  });
  if (!fileResponse.ok) {
    throw new Error(`WhatsApp API error downloading media (${fileResponse.status}): ${await fileResponse.text()}`);
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
    video: { link: videoUrl, caption },
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
