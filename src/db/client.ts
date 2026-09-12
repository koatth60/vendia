import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env";

// max defaults to node-postgres's own default of 10 if left unset - too low once several businesses'
// conversations can be in flight at the same time on this one shared process/pool.
const adapter = new PrismaPg({ connectionString: env.databaseUrl, max: 20 });

export const prisma = new PrismaClient({ adapter });
