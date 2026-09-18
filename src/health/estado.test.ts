import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { hashPassword } from "../auth/service";
import { sinSolape } from "../jobs/sinSolape";
import { saludDelSistema, comoPrometheus, COLA_ANTIGUEDAD_DEGRADADA_MS } from "./estado";

// E24 (2026-09-18). El criterio de aceptacion de la etapa, textual: "con un job caido, /health devuelve
// el estado degradado y nombra cual".
//
// Lo de "nombra cual" no es decoracion: un healthcheck que dice "degradado" y nada mas obliga a ir a
// buscar a mano, que es exactamente el trabajo que esta etapa vino a sacar.

const creados: string[] = [];
const eventos: string[] = [];

afterEach(async () => {
  for (const id of creados.splice(0)) await prisma.business.delete({ where: { id } }).catch(() => undefined);
  if (eventos.length) await prisma.inboundEvent.deleteMany({ where: { id: { in: eventos.splice(0) } } });
});

test("el reporte nombra SIEMPRE los siete componentes, esten bien o mal", async () => {
  const salud = await saludDelSistema();

  // Un componente que solo aparece cuando falla es un componente que nadie sabe que se esta vigilando.
  assert.deepEqual(
    salud.componentes.map((c) => c.nombre).sort(),
    // "respaldos" entra el 2026-09-18: el job llevaba horas fallando con AccessDenied de S3 y este
    // reporte decia "ok" igual, porque los respaldos no eran un componente.
    ["base", "cola-de-entrada", "credenciales-de-meta", "jobs", "proveedor-de-ia", "respaldos", "turnos-sin-responder"],
  );
  assert.equal(salud.componentes.find((c) => c.nombre === "base")?.estado, "ok");

  // `problemas` y el estado general tienen que coincidir siempre: un "ok" con problemas listados, o un
  // "degradado" con la lista vacia, seria justo la mentira que esta etapa vino a sacar.
  assert.equal(salud.problemas.length === 0, salud.estado === "ok");
  assert.deepEqual(
    salud.problemas.sort(),
    salud.componentes.filter((c) => c.estado !== "ok").map((c) => c.nombre).sort(),
  );
});

test("un job que se pisa a si mismo pone el sistema en degradado Y LO NOMBRA", async () => {
  // Se fuerza el solape de verdad: una tarea que no termina hasta que se le diga, y una segunda pasada
  // encima. Es el escenario real de saleConfirmationChaser, que corre cada 60s sobre un bucle sin tope.
  let soltar: () => void = () => {};
  const bloqueada = new Promise<void>((r) => {
    soltar = r;
  });
  const nombre = `job-de-prueba-${randomUUID().slice(0, 8)}`;
  const guardia = sinSolape(nombre, () => bloqueada);

  const primera = guardia.correr();
  await guardia.correr(); // esta se saltea: la anterior sigue en curso

  const salud = await saludDelSistema();
  assert.equal(salud.estado, "degradado");
  assert.ok(salud.problemas.includes("jobs"));

  const componente = salud.componentes.find((c) => c.nombre === "jobs");
  assert.ok(componente);
  // ESTO es la mitad que importa de la etapa. "hay jobs saltandose pasadas" no sirve de nada.
  assert.match(componente.detalle, new RegExp(nombre), "el detalle tiene que decir QUE job, con nombre");
  assert.equal(componente.valores?.salteadas, 1);

  soltar();
  await primera;
});

test("un negocio con la conexion de WhatsApp rota degrada, y el reporte NO dice cual es", async () => {
  const negocio = await prisma.business.create({
    data: {
      name: "Rota",
      email: `rota-${randomUUID()}@ejemplo.com`,
      passwordHash: await hashPassword("x"),
      active: true,
      whatsappConnectionBrokenAt: new Date(),
    },
  });
  creados.push(negocio.id);

  const salud = await saludDelSistema();
  assert.ok(salud.problemas.includes("credenciales-de-meta"));
  const componente = salud.componentes.find((c) => c.nombre === "credenciales-de-meta");
  assert.ok((componente?.valores?.rotas ?? 0) >= 1, "ese bot esta mudo y el healthcheck tiene que saberlo");

  // /health no tiene control de acceso. Decir "el negocio Rota esta caido" en una ruta publica seria
  // filtrar quien es cliente; el detalle con nombre va en el panel, que si tiene control de acceso.
  assert.doesNotMatch(componente?.detalle ?? "", /Rota/);
  assert.doesNotMatch(componente?.detalle ?? "", new RegExp(negocio.id));
});

test("un token vencido cuenta igual que una conexion rota: el bot esta mudo de las dos formas", async () => {
  const negocio = await prisma.business.create({
    data: {
      name: "Vencida",
      email: `vencida-${randomUUID()}@ejemplo.com`,
      passwordHash: await hashPassword("x"),
      active: true,
      whatsappTokenExpiresAt: new Date(Date.now() - 60_000),
    },
  });
  creados.push(negocio.id);

  const salud = await saludDelSistema();
  const componente = salud.componentes.find((c) => c.nombre === "credenciales-de-meta");
  assert.ok((componente?.valores?.vencidas ?? 0) >= 1);
  assert.ok(salud.problemas.includes("credenciales-de-meta"));
});

test("un negocio INACTIVO con el token vencido no ensucia el reporte", async () => {
  const negocio = await prisma.business.create({
    data: {
      name: "Apagada",
      email: `apagada-${randomUUID()}@ejemplo.com`,
      passwordHash: await hashPassword("x"),
      active: false,
      whatsappTokenExpiresAt: new Date(Date.now() - 60_000),
    },
  });
  creados.push(negocio.id);

  // Un negocio apagado no manda nada, asi que su token vencido no es un problema que atender. Contarlo
  // dejaria el healthcheck en amarillo permanente por cuentas dadas de baja, y un amarillo permanente
  // es un amarillo que se deja de mirar.
  // No se mira el estado global -- depende de toda la base y lo volveria rehen de cualquier otro
  // archivo. Se mira el componente, que es lo que esta prueba afirma.
  const salud = await saludDelSistema();
  const componente = salud.componentes.find((c) => c.nombre === "credenciales-de-meta");
  assert.equal(componente?.estado, "ok", `un negocio apagado no deberia contar: ${componente?.detalle}`);
  assert.equal(componente?.valores?.vencidas, 0);
});

test("un evento viejo sin procesar degrada la cola de entrada y dice cuanto lleva", async () => {
  const wamid = `health-${randomUUID()}`;
  const evento = await prisma.inboundEvent.create({
    data: {
      dedupeKey: `msg:${wamid}`,
      kind: "MESSAGE",
      wamid,
      payload: {},
      receivedAt: new Date(Date.now() - COLA_ANTIGUEDAD_DEGRADADA_MS - 60_000),
    },
  });
  eventos.push(evento.id);

  const salud = await saludDelSistema();
  assert.ok(salud.problemas.includes("cola-de-entrada"));
  const componente = salud.componentes.find((c) => c.nombre === "cola-de-entrada");
  // La antiguedad importa mas que la profundidad: mil eventos de hace dos segundos es un pico normal;
  // UNO esperando diez minutos es el consumidor parado.
  assert.match(componente?.detalle ?? "", /sin procesarse/);
  assert.ok((componente?.valores?.antiguedadMs ?? 0) >= COLA_ANTIGUEDAD_DEGRADADA_MS);
});

test("la carta muerta se reporta pero NO pone el sistema en rojo", async () => {
  const wamid = `health-muerto-${randomUUID()}`;
  const evento = await prisma.inboundEvent.create({
    data: { dedupeKey: `msg:${wamid}`, kind: "MESSAGE", wamid, payload: {}, failedAt: new Date(), attempts: 5 },
  });
  eventos.push(evento.id);

  const salud = await saludDelSistema();
  const componente = salud.componentes.find((c) => c.nombre === "cola-de-entrada");
  assert.ok((componente?.valores?.muertos ?? 0) >= 1, "el numero tiene que estar");
  // Un rojo que solo se apaga cuando una persona limpia a mano es un rojo permanente, y un rojo
  // permanente se deja de mirar. Esos mensajes ya fallaron: esperan a alguien, no a un reintento.
  //
  // Se mira que la carta muerta no sea LA causa: el componente solo puede estar degradado por
  // antiguedad o profundidad de lo PENDIENTE, nunca por lo que ya murio.
  assert.doesNotMatch(componente?.detalle ?? "", /carta muerta.*sin procesarse/);
  if (componente?.estado !== "ok") {
    assert.match(componente?.detalle ?? "", /pendientes|sin procesarse/, "si degrada, es por lo pendiente");
  }
});

test("/metrics sale en formato Prometheus, con una linea por componente", async () => {
  const texto = comoPrometheus(await saludDelSistema());

  assert.match(texto, /^# HELP onix_estado /m);
  assert.match(texto, /^# TYPE onix_estado gauge$/m);
  assert.match(texto, /^onix_estado [012]$/m);
  assert.match(texto, /^onix_componente_estado\{componente="base"\} [012]$/m);

  // Prometheus no admite guiones en un nombre de metrica: "cola-de-entrada" tiene que salir con
  // guiones bajos o el scrape falla entero, no solo esa linea.
  assert.match(texto, /^onix_cola_de_entrada_pendientes \d+$/m);
  assert.doesNotMatch(texto, /^onix_[a-z_]*-[a-z_]* /m);
  assert.ok(texto.endsWith("\n"), "el formato exige salto de linea final");
});
