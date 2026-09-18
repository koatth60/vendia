import express from "express";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "path";
import { env } from "./config/env";
import { prisma } from "./db/client";
import { sessionMiddleware } from "./auth/sessionMiddleware";
import { securityHeaders } from "./security/headers";
import { captureRawBody } from "./whatsapp/webhookSignature";
import { setupRealtime } from "./realtime/socket";
import { whatsappRouter, getActiveTurnCount, flushPendingReplyBursts, getPendingReplyBurstCount } from "./routes/whatsapp";
import { createOrderedShutdown } from "./shutdown";
import { adminRouter } from "./routes/admin";
import { adminApiLimiter } from "./auth/rateLimits";
import { saludDelSistema, comoPrometheus } from "./health/estado";
import { avisarSiLaClaveEstaEnTextoPlano } from "./auth/platformPassword";
import { authRouter } from "./routes/auth";
import { platformAdminRouter } from "./routes/platformAdmin";
import { runFollowUpJob } from "./jobs/followUp";
import { runEscalationReminderJob } from "./jobs/escalationReminder";
import { runConversationHealthJob, HEALTH_CHECK_INTERVAL_MS } from "./jobs/conversationHealth";
import { runOutboundQueueJob, OUTBOUND_QUEUE_INTERVAL_MS } from "./jobs/outboundQueue";
import { runTokenExpiryJob, TOKEN_EXPIRY_CHECK_INTERVAL_MS } from "./jobs/tokenExpiry";
import { runAbandonmentJob, ABANDONMENT_CHECK_INTERVAL_MS } from "./jobs/abandonment";
import { runSaleConfirmationChaserJob, SALE_CONFIRMATION_CHASER_INTERVAL_MS } from "./jobs/saleConfirmationChaser";
import { runPendingBurstJob, PENDING_BURST_INTERVAL_MS } from "./jobs/pendingBursts";
import { runInboundEventsJob, INBOUND_EVENTS_INTERVAL_MS } from "./jobs/inboundEvents";
import { runReconciliacionJob, RECONCILIACION_INTERVAL_MS } from "./jobs/reconciliacion";
import { runStartupJobs } from "./jobs/startup";
import { sinSolape } from "./jobs/sinSolape";
import { runBackupJob, BACKUP_CHECK_INTERVAL_MS } from "./jobs/backup";
import { correTrabajos, correWeb } from "./config/rol";
import { conArriendo } from "./jobs/arriendo";

const app = express();
app.set("trust proxy", 1);
// Fase 8, punto 8: va primero, para que cubra tambien las respuestas de error de todo lo que viene
// despues. Ver src/security/headers.ts.
avisarSiLaClaveEstaEnTextoPlano();

app.use(securityHeaders);
// Fase 8, punto 1: el cuerpo crudo de /webhook se captura ANTES del express.json() global, porque una
// vez parseado el JSON los bytes originales se pierden y la firma HMAC de Meta ya no se puede
// verificar (ver src/whatsapp/webhookSignature.ts). Solo esta ruta: todo lo demas sigue entrando por
// express.json() como siempre.
app.use("/webhook", ...captureRawBody());
app.use(express.json());
app.use(sessionMiddleware);

// E24 (2026-09-18): `/health` deja de mentir.
//
// La Fase 7 le habia agregado un `SELECT 1`, que ya era mejor que el {status:"ok"} incondicional de
// antes. Pero seguia respondiendo sano con todos los jobs pisandose, con las credenciales de Meta de un
// negocio vencidas y su bot mudo, con el proveedor de IA en enfriamiento y con la cola de entrada
// acumulando. Un healthcheck que no puede ponerse en rojo no es un healthcheck: es un adorno que ademas
// da falsa tranquilidad. Ver src/health/estado.ts, que es donde viven las preguntas.
//
// 503 SOLO cuando algo esta CAIDO (hoy: la base). "degradado" responde 200 a proposito: el balanceador
// no tiene que sacar de rotacion un proceso que atiende perfectamente aunque un negocio tenga el token
// vencido. La diferencia esta en el cuerpo, que dice QUE esta mal y con nombre.
app.get("/health", async (_req, res) => {
  const salud = await saludDelSistema();
  if (salud.estado === "caido") {
    console.error(`[ZAQI ALERT] Healthcheck CAIDO: ${salud.problemas.join(", ")}`);
    res.status(503).json(salud);
    return;
  }
  res.json(salud);
});

// Formato Prometheus, para que esto se pueda graficar y alertar sin que nadie mire una pantalla.
app.get("/metrics", async (_req, res) => {
  res.type("text/plain; version=0.0.4").send(comoPrometheus(await saludDelSistema()));
});

// Los estáticos no llevan hash en el nombre (admin.css es siempre admin.css), así que
// el navegador no tiene forma de saber que cambiaron. Sin esto, después de cada
// despliegue un usuario puede quedarse con el CSS viejo y el HTML nuevo, que se ve peor
// que cualquiera de las dos versiones. `no-cache` no significa "no guardes": significa
// "guardá, pero preguntá antes de usar". Si nada cambió, el servidor responde 304 vacío.
const staticOptions = {
  setHeaders(res: http.ServerResponse, filePath: string) {
    if (/\.(html|css|js)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache");
    } else {
      // Imágenes, íconos y fuentes: no cambian entre despliegues.
      res.setHeader("Cache-Control", "public, max-age=604800");
    }
  },
};

// EL SERVICE WORKER DE LA APLICACION INSTALADA (2026-09-18).
//
// Se sirve desde una ruta y no como archivo estatico por un motivo: adentro lleva el identificador de
// version del panel, y ese identificador tiene que cambiar SOLO cuando el panel cambia. Si fuera un
// numero escrito a mano, actualizar la aplicacion dependeria de que alguien se acuerde de subirlo en
// cada despliegue - y lo que no se arregla solo, eventualmente no se arregla.
//
// El identificador es el hash del HTML, el CSS y el JS del panel, calculado una vez al arrancar: dos
// reinicios sin cambios dan el mismo, y un despliegue con cambios da uno nuevo. Ese cambio es lo que
// hace que el navegador descargue el worker nuevo y que al dueño le aparezca "Hay una version nueva".
//
// Scope: el archivo se sirve desde la raiz a proposito. Un service worker solo controla lo que cuelga
// de su propia ruta, y la aplicacion abarca /admin/ y tambien /login.html.
const PANEL_FILES = [
  path.join(__dirname, "..", "public", "admin", "index.html"),
  path.join(__dirname, "..", "public", "admin", "css", "admin.css"),
  path.join(__dirname, "..", "public", "admin", "css", "tokens.css"),
  path.join(__dirname, "..", "public", "admin", "js", "admin.js"),
];

const PANEL_BUILD_ID = (() => {
  const hash = createHash("sha1");
  for (const file of PANEL_FILES) {
    try {
      hash.update(readFileSync(file));
    } catch {
      // Un archivo que no esta no puede tumbar el arranque: se ignora y el hash sale de los que si estan.
    }
  }
  return hash.digest("hex").slice(0, 12);
})();

app.get("/sw.js", (_req, res) => {
  try {
    const sw = readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8").replace("__BUILD__", PANEL_BUILD_ID);
    res.type("application/javascript");
    // El worker en si NUNCA se cachea: es el archivo que le avisa al navegador que todo lo demas cambio.
    res.setHeader("Cache-Control", "no-cache");
    res.send(sw);
  } catch {
    res.sendStatus(404);
  }
});

app.use(whatsappRouter);
app.use("/auth", authRouter);
// E29 (2026-09-18): el limitador va ANTES del router, no adentro de cada ruta. Adentro habria que
// acordarse de ponerlo en cada una que se agregue; aca no hay forma de agregar una ruta del panel que
// quede sin limite.
app.use("/admin", adminApiLimiter, adminRouter);
app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin"), staticOptions));
app.use("/zaqi-admin/api", adminApiLimiter, platformAdminRouter);
app.use("/zaqi-admin", express.static(path.join(__dirname, "..", "public", "zaqi-admin"), staticOptions));
// Fase 5 (ver ONIX-CRM-REORG-PLAN.md, P12 del diagnostico): el panel interno se llamaba
// /vendia-admin desde antes del rebrand a Zaqi Solutions (2026-09-10). Redirect, no borrado - un
// enlace guardado de alguien del equipo sigue funcionando en vez de romperse de un dia para otro.
app.get("/vendia-admin", (_req, res) => res.redirect(301, "/zaqi-admin"));
// Express 5 (path-to-regexp v7) exige nombrar el wildcard - un "/*" sin nombre revienta el proceso
// entero al arrancar (probado en caliente: "Missing parameter name at index 15").
app.get("/vendia-admin/*rest", (req, res) => res.redirect(301, req.originalUrl.replace("/vendia-admin", "/zaqi-admin")));
app.use(express.static(path.join(__dirname, "..", "public"), staticOptions));

const server = http.createServer(app);
setupRealtime(server);

// El rol `worker` no escucha en ningun puerto: sin esto, dos procesos sobre el mismo PORT se pelean
// (EADDRINUSE) y pm2 reinicia uno de los dos para siempre.
if (correWeb(env.rol)) {
  server.listen(env.port, () => {
    console.log(`Server listening on port ${env.port} (rol ${env.rol})`);
  });
}

// E23, segunda parte (2026-09-18). TODO EL TRABAJO DE FONDO VIVE EN EL ROL `worker`.
//
// El proceso `web` atiende HTTP, el WebSocket y el webhook de Meta -- que solo ENCOLA (E20). No corre
// ningun job, asi que levantar dos `web` para aguantar mas trafico ya no puede mandarle dos mensajes a
// la misma clienta. Lo que manda hacia afuera corre en `worker`, y lo que impide que dos `worker` se
// pisen ya no es `instances: 1`: es la base (FOR UPDATE SKIP LOCKED + lockedUntil en la cola de
// entrada, el lock consultivo por conversacion de E07, y la guardia de solape de cada job).
//
// Sin ONIX_ROL el proceso hace las dos cosas, que es el comportamiento de siempre.
function arrancarTrabajosDeFondo(): void {
  // setInterval no dispara al arrancar, solo despues del primer intervalo completo, asi que cada reinicio
  // empujaba todo lo pendiente un intervalo entero mas adelante (medido el 2026-09-16: reinicio 16:32 UTC,
  // confirmacion vencida 16:34, primera pasada 17:02). Los siete jobs se apoyan en fechas guardadas en la
  // base para decidir a quien tocar, asi que una pasada de mas no manda nada que no estuviera vencido
  // igual - el razonamiento, job por job, esta en src/jobs/startup.ts.
  runStartupJobs().catch((error) => console.error("Error corriendo los jobs al arranque:", error));


  // E23, primera parte (2026-09-18). Cada job lleva su guardia contra solaparse CONSIGO MISMO.
  //
  // setInterval no espera a que la pasada anterior termine: si una tarda mas que su intervalo, arranca
  // otra encima. El perseguidor de confirmaciones corre cada 60 SEGUNDOS mandando WhatsApps en un bucle
  // secuencial - una pasada lenta se solapaba con la siguiente, las dos encontraban la misma conversacion
  // vencida, y al cliente le llegaban dos mensajes identicos.
  //
  // Esto NO reemplaza el reparto por base con FOR UPDATE SKIP LOCKED (resto de E23, depende de E21): la
  // guardia es por proceso. Lo unico que impide dos procesos sigue siendo `instances: 1`.
  //
  // E23, segunda parte (2026-09-18): y ademas, contra el OTRO proceso. `conArriendo` toma una fila en
  // JobLease antes de correr, asi que dos `worker` no pueden hacer la misma pasada. El arriendo dura
  // mas que una pasada lenta a proposito: si venciera antes, el segundo proceso arrancaria encima del
  // primero y volveria el mensaje duplicado.
  //
  // Quedan SIN arriendo dos jobs, y es a proposito: el consumidor de la cola de entrada y el drenaje de
  // rafagas ya reparten su trabajo fila por fila (FOR UPDATE SKIP LOCKED y `claimedAt`), asi que dos
  // procesos se ayudan en vez de pisarse. Ponerles arriendo los volveria secuenciales sin ganar nada.
  const MINUTO = 60 * 1000;
  const guardiaSeguimientoPostventa = sinSolape(
    "seguimiento post-venta",
    conArriendo("seguimiento post-venta", 10 * MINUTO, runFollowUpJob),
  );
  const guardiaRecordatorioDeEscalaciones = sinSolape(
    "recordatorio de escalaciones",
    conArriendo("recordatorio de escalaciones", 5 * MINUTO, runEscalationReminderJob),
  );
  const guardiaChequeoDeConversaciones = sinSolape(
    "chequeo de conversaciones",
    conArriendo("chequeo de conversaciones", 5 * MINUTO, runConversationHealthJob),
  );
  const guardiaColaDeSalida = sinSolape("cola de salida", conArriendo("cola de salida", 5 * MINUTO, runOutboundQueueJob));
  const guardiaVencimientoDeToken = sinSolape(
    "vencimiento de token",
    conArriendo("vencimiento de token", 5 * MINUTO, runTokenExpiryJob),
  );
  const guardiaRafagasPendientes = sinSolape("rafagas pendientes", runPendingBurstJob);
  const guardiaReconciliacion = sinSolape(
    "reconciliacion de turnos perdidos",
    conArriendo("reconciliacion de turnos perdidos", 5 * MINUTO, async () => {
      await runReconciliacionJob();
    }),
  );
  const guardiaAbandonoDeConversaciones = sinSolape(
    "abandono de conversaciones",
    conArriendo("abandono de conversaciones", 10 * MINUTO, runAbandonmentJob),
  );
  // El volcado de la base es el mas lento de todos: su arriendo dura mucho mas que los demas.
  const guardiaRespaldoDeLaBase = sinSolape(
    "respaldo de la base",
    conArriendo("respaldo de la base", 30 * MINUTO, runBackupJob),
  );
  const guardiaPerseguidorDeVentas = sinSolape(
    "perseguidor de confirmaciones de venta",
    conArriendo("perseguidor de confirmaciones de venta", 5 * MINUTO, runSaleConfirmationChaserJob),
  );

  const FOLLOW_UP_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(() => {
    guardiaSeguimientoPostventa.correr().catch((error) => console.error("Error corriendo el job de seguimiento post-venta:", error));
  }, FOLLOW_UP_INTERVAL_MS);

  const ESCALATION_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
  setInterval(() => {
    guardiaRecordatorioDeEscalaciones.correr().catch((error) => console.error("Error corriendo el job de recordatorio de escalaciones:", error));
  }, ESCALATION_REMINDER_INTERVAL_MS);

  // El perseguidor de confirmaciones de venta tiene reloj propio y mucho mas fino (ver
  // SALE_CONFIRMATION_CHASER_INTERVAL_MS). Con los 30 minutos del job de escalaciones,
  // Business.ownerReminderMinutes no se podia cumplir: el panel deja poner 5 y el piso real era 30.
  setInterval(() => {
    guardiaPerseguidorDeVentas
      .correr()
      .catch((error) => console.error("Error corriendo el perseguidor de confirmaciones de venta:", error));
  }, SALE_CONFIRMATION_CHASER_INTERVAL_MS);

  // Fase 0: el chequeo de conversaciones corre solo. Ver src/jobs/conversationHealth.ts.
  setInterval(() => {
    guardiaChequeoDeConversaciones.correr().catch((error) => console.error("Error corriendo el job de chequeo de conversaciones:", error));
  }, HEALTH_CHECK_INTERVAL_MS);

  // Fase 7: la cola de salida deja de depender de que el cliente escriba. Ver src/jobs/outboundQueue.ts.
  setInterval(() => {
    guardiaColaDeSalida.correr().catch((error) => console.error("Error corriendo el job de cola de salida:", error));
  }, OUTBOUND_QUEUE_INTERVAL_MS);

  // Fase 7: aviso de vencimiento de token de WhatsApp. Ver src/jobs/tokenExpiry.ts.
  setInterval(() => {
    guardiaVencimientoDeToken.correr().catch((error) => console.error("Error corriendo el job de vencimiento de token:", error));
  }, TOKEN_EXPIRY_CHECK_INTERVAL_MS);

  // E08: el reloj de las rafagas de mensajes. Antes era un setTimeout por rafaga dentro del proceso, asi
  // que un reinicio se llevaba la rafaga; ahora las rafagas son filas y este job las drena cuando vencen.
  // Corre cada segundo: la ventana de silencio es de 8 s, asi que esta resolucion no agrega latencia.
  setInterval(() => {
    guardiaRafagasPendientes.correr().catch((error) => console.error("Error corriendo el job de rafagas pendientes:", error));
  }, PENDING_BURST_INTERVAL_MS);

  // E21: el consumidor de la cola de entrada. Corre cada segundo igual que las rafagas, y por el mismo
  // motivo: es latencia que ve la clienta entre que escribe y que el bot empieza a pensar.
  //
  // El webhook ademas lo despierta apenas encola, asi que este intervalo es la RED, no el camino normal:
  // existe para los eventos que quedaron de un reinicio, para los reintentos con espera, y para el dia
  // que el despertar falle. Sin el, un mensaje que fallo una vez esperaria a que escriba otra clienta.
  //
  // runInboundEventsJob ya trae su propio guard de solape adentro (inboundEventsGuard), asi que no se
  // envuelve de nuevo: dos guards sobre la misma tarea contarian las salteadas dos veces.
  setInterval(() => {
    runInboundEventsJob().catch((error) => console.error("Error corriendo el job de la cola de entrada:", error));
  }, INBOUND_EVENTS_INTERVAL_MS);

  // E22: la reconciliacion. La cola de entrada cubre los fallos que VE; esto cubre la ausencia -- la
  // clienta escribio, el mensaje se registro, y la respuesta nunca salio. Hasta hoy eso no lo detectaba
  // nada: el unico numero que existia salio de una consulta escrita a mano para el plan.
  setInterval(() => {
    guardiaReconciliacion.correr().catch((error) => console.error("Error corriendo el job de reconciliacion:", error));
  }, RECONCILIACION_INTERVAL_MS);

  // Fase 9: conversaciones inactivas pasan a ABANDONED y su carrito (si tenia) recibe la plantilla de
  // recuperacion. Ver src/jobs/abandonment.ts.
  setInterval(() => {
    guardiaAbandonoDeConversaciones.correr().catch((error) => console.error("Error corriendo el job de abandono de conversaciones:", error));
  }, ABANDONMENT_CHECK_INTERVAL_MS);

  // Respaldo de la base. Se revisa cada hora y se vuelca si el ultimo tiene mas de 20h - o sea, uno por
  // dia sin depender de que el proceso viva 24h seguidas. Ver src/jobs/backup.ts: hasta el 2026-09-18
  // existia el script del volcado y NO LO LLAMABA NADIE.
  setInterval(() => {
    guardiaRespaldoDeLaBase.correr().catch((error) => console.error("Error corriendo el job de respaldo de la base:", error));
  }, BACKUP_CHECK_INTERVAL_MS);
}

if (correTrabajos(env.rol)) arrancarTrabajosDeFondo();
else console.log(`Rol ${env.rol}: los jobs y el consumidor de la cola de entrada corren en el proceso worker.`);

// Fase 7 del plan maestro (2026-09-15): sin esto, cada `pm2 restart` mataba el proceso a mitad de un
// turno (webhook -> generateReply -> envio) sin ningun registro - y como el webhook ya habia respondido
// 200 antes de procesar nada (ver whatsappRouter.post("/webhook")), Meta nunca reintentaba, asi que ese
// cliente simplemente se quedaba sin respuesta. server.close() deja de aceptar conexiones nuevas; se
// espera a que los turnos ya en vuelo (withConversationLock, ver routes/whatsapp.ts) terminen solos,
// hasta un tope - despues de ese tope se registra explicitamente cuantos quedaron sin terminar en vez de
// matarlos en silencio.
//
// Fase 10, eje 19: extendido para tambien vaciar el buffer de agrupacion de rafaga antes de esperar
// esos turnos (ver src/shutdown.ts) - un mensaje esperando su ventana de ~8s ya esta grabado en la
// base y Meta ya recibio el 200, asi que dejarlo esperando el timer normal y morir antes de que
// dispare lo perdia en silencio. La logica en si vive en shutdown.ts (separada para poder probarla
// sin levantar este servidor de verdad); aca solo se conecta con las dependencias reales.
const shutdown = createOrderedShutdown({
  closeServer: () =>
    server.close((error) => {
      if (error) console.error("Error cerrando el servidor HTTP:", error);
    }),
  getActiveTurnCount,
  flushPendingBursts: flushPendingReplyBursts,
  getPendingBurstCount: getPendingReplyBurstCount,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.log(message),
  logError: (message) => console.error(message),
  exit: (code) => process.exit(code),
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// E23, primera parte (2026-09-18). Hasta hoy NO existia ningun manejador de caida, en ninguna parte.
//
// Que agrega, si Node ya muere solo ante una excepcion no atrapada: muere SIN pasar por el apagado
// ordenado. O sea que los turnos en vuelo - un cliente esperando su respuesta, un mensaje esperando su
// ventana de rafaga - se cortan a la mitad, y como el webhook ya le respondio 200 a Meta, Meta no
// reintenta: ese cliente se queda sin respuesta y no queda registro de por que.
//
// Y con mas negocios importa mas: hoy el proceso es uno solo para TODOS los inquilinos. Una excepcion
// no atrapada por el turno de un negocio se lleva puestos los turnos en vuelo de todos los demas.
//
// Se SALE igual, a proposito. Despues de una excepcion no atrapada el estado del proceso es
// indefinido y seguir andando es peor que reiniciar: pm2 lo levanta. Lo que cambia es que ahora
// primero se drena lo que se pueda y queda un log buscable con la causa, en vez de un corte mudo.
function caidaNoAtrapada(clase: string, error: unknown): void {
  console.error(`[ZAQI ALERT] ${clase}: el proceso se cae. Causa:`, error);
  // El apagado ordenado tiene su propio tope de espera; si se cuelga, el timer de abajo igual sale.
  void shutdown(clase).finally(() => process.exit(1));
  // Red de seguridad: si el drenado quedara colgado, no se puede quedar un proceso zombi aceptando
  // nada. unref() para que este timer no mantenga vivo el proceso si el drenado termina antes.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("uncaughtException", (error) => caidaNoAtrapada("uncaughtException", error));
process.on("unhandledRejection", (motivo) => caidaNoAtrapada("unhandledRejection", motivo));
