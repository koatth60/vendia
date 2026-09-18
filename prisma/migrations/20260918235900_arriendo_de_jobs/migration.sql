-- E23: el arriendo de un job, para que dos procesos worker no hagan el mismo trabajo.
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "holder" TEXT,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);
