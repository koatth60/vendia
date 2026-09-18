// Respaldo MANUAL de la base. El automatico es src/jobs/backup.ts, que corre solo cada hora y hace un
// volcado si el ultimo tiene mas de 20 horas.
//
// Los dos comparten la MISMA funcion (hacerRespaldo). Antes este script tenia su propia copia de la
// logica; dos implementaciones del respaldo es la clase de duplicado donde una se arregla y la otra no.
//
//   npm run backup:db
import { hacerRespaldo } from "../src/jobs/backup";

async function main() {
  const { filename, bytes } = await hacerRespaldo();
  console.log(`Backup subido: ${filename} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((error) => {
  console.error("Error corriendo el backup de la base de datos:", error);
  process.exit(1);
});
