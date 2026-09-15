import express from "express";
import http from "node:http";
import path from "path";
import { env } from "./config/env";
import { sessionMiddleware } from "./auth/sessionMiddleware";
import { setupRealtime } from "./realtime/socket";
import { whatsappRouter } from "./routes/whatsapp";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { platformAdminRouter } from "./routes/platformAdmin";
import { runFollowUpJob } from "./jobs/followUp";
import { runEscalationReminderJob } from "./jobs/escalationReminder";
import { runConversationHealthJob, HEALTH_CHECK_INTERVAL_MS } from "./jobs/conversationHealth";
import { runOutboundQueueJob, OUTBOUND_QUEUE_INTERVAL_MS } from "./jobs/outboundQueue";
import { runTokenExpiryJob, TOKEN_EXPIRY_CHECK_INTERVAL_MS } from "./jobs/tokenExpiry";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(sessionMiddleware);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
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

const FOLLOW_UP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  runFollowUpJob().catch((error) => console.error("Error corriendo el job de seguimiento post-venta:", error));
}, FOLLOW_UP_INTERVAL_MS);

const ESCALATION_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  runEscalationReminderJob().catch((error) => console.error("Error corriendo el job de recordatorio de escalaciones:", error));
}, ESCALATION_REMINDER_INTERVAL_MS);

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
