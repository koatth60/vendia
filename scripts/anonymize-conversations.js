const fs = require("fs");

const raw = JSON.parse(
  fs.readFileSync(
    "C:/Users/Koatth/AppData/Local/Temp/claude/c--Users-Koatth-Desktop-APP-BOT/1f7f3e50-a9ef-4f81-b29a-5445a80f0294/scratchpad/conversations-export.json",
    "utf8"
  )
);

const FAKE_NAMES = ["Camila", "Andrea", "Daniela", "Valentina", "Mariana", "Laura", "Juliana", "Natalia", "Carolina", "Sofia",
  "Andres", "Diego", "Felipe", "Julian", "Mateo", "Nicolas", "Santiago2", "Sebastian", "Alejandro", "David2"];
const FAKE_ADDRESS = "Calle 10 # 20-30, Barrio Ejemplo, Ciudad Ejemplo";
const FAKE_ID = "00000000";

let nameCounter = 0;
function fakeName() {
  return FAKE_NAMES[nameCounter++ % FAKE_NAMES.length] + (nameCounter > FAKE_NAMES.length ? nameCounter : "");
}
function fakePhone(seed) {
  // Deterministic-looking fake Colombian mobile number, stable per seed so the same customer keeps the
  // same fake number across their own conversation.
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return "300" + String(h % 10000000).padStart(7, "0");
}

let stats = { conversations: 0, replacements: 0 };

// The bot addresses customers by first name constantly per MAGByLizN's own script ("Perfecto, Ludy!"),
// and that name doesn't always match what ended up saved on Customer.name (mid-conversation correction,
// stale record from an earlier session, etc) - this catches that stylistic pattern directly instead of
// relying only on the stored field, keeping the SAME fake name consistent within one conversation.
const GREETING_NAME_PATTERN =
  /(¡?(?:Perfecto|Listo|Gracias|Hola|Genial|Claro que s[ií]|Con gusto|Buenas?)!?,?\s+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,15})(?=[!,.\s])/g;

const anonymized = raw.map((conv) => {
  stats.conversations++;
  const greetingNameMap = new Map();
  let greetingCounter = 0;
  const real = {
    name: conv.customer.name?.trim() || null,
    phoneNumber: conv.customer.phoneNumber?.trim() || null,
    idNumber: conv.customer.idNumber?.trim() || null,
    deliveryPhone: conv.customer.deliveryPhone?.trim() || null,
    addresses: (conv.customer.shippingAddresses || []).filter(Boolean),
  };

  const fake = {
    name: real.name ? fakeName() : null,
    phoneNumber: fakePhone(conv.conversationId),
    idNumber: real.idNumber ? FAKE_ID : null,
    deliveryPhone: real.deliveryPhone ? fakePhone(conv.conversationId + "-delivery") : null,
  };

  function scrub(text) {
    if (typeof text !== "string") return text;
    let out = text;
    if (real.name && real.name.length >= 3) {
      out = out.split(real.name).join(fake.name);
      stats.replacements += out === text ? 0 : 1;
    }
    if (real.phoneNumber && !real.phoneNumber.startsWith("CO.")) {
      out = out.split(real.phoneNumber).join(fake.phoneNumber);
    }
    if (real.idNumber) out = out.split(real.idNumber).join(fake.idNumber);
    if (real.deliveryPhone) out = out.split(real.deliveryPhone).join(fake.deliveryPhone);
    for (const addr of real.addresses) {
      if (addr && addr.length >= 6) out = out.split(addr).join(FAKE_ADDRESS);
    }
    // Label-based fallback for the common bot-summary formats, in case the free-text address the customer
    // typed doesn't exactly match what ended up stored on the Order (paraphrased, or the order was never
    // completed so there's no Order.shippingAddress to compare against at all).
    out = out.replace(/(\*?Direcci[oó]n:?\*?\s*)([^\n]{4,120})/gi, (m, label) => `${label}${FAKE_ADDRESS}`);
    out = out.replace(/(\*?Nombre:?\*?\s*)([^\n]{2,60})/gi, (m, label) => `${label}${fake.name || "Cliente Ejemplo"}`);
    out = out.replace(/(\*?C[eé]dula:?\*?\s*)(\d{5,12})/gi, (m, label) => `${label}${FAKE_ID}`);
    out = out.replace(/(\*?Celular:?\*?\s*)(\d{7,12})/gi, (m, label) => `${label}${fake.phoneNumber}`);
    // A street address inline in prose (assistant echoing it back, no "Direccion:" label) has a
    // recognizable shape regardless of role - catch it directly instead of only via the labeled form.
    out = out.replace(
      /\b(calle|cra\.?|carrera|kr\.?|cl\.?|diagonal|transversal|dg\.?|tv\.?|kdx)\s?\d{1,3}[a-z]?\s?#?\s?\d{0,3}[a-z]?[\s-]*\d{0,4}[a-z]?\b/gi,
      FAKE_ADDRESS
    );
    out = out.replace(GREETING_NAME_PATTERN, (m, prefix, name) => {
      const KNOWN_WORDS = new Set(["Que", "Si", "No", "Entonces", "Aca", "Aquí", "Ahi", "Con", "En"]);
      if (KNOWN_WORDS.has(name)) return m;
      if (!greetingNameMap.has(name)) greetingNameMap.set(name, fakeName());
      return `${prefix}${greetingNameMap.get(name)}`;
    });
    return out;
  }

  // Free-text "datos de entrega" blocks the customer pastes in one message (name/cedula/celular/
  // ciudad/barrio/direccion, no labels) slip past every targeted replacement above whenever what they
  // typed doesn't match the exact string later saved to Customer/Order (paraphrased, or the order was
  // never completed). Catch-all: any CUSTOMER message with a bare 7-10 digit run (cedula/celular shape,
  // never how a Colombian peso price is written) or an address keyword gets replaced wholesale with a
  // same-shaped fake block - the exact delivery data is never what a regression assertion checks, only
  // that the turn exists and the bot's next reply is well-formed.
  const BARE_DIGIT_RUN = /\b\d{7,10}\b/;
  const ADDR_KEYWORDS =
    /\b(barrio|cra\.?|carrera|calle|cl\.?\s?\d|kdx|vereda|manzana|mz\.?|apto\.?|urbanizaci[oó]n|kr\.?\s?\d|diagonal|transversal|tv\.?\s?\d)\b/i;
  const FAKE_DATA_BLOCK = "Cliente Ejemplo\n00000000\n3000000000\nCiudad Ejemplo\nBarrio Ejemplo\nCalle 10 # 20-30\nCasa";
  function scrubCustomerBlock(text) {
    if (typeof text !== "string") return text;
    if (BARE_DIGIT_RUN.test(text) || ADDR_KEYWORDS.test(text)) return FAKE_DATA_BLOCK;
    return text;
  }

  return {
    conversationId: conv.conversationId,
    businessId: conv.businessId,
    businessName: conv.businessName,
    status: conv.status,
    humanControl: conv.humanControl,
    messages: conv.messages.map((m) => ({
      role: m.role,
      content: m.role === "CUSTOMER" ? scrubCustomerBlock(scrub(m.content)) : scrub(m.content),
      imageAnalysis: scrub(m.imageAnalysis),
    })),
  };
});

fs.writeFileSync(
  "C:/Users/Koatth/AppData/Local/Temp/claude/c--Users-Koatth-Desktop-APP-BOT/1f7f3e50-a9ef-4f81-b29a-5445a80f0294/scratchpad/conversations-anonymized.json",
  JSON.stringify(anonymized, null, 2)
);
console.log("Conversations processed:", stats.conversations);
console.log("Done. Written to conversations-anonymized.json");
