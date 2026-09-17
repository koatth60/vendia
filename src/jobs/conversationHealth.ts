import { prisma } from "../db/client";
import { recordAgentIncident } from "../ai/incidents";

// Fase 0 del plan de estabilizacion (2026-09-15). Hasta ahora el unico detector de fallos del bot era
// una persona leyendo conversaciones: los 24 hallazgos de la auditoria de esa noche salieron de revisar
// 361 mensajes a mano, ninguno llego por una alerta. El sistema los venia produciendo en silencio - el
// bot prometio fotos y no las mando dos veces en la misma conversacion sin dejar rastro, y dos ventas
// cerraron sin quedar registradas como pedido.
//
// Este job corre esas mismas comprobaciones solas, cada media hora, sobre lo que acaba de pasar. No
// arregla nada y NO le escribe a nadie: deja constancia (AgentIncident, visible en Bot > Salud).
//
// Le mandaba un WhatsApp al dueno cuando encontraba algo, y eso se saco el 2026-09-17. El mensaje decia
// "El chequeo automatico encontro 2 cosas para revisar: VENTA_SIN_PEDIDO, ESCALACION_PROMETIDA_SIN_HERRAMIENTA"
// - nombres internos del codigo, sin el cliente, sin el producto y sin nada que el dueno pueda hacer al
// leerlo. Le llegaron seis en dos dias. Un aviso que no se puede accionar no es informacion: es ruido, y
// el ruido entrena a ignorar tambien los avisos que si importan.
//
// Lo que si le llega al dueno sigue igual y es todo accionable: una pregunta de un cliente que el bot no
// supo responder, un pedido pagado, y el recordatorio de una conversacion que lo esta esperando. Ese
// ultimo es el que rescata al cliente que quedo colgado, que era la unica consecuencia real que estos
// avisos cubrian.

// Prefijo en AgentIncident.detail: permite separar lo que encontro este chequeo de las intervenciones
// que los backstops registran en vivo, sin tener que migrar el enum de la base.
export const HEALTH_FINDING_PREFIX = "[chequeo]";

// Ventana de revision: mas ancha que el intervalo del job para que un turno que cae justo en el borde no
// se pierda entre dos corridas. Repetir un hallazgo es barato (se deduplica abajo); perderlo no.
const LOOKBACK_MINUTES = 45;
export const HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Guard de agent.ts (detector F1 del diagnostico) que hasta ahora solo dejaba una fila en AgentIncident:
// el bot prometio consultarle algo al dueno y no existe ninguna PendingOwnerQuestion que respalde la
// promesa. Es el mismo tipo de fallo que VENTA_SIN_PEDIDO (el turno afirma un efecto que no ocurrio), asi
// que ahora tambien avisa. Se levanta de la base porque lo registra el turno en vivo, no este chequeo.
const ESCALATION_PROMISE_GUARD = "escalacion_prometida_sin_herramienta";

const SAVED_CLAIM = /\bya tengo (el|tu|la|los|tus)\s+(nombre|c[eé]dula|celular|datos|identificaci[oó]n)/i;
const PHOTO_CLAIM = /\b(te (mand|envi|pas)|ya (te |se la |la |lo )?(mand|envi|pas)\w*|aqu[ií] (te van|te va|van|va)|ah[ií] (te van|te va|van|va))/i;
const PHOTO_WORD = /\b(foto|fotos|imagen|im[aá]genes|video|videos)\b/i;
const NON_PRODUCT_PHOTO = /\b(gu[ií]a|comprobante|recibo|soporte|transferencia|pago)\b/i;
const OFFER = /\b(si (quieres|prefieres|gustas|deseas)|(quieres|quer[ée]s|prefieres|gustar[ií]as?|gustas|deseas)\b.{0,20}\bque\b|te (gustar[ií]a|mando|muestro)\b.{0,20}\?)/i;
const ORDER_SUMMARY = /resumen (de tu|del) pedido|\*?total a pagar|te dejo el resumen/i;
const INTERNAL_STATE_LEAK = /no aparece registrad[oa] en el sistema|no figura en el sistema|\[[a-z_]+:\s/i;

export interface HealthFinding {
  kind: string;
  conversationId: string;
  detail: string;
}

// Exportada como funcion pura sobre datos ya cargados para poder probarla sin base ni red - la misma
// razon por la que findMentionedProductsForMediaBackstop y extractDeliveryDataFromAnswer viven aparte.
export function findHealthIssues(input: {
  conversationId: string;
  messages: { role: string; content: string; mediaType: string | null; createdAt: Date }[];
  since: Date;
  customer: { idNumber: string | null; deliveryPhone: string | null };
  hasOrder: boolean;
}): HealthFinding[] {
  const out: HealthFinding[] = [];
  const { conversationId, messages, since, customer, hasOrder } = input;
  const add = (kind: string, detail: string) => out.push({ kind, conversationId, detail });
  const recent = messages.filter((m) => m.createdAt >= since);

  for (const m of recent) {
    if (m.role !== "ASSISTANT") continue;
    const clean = m.content.replace(/[*_]/g, "");

    // "Ya tengo tu cedula" con el campo vacio en la ficha: el caso que dejo dos pedidos sin datos.
    if (SAVED_CLAIM.test(clean)) {
      const faltan: string[] = [];
      if (/c[eé]dula|identificaci/i.test(clean) && !customer.idNumber) faltan.push("cedula");
      if (/celular/i.test(clean) && !customer.deliveryPhone) faltan.push("celular");
      if (faltan.length > 0) add("DATO_NO_GUARDADO", `dijo tener ${faltan.join(" y ")} pero la ficha sigue vacia`);
    }

    // Nombre de herramienta interna o estado interno del sistema a la vista del cliente.
    if (INTERNAL_STATE_LEAK.test(clean)) {
      add("FUGA_INTERNA", `"${clean.replace(/\n/g, " ").slice(0, 90)}"`);
    }

    if (m.mediaType) continue;

    // Prometio fotos de catalogo y no salio ninguna cerca.
    if (PHOTO_CLAIM.test(clean) && PHOTO_WORD.test(clean) && !NON_PRODUCT_PHOTO.test(clean) && !OFFER.test(clean)) {
      const cerca = messages.some(
        (x) => x.mediaType && x.role === "ASSISTANT" && Math.abs(x.createdAt.getTime() - m.createdAt.getTime()) < 90_000
      );
      if (!cerca) add("FOTO_PROMETIDA_SIN_ENVIAR", `"${clean.replace(/\n/g, " ").slice(0, 90)}"`);
    }
  }

  // Dos respuestas del bot con segundos de diferencia: la firma de dos turnos corriendo en paralelo.
  for (let i = 1; i < messages.length; i++) {
    const a = messages[i - 1];
    const b = messages[i];
    if (a.role !== "ASSISTANT" || b.role !== "ASSISTANT" || a.mediaType || b.mediaType) continue;
    if (b.createdAt < since) continue;
    const gap = b.createdAt.getTime() - a.createdAt.getTime();
    if (gap < 12_000) add("RESPUESTA_DUPLICADA", `dos respuestas con ${Math.round(gap / 1000)}s de diferencia`);
  }

  // Mando el resumen de cierre y no existe pedido: una venta que no quedo en el sistema.
  const resumen = recent.find((m) => m.role === "ASSISTANT" && ORDER_SUMMARY.test(m.content));
  if (resumen && !hasOrder) add("VENTA_SIN_PEDIDO", "mando el resumen de cierre y no hay pedido registrado");

  return out;
}


export async function runConversationHealthJob(): Promise<void> {
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
  // Ya no hace falta que el negocio tenga WhatsApp conectado: este chequeo no le manda nada a nadie, solo
  // deja constancia. Un negocio activo sin conexion tambien puede tener conversaciones que revisar.
  const businesses = await prisma.business.findMany({ where: { active: true }, select: { id: true } });

  for (const business of businesses) {
    const touched = await prisma.message.findMany({
      where: { createdAt: { gte: since }, conversation: { customer: { businessId: business.id } } },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
    if (touched.length === 0) continue;

    const findings: HealthFinding[] = [];
    for (const { conversationId } of touched) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { customer: { select: { idNumber: true, deliveryPhone: true } } },
      });
      if (!conversation) continue;

      const [messages, order] = await Promise.all([
        prisma.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true, mediaType: true, createdAt: true },
        }),
        prisma.order.findFirst({ where: { conversationId }, select: { id: true } }),
      ]);

      findings.push(
        ...findHealthIssues({
          conversationId,
          messages,
          since,
          customer: conversation.customer,
          hasOrder: Boolean(order),
        })
      );
    }

    // Los incidentes que los backstops del turno ya registraron en vivo y que tambien ameritan aviso.
    // Entran por el mismo embudo que el resto (dedupe + AgentIncident + alerta) en vez de tener su propio
    // camino: el id del incidente original va en el detail, asi que la deduplicacion de las ventanas
    // solapadas funciona igual que con los demas hallazgos.
    const promesasSinHerramienta = await prisma.agentIncident.findMany({
      where: { businessId: business.id, createdAt: { gte: since }, guard: ESCALATION_PROMISE_GUARD },
      select: { id: true, conversationId: true },
    });
    for (const incidente of promesasSinHerramienta) {
      if (!incidente.conversationId) continue;
      findings.push({
        kind: "ESCALACION_PROMETIDA_SIN_HERRAMIENTA",
        conversationId: incidente.conversationId,
        detail: `prometio consultar al dueno sin abrir ninguna pregunta real (incidente ${incidente.id})`,
      });
    }

    if (findings.length === 0) continue;

    // No repetir un hallazgo que la corrida anterior ya registro: las ventanas se solapan a proposito.
    const yaRegistrados = await prisma.agentIncident.findMany({
      where: {
        businessId: business.id,
        createdAt: { gte: since },
        detail: { startsWith: HEALTH_FINDING_PREFIX },
      },
      select: { detail: true, conversationId: true },
    });
    const vistos = new Set(yaRegistrados.map((i) => `${i.conversationId}|${i.detail}`));

    for (const f of findings) {
      const detail = `${HEALTH_FINDING_PREFIX} ${f.kind}: ${f.detail}`;
      if (vistos.has(`${f.conversationId}|${detail}`)) continue;
      vistos.add(`${f.conversationId}|${detail}`);
      await recordAgentIncident(business.id, "BACKSTOP_INTERVENTION", detail, f.conversationId);
    }
  }
}
