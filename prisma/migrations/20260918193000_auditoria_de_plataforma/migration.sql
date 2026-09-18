-- E29: auditoria de la consola de plataforma. La misma tabla es el registro de lo que paso y el
-- contador del bloqueo por intentos fallidos.
CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorEmail" TEXT,
    "ip" TEXT,
    "businessId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

-- El indice del bloqueo: se consulta por accion + ip + ventana de tiempo, en ese orden.
CREATE INDEX "PlatformAuditLog_action_ip_createdAt_idx" ON "PlatformAuditLog"("action", "ip", "createdAt");
CREATE INDEX "PlatformAuditLog_businessId_createdAt_idx" ON "PlatformAuditLog"("businessId", "createdAt");
