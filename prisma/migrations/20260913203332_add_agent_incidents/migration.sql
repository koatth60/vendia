-- CreateEnum
CREATE TYPE "AgentIncidentKind" AS ENUM ('LOOP_EXHAUSTED', 'BACKSTOP_INTERVENTION', 'DEGRADED_REPLY');

-- CreateTable
CREATE TABLE "AgentIncident" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" "AgentIncidentKind" NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentIncident_businessId_createdAt_idx" ON "AgentIncident"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentIncident" ADD CONSTRAINT "AgentIncident_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
