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

/**
 * Cuanto se estira la ventana para buscar los turnos del agente alrededor de dos mensajes seguidos.
 *
 * Un turno se registra cuando termina, asi que su fila cae DESPUES del primer mensaje que mando. Diez
 * segundos alcanzan para el turno que ya estaba en vuelo y no tanto como para arrastrar al de la
 * pregunta siguiente, que llega cuando la clienta escribe de nuevo.
 */
const TURNO_MARGEN_MS = 10_000;

/**
 * Cuanto se le da a una venta para que el pedido aparezca antes de llamarla "venta sin pedido".
 *
 * Medido contra produccion el 2026-09-18: de 8 incidentes VENTA_SIN_PEDIDO en 7 dias, SEIS eran
 * conversaciones que hoy estan en SOLD y con su pedido creado. El chequeo corria a los pocos minutos
 * del resumen, cuando el pedido todavia no existia, y dejaba la fila para siempre.
 *
 * Media hora es holgada: el cierre normal pasa en el mismo turno o en el siguiente. Lo que queda
 * afuera es el caso que importa -- el resumen que se mando y media hora despues sigue sin pedido.
 */
const GRACIA_PARA_EL_PEDIDO_MS = 30 * 60 * 1000;
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
  /**
   * Cuando corrio cada turno del agente en esta conversacion. Es lo que distingue "el bot contesto dos
   * veces" de "un mensaje largo salio partido en dos": ver RESPUESTA_DUPLICADA abajo.
   *
   * Opcional para no romper a ningun llamador viejo; sin turnos, el chequeo de duplicadas no corre --
   * que es lo correcto: sin el dato no se puede afirmar que hubo dos turnos.
   */
  turnos?: { createdAt: Date }[];
}): HealthFinding[] {
  const out: HealthFinding[] = [];
  const { conversationId, messages, since, customer, hasOrder, turnos } = input;
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

  // DOS RESPUESTAS DEL BOT CON SEGUNDOS DE DIFERENCIA.
  //
  // Medido contra produccion el 2026-09-18 con scripts/e06-clasificar-duplicadas.ts, 7 dias, 141 pares
  // marcados por esta regla:
  //
  //   TROZOS           58  (41%)  un mensaje largo del bot partido por splitLongMessage
  //   BLOQUE_CATALOGO  50  (35%)  la frase del modelo + el bloque que compuso el servidor
  //   OTRO_AUTOR       20  (14%)  ningun AgentTurn: lo escribio la duena desde el panel
  //   DOS_TURNOS       11   (8%)  dos llamadas a generateReply de verdad  <-- el unico defecto
  //   UN_TURNO_OTRO     2   (1%)
  //
  // O sea: el 92% de lo que este chequeo gritaba no era un defecto. Y eso tiene un costo que se pago en
  // la misma semana -- con 49 avisos falsos, nadie mira la lista, y los 5 incidentes reales del bloque de
  // pago (el numero de Nequi que nunca salio, 2026-09-18) pasaron desapercibidos tres dias.
  //
  // El corte ahora es el mismo que usa el clasificador, y es una consulta y no una opinion: DOS filas de
  // AgentTurn en la ventana entre los dos mensajes. Un turno que salio partido tiene una sola fila; lo
  // que escribe la duena no tiene ninguna.
  if (turnos) {
    for (let i = 1; i < messages.length; i++) {
      const a = messages[i - 1];
      const b = messages[i];
      if (a.role !== "ASSISTANT" || b.role !== "ASSISTANT" || a.mediaType || b.mediaType) continue;
      if (b.createdAt < since) continue;
      const gap = b.createdAt.getTime() - a.createdAt.getTime();
      if (gap >= 12_000) continue;

      // El margen hacia atras existe porque el turno se registra al TERMINAR: su fila queda despues del
      // primer mensaje que ya habia mandado. Sin el, un turno legitimo quedaria fuera de la ventana y
      // volveria a contarse como duplicado.
      const desde = a.createdAt.getTime() - TURNO_MARGEN_MS;
      const hasta = b.createdAt.getTime() + TURNO_MARGEN_MS;
      const enLaVentana = turnos.filter((t) => t.createdAt.getTime() >= desde && t.createdAt.getTime() <= hasta);
      if (enLaVentana.length < 2) continue;

      add("RESPUESTA_DUPLICADA", `dos respuestas con ${Math.round(gap / 1000)}s de diferencia, y dos turnos del agente detras`);
    }
  }

  // MANDO EL RESUMEN DE CIERRE Y NO EXISTE PEDIDO: una venta que no quedo en el sistema.
  //
  // Dos correcciones, las dos medidas contra produccion el 2026-09-18 sobre los 8 incidentes de la
  // semana (ver GRACIA_PARA_EL_PEDIDO_MS arriba):
  //
  //   - Seis eran conversaciones ya vendidas: el pedido se creo minutos despues del chequeo. Ahora el
  //     resumen tiene que tener al menos media hora para contar.
  //   - Uno era de un cliente que SI tenia su pedido, abierto en otra conversacion suya. Desde que la
  //     Bandeja agrupa por cliente (2026-09-13), "no hay pedido" se responde mirando al cliente y no a
  //     una sola conversacion.
  //
  // Queda uno de los ocho, que es el defecto de verdad.
  const resumen = recent.find((m) => m.role === "ASSISTANT" && ORDER_SUMMARY.test(m.content));
  const resumenYaMaduro = resumen ? Date.now() - resumen.createdAt.getTime() >= GRACIA_PARA_EL_PEDIDO_MS : false;
  if (resumen && resumenYaMaduro && !hasOrder) {
    add("VENTA_SIN_PEDIDO", "mando el resumen de cierre hace mas de media hora y el cliente no tiene ningun pedido");
  }

  return out;
}


export async function runConversationHealthJob(): Promise<void> {
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
  // Ya no hace falta que el negocio tenga WhatsApp conectado: este chequeo no le manda nada a nadie, solo
  // deja constancia. Un negocio activo sin conexion tambien puede tener conversaciones que revisar.
  const businesses = await prisma.business.findMany({ where: { active: true }, select: { id: true } });

  for (const business of businesses) {
    // E14: un negocio que revienta no puede dejar sin atender a los que siguen. Antes un solo
    // throw abortaba la pasada entera de este job, y como corre por temporizador nadie se entera:
    // los demas negocios simplemente no reciben su salud de las conversaciones y no hay error visible en ningun lado.
    // El continue de adentro sigue funcionando porque el try esta DENTRO del bucle, no afuera.
    try {
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
          select: { customerId: true, customer: { select: { idNumber: true, deliveryPhone: true } } },
        });
        if (!conversation) continue;

        const [messages, order] = await Promise.all([
          prisma.message.findMany({
            where: { conversationId },
            orderBy: { createdAt: "asc" },
            select: { role: true, content: true, mediaType: true, createdAt: true },
          }),
          // Del CLIENTE, no de esta conversacion: desde que la Bandeja agrupa por cliente, un pedido
          // abierto en otro ciclo suyo es igual de real. Uno de los 8 incidentes de la semana era esto.
          prisma.order.findFirst({ where: { customerId: conversation.customerId }, select: { id: true } }),
        ]);

        findings.push(
          ...findHealthIssues({
            conversationId,
            messages,
            since,
            customer: conversation.customer,
            hasOrder: Boolean(order),
            // Los turnos de la ventana, para poder distinguir dos respuestas de un mensaje partido.
            turnos: await prisma.agentTurn.findMany({
              where: { conversationId, createdAt: { gte: new Date(since.getTime() - TURNO_MARGEN_MS) } },
              select: { createdAt: true },
              orderBy: { createdAt: "asc" },
            }),
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
    } catch (error) {
      console.error(`[ZAQI ALERT] conversationHealth: fallo el negocio ${business.id}, sigo con los demas:`, error);
    }
  }
}
