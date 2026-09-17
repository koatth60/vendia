import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/client";
import { recordMessage } from "../../conversation/service";
import { deepseek } from "../client";
import { generateReply } from "../agent";
import type { ToolContext } from "../tools";
import { seedReplayBusiness, teardownReplayBusiness } from "./seed";
import { getSaleState } from "../../orders/saleState";
import { getBusinessLocale } from "../../config/businessConfig";
import { formatPrice } from "../../config/money";

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
  // Bloqueador de produccion (2026-09-15): este turno le lista productos al cliente, asi que la
  // respuesta final tiene que salir entera del catalogo sembrado - ver assertCatalogFidelity. Solo para
  // turnos de listado: un turno que ademas muestre un costo de envio o un total traeria cifras que no
  // son del catalogo y esta asercion las marcaria como inventadas.
  catalogFidelity?: boolean;
  // Igual que catalogFidelity, pero para un turno que lista un SUBCONJUNTO del catalogo
  // (find_products_by_attributes filtrando por categoria o color). Los nombres declarados aca son el
  // universo permitido de ese turno: la respuesta no puede traer el precio ni el nombre de ningun otro
  // producto del negocio, y tiene que traer todos estos. Se declaran a mano a proposito - si el filtro
  // deja de devolver lo que corresponde, la lista deja de coincidir y el turno falla.
  catalogFidelityScope?: string[];
  textMustContain?: string[];
  // Texto que el SERVIDOR tiene que haberle puesto delante al modelo en este turno, en algun mensaje
  // de rol `system` (comparacion literal, sin regex - misma regla que textMustContain). Es la unica
  // forma determinista de probar una pieza cuyo efecto es el CONTENIDO del turno y no la respuesta: el
  // modelo esta mockeado. Lo usa el reloj del turno (2026-09-17) y lo va a usar cualquier fase que
  // agregue un hecho leido de la base.
  systemMustContain?: string[];
  // Lo contrario: texto que el servidor NO puede haberle puesto delante al modelo este turno. Existe
  // para las piezas que se prueban por AUSENCIA - un bloque que salia cuando no correspondia y ahora
  // no sale (el "PEDIDO EN CURSO" sin un solo producto elegido, 2026-09-17).
  systemMustNotContain?: string[];
  // Bloqueador de produccion (2026-09-15, seguimiento de f9b994b): herramientas que generateReply
  // FORZO via tool_choice este turno, en orden. Es lo unico del forzado que un replay determinista puede
  // medir de verdad: las respuestas del modelo estan grabadas, asi que si el fixture programa la llamada
  // a la herramienta, que aparezca en toolSequence no prueba nada por si solo. Lo que si prueba algo es
  // que el motor haya pedido tool_choice para ese mensaje del cliente - sin el forzado, el modelo real
  // es libre de no llamarla, que es exactamente el defecto que se esta arreglando.
  forcedTools?: string[];
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
  // Fase B del plan de catalogo y medios (2026-09-16): los mensajes que compone el SERVIDOR con datos
  // reales del catalogo y que salen despues de la frase del modelo. Lo que el cliente recibe es
  // [reply, ...blocks], asi que las aserciones de fidelidad de catalogo miden sobre los dos juntos.
  blocks: string[];
  // Cuantas fotos/videos viajan pegados a esos bloques. No pasan por el fetch mockeado porque los manda
  // el caller real (routes/whatsapp.ts), no generateReply - por eso se cuentan aparte y se suman.
  blockMediaCount: number;
  // Todos los mensajes `system` de la primera llamada al modelo, concatenados. Es lo que el servidor
  // le puso delante antes de que el modelo decidiera nada. Ver la nota en el stub de abajo.
  systemContext: string;
  toolSequence: string[];
  forcedTools: string[];
  sends: CapturedSend[];
  ownerQuestionsCreated: number;
  state: TurnState;
}

// Catalogo real del negocio sembrado, con el precio ya formateado igual que lo formatea el motor
// (misma moneda y locale) - es contra esto que se mide si el bot invento un nombre o una cifra.
export interface SeededCatalogProduct {
  name: string;
  price: string;
  stock: number;
}

export interface ReplayResult {
  catalog: SeededCatalogProduct[];
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

  const catalog = await readSeededCatalog(businessId);
  const idPlaceholders = await buildIdPlaceholders(businessId);
  const originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  const originalFetch = globalThis.fetch;
  const turns: TurnResult[] = [];

  try {
    for (const turn of fixture.turns) {
      await recordMessage(businessId, conversation.id, "CUSTOMER", turn.customer);

      const queue = [...turn.modelResponses];
      const toolSequence: string[] = [];
      const forcedTools: string[] = [];
      // Lo que el SERVIDOR le puso delante al modelo en este turno: todos los mensajes de rol `system`
      // de la PRIMERA llamada, concatenados (2026-09-17). Existe porque desde el reloj del turno hay
      // piezas cuyo unico efecto observable es el contenido del contexto - el modelo esta mockeado, asi
      // que ninguna asercion sobre su respuesta puede probar que el dato llego. Con esto un fixture
      // afirma "este dato estaba en el turno" de forma determinista y gratis.
      let systemContext = "";
      // @ts-expect-error test stub, narrower shape than the real SDK type - same pattern as
      // agent.loopExhaustion.test.ts.
      deepseek.chat.completions.create = async (params: { tool_choice?: unknown; messages?: unknown }) => {
        const choice = params?.tool_choice;
        if (choice && typeof choice === "object" && "function" in choice) {
          forcedTools.push(String((choice as { function: { name: string } }).function.name));
        }
        if (!systemContext && Array.isArray(params?.messages)) {
          systemContext = (params.messages as { role?: string; content?: unknown }[])
            .filter((m) => m.role === "system" && typeof m.content === "string")
            .map((m) => m.content as string)
            .join("\n");
        }
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
      const { text: reply, blocks } = await generateReply(conversation.id, context, personality, turn.customer);
      const pendingAfter = await prisma.pendingOwnerQuestion.count({ where: { conversationId: conversation.id } });

      if (queue.length > 0) {
        throw new Error(
          `Fixture "${fixture.name}": quedaron ${queue.length} respuesta(s) del modelo sin usar en el turno "${turn.customer.slice(0, 40)}" - generateReply devolvio texto final antes de tiempo`
        );
      }

      // generateReply no persiste su propia respuesta (el caller real, routes/whatsapp.ts, lo hace
      // despues de mandarla) - sin esto, un fixture de varios turnos le mostraria al modelo del
      // segundo turno una historia sin la respuesta del bot en el primero, que no es realista.
      // El historial del turno siguiente tiene que ver lo mismo que vio el cliente: la frase del modelo
      // Y los bloques del servidor. Sin los bloques, el modelo del segundo turno no sabria que lista se
      // le mostro y "el 3" no tendria contra que resolver.
      for (const enviado of [reply, ...blocks.map((b) => b.text)]) {
        if (enviado.trim()) await recordMessage(businessId, conversation.id, "ASSISTANT", enviado);
      }

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

      turns.push({
        reply,
        blocks: blocks.map((b) => b.text),
        blockMediaCount: blocks.reduce((acc, b) => acc + b.media.reduce((n, m) => n + m.items.length, 0), 0),
        systemContext,
        toolSequence,
        forcedTools,
        sends,
        ownerQuestionsCreated: pendingAfter - pendingBefore,
        state,
      });
    }
  } finally {
    deepseek.chat.completions.create = originalCreate;
    globalThis.fetch = originalFetch;
    await teardownReplayBusiness(businessId);
  }

  return { catalog, businessId, conversationId: conversation.id, customerId: customer.id, turns };
}

// Mismo calculo de stock que formatProduct/totalStock en tools.ts: con variantes, el stock real es la
// suma de las activas (product.stock queda congelado apenas existen variantes).
async function readSeededCatalog(businessId: string): Promise<SeededCatalogProduct[]> {
  const { locale } = await getBusinessLocale(businessId);
  const products = await prisma.product.findMany({
    where: { businessId, active: true },
    select: { name: true, price: true, currency: true, stock: true, variants: { select: { stock: true, active: true } } },
  });
  return products.map((p) => ({
    name: p.name,
    price: formatPrice(p.price, p.currency, locale),
    stock: p.variants.length === 0 ? p.stock : p.variants.filter((v) => v.active).reduce((sum, v) => sum + v.stock, 0),
  }));
}

// Asserciones reusables para que replay.test.ts quede corto y legible - una linea por fixture, no un
// bloque de asserts repetido por archivo.
// Bloqueador de produccion (2026-09-15): el bot le listo 18 productos a un cliente real de los cuales
// 11 no existian, cotizo AIRPODS SERIE 4 a $105.000 (vale $65.000) y AIRPODS PRO 2 a $110.000 (vale
// $55.000), y dejo afuera cinco productos con stock. Esta funcion mide la respuesta final contra el
// catalogo sembrado, no contra un texto esperado: falla si aparece una cifra que no es de ningun
// producto, si una linea con precio nombra algo que no esta en el catalogo, o si falta un producto.
//
// Sin expresiones regulares a proposito (regla del repositorio): los numeros se recortan con un barrido
// de caracteres, y los nombres se comparan con includes literal.
function numericTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const char of text) {
    const isDigit = char >= "0" && char <= "9";
    const isSeparator = (char === "." || char === ",") && current.length > 0;
    if (isDigit || isSeparator) {
      current += char;
    } else {
      if (current) tokens.push(current);
      current = "";
    }
  }
  if (current) tokens.push(current);
  return tokens.map((token) => {
    let trimmed = token;
    while (trimmed.endsWith(".") || trimmed.endsWith(",")) trimmed = trimmed.slice(0, -1);
    return trimmed;
  });
}

function digitCount(token: string): number {
  let count = 0;
  for (const char of token) if (char >= "0" && char <= "9") count++;
  return count;
}

function withoutSeparators(token: string): string {
  return token.split(".").join("").split(",").join("");
}

export function assertCatalogFidelity(label: string, reply: string, catalog: SeededCatalogProduct[]): void {
  assert.ok(catalog.length > 0, `${label}: el negocio sembrado no tiene productos activos que comparar`);

  // Cifras que SI pueden aparecer: los precios reales (con y sin separador de miles), el stock real, y
  // los numeros que forman parte del nombre de un producto ("Bateria portatil power bank 12000 mah").
  const allowedNumbers = new Set<string>();
  for (const product of catalog) {
    allowedNumbers.add(product.price);
    allowedNumbers.add(withoutSeparators(product.price));
    allowedNumbers.add(String(product.stock));
    for (const token of numericTokens(product.name)) allowedNumbers.add(token);
  }

  // Solo se miran los numeros de 3 digitos o mas: los de uno o dos son posiciones de la lista,
  // cantidades y numeros sueltos de la redaccion, nunca un precio.
  for (const token of numericTokens(reply)) {
    if (digitCount(token) < 3) continue;
    assert.ok(
      allowedNumbers.has(token) || allowedNumbers.has(withoutSeparators(token)),
      `${label}: la respuesta trae la cifra "${token}", que no es ningun precio ni stock del catalogo sembrado. Respuesta: "${reply}"`
    );
  }

  // Una linea que lleva precio esta listando un producto: tiene que ser uno real.
  for (const line of reply.split("\n")) {
    if (!line.includes("$")) continue;
    assert.ok(
      catalog.some((product) => line.includes(product.name)),
      `${label}: la linea "${line.trim()}" muestra un precio de un producto que no esta en el catalogo sembrado`
    );
  }

  // Y no se le puede esconder al cliente un producto que si existe.
  for (const product of catalog) {
    assert.ok(
      reply.includes(product.name),
      `${label}: falta el producto "${product.name}" en la lista que recibio el cliente. Respuesta: "${reply}"`
    );
  }
}

export function assertTurn(
  fixtureName: string,
  turnIndex: number,
  expect_: FixtureTurnExpectation | undefined,
  result: TurnResult,
  catalog: SeededCatalogProduct[]
): void {
  if (!expect_) return;
  const label = `${fixtureName} turno ${turnIndex}`;

  // Todo lo que el cliente recibe este turno, en orden: la frase del modelo y despues los bloques que
  // compuso el servidor. Es sobre esto que se mide la fidelidad de catalogo y el texto prohibido -
  // medir solo `reply` dejaria fuera exactamente los mensajes que traen nombres y precios.
  const customerFacingText = [result.reply, ...result.blocks].filter((t) => t.trim()).join("\n\n");

  if (expect_.catalogFidelity) assertCatalogFidelity(label, customerFacingText, catalog);

  if (expect_.catalogFidelityScope) {
    const scoped = catalog.filter((product) => expect_.catalogFidelityScope!.includes(product.name));
    assert.equal(
      scoped.length,
      expect_.catalogFidelityScope.length,
      `${label}: catalogFidelityScope nombra productos que no existen en el catalogo sembrado: ${expect_.catalogFidelityScope
        .filter((name) => !catalog.some((product) => product.name === name))
        .join(", ")}`
    );
    assertCatalogFidelity(label, customerFacingText, scoped);
  }

  if (expect_.toolSequence) {
    assert.deepEqual(result.toolSequence, expect_.toolSequence, `${label}: secuencia de herramientas no coincide`);
  }
  if (expect_.forcedTools) {
    assert.deepEqual(
      result.forcedTools,
      expect_.forcedTools,
      `${label}: las herramientas forzadas via tool_choice no coinciden`
    );
  }
  for (const forbidden of expect_.textMustNotContain ?? []) {
    assert.ok(!customerFacingText.includes(forbidden), `${label}: la respuesta no debia contener "${forbidden}" pero dice: "${customerFacingText}"`);
  }
  for (const required of expect_.textMustContain ?? []) {
    assert.ok(customerFacingText.includes(required), `${label}: la respuesta debia contener "${required}" pero dice: "${customerFacingText}"`);
  }
  for (const required of expect_.systemMustContain ?? []) {
    assert.ok(
      result.systemContext.includes(required),
      `${label}: el servidor debia ponerle "${required}" delante al modelo, y no esta en ningun mensaje system del turno`
    );
  }
  for (const forbidden of expect_.systemMustNotContain ?? []) {
    assert.ok(
      !result.systemContext.includes(forbidden),
      `${label}: el servidor NO debia ponerle "${forbidden}" delante al modelo, y se lo puso`
    );
  }
  if (expect_.sideEffects?.mediaSent !== undefined) {
    const mediaSent =
      result.sends.filter((s) => s.type === "image" || s.type === "video").length + result.blockMediaCount;
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
