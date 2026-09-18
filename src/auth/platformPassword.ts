import { createHash, timingSafeEqual } from "node:crypto";
import { verifyPassword } from "./service";
import { env } from "../config/env";

// E29 (2026-09-18). LA CONTRASENA DE LA CONSOLA DE PLATAFORMA.
//
// Hasta hoy `platformAdmin.ts` hacia `password !== env.platformAdmin.password`: texto plano en el
// entorno, y una comparacion de strings que corta en el primer caracter distinto.
//
// POR QUE HAY DOS CAMINOS Y NO UNO. Cambiar el nombre de la variable de entorno y listo dejaria al
// dueno afuera de su propia consola en el despliegue siguiente, antes de que pueda generar el hash. Y
// una plataforma donde el administrador no puede entrar no es mas segura, es una plataforma caida.
//
// Asi que:
//   PLATFORM_ADMIN_PASSWORD_HASH  -> si esta, es la unica que se usa. La de texto plano se ignora.
//   PLATFORM_ADMIN_PASSWORD       -> si es la unica, sigue funcionando, con un [ZAQI ALERT] por arranque.
//
// La migracion es un paso de operaciones que hace el dueno cuando quiere (`npm run hash:password`), no
// un despliegue que lo deja afuera. Lo que SI se cerro hoy, en los dos caminos, es la comparacion: ni
// uno ni otro compara strings con `!==`.

let avisado = false;

/** Comparacion de tiempo constante sobre digests, para que dos largos distintos no delaten el largo. */
function igualEnTiempoConstante(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** true si la consola tiene alguna credencial configurada. Sin esto, el login siempre falla. */
export function hayCredencialDePlataforma(): boolean {
  return Boolean(env.platformAdmin.email && (env.platformAdmin.passwordHash || env.platformAdmin.password));
}

export async function verificarCredencialDePlataforma(email: unknown, password: unknown): Promise<boolean> {
  if (typeof email !== "string" || typeof password !== "string") return false;
  if (!hayCredencialDePlataforma()) return false;

  // El correo NO es secreto, pero se compara igual en tiempo constante: son dos lineas y evita tener
  // que razonar despues sobre si por aca se filtra algo.
  const correoOk = igualEnTiempoConstante(email.trim().toLowerCase(), env.platformAdmin.email.trim().toLowerCase());

  // A proposito NO se sale temprano cuando el correo no coincide: el trabajo de bcrypt se hace igual,
  // para que un correo equivocado y una contrasena equivocada tarden lo mismo. Salir antes convertiria
  // el tiempo de respuesta en un oraculo de "ese correo existe".
  const claveOk = env.platformAdmin.passwordHash
    ? await verifyPassword(password, env.platformAdmin.passwordHash)
    : igualEnTiempoConstante(password, env.platformAdmin.password);

  return correoOk && claveOk;
}

/**
 * Se llama una vez al arrancar. Ruidoso a proposito: una contrasena de plataforma en texto plano en el
 * entorno tiene que doler al leer los logs, no pasar callada.
 */
export function avisarSiLaClaveEstaEnTextoPlano(): void {
  if (avisado) return;
  avisado = true;
  if (!env.platformAdmin.passwordHash && env.platformAdmin.password) {
    console.error(
      "[ZAQI ALERT] La contrasena de la consola de plataforma esta en TEXTO PLANO en el entorno " +
        "(PLATFORM_ADMIN_PASSWORD). Genera el hash con `npm run hash:password`, ponelo en " +
        "PLATFORM_ADMIN_PASSWORD_HASH y borra la de texto plano.",
    );
  }
}
