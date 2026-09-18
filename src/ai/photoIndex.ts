import { prisma } from "../db/client";
import { deepseek, DEEPSEEK_VISION_MODEL } from "./client";
import { logAiUsage } from "./usage";
import { getPresignedMediaUrl } from "../media/s3";
import { bestVisualMatch, type VisualCandidate, type VisualMatchResult } from "../catalog/visualIndex";

// LA FICHA VISUAL DEL CATALOGO (E12b paso 2, 2026-09-18).
//
// El lado con modelo del emparejamiento por foto: mira cada foto del catalogo UNA vez y guarda lo que ve.
// La comparacion en si es pura y vive en src/catalog/visualIndex.ts.
//
// Por que una sola vez y no en cada consulta: una foto de catalogo no cambia. Indexar los 39 medios de
// un negocio cuesta lo mismo que 39 consultas de clientes, pero se paga una vez y despues cada consulta
// solo compara texto contra texto, sin red y sin modelo.

/**
 * El prompt es deliberadamente PARALELO al que mira la foto del cliente (src/ai/visionPrompt.ts): mismas
 * facetas, mismo orden, mismas palabras. Si los dos lados describieran con vocabularios distintos, la
 * comparacion volveria a ser entre idiomas diferentes, que es el defecto que esta etapa cierra.
 */
export const CATALOG_PHOTO_PROMPT = `Estas mirando la foto de un producto del catalogo de un negocio.

Describila para poder RECONOCERLA despues en una captura de pantalla que mande un cliente. Nombra, en
una sola frase y en este orden:

- que tipo de producto es
- su forma (redondo, cuadrado, rectangular, alargado, etc)
- sus colores
- el material o la correa/empaque que se le vea
- el tamaño aparente (compacto, grande, mediano)
- cualquier texto, marca o modelo legible en la imagen

No inventes lo que no se ve y no uses el nombre comercial del producto: solo lo que se distingue en la
foto. No agregues nada mas que esa frase.`;

/** La ficha visual de una foto, o null si la vision no pudo darla. Nunca lanza: indexar es opcional. */
export async function describeCatalogPhoto(businessId: string, imageUrl: string): Promise<string | null> {
  try {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_VISION_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: CATALOG_PHOTO_PROMPT },
          ],
        },
      ],
      // @ts-expect-error parametro propio de DeepSeek, no esta en los tipos del SDK de OpenAI.
      thinking: { type: "disabled" },
    });
    await logAiUsage({ businessId, kind: "VISION", model: DEEPSEEK_VISION_MODEL, usage: response.usage });
    const text = response.choices[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (error) {
    console.error("No se pudo describir una foto del catalogo (no bloqueante):", error);
    return null;
  }
}

/**
 * Indexa una foto del catalogo. Idempotente y no bloqueante: si falla, la fila queda sin ficha y el
 * emparejamiento simplemente no cuenta con esa foto.
 */
export async function indexProductMedia(mediaId: string): Promise<boolean> {
  try {
    const media = await prisma.productMedia.findUnique({
      where: { id: mediaId },
      select: { id: true, type: true, s3Key: true, product: { select: { businessId: true } } },
    });
    if (!media || media.type !== "IMAGE") return false;

    const url = await getPresignedMediaUrl(media.s3Key);
    const description = await describeCatalogPhoto(media.product.businessId, url);
    if (!description) return false;

    await prisma.productMedia.update({
      where: { id: media.id },
      data: { visionDescription: description, visionDescriptionAt: new Date() },
    });
    return true;
  } catch (error) {
    console.error(`No se pudo indexar la foto ${mediaId} (no bloqueante):`, error);
    return false;
  }
}

/** Las fotos de este negocio que todavia no tienen ficha visual. Lo usa el script de relleno. */
export async function pendingProductMedia(businessId?: string): Promise<{ id: string; productName: string }[]> {
  const rows = await prisma.productMedia.findMany({
    where: {
      type: "IMAGE",
      visionDescription: null,
      ...(businessId ? { product: { businessId } } : {}),
    },
    select: { id: true, product: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.id, productName: r.product.name }));
}

/**
 * Contra que se compara la foto que mando el cliente: las fichas visuales del catalogo ACTIVO de este
 * negocio. Un producto inactivo no puede ser la respuesta a nada.
 */
export async function loadVisualCandidates(businessId: string): Promise<VisualCandidate[]> {
  const rows = await prisma.productMedia.findMany({
    where: { visionDescription: { not: null }, product: { businessId, active: true } },
    select: { productId: true, visionDescription: true, product: { select: { name: true } } },
  });
  return rows.map((r) => ({ productId: r.productId, productName: r.product.name, description: r.visionDescription! }));
}

/**
 * El producto del catalogo que muestra la foto de un cliente, comparando la descripcion que dio la
 * vision contra las fichas visuales guardadas.
 *
 * Devuelve la duda tal cual cuando la hay: quien llama tiene que preguntarle a la dueña en vez de
 * elegir, que es justo lo que fallo el 2026-09-18.
 */
export async function matchCustomerPhoto(businessId: string, visionDescription: string): Promise<VisualMatchResult> {
  const candidatos = await loadVisualCandidates(businessId);
  return bestVisualMatch(visionDescription, candidatos);
}

/**
 * Lo que el servidor le pone al turno despues de comparar la foto contra el catalogo. Es un HECHO, no
 * una instruccion: dice que encontro la comparacion, no que tiene que hacer el modelo con eso. Que hacer
 * con una duda es conversacion, y eso sigue siendo del modelo (y, cuando exista, de la garantia de
 * secuencia de E12).
 *
 * null cuando la comparacion no aporta nada - no hay fichas todavia, o la foto no se parece a nada del
 * catalogo. Ahi el turno queda exactamente como antes de esta etapa.
 */
export function describeMatchForTurn(result: VisualMatchResult): string | null {
  if (result.match) {
    return `[El servidor comparo esta foto contra las fotos del catalogo: corresponde a "${result.match.productName}" (productId: ${result.match.productId}).]`;
  }
  if (result.ambiguous) {
    const nombres = result.candidates.map((c) => `"${c.productName}" (productId: ${c.productId})`).join(" y ");
    return `[El servidor comparo esta foto contra las fotos del catalogo y NO pudo distinguir entre ${nombres}. La comparacion no alcanza para decir cual es.]`;
  }
  return null;
}
