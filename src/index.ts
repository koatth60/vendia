import express from "express";
import http from "node:http";
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
import { runStartupJobs } from "./jobs/startup";

const app = express();
app.set("trust proxy", 1);
// Fase 8, punto 8: va primero, para que cubra tambien las respuestas de error de todo lo que viene
// despues. Ver src/security/headers.ts.
app.use(securityHeaders);
// Fase 8, punto 1: el cuerpo crudo de /webhook se captura ANTES del express.json() global, porque una
// vez parseado el JSON los bytes originales se pierden y la firma HMAC de Meta ya no se puede
// verificar (ver src/whatsapp/webhookSignature.ts). Solo esta ruta: todo lo demas sigue entrando por
// express.json() como siempre.
app.use("/webhook", ...captureRawBody());
app.use(express.json());
app.use(sessionMiddleware);

// Fase 7 del plan maestro (2026-09-15): antes devolvia {status:"ok"} incondicionalmente - no detectaba
// una conexion rota a Postgres, que es justo el tipo de falla que un healthcheck existe para atrapar.
// `SELECT 1` es la consulta mas barata que toca la base de verdad, sin depender de ninguna tabla.
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (error) {
    console.error("Healthcheck fallo: no se pudo consultar la base de datos:", error);
    res.status(503).json({ status: "error", detail: "database unreachable" });
  }
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

app.use(whatsappRouter);
app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin"), staticOptions));
app.use("/zaqi-admin/api", platformAdminRouter);
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

server.listen(env.port, () => {
  console.log(`Server listening on port ${env.port}`);
});

// setInterval no dispara al arrancar, solo despues del primer intervalo completo, asi que cada reinicio
// empujaba todo lo pendiente un intervalo entero mas adelante (medido el 2026-09-16: reinicio 16:32 UTC,
// confirmacion vencida 16:34, primera pasada 17:02). Los siete jobs se apoyan en fechas guardadas en la
// base para decidir a quien tocar, asi que una pasada de mas no manda nada que no estuviera vencido
// igual - el razonamiento, job por job, esta en src/jobs/startup.ts.
runStartupJobs().catch((error) => console.error("Error corriendo los jobs al arranque:", error));

const FOLLOW_UP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  runFollowUpJob().catch((error) => console.error("Error corriendo el job de seguimiento post-venta:", error));
}, FOLLOW_UP_INTERVAL_MS);

const ESCALATION_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  runEscalationReminderJob().catch((error) => console.error("Error corriendo el job de recordatorio de escalaciones:", error));
}, ESCALATION_REMINDER_INTERVAL_MS);

// El perseguidor de confirmaciones de venta tiene reloj propio y mucho mas fino (ver
// SALE_CONFIRMATION_CHASER_INTERVAL_MS). Con los 30 minutos del job de escalaciones,
// Business.ownerReminderMinutes no se podia cumplir: el panel deja poner 5 y el piso real era 30.
setInterval(() => {
  runSaleConfirmationChaserJob().catch((error) =>
    console.error("Error corriendo el perseguidor de confirmaciones de venta:", error)
  );
}, SALE_CONFIRMATION_CHASER_INTERVAL_MS);

// Fase 0: el chequeo de conversaciones corre solo. Ver src/jobs/conversationHealth.ts.
setInterval(() => {
  runConversationHealthJob().catch((error) => console.error("Error corriendo el chequeo de conversaciones:", error));
}, HEALTH_CHECK_INTERVAL_MS);

// Fase 7: la cola de salida deja de depender de que el cliente escriba. Ver src/jobs/outboundQueue.ts.
setInterval(() => {
  runOutboundQueueJob().catch((error) => console.error("Error drenando la cola de salida:", error));
}, OUTBOUND_QUEUE_INTERVAL_MS);

// Fase 7: aviso de vencimiento de token de WhatsApp. Ver src/jobs/tokenExpiry.ts.
setInterval(() => {
  runTokenExpiryJob().catch((error) => console.error("Error corriendo el chequeo de vencimiento de token:", error));
}, TOKEN_EXPIRY_CHECK_INTERVAL_MS);

// E08: el reloj de las rafagas de mensajes. Antes era un setTimeout por rafaga dentro del proceso, asi
// que un reinicio se llevaba la rafaga; ahora las rafagas son filas y este job las drena cuando vencen.
// Corre cada segundo: la ventana de silencio es de 8 s, asi que esta resolucion no agrega latencia.
setInterval(() => {
  runPendingBurstJob().catch((error) => console.error("Error drenando las rafagas pendientes:", error));
}, PENDING_BURST_INTERVAL_MS);

// Fase 9: conversaciones inactivas pasan a ABANDONED y su carrito (si tenia) recibe la plantilla de
// recuperacion. Ver src/jobs/abandonment.ts.
setInterval(() => {
  runAbandonmentJob().catch((error) => console.error("Error corriendo el job de abandono de conversaciones:", error));
}, ABANDONMENT_CHECK_INTERVAL_MS);

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
