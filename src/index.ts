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

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(sessionMiddleware);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(whatsappRouter);
app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));
app.use("/zaqi-admin/api", platformAdminRouter);
app.use("/zaqi-admin", express.static(path.join(__dirname, "..", "public", "zaqi-admin")));
// Fase 5 (ver ONIX-CRM-REORG-PLAN.md, P12 del diagnostico): el panel interno se llamaba
// /vendia-admin desde antes del rebrand a Zaqi Solutions (2026-09-10). Redirect, no borrado - un
// enlace guardado de alguien del equipo sigue funcionando en vez de romperse de un dia para otro.
app.get("/vendia-admin", (_req, res) => res.redirect(301, "/zaqi-admin"));
// Express 5 (path-to-regexp v7) exige nombrar el wildcard - un "/*" sin nombre revienta el proceso
// entero al arrancar (probado en caliente: "Missing parameter name at index 15").
app.get("/vendia-admin/*rest", (req, res) => res.redirect(301, req.originalUrl.replace("/vendia-admin", "/zaqi-admin")));
app.use(express.static(path.join(__dirname, "..", "public")));

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
