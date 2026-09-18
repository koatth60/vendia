import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdir, readdir, stat, rename } from "node:fs/promises";
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

/**
 * EL RESPALDO TAMBIEN QUEDA EN EL DISCO DEL SERVIDOR (2026-09-18).
 *
 * Medido en produccion ese dia: la llave de AWS del servidor NO tiene permiso sobre el prefijo
 * `backups/` (`AccessDenied` en ListObjectsV2 y en PutObject; quedo afuera cuando se endurecio la
 * politica de IAM). O sea que el job corria cada hora, fallaba, escribia el error en el log y **no
 * habia ningun respaldo**. El unico que existia lo tome a mano.
 *
 * Un respaldo en el mismo disco que la base no reemplaza a uno fuera del servidor -- si se pierde el
 * droplet se pierden los dos. Pero "en el mismo disco" le gana por lejos a "ninguno": cubre el error
 * humano, la migracion fallida y el DELETE mal escrito, que es la mayoria de las veces que un respaldo
 * hace falta. Y sobre todo, deja de ser mentira que hay respaldos.
 */
export const DIRECTORIO_DE_RESPALDOS = path.join(process.cwd(), "backups");

/** Cuando se hizo el ultimo respaldo LOCAL, o null si no hay ninguno. */
export async function ultimoRespaldoLocal(): Promise<Date | null> {
  try {
    const archivos = await readdir(DIRECTORIO_DE_RESPALDOS);
    const dumps = archivos.filter((nombre) => nombre.endsWith(".dump"));
    if (dumps.length === 0) return null;
    const fechas = await Promise.all(
      dumps.map(async (nombre) => (await stat(path.join(DIRECTORIO_DE_RESPALDOS, nombre))).mtime),
    );
    return fechas.reduce((masReciente, fecha) => (fecha > masReciente ? fecha : masReciente));
  } catch {
    // El directorio todavia no existe: es lo mismo que no tener ningun respaldo.
    return null;
  }
}

/**
 * El ultimo respaldo que existe, este donde este. S3 manda cuando se lo puede leer; si no se puede -- hoy
 * en produccion no se puede -- vale el del disco.
 *
 * Nunca tira: es la funcion que usa `/health`, y un chequeo de salud que revienta es peor que uno que
 * dice "no se".
 */
export async function ultimoRespaldo(): Promise<{ cuando: Date | null; enS3: boolean }> {
  const local = await ultimoRespaldoLocal();
  try {
    const enS3 = await latestBackupAt();
    if (enS3 && (!local || enS3 > local)) return { cuando: enS3, enS3: true };
  } catch {
    // Sin permiso, o sin red. El respaldo local sigue contando.
  }
  return { cuando: local, enS3: false };
}

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
export async function hacerRespaldo(): Promise<{ filename: string; bytes: number; enS3: boolean }> {
  const dbUrl = new URL(env.databaseUrl);
  // Se sacan los parametros propios de Prisma (?schema=public): pg_dump no los entiende. El esquema va
  // como su propia bandera -n mas abajo.
  const connectionString = `postgresql://${dbUrl.username}:${dbUrl.password}@${dbUrl.hostname}:${dbUrl.port || "5432"}${dbUrl.pathname}`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `vendia-db-${timestamp}.dump`;
  const tmpPath = path.join(os.tmpdir(), filename);
  const destinoLocal = path.join(DIRECTORIO_DE_RESPALDOS, filename);

  // -F c: formato custom de pg_dump, comprimido y restaurable con pg_restore. Un .sql plano no permite
  // restaurar una sola tabla.
  await execFileAsync("pg_dump", [connectionString, "-n", "public", "-F", "c", "-f", tmpPath]);

  const buffer = await readFile(tmpPath);

  // EL ORDEN IMPORTA: primero al disco, despues a S3. Al reves, un fallo de S3 se llevaba el volcado
  // entero (era lo que pasaba en produccion: el `unlink` del temporal corria igual y no quedaba nada).
  await mkdir(DIRECTORIO_DE_RESPALDOS, { recursive: true });
  await rename(tmpPath, destinoLocal).catch(async () => {
    // `rename` falla entre sistemas de archivos distintos (/tmp y /opt suelen serlo). Copiar y borrar.
    await import("node:fs/promises").then((fs) => fs.writeFile(destinoLocal, buffer));
    await unlink(tmpPath).catch(() => undefined);
  });

  let enS3 = false;
  try {
    await uploadBackup(buffer, filename);
    enS3 = true;
  } catch (error) {
    // Ruidoso y con el motivo, porque esto es exactamente lo que estuvo fallando callado: la llave de
    // AWS no tiene permiso sobre `backups/`. El respaldo local ya esta hecho, asi que no se pierde nada
    // -- lo que falta es la copia FUERA del servidor, y eso se arregla en la consola de AWS.
    console.error(
      `[ZAQI ALERT] El respaldo quedo solo en el disco del servidor (${destinoLocal}): no se pudo subir a S3.`,
      error instanceof Error ? error.message : error,
    );
  }

  return { filename, bytes: buffer.length, enS3 };
}

/**
 * Respalda si hace falta. Decide mirando S3, no un reloj en memoria ni una columna: el respaldo mismo es
 * el registro de que se hizo.
 *
 * Por que importa el guard: este job corre tambien al arrancar (ver startup.ts), y un dia con trece
 * despliegues - paso el 2026-09-17 - haria trece respaldos sin el.
 */
export async function runBackupJob(): Promise<void> {
  // Sin S3 configurado el respaldo se hace IGUAL, al disco. Antes esto era un `return`: un negocio sin
  // bucket no tenia ningun respaldo y el log lo decia una vez por hora, que es lo mismo que nada.
  if (!env.aws.bucket || !env.aws.region) {
    console.error("[ZAQI ALERT] Sin AWS_S3_BUCKET / AWS_REGION: el respaldo queda solo en el disco del servidor.");
  }

  const { cuando } = await ultimoRespaldo();
  if (!hayQueRespaldar(cuando, new Date())) return;

  const { filename, bytes, enS3 } = await hacerRespaldo();
  console.log(
    `Respaldo de la base: ${filename} (${(bytes / 1024 / 1024).toFixed(2)} MB) ${enS3 ? "en S3 y en disco" : "SOLO en disco"}`,
  );
}

// NO se borran los respaldos viejos, y no es un olvido. Decision del dueno (2026-09-18): ningun agente
// borra nada. La retencion es la decision D10 del plan y la toma el; hasta entonces se acumulan, que en
// S3 cuesta centavos y es el lado seguro del error.
