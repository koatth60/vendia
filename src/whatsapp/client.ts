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

export async function sendTextMessage(credentials: WhatsappCredentials, to: string, text: string) {
  return callGraphApi(credentials, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
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
