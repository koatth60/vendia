import { deflateSync } from "node:zlib";

// UN PNG CON TEXTO, HECHO A MANO (2026-09-18).
//
// Existe para una sola cosa: que las conversaciones de prueba puedan mandar un comprobante de pago que
// se pueda LEER. El flujo del comprobante pasa por el modelo de visión, así que una imagen cualquiera
// no sirve -- tiene que decir algo, y tiene que decirlo con letras que se distingan.
//
// Se escribe a mano porque el proyecto no tiene ninguna librería de imágenes, y meter una (sharp,
// canvas) para generar un rectángulo con texto en las pruebas sería pagar una dependencia nativa, con
// su compilación y su superficie de seguridad, por algo que sale en sesenta líneas de zlib.
//
// NADA de esto corre en produccion: solo lo llama src/whatsapp/simulacion.ts, y solo para medios cuyo
// id empieza con "sim.".

/**
 * Tipografía de 5x7, un bit por píxel, una fila por número.
 *
 * Cada carácter son 7 filas de 5 bits. Es la fuente mínima que un modelo de visión lee sin dudar, y
 * cubre lo que hace falta para un comprobante: letras, dígitos, y los signos del dinero y la fecha.
 */
const FUENTE: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ",": [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  "-": [0, 0, 0, 0x1f, 0, 0, 0],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  $: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  "*": [0, 0x0a, 0x04, 0x1f, 0x04, 0x0a, 0],
  "#": [0x0a, 0x1f, 0x0a, 0x0a, 0x0a, 0x1f, 0x0a],
};

const ANCHO = 720;
const ESCALA = 4;
const ALTO_DE_LINEA = 7 * ESCALA + 10;
const MARGEN = 28;

function trozo(tipo: string, datos: Buffer): Buffer {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (const byte of datos) c = TABLA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Dibuja las líneas de texto en un PNG y devuelve sus bytes.
 *
 * Fondo blanco y tinta negra a propósito: es lo que mejor lee un modelo de visión, y un comprobante de
 * verdad tampoco tiene más color que ese.
 */
export function pngConTexto(lineas: string[]): Buffer {
  const alto = MARGEN * 2 + lineas.length * ALTO_DE_LINEA;
  // RGB, tres bytes por pixel, mas el byte de filtro al principio de cada fila.
  const filas = Buffer.alloc(alto * (1 + ANCHO * 3), 0xff);
  for (let y = 0; y < alto; y++) filas[y * (1 + ANCHO * 3)] = 0;

  const pintar = (x: number, y: number) => {
    if (x < 0 || x >= ANCHO || y < 0 || y >= alto) return;
    const base = y * (1 + ANCHO * 3) + 1 + x * 3;
    filas[base] = 0x11;
    filas[base + 1] = 0x11;
    filas[base + 2] = 0x11;
  };

  lineas.forEach((linea, indice) => {
    const arriba = MARGEN + indice * ALTO_DE_LINEA;
    let cursor = MARGEN;
    for (const caracter of linea.toUpperCase()) {
      const glifo = FUENTE[caracter] ?? FUENTE[" "];
      for (let fila = 0; fila < 7; fila++) {
        for (let columna = 0; columna < 5; columna++) {
          if (!(glifo[fila] & (1 << (4 - columna)))) continue;
          for (let dy = 0; dy < ESCALA; dy++) {
            for (let dx = 0; dx < ESCALA; dx++) {
              pintar(cursor + columna * ESCALA + dx, arriba + fila * ESCALA + dy);
            }
          }
        }
      }
      cursor += 6 * ESCALA;
    }
  });

  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ANCHO, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera[8] = 8; // bits por canal
  cabecera[9] = 2; // color RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo("IHDR", cabecera),
    trozo("IDAT", deflateSync(filas)),
    trozo("IEND", Buffer.alloc(0)),
  ]);
}

/** Un comprobante de transferencia que se parece a los que manda la gente de verdad. */
export function comprobanteDePago(params: { monto: string; metodo: string; referencia: string; fecha: string }): Buffer {
  return pngConTexto([
    params.metodo,
    "",
    "TRANSFERENCIA EXITOSA",
    "",
    `VALOR: $${params.monto}`,
    `FECHA: ${params.fecha}`,
    `REF: ${params.referencia}`,
    "",
    "COMPROBANTE No 00457821",
  ]);
}
