import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { env } from "../src/config/env";
import { uploadBackup } from "../src/media/s3";

const execFileAsync = promisify(execFile);

async function main() {
  const dbUrl = new URL(env.databaseUrl);
  // Strip Prisma-specific query params (e.g. ?schema=public) - pg_dump doesn't understand them,
  // schema selection is passed as its own -n flag below instead.
  const connectionString = `postgresql://${dbUrl.username}:${dbUrl.password}@${dbUrl.hostname}:${dbUrl.port || "5432"}${dbUrl.pathname}`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `vendia-db-${timestamp}.dump`;
  const tmpPath = path.join(os.tmpdir(), filename);

  // -F c: pg_dump's own compressed custom format, restorable with pg_restore.
  await execFileAsync("pg_dump", [connectionString, "-n", "public", "-F", "c", "-f", tmpPath]);

  const buffer = await readFile(tmpPath);
  await uploadBackup(buffer, filename);
  await unlink(tmpPath);

  console.log(`Backup subido: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((error) => {
  console.error("Error corriendo el backup de la base de datos:", error);
  process.exit(1);
});
