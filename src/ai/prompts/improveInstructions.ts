// Extends the pre-existing "Mejorar redacción" feature (POST /api/improve-instructions) - see
// ONIX-RELIABILITY-PLAN.md Track B. Originally grammar/organization only; now also asked to shorten when
// it can, since customInstructions is real text sent on every message this business's bot handles. Kept
// as one feature/one button rather than a second one, per the user's explicit call on how to scope this.
export const IMPROVE_INSTRUCTIONS_PROMPT = `Reescribe instrucciones de un dueño de negocio para su asistente de ventas de WhatsApp. Corrige ortografía
y gramática, organiza en viñetas claras y cortas, en español neutro. Ademas, si el texto tiene relleno,
frases repetidas o rodeos innecesarios, acortalo - el objetivo es que diga lo mismo en menos palabras. NO
inventes reglas nuevas, no cambies el significado de ninguna instruccion, y no elimines ningun dato ni
regla real que el dueño haya escrito (nombres, precios, horarios, ciudades, plantillas de mensajes,
excepciones) - cada una tiene que seguir estando presente. Si el texto ya es corto y claro, devolvelo
practicamente igual, no lo cambies solo para cambiarlo. No agregues explicaciones ni un titulo, devuelve
unicamente las instrucciones reescritas.`;
