import { test } from "node:test";
import assert from "node:assert/strict";
import { collectWebhookBatch } from "./whatsapp";

// E16 (2026-09-18): el webhook leia entry[0].changes[0] y de ahi messages[0] y statuses[0]. Todo lo
// demas del lote se descartaba en silencio, sin una linea de log: dos clientes escribiendo en el mismo
// instante, o tres mensajes seguidos que Meta agrupa, y el bot contestaba uno solo.

function mensaje(id: string, texto: string) {
  return { id, from: "573001112233", type: "text", text: { body: texto } };
}

test("un lote con tres mensajes devuelve los tres, en orden", () => {
  const lote = collectWebhookBatch({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "linea-a" },
              messages: [mensaje("wamid.1", "Hola"), mensaje("wamid.2", "quiero el reloj"), mensaje("wamid.3", "el dorado")],
            },
          },
        ],
      },
    ],
  });

  assert.equal(lote.messages.length, 3);
  assert.deepEqual(lote.messages.map((m) => m.message.text.body), ["Hola", "quiero el reloj", "el dorado"]);
  assert.equal(lote.messages[0].incomingPhoneNumberId, "linea-a");
});

test("varios entry y varios changes en el mismo lote se recorren todos", () => {
  // Es el caso de dos clientes distintos escribiendo a la vez: Meta los puede agrupar en un solo POST.
  const lote = collectWebhookBatch({
    entry: [
      { changes: [{ value: { metadata: { phone_number_id: "linea-a" }, messages: [mensaje("wamid.1", "uno")] } }] },
      {
        changes: [
          { value: { metadata: { phone_number_id: "linea-a" }, messages: [mensaje("wamid.2", "dos")] } },
          { value: { metadata: { phone_number_id: "linea-b" }, messages: [mensaje("wamid.3", "tres")] } },
        ],
      },
    ],
  });

  assert.deepEqual(lote.messages.map((m) => m.message.id), ["wamid.1", "wamid.2", "wamid.3"]);
  assert.deepEqual(lote.messages.map((m) => m.incomingPhoneNumberId), ["linea-a", "linea-a", "linea-b"]);
});

test("un acuse que viaja JUNTO a un mensaje ya no se pierde", () => {
  // Antes statuses[0] solo se miraba cuando el lote no traia ningun mensaje: con los dos juntos, el
  // acuse se descartaba entero y un fallo de entrega quedaba sin registrar.
  const lote = collectWebhookBatch({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "linea-a" },
              messages: [mensaje("wamid.1", "Hola")],
              statuses: [{ id: "wamid.0", status: "failed", recipient_id: "573001112233" }],
            },
          },
        ],
      },
    ],
  });

  assert.equal(lote.messages.length, 1);
  assert.equal(lote.statuses.length, 1);
  assert.equal(lote.statuses[0].status.status, "failed");
});

test("un change sin numero de destino descarta sus mensajes pero no el resto del lote", () => {
  const lote = collectWebhookBatch({
    entry: [
      {
        changes: [
          { value: { messages: [mensaje("wamid.huerfano", "sin linea")] } },
          { value: { metadata: { phone_number_id: "linea-a" }, messages: [mensaje("wamid.bueno", "con linea")] } },
        ],
      },
    ],
  });

  assert.deepEqual(lote.messages.map((m) => m.message.id), ["wamid.bueno"]);
});

test("un cuerpo vacio o raro no revienta ni inventa elementos", () => {
  for (const cuerpo of [undefined, null, {}, { entry: null }, { entry: [{}] }, { entry: [{ changes: [{}] }] }]) {
    const lote = collectWebhookBatch(cuerpo);
    assert.deepEqual(lote.messages, []);
    assert.deepEqual(lote.statuses, []);
  }
});
