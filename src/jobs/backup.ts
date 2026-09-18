import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { env } from "../config/env";
import { uploadBackup, latestBackupAt } from "../media/s3";

const execFileAsync = promisify(execFile);

// RESPALDOS DE LA BASE (2026-09-18).
//
// scripts/backupDb.ts existia desde antes y hacia exactamente lo correcto: pg_dump en formato custom,
// subido a S3. NO LO LLAMABA NADIE. Cero referencias en todo el repositorio - ni cron, ni job, ni un
// script de npm. Alguien lo escribio y quedo ahi.
//
// Eso es peor que no tenerlo, porque da la sensacion de que hay respaldos. Todo lo demas del plan hace
// que el sistema falle menos; el respaldo es lo unico que hace que un error NO SEA IRREVERSIBLE. Con
// clientes que pagan, una migracion fallida o un DELETE mal escrito sin respaldo no se arregla con un
// despliegue.
//
// El job vive adentro del proceso y no en un cron del servidor a proposito: asi se despliega con el
// codigo, se prueba con el codigo, y no depende de que alguien se acuerde de configurar la maquina.

export const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Cada cuanto se quiere un respaldo. 20h y no 24h para que no se corra solo un poco cada dia. */
export const HORAS_ENTRE_RESPALDOS = 20;

/**
 * La decision, separada de todo lo que toca el mundo. Es la unica parte con logica: el volcado es
 * pg_dump y la subida es el SDK de S3, y probar esos dos seria probar codigo ajeno.
 *
 * `ultimo` null significa que no hay ningun respaldo todavia, y entonces siempre hay que hacer uno.
 */
export function hayQueRespaldar(ultimo: Date | null, ahora: Date): boolean {
  if (!ultimo) return true;
  return ahora.getTime() - ultimo.getTime() >= HORAS_ENTRE_RESPALDOS * 60 * 60 * 1000;
}

/**
 * Hace el volcado y lo sube. Es la unica implementacion: scripts/backupDb.ts la llama tambien, para que
 * el respaldo manual y el automatico no puedan diferir.
 */
export async function hacerRespaldo(): Promise<{ filename: string; bytes: number }> {
  const dbUrl = new URL(env.databaseUrl);
  // Se sacan los parametros propios de Prisma (?schema=public): pg_dump no los entiende. El esquema va
  // como su propia bandera -n mas abajo.
  const connectionString = `postgresql://${dbUrl.username}:${dbUrl.password}@${dbUrl.hostname}:${dbUrl.port || "5432"}${dbUrl.pathname}`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `vendia-db-${timestamp}.dump`;
  const tmpPath = path.join(os.tmpdir(), filename);

  // -F c: formato custom de pg_dump, comprimido y restaurable con pg_restore. Un .sql plano no permite
  // restaurar una sola tabla.
  await execFileAsync("pg_dump", [connectionString, "-n", "public", "-F", "c", "-f", tmpPath]);

  const buffer = await readFile(tmpPath);
  await uploadBackup(buffer, filename);
  await unlink(tmpPath);
  return { filename, bytes: buffer.length };
}

/**
 * Respalda si hace falta. Decide mirando S3, no un reloj en memoria ni una columna: el respaldo mismo es
 * el registro de que se hizo.
 *
 * Por que importa el guard: este job corre tambien al arrancar (ver startup.ts), y un dia con trece
 * despliegues - paso el 2026-09-17 - haria trece respaldos sin el.
 */
export async function runBackupJob(): Promise<void> {
  if (!env.aws.bucket || !env.aws.region) {
    // Ruidoso a proposito. Un respaldo que no corre tiene que doler al leer los logs, no pasar callado:
    // el dia que haga falta ya es tarde para enterarse.
    console.error("[ZAQI ALERT] No hay respaldo de la base: falta configurar AWS_S3_BUCKET / AWS_REGION");
    return;
  }

  const ultimo = await latestBackupAt();
  if (!hayQueRespaldar(ultimo, new Date())) return;

  const { filename, bytes } = await hacerRespaldo();
  console.log(`Respaldo de la base subido: ${filename} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

// NO se borran los respaldos viejos, y no es un olvido. Decision del dueno (2026-09-18): ningun agente
// borra nada. La retencion es la decision D10 del plan y la toma el; hasta entonces se acumulan, que en
// S3 cuesta centavos y es el lado seguro del error.
