import { prisma } from "../db/client";
import { normalizeForMatch } from "../search/text";

// QUE ES UN NOMBRE Y QUE NO (2026-09-18).
//
// La ficha del cliente se estaba llenando de cosas que no son nombres. Medido sobre 25 fichas de
// prueba, 22 estaban mal, y en tres clases distintas:
//
//   1. Lo que el bot dice cuando no hay nombre:  "No proporcionado", "No especificado", "No indicado",
//      "Sin nombre aun", "Pendiente", "No disponible", "Cliente".
//   2. Un producto del catalogo:                 "Smartwatch V20 Caballero".
//   3. El mensaje entero:                        "Hernan Gil, cedula 1098765432, celular 3112223344...".
//
// Y antes ya habia pasado con una forma de pago ("Contraentrega"), que es la clase que ya estaba tapada.
//
// La tentacion es una lista de palabras prohibidas. Esa lista no converge -- el propio comentario del
// backstop viejo de agent.ts lo dice, y por ahi entro "Contraentrega" -- porque cada vez que el modelo
// inventa una forma nueva de decir "no me lo dijo" hay que acordarse de agregarla.
//
// Las tres comprobaciones de aca no son listas: son propiedades que se calculan.
//
//   - Un nombre no es un producto ni una categoria de ESTE negocio. Es un SELECT contra su propio
//     catalogo. Mata la clase 2, y se mantiene sola cuando el catalogo cambia. Va primero porque un
//     producto como "Smartwatch V20 Caballero" tambien tiene digitos, y el motivo que se le devuelve
//     al modelo tiene que ser el verdadero.
//   - Un nombre no lleva digitos. Es una propiedad de los caracteres, no una palabra que haya que
//     acordarse. Mata la clase 3 entera.
//   - Un nombre lo tiene que haber ESCRITO el cliente. Es un SELECT contra sus propios mensajes. Mata
//     la clase 1 entera y cualquier forma futura de decir lo mismo, porque el cliente nunca escribio
//     "No especificado": eso lo puso el modelo.
//
// La tercera es la que cierra la clase de defecto, no un caso: el modelo no puede guardar un nombre
// que nadie dijo.

export type RechazoDeNombre = { motivo: "digitos" | "producto" | "no-lo-dijo"; detalle: string };

/** Cuantas palabras puede tener un nombre antes de que sea claramente otra cosa. */
const MAXIMO_DE_PALABRAS = 6;

/**
 * Devuelve por qué ese texto no puede guardarse como nombre, o `null` si sí puede.
 *
 * No decide si el nombre es "bonito" ni si está bien escrito: sólo descarta lo que demostrablemente
 * pertenece a otro campo o lo que el cliente nunca dijo.
 */
export async function porQueNoEsUnNombre(params: {
  businessId: string;
  customerId: string;
  nombre: string;
}): Promise<RechazoDeNombre | null> {
  const nombre = params.nombre.trim();

  const normalizado = normalizeForMatch(nombre);

  // Contra el catalogo del propio negocio: producto, categoria o color. Si el cliente escribio el
  // nombre de lo que quiere comprar, eso es el pedido, no quien lo compra.
  const [productos, categorias] = await Promise.all([
    prisma.product.findMany({ where: { businessId: params.businessId }, select: { name: true, category: true } }),
    prisma.categoryAlias.findMany({ where: { businessId: params.businessId }, select: { canonical: true, synonym: true } }),
  ]);
  const delCatalogo = new Set<string>();
  for (const p of productos) {
    delCatalogo.add(normalizeForMatch(p.name));
    if (p.category) delCatalogo.add(normalizeForMatch(p.category));
  }
  for (const c of categorias) {
    delCatalogo.add(normalizeForMatch(c.canonical));
    delCatalogo.add(normalizeForMatch(c.synonym));
  }
  if (delCatalogo.has(normalizado)) {
    return {
      motivo: "producto",
      detalle: `"${nombre}" es algo del catalogo de este negocio, no el nombre de una persona. Eso va en el pedido; volve a pedirle el nombre al cliente.`,
    };
  }

  if (/\d/.test(nombre)) {
    return {
      motivo: "digitos",
      detalle: `"${nombre}" tiene numeros, asi que no es un nombre: es el mensaje entero o un dato de otro campo. Guarda la cedula y el celular con save_customer_contact_info y deja en el nombre solo el nombre.`,
    };
  }

  if (nombre.split(/\s+/).length > MAXIMO_DE_PALABRAS) {
    return {
      motivo: "digitos",
      detalle: `"${nombre.slice(0, 60)}..." es demasiado largo para ser un nombre. Guarda solo el nombre de la persona.`,
    };
  }

  // Lo tiene que haber escrito el cliente. Se mira contra SUS mensajes, no contra los del bot: un
  // nombre que solo aparece en lo que escribio el bot es un nombre que el bot invento.
  const suyos = await prisma.message.findMany({
    where: { conversation: { customerId: params.customerId }, role: "CUSTOMER" },
    select: { content: true },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  // Mensaje por mensaje, no todos pegados: pegandolos, un nombre podria "aparecer" a caballo entre el
  // final de uno y el principio de otro, que es una coincidencia que nadie escribio.
  const loDijo = suyos.some((m) => normalizeForMatch(m.content ?? "").includes(normalizado));
  if (!loDijo) {
    return {
      motivo: "no-lo-dijo",
      detalle: `El cliente nunca escribio "${nombre}", asi que no se guardo nada. Si todavia no te dio su nombre, no inventes uno ni guardes "no proporcionado": dejalo vacio y preguntaselo.`,
    };
  }

  return null;
}
