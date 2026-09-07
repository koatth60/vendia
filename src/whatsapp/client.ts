const GRAPH_BASE_URL = "https://graph.facebook.com/v21.0";

export interface WhatsappCredentials {
  phoneNumberId: string;
  accessToken: string;
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
    to,
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
    to,
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

export async function sendImageMessage(
  credentials: WhatsappCredentials,
  to: string,
  imageUrl: string,
  caption?: string
) {
  return callGraphApi(credentials, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, caption },
  });
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
) {
  return callGraphApi(credentials, {
    messaging_product: "whatsapp",
    to,
    type: "video",
    video: { link: videoUrl, caption },
  });
}
