// Restaurar la base desde un respaldo de S3.
//
// POR QUE EXISTE: un volcado que nunca se restauro no es un respaldo, es un archivo. Hasta el
// 2026-09-18 habia un script que hacia el volcado (y que ademas no llamaba nadie) y NINGUNA forma de
// volver atras. El dia que haga falta no es el dia para escribir esto.
//
//   npm run restore:db                      # lista los respaldos disponibles y sale
//   npm run restore:db -- <nombre-archivo>   # muestra exactamente que va a hacer, y sale
//   npm run restore:db -- <nombre-archivo> --si-estoy-seguro
//
// LA RESTAURACION ES DESTRUCTIVA: pg_restore --clean borra los objetos del esquema antes de recrearlos.
// Por eso hacen falta DOS cosas para que corra: nombrar el archivo Y pasar --si-estoy-seguro. Sin las
// dos, el script solo informa. No hay forma de "restaurar sin querer".
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../src/config/env";

const execFileAsync = promisify(execFile);

function cliente(): S3Client {
  if (!env.aws.region || !env.aws.bucket) {
    throw new Error("Faltan AWS_REGION / AWS_S3_BUCKET: no hay de donde leer los respaldos");
  }
  return new S3Client({
    region: env.aws.region,
    credentials: { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey },
  });
}

async function listar(s3: S3Client): Promise<{ key: string; fecha: Date; mb: string }[]> {
  const respuesta = await s3.send(new ListObjectsV2Command({ Bucket: env.aws.bucket, Prefix: "backups/" }));
  return (respuesta.Contents ?? [])
    .filter((o) => o.Key && o.LastModified)
    .map((o) => ({
      key: o.Key!,
      fecha: o.LastModified!,
      mb: ((o.Size ?? 0) / 1024 / 1024).toFixed(2),
    }))
    .sort((a, b) => b.fecha.getTime() - a.fecha.getTime());
}

async function main() {
  const s3 = cliente();
  const pedido = process.argv[2];
  const confirmado = process.argv.includes("--si-estoy-seguro");

  const disponibles = await listar(s3);
  if (disponibles.length === 0) {
    console.error("No hay ningun respaldo en S3 todavia. Corré `npm run backup:db` primero.");
    process.exit(1);
  }

  if (!pedido) {
    console.log(`Respaldos disponibles (${disponibles.length}), del mas nuevo al mas viejo:\n`);
    for (const b of disponibles.slice(0, 20)) {
      console.log(`  ${b.key.replace("backups/", "")}   ${b.fecha.toISOString()}   ${b.mb} MB`);
    }
    console.log("\nPara restaurar uno:  npm run restore:db -- <nombre-archivo> --si-estoy-seguro");
    return;
  }

  const elegido = disponibles.find((b) => b.key === `backups/${pedido}` || b.key === pedido);
  if (!elegido) {
    console.error(`No encontre "${pedido}" entre los respaldos. Corré \`npm run restore:db\` para ver la lista.`);
    process.exit(1);
  }

  const dbUrl = new URL(env.databaseUrl);
  const destino = `${dbUrl.hostname}:${dbUrl.port || "5432"}${dbUrl.pathname}`;

  if (!confirmado) {
    console.log("Esto es lo que va a pasar, y NO se hizo nada todavia:\n");
    console.log(`  respaldo:  ${elegido.key.replace("backups/", "")}  (${elegido.fecha.toISOString()}, ${elegido.mb} MB)`);
    console.log(`  destino:   ${destino}`);
    console.log("\n  pg_restore --clean --if-exists  ->  BORRA los objetos del esquema public y los recrea");
    console.log("  Todo lo que haya en esa base desde ese respaldo SE PIERDE.\n");
    console.log("Si es lo que queres, repetí el comando agregando --si-estoy-seguro");
    return;
  }

  console.log(`Restaurando ${elegido.key} sobre ${destino} ...`);
  const objeto = await s3.send(new GetObjectCommand({ Bucket: env.aws.bucket, Key: elegido.key }));
  const bytes = await objeto.Body!.transformToByteArray();
  const tmpPath = path.join(os.tmpdir(), path.basename(elegido.key));
  await writeFile(tmpPath, bytes);

  const connectionString = `postgresql://${dbUrl.username}:${dbUrl.password}@${dbUrl.hostname}:${dbUrl.port || "5432"}${dbUrl.pathname}`;
  try {
    // --clean --if-exists: borra lo que exista antes de recrear, sin fallar si no existia.
    // --no-owner: el dueno de los objetos en el volcado puede no existir en la base destino.
    await execFileAsync("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "-n",
      "public",
      "-d",
      connectionString,
      tmpPath,
    ]);
    console.log("Restauracion terminada.");
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("Error restaurando la base:", error);
  process.exit(1);
});
