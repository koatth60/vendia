/**
 * E23 (2026-09-18). EL ROL DEL PROCESO: `web`, `worker` o los dos.
 *
 * Hasta hoy lo unico que impedia que dos procesos mandaran dos respuestas al mismo cliente era
 * `instances: 1` en ecosystem.config.js -- o sea, una linea de configuracion que cualquiera puede
 * subir a 2 sin saber lo que rompe. Con el rol, escalar el HTTP deja de tocar los jobs: `web` no
 * corre ningun job, y el trabajo de fondo vive en `worker`, que toma lo suyo de la base con
 * FOR UPDATE SKIP LOCKED (ver conversation/inboundEvents.ts) en vez de suponer que es el unico.
 *
 * Vive aparte de src/index.ts a proposito: index.ts levanta el servidor al importarse, asi que no se
 * puede probar. Esto si.
 */
export type RolDeProceso = "web" | "worker" | "todo";

const ROLES: RolDeProceso[] = ["web", "worker", "todo"];

/**
 * Sin variable, "todo": es lo que hacia el proceso unico de siempre, y es lo que hace falta en
 * desarrollo y en las pruebas. Un valor escrito mal NO cae en el default -- revienta al arrancar.
 * Un `ONIX_ROL=Worker` que cayera en "todo" pondria dos procesos corriendo todos los jobs, que es
 * exactamente el mensaje duplicado que esta etapa viene a hacer imposible.
 */
export function parsearRol(valor: string | undefined): RolDeProceso {
  const limpio = (valor ?? "").trim();
  if (limpio === "") return "todo";
  if ((ROLES as string[]).includes(limpio)) return limpio as RolDeProceso;
  throw new Error(`ONIX_ROL invalido: "${valor}". Valores validos: ${ROLES.join(", ")} (o sin definir, que es "todo").`);
}

/** Atiende HTTP, WebSocket y el webhook de Meta -- que solo ENCOLA, no procesa. */
export function correWeb(rol: RolDeProceso): boolean {
  return rol !== "worker";
}

/** Corre los jobs y el consumidor de la cola de entrada: todo lo que manda mensajes hacia afuera. */
export function correTrabajos(rol: RolDeProceso): boolean {
  return rol !== "web";
}
