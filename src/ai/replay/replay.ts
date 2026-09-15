import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/client";
import { recordMessage } from "../../conversation/service";
import { deepseek } from "../client";
import { generateReply } from "../agent";
import type { ToolContext } from "../tools";
import { seedReplayBusiness, teardownReplayBusiness } from "./seed";
import { getSaleState } from "../../orders/saleState";

// Fase 1 del plan maestro (2026-09-15). Motor de reproduccion determinista: mockea el modelo
// (deepseek.chat.completions.create) con respuestas YA GRABADAS y deja correr generateReply de
// verdad - misma base, mismo catalogo, mismas herramientas reales (runCatalogTool si ejecuta contra
// Postgres). Cero llamadas de red a DeepSeek. Ver ONIX-PLAN-MAESTRO.md seccion 3 para el diseno y las
// reglas de asercion (nunca se asierta sobre el texto exacto del modelo).
//
// Diferencia deliberada con el diseno del plan: SaleState (Fase 2) todavia no existe, asi que `expect`
// en esta fase se limita a lo que YA se puede leer hoy - status de la conversacion, campos guardados
// del cliente, si hay Order, cuantas PendingOwnerQuestion se crearon, y los envios reales por WhatsApp
// (mockeados, pero contados). Cuando la Fase 2 exista, este mismo motor gana un `expect.saleState`.

export interface FixtureToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface FixtureModelResponse {
  toolCalls?: FixtureToolCall[];
  content?: string | null;
}

export interface FixtureTurnExpectation {
  // Nombres de herramienta en el orden que el modelo debe llamarlas este turno. Se compara contra lo
  // que el propio fixture programo (ver nota de diseno abajo) - lo que realmente prueba es que
  // generateReply consumio EXACTAMENTE esa secuencia (ni una llamada de mas, ni de menos) antes de
  // devolver texto final.
  toolSequence?: string[];
  // Texto que NO puede aparecer en la respuesta final del bot (comparacion literal, sin regex - la
  // regla de esta fase es no agregar expresiones regulares nuevas).
  textMustNotContain?: string[];
  textMustContain?: string[];
  // Efectos laterales reales contados via el fetch mockeado (envios a la Graph API de WhatsApp) y la
  // base (PendingOwnerQuestion). No incluye la respuesta principal del turno - esa siempre es 1 y la
  // devuelve generateReply directamente, no pasa por fetch.
  sideEffects?: {
    mediaSent?: number;
    ownerQuestionsCreated?: number;
  };
  // Estado real, leido de la base despues del turno. Todo opcional: solo se compara lo que el fixture
  // declara.
  state?: {
    conversationStatus?: string;
    hasOrder?: boolean;
    customerName?: string | null;
    customerIdNumber?: string | null;
    customerDeliveryPhone?: string | null;
  };
  // Fase 2 del plan maestro: SaleState real (solo tiene sentido si el fixture sembro el negocio con
  // saleStateEnabled:true). Todo opcional, igual que `state`.
  saleState?: {
    itemsCount?: number;
    missing?: string[];
    subtotal?: number;
    total?: number;
  };
}

export interface FixtureTurn {
  customer: string;
  modelResponses: FixtureModelResponse[];
  expect?: FixtureTurnExpectation;
  // Por que este turno tiene un `expect` - de donde sale el defecto real que prueba, no que hace el
  // texto. Puramente documental, replay.test.ts no lo lee.
  note?: string;
}

export interface ConversationFixture {
  name: string;
  seed: { catalogName: string; saleStateEnabled?: boolean };
  turns: FixtureTurn[];
  // Documental, igual que FixtureTurn.note - por ejemplo, para dejar constancia de que grabar esta
  // conversacion contra el modelo real HOY no reprodujo el defecto original que motivo el fixture
  // (el prompt/los guards ya cambiaron desde el incidente, o el dato anonimizado altero el flujo).
  note?: string;
  // Fase 1 del plan maestro: esta conversacion prueba un defecto real que TODAVIA existe (verificado
  // contra DeepSeek real, ver `note` de cada turno) y que ninguna fase posterior corrigio aun. La regla
  // del repositorio es que `npm test` quede en verde siempre, asi que replay.test.ts la corre como TODO
  // (Node la reporta, no rompe el exit code) hasta que la Fase que corresponda (2-5) la arregle - en ese
  // momento sacar este campo debe hacer que la prueba pase de verdad, no que siga en rojo.
  knownFailing?: string;
}

interface CapturedSend {
  type: string;
  to: string | null;
}

// Fase 11 del plan maestro (2026-09-15). Un fixture no puede traer escrito el productId ni el
// paymentMethodId reales: la suite siembra un negocio NUEVO en cada corrida y esos ids cambian. Hasta
// ahora eso se veia en bf5c4k-cierre-feliz, donde set_order_item quedo apuntando a un id de la grabacion
// original y el pedido se quedaba sin items para siempre (ver la nota de su turno 20). Un fixture nuevo
// escribe "{{product:Nombre exacto del catalogo}}" o "{{payment:Etiqueta}}" y esto lo resuelve contra el
// negocio recien sembrado. No cambia ningun fixture existente: sin marcas, la sustitucion no hace nada.
async function buildIdPlaceholders(businessId: string): Promise<Map<string, string>> {
  const [products, methods] = await Promise.all([
    prisma.product.findMany({ where: { businessId }, select: { id: true, name: true } }),
    prisma.paymentMethod.findMany({ where: { businessId }, select: { id: true, label: true } }),
  ]);
  const map = new Map<string, string>();
  for (const p of products) map.set(`{{product:${p.name}}}`, p.id);
  for (const m of methods) map.set(`{{payment:${m.label}}}`, m.id);
  return map;
}

function resolvePlaceholders(response: FixtureModelResponse, ids: Map<string, string>): FixtureModelResponse {
  if (!response.toolCalls?.length) return response;
  let raw = JSON.stringify(response);
  if (!raw.includes("{{product:") && !raw.includes("{{payment:")) return response;
  for (const [marker, id] of ids) raw = raw.split(marker).join(id);
  const resolved = JSON.parse(raw) as FixtureModelResponse;
  for (const call of resolved.toolCalls ?? []) {
    for (const [key, value] of Object.entries(call.arguments ?? {})) {
      if (typeof value === "string" && value.startsWith("{{")) {
        throw new Error(`Fixture: "${value}" (argumento "${key}" de ${call.name}) no existe en el catalogo sembrado`);
      }
    }
  }
  return resolved;
}

function toChatCompletion(response: FixtureModelResponse) {
  const toolCalls = (response.toolCalls ?? []).map((tc) => ({
    id: `call_${randomUUID()}`,
    type: "function" as const,
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
  }));
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: response.content ?? (toolCalls.length > 0 ? "" : null),
          tool_calls: toolCalls,
        },
      },
    ],
    usage: undefined,
  };
}

export interface TurnState {
  conversationStatus: string;
  hasOrder: boolean;
  customerName: string | null;
  customerIdNumber: string | null;
  customerDeliveryPhone: string | null;
  saleState: { itemsCount: number; missing: string[]; subtotal: number; total: number } | null;
}

export interface TurnResult {
  reply: string;
  toolSequence: string[];
  sends: CapturedSend[];
  ownerQuestionsCreated: number;
  state: TurnState;
}

export interface ReplayResult {
  businessId: string;
  conversationId: string;
  customerId: string;
  turns: TurnResult[];
}

// Corre el fixture entero contra un negocio recien sembrado y devuelve, por turno, todo lo necesario
// para asertar - no asierta nada acá adentro, eso vive en replay.test.ts (misma separacion que
// findHealthIssues: funcion pura de datos, facil de leer sin arrancar un test runner).
export async function runFixture(fixture: ConversationFixture): Promise<ReplayResult> {
  const { businessId, personality } = await seedReplayBusiness(fixture.seed.catalogName, {
    saleStateEnabled: fixture.seed.saleStateEnabled,
  });
  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `replay-${randomUUID()}` },
  });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId: customer.id,
    credentials: { phoneNumberId: "replay-fake-phone-id", accessToken: "replay-fake-token" },
    recipientPhone: customer.phoneNumber,
  };

  const idPlaceholders = await buildIdPlaceholders(businessId);
  const originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  const originalFetch = globalThis.fetch;
  const turns: TurnResult[] = [];

  try {
    for (const turn of fixture.turns) {
      await recordMessage(businessId, conversation.id, "CUSTOMER", turn.customer);

      const queue = [...turn.modelResponses];
      const toolSequence: string[] = [];
      // @ts-expect-error test stub, narrower shape than the real SDK type - same pattern as
      // agent.loopExhaustion.test.ts.
      deepseek.chat.completions.create = async () => {
        const next = queue.shift();
        if (!next) {
          throw new Error(
            `Fixture "${fixture.name}": generateReply pidio mas respuestas del modelo de las que el turno "${turn.customer.slice(0, 40)}" tiene grabadas`
          );
        }
        const resolved = resolvePlaceholders(next, idPlaceholders);
        for (const tc of resolved.toolCalls ?? []) toolSequence.push(tc.name);
        return toChatCompletion(resolved);
      };

      const sends: CapturedSend[] = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sends.push({ type: body.type ?? "unknown", to: body.to ?? null });
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: `wamid.replay-${randomUUID()}` }] }),
          text: async () => "{}",
        } as Response;
      }) as typeof fetch;

      const pendingBefore = await prisma.pendingOwnerQuestion.count({ where: { conversationId: conversation.id } });
      const reply = await generateReply(conversation.id, context, personality, turn.customer);
      const pendingAfter = await prisma.pendingOwnerQuestion.count({ where: { conversationId: conversation.id } });

      if (queue.length > 0) {
        throw new Error(
          `Fixture "${fixture.name}": quedaron ${queue.length} respuesta(s) del modelo sin usar en el turno "${turn.customer.slice(0, 40)}" - generateReply devolvio texto final antes de tiempo`
        );
      }

      // generateReply no persiste su propia respuesta (el caller real, routes/whatsapp.ts, lo hace
      // despues de mandarla) - sin esto, un fixture de varios turnos le mostraria al modelo del
      // segundo turno una historia sin la respuesta del bot en el primero, que no es realista.
      await recordMessage(businessId, conversation.id, "ASSISTANT", reply);

      const [conversationRow, customerRow, orderRow, saleState] = await Promise.all([
        prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { status: true } }),
        prisma.customer.findUniqueOrThrow({ where: { id: customer.id }, select: { name: true, idNumber: true, deliveryPhone: true } }),
        prisma.order.findFirst({ where: { conversationId: conversation.id } }),
        fixture.seed.saleStateEnabled ? getSaleState(conversation.id) : Promise.resolve(null),
      ]);
      const state: TurnState = {
        conversationStatus: conversationRow.status,
        hasOrder: Boolean(orderRow),
        customerName: customerRow.name,
        customerIdNumber: customerRow.idNumber,
        customerDeliveryPhone: customerRow.deliveryPhone,
        saleState: saleState
          ? { itemsCount: saleState.items.length, missing: saleState.checkout.faltan, subtotal: saleState.subtotal, total: saleState.total }
          : null,
      };

      turns.push({ reply, toolSequence, sends, ownerQuestionsCreated: pendingAfter - pendingBefore, state });
    }
  } finally {
    deepseek.chat.completions.create = originalCreate;
    globalThis.fetch = originalFetch;
    await teardownReplayBusiness(businessId);
  }

  return { businessId, conversationId: conversation.id, customerId: customer.id, turns };
}

// Asserciones reusables para que replay.test.ts quede corto y legible - una linea por fixture, no un
// bloque de asserts repetido por archivo.
export function assertTurn(fixtureName: string, turnIndex: number, expect_: FixtureTurnExpectation | undefined, result: TurnResult): void {
  if (!expect_) return;
  const label = `${fixtureName} turno ${turnIndex}`;

  if (expect_.toolSequence) {
    assert.deepEqual(result.toolSequence, expect_.toolSequence, `${label}: secuencia de herramientas no coincide`);
  }
  for (const forbidden of expect_.textMustNotContain ?? []) {
    assert.ok(!result.reply.includes(forbidden), `${label}: la respuesta no debia contener "${forbidden}" pero dice: "${result.reply}"`);
  }
  for (const required of expect_.textMustContain ?? []) {
    assert.ok(result.reply.includes(required), `${label}: la respuesta debia contener "${required}" pero dice: "${result.reply}"`);
  }
  if (expect_.sideEffects?.mediaSent !== undefined) {
    const mediaSent = result.sends.filter((s) => s.type === "image" || s.type === "video").length;
    assert.equal(mediaSent, expect_.sideEffects.mediaSent, `${label}: cantidad de media enviada no coincide`);
  }
  if (expect_.sideEffects?.ownerQuestionsCreated !== undefined) {
    assert.equal(
      result.ownerQuestionsCreated,
      expect_.sideEffects.ownerQuestionsCreated,
      `${label}: cantidad de PendingOwnerQuestion creadas no coincide`
    );
  }

  const s = expect_.state;
  if (s?.conversationStatus !== undefined) assert.equal(result.state.conversationStatus, s.conversationStatus, `${label}: status`);
  if (s?.hasOrder !== undefined) assert.equal(result.state.hasOrder, s.hasOrder, `${label}: hasOrder`);
  if (s?.customerName !== undefined) assert.equal(result.state.customerName, s.customerName, `${label}: customerName`);
  if (s?.customerIdNumber !== undefined) assert.equal(result.state.customerIdNumber, s.customerIdNumber, `${label}: customerIdNumber`);
  if (s?.customerDeliveryPhone !== undefined) {
    assert.equal(result.state.customerDeliveryPhone, s.customerDeliveryPhone, `${label}: customerDeliveryPhone`);
  }

  const ss = expect_.saleState;
  if (ss) {
    assert.ok(result.state.saleState, `${label}: se esperaba saleState pero es null (falta saleStateEnabled:true en el seed?)`);
    if (ss.itemsCount !== undefined) assert.equal(result.state.saleState!.itemsCount, ss.itemsCount, `${label}: saleState.itemsCount`);
    if (ss.missing !== undefined) assert.deepEqual(result.state.saleState!.missing, ss.missing, `${label}: saleState.missing`);
    if (ss.subtotal !== undefined) assert.equal(result.state.saleState!.subtotal, ss.subtotal, `${label}: saleState.subtotal`);
    if (ss.total !== undefined) assert.equal(result.state.saleState!.total, ss.total, `${label}: saleState.total`);
  }
}
