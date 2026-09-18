import { prisma } from "../db/client";
import { todasLasGuardias } from "../jobs/sinSolape";
import { modelFailoverState, refreshModelFailoverState } from "../ai/modelFailover";
import { MINUTOS_SIN_RESPUESTA } from "../jobs/reconciliacion";

// E24 (2026-09-18). `/health` DEJA DE MENTIR.
//
// Hasta hoy respondia `{status:"ok"}` con un `SELECT 1` y nada mas. O sea que respondia sano mientras:
//   - todos los jobs se pisaban entre si o no corrian,
//   - las credenciales de Meta de un negocio estaban vencidas y su bot mudo,
//   - el proveedor de IA estaba en enfriamiento y todo corria sobre el modelo de respaldo,
//   - la cola de entrada acumulaba mensajes sin procesar.
//
// Un healthcheck que no puede ponerse en rojo no es un healthcheck: es un adorno que ademas da falsa
// tranquilidad, porque alguien lo mira y concluye que el sistema esta bien.
//
// LA REGLA DE ESTE ARCHIVO: cada componente dice su estado Y SU NOMBRE. "degradado" sin decir cual
// obliga a ir a buscar a mano, que es exactamente el trabajo que esta etapa vino a sacar.

export type Estado = "ok" | "degradado" | "caido";

export interface Componente {
  nombre: string;
  estado: Estado;
  /** Una linea, para leer en un log o en una pantalla. Nunca lleva secretos. */
  detalle: string;
  /** Numeros crudos, para /metrics. */
  valores?: Record<string, number>;
}

export interface SaludDelSistema {
  estado: Estado;
  /** Los nombres de lo que NO esta bien. Vacio cuando todo esta bien. */
  problemas: string[];
  componentes: Componente[];
}

/** Cuantos eventos pendientes son demasiados. Con el consumidor corriendo cada segundo, 100 es mucho. */
export const COLA_PROFUNDIDAD_DEGRADADA = 100;

/** Y cuanto tiempo. Un evento pendiente de mas de 5 minutos significa que el consumidor no avanza. */
export const COLA_ANTIGUEDAD_DEGRADADA_MS = 5 * 60 * 1000;

async function base(): Promise<Componente> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { nombre: "base", estado: "ok", detalle: "responde" };
  } catch (error) {
    // Es el unico componente cuyo fallo es "caido" y no "degradado": sin base no hay nada.
    return {
      nombre: "base",
      estado: "caido",
      detalle: `no se puede consultar: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function colaDeEntrada(): Promise<Componente> {
  const [pendientes, masViejo, muertos] = await Promise.all([
    prisma.inboundEvent.count({ where: { processedAt: null, failedAt: null } }),
    prisma.inboundEvent.findFirst({
      where: { processedAt: null, failedAt: null },
      orderBy: { receivedAt: "asc" },
      select: { receivedAt: true },
    }),
    prisma.inboundEvent.count({ where: { failedAt: { not: null } } }),
  ]);

  const antiguedadMs = masViejo ? Date.now() - masViejo.receivedAt.getTime() : 0;
  const valores = { pendientes, antiguedadMs, muertos };

  // La ANTIGUEDAD importa mas que la profundidad, y por eso se mira primero: mil eventos que entraron
  // hace dos segundos es un pico normal; UNO solo esperando diez minutos es el consumidor parado.
  if (antiguedadMs >= COLA_ANTIGUEDAD_DEGRADADA_MS) {
    return {
      nombre: "cola-de-entrada",
      estado: "degradado",
      detalle: `el evento mas viejo lleva ${Math.round(antiguedadMs / 1000)}s sin procesarse (${pendientes} pendientes)`,
      valores,
    };
  }
  if (pendientes >= COLA_PROFUNDIDAD_DEGRADADA) {
    return {
      nombre: "cola-de-entrada",
      estado: "degradado",
      detalle: `${pendientes} eventos pendientes`,
      valores,
    };
  }
  // La carta muerta NO pone el sistema en degradado: son mensajes que ya fallaron y que esperan a una
  // persona. Ponerlo en rojo dejaria el healthcheck rojo para siempre hasta que alguien limpie, y un
  // rojo permanente es un rojo que se deja de mirar. Se reporta el numero.
  return {
    nombre: "cola-de-entrada",
    estado: "ok",
    detalle: `${pendientes} pendientes, ${muertos} en carta muerta`,
    valores,
  };
}

function jobs(): Componente {
  const guardias = todasLasGuardias();
  const salteadas = guardias.reduce((suma, g) => suma + g.salteadas, 0);
  const conSalteos = guardias.filter((g) => g.salteadas > 0);

  if (guardias.length === 0) {
    // Pasa en un proceso que no levanta jobs (una prueba, o el proceso `web` cuando exista `E23`). No
    // es un fallo: es que aca no corren.
    return { nombre: "jobs", estado: "ok", detalle: "no hay jobs en este proceso", valores: { jobs: 0, salteadas: 0 } };
  }
  if (conSalteos.length > 0) {
    return {
      nombre: "jobs",
      estado: "degradado",
      // Se nombran, uno por uno. "hay jobs saltandose pasadas" obligaria a ir a buscar cual.
      detalle: `pasadas salteadas por solape: ${conSalteos.map((g) => `${g.nombre} (${g.salteadas})`).join(", ")}`,
      valores: { jobs: guardias.length, salteadas },
    };
  }
  return {
    nombre: "jobs",
    estado: "ok",
    detalle: `${guardias.length} jobs, ninguno se pisa`,
    valores: { jobs: guardias.length, salteadas: 0 },
  };
}

async function proveedorDeIa(): Promise<Componente> {
  // E23: el breaker vive en una fila, compartida por `web` y `worker`. Sin este refresco, `/health`
  // contestaria con lo que sepa el proceso que atendio la peticion -- y el que corre los turnos es el
  // otro, asi que el `web` diria "ok" con el modelo caido.
  await refreshModelFailoverState();
  const breaker = modelFailoverState();
  if (!breaker.enRespaldo) {
    return { nombre: "proveedor-de-ia", estado: "ok", detalle: `usando ${breaker.modelo}`, valores: { enRespaldo: 0 } };
  }
  return {
    nombre: "proveedor-de-ia",
    estado: "degradado",
    detalle: `el modelo preferido fallo${breaker.desde ? ` a las ${breaker.desde.toISOString()}` : ""}; corriendo sobre ${breaker.modelo}`,
    valores: { enRespaldo: 1 },
  };
}

async function credencialesDeMeta(): Promise<Componente> {
  const ahora = new Date();
  const [rotas, vencidas, sinNumero] = await Promise.all([
    prisma.business.count({ where: { active: true, whatsappConnectionBrokenAt: { not: null } } }),
    prisma.business.count({ where: { active: true, whatsappTokenExpiresAt: { lt: ahora } } }),
    prisma.business.count({ where: { active: true, whatsappPhoneNumberId: null } }),
  ]);

  const valores = { rotas, vencidas, sinNumero };
  if (rotas > 0 || vencidas > 0) {
    // Se cuentan pero NO se nombran los negocios: /health no tiene control de acceso, y decir que
    // "el negocio X esta caido" en una ruta publica es filtrar quien es cliente. El panel, que si tiene
    // control de acceso, es donde va el detalle.
    return {
      nombre: "credenciales-de-meta",
      estado: "degradado",
      detalle: `${rotas} con la conexion rota y ${vencidas} con el token vencido: esos bots estan mudos`,
      valores,
    };
  }
  // sinNumero no es un fallo: es un negocio recien dado de alta que todavia no conecto su WhatsApp.
  return { nombre: "credenciales-de-meta", estado: "ok", detalle: `ninguna rota (${sinNumero} sin conectar todavia)`, valores };
}

async function turnosSinResponder(): Promise<Componente> {
  const corte = new Date(Date.now() - MINUTOS_SIN_RESPUESTA * 60 * 1000);
  // La misma pregunta que hace E22, pero solo contando: si esto sube y la reconciliacion esta corriendo,
  // es que el reencolado no alcanza y hay que mirar por que.
  const [{ sin_responder: sinResponder }] = await prisma.$queryRaw<{ sin_responder: bigint }[]>`
    SELECT count(*) AS sin_responder
    FROM "Conversation" c
    JOIN "Customer" cu ON cu.id = c."customerId"
    JOIN "Business" b ON b.id = cu."businessId"
    JOIN LATERAL (
      SELECT mm.role, mm."createdAt" FROM "Message" mm
      WHERE mm."conversationId" = c.id ORDER BY mm."createdAt" DESC LIMIT 1
    ) m ON true
    WHERE m.role = 'CUSTOMER' AND m."createdAt" <= ${corte} AND c."humanControl" = false AND b.active = true
  `;

  const n = Number(sinResponder);
  return {
    nombre: "turnos-sin-responder",
    // No pone el sistema en degradado por si solo: una clienta que escribio hace 20 minutos con la
    // reconciliacion en camino es normal. El numero es para verlo subir, no para gritar.
    estado: "ok",
    detalle: `${n} conversaciones con la ultima palabra del cliente hace mas de ${MINUTOS_SIN_RESPUESTA} min`,
    valores: { sinResponder: n },
  };
}

/**
 * El estado entero. Cada componente falla solo: si uno tira, no se lleva el resto del reporte -- un
 * healthcheck que revienta cuando algo anda mal es un healthcheck que no sirve justo cuando hace falta.
 */
export async function saludDelSistema(): Promise<SaludDelSistema> {
  const partes = await Promise.all(
    [base, colaDeEntrada, jobs, proveedorDeIa, credencialesDeMeta, turnosSinResponder].map(
      async (f): Promise<Componente> => {
        try {
          return await f();
        } catch (error) {
          return {
            nombre: f.name || "desconocido",
            estado: "degradado",
            detalle: `no se pudo evaluar: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    ),
  );

  const problemas = partes.filter((c) => c.estado !== "ok").map((c) => c.nombre);
  const estado: Estado = partes.some((c) => c.estado === "caido")
    ? "caido"
    : problemas.length > 0
      ? "degradado"
      : "ok";

  return { estado, problemas, componentes: partes };
}

/**
 * Formato Prometheus. Es texto plano y a mano a proposito: traer un cliente de Prometheus para seis
 * metricas seria mas dependencia que codigo.
 */
export function comoPrometheus(salud: SaludDelSistema): string {
  const lineas: string[] = [];
  const estadoNumerico = (e: Estado) => (e === "ok" ? 0 : e === "degradado" ? 1 : 2);

  lineas.push("# HELP onix_estado 0 = ok, 1 = degradado, 2 = caido");
  lineas.push("# TYPE onix_estado gauge");
  lineas.push(`onix_estado ${estadoNumerico(salud.estado)}`);

  lineas.push("# HELP onix_componente_estado Estado por componente. 0 = ok, 1 = degradado, 2 = caido");
  lineas.push("# TYPE onix_componente_estado gauge");
  for (const c of salud.componentes) {
    lineas.push(`onix_componente_estado{componente="${c.nombre}"} ${estadoNumerico(c.estado)}`);
  }

  for (const c of salud.componentes) {
    for (const [clave, valor] of Object.entries(c.valores ?? {})) {
      // El nombre del componente lleva guiones y Prometheus no los admite en un nombre de metrica.
      lineas.push(`onix_${c.nombre.replace(/-/g, "_")}_${clave} ${valor}`);
    }
  }

  return lineas.join("\n") + "\n";
}
