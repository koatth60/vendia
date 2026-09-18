import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env";
import { decryptSecret, encryptSecret, isEncrypted } from "../crypto/secretBox";

// max defaults to node-postgres's own default of 10 if left unset - too low once several businesses'
// conversations can be in flight at the same time on this one shared process/pool.
const adapter = new PrismaPg({ connectionString: env.databaseUrl, max: 20 });

// Fase 8, punto 2: el cifrado de Business.whatsappAccessToken vive aca y no en cada sitio que lee el
// token. Hay mas de veinte lugares que hacen `business.whatsappAccessToken` (rutas, jobs, la capa de
// salida); pedirle a cada uno que se acuerde de descifrar es garantizar que el proximo se olvide.
// Esta extension cifra al escribir y descifra al leer, y el resto del codigo no cambia.
//
// Lo que NO cubre: `where: { whatsappAccessToken: ... }`. El unico filtro que existe hoy es
// `{ not: null }`, que sigue funcionando porque "cifrado" y "no nulo" son la misma cosa. Un filtro por
// IGUALDAD si se romperia (GCM usa un IV aleatorio, el mismo token da otro ciphertext cada vez) - por
// eso no se agrega ninguno.
const TOKEN_FIELD = "whatsappAccessToken";

function encryptTokenInData(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;
  if (!(TOKEN_FIELD in record)) return;
  const value = record[TOKEN_FIELD];
  if (typeof value === "string") {
    if (!isEncrypted(value)) record[TOKEN_FIELD] = encryptSecret(value);
    return;
  }
  // Prisma tambien acepta la forma `{ set: "..." }` en un update.
  if (value && typeof value === "object" && "set" in (value as Record<string, unknown>)) {
    const wrapper = value as Record<string, unknown>;
    if (typeof wrapper.set === "string" && !isEncrypted(wrapper.set)) wrapper.set = encryptSecret(wrapper.set);
  }
}

function decryptTokenInResult<T>(result: T): T {
  if (Array.isArray(result)) {
    for (const row of result) decryptTokenInResult(row);
    return result;
  }
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  const value = record[TOKEN_FIELD];
  if (typeof value === "string") {
    try {
      record[TOKEN_FIELD] = decryptSecret(value);
    } catch (error) {
      // E30: UNA fila con el texto cifrado corrupto tumbaba a TODOS los inquilinos. decryptSecret llama
      // a decipher.final(), que tira cuando el tag de autenticacion no cierra (token escrito con otra
      // TOKEN_ENCRYPTION_KEY, fila truncada, copia de base entre entornos). Como esto corre dentro de la
      // extension de lectura, ese throw salia por el findMany: el panel de plataforma, los jobs y el
      // webhook se caian enteros por un negocio.
      //
      // Ahora el token queda en null - ese negocio no puede mandar mensajes, que es la verdad - y los
      // demas siguen funcionando. Se marca la fila para que sea VISIBLE: un token null tambien lo tiene
      // un negocio que nunca conecto WhatsApp, y sin la marca los dos casos se ven iguales.
      record[TOKEN_FIELD] = null;
      const id = typeof record.id === "string" ? record.id : null;
      console.error(`[ZAQI ALERT] secreto ilegible en Business${id ? ` ${id}` : ""}: el token quedo en null`, error);
      if (id) marcarSecretoRoto(id);
    }
  }
  return result;
}

/**
 * Marca la fila sin pasar por la extension: $executeRaw no entra a $allOperations del modelo business,
 * asi que no se reentra aca desde aca mismo. Va sin await a proposito - es una marca de diagnostico, no
 * puede demorar ni hacer fallar la lectura que la disparo - y es idempotente, asi que repetirla no
 * cuesta nada.
 */
function marcarSecretoRoto(businessId: string): void {
  prisma
    .$executeRaw`UPDATE "Business" SET "secretsBroken" = true WHERE "id" = ${businessId} AND "secretsBroken" = false`
    .catch((error: unknown) => console.error(`No se pudo marcar secretsBroken en ${businessId}:`, error));
}

export const prisma = new PrismaClient({ adapter }).$extends({
  name: "encrypt-whatsapp-access-token",
  query: {
    business: {
      async $allOperations({ args, query }) {
        const writeArgs = args as { data?: unknown };
        if (writeArgs?.data) {
          // createMany recibe un arreglo; create/update/upsert reciben un objeto.
          if (Array.isArray(writeArgs.data)) writeArgs.data.forEach(encryptTokenInData);
          else encryptTokenInData(writeArgs.data);
        }
        // upsert lleva los dos lados.
        const upsertArgs = args as { create?: unknown; update?: unknown };
        if (upsertArgs?.create) encryptTokenInData(upsertArgs.create);
        if (upsertArgs?.update) encryptTokenInData(upsertArgs.update);

        return decryptTokenInResult(await query(args));
      },
    },
  },
});
