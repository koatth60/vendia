import { prisma } from "../db/client";
import { downloadMediaBytes } from "../media/s3";
import { comprobanteDePago, pngConTexto } from "./imagenDePrueba";

// MEDIOS SIMULADOS: UNA IMAGEN QUE ENTRA SIN PASAR POR META (2026-09-18).
//
// Las conversaciones de prueba ya podían escribir (ver `Customer.simulated` y `esClienteSimulado` en
// outbound.ts), pero no podían MANDAR una foto. Y los dos defectos que más duelen del flujo de fotos
// -- el comprobante de pago y la foto que el cliente manda para identificar un producto -- sólo
// aparecen cuando entra una imagen de verdad.
//
// El problema era que una imagen entrante se baja de Meta por su `media_id`, así que un webhook de
// imagen inventado hacía que el servidor le pidiera a Meta un archivo que no existe.
//
// Acá se corta ese camino, y se corta en un solo punto: `downloadMedia` (src/whatsapp/client.ts). Un
// id que empieza por `sim.` no existe en Meta y lo resuelve el servidor. El resto del recorrido -- el
// webhook, la cola de entrada, la transcripción, la visión, `paymentProof`, el agente -- es el mismo
// código sin una sola rama distinta. Eso es lo que hace que la prueba valga: lo único simulado es de
// dónde salen los bytes.
//
// Dos formas, las dos escritas en el propio id para que no haga falta ningún estado:
//
//   sim.comprobante:<monto>:<metodo>   un comprobante de transferencia legible, generado al vuelo
//   sim.producto:<productId>           la foto real del catálogo de ese producto, tal cual está en S3
//   sim.otro:<renglones|separados>     una captura cualquiera, que no es ni comprobante ni producto
//
// Un id de Meta es siempre numérico, así que ninguno de estos puede chocar con uno real.

const PREFIJO = "sim.";

export function esMedioSimulado(mediaId: string): boolean {
  return mediaId.startsWith(PREFIJO);
}

export async function descargarMedioSimulado(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const [clase, ...resto] = mediaId.slice(PREFIJO.length).split(":");

  if (clase === "comprobante") {
    const [monto = "0", metodo = "NEQUI"] = resto;
    const fecha = new Date().toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" });
    const referencia = `M${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    return { buffer: comprobanteDePago({ monto, metodo, referencia, fecha }), mimeType: "image/png" };
  }

  if (clase === "producto") {
    // Se acepta el id exacto o un pedazo del nombre. El nombre es lo que se puede escribir en un guion
    // sin ir a buscar ids a la base, que es lo que hace que el guion se lea como una conversacion.
    const referencia = resto.join(":").trim();
    const media = await prisma.productMedia.findFirst({
      where: {
        type: "IMAGE",
        product: { OR: [{ id: referencia }, { name: { contains: referencia, mode: "insensitive" } }] },
      },
      select: { s3Key: true, product: { select: { name: true } } },
    });
    if (!media?.s3Key) {
      throw new Error(`Ningun producto que coincida con "${referencia}" tiene foto en el catalogo, no hay medio simulado que mandar.`);
    }
    const { buffer, contentType } = await downloadMediaBytes(media.s3Key);
    return { buffer, mimeType: contentType };
  }

  if (clase === "otro") {
    // Una imagen que no es ni comprobante ni producto: una captura cualquiera, de las que la gente manda
    // por error o para preguntar otra cosa. Sirve para ver que hace el bot con algo que no encaja en
    // ninguna de sus dos categorias.
    const texto = resto.join(":").trim() || "CAPTURA DE PANTALLA";
    return { buffer: pngConTexto(texto.split("|").map((r) => r.trim())), mimeType: "image/png" };
  }

  throw new Error(`Medio simulado desconocido: "${mediaId}". Las formas validas son sim.comprobante:<monto>:<metodo> y sim.producto:<productId>.`);
}

/**
 * True cuando el "dueño" de ese negocio es un número de prueba.
 *
 * Pedido del dueño el 2026-09-18: poder correr el circuito completo -- incluidas las escalaciones, las
 * respuestas del dueño y la toma de control humano -- sin que le lleguen cinco notificaciones al
 * teléfono por cada tanda.
 *
 * Es la MISMA marca que ya usan los clientes (`Customer.simulated`), no un interruptor nuevo: se pone
 * como `contactPhone` del negocio un número que existe como cliente simulado, y los avisos al dueño
 * dejan de salir a Meta igual que las respuestas a esos clientes. El mensaje se registra igual, así que
 * el circuito se puede seguir leyendo entero en la base.
 */
export async function esDuenoSimulado(businessId: string, telefono: string): Promise<boolean> {
  const soloDigitos = telefono.replace(/[^0-9]/g, "");
  if (!soloDigitos) return false;
  const cliente = await prisma.customer.findFirst({
    where: { businessId, phoneNumber: soloDigitos, simulated: true },
    select: { id: true },
  });
  return Boolean(cliente);
}
