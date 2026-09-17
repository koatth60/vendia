/**
 * Servidor estatico de public/ para revisar la landing sin levantar la app.
 *
 * `npm run dev` arranca el servidor real: base de datos, WhatsApp y tareas
 * programadas. Para mirar un cambio de CSS eso sobra y ademas toca sistemas
 * vivos. Esto solo entrega archivos.
 *
 *   node scripts/serve-public.mjs [puerto]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const ROOT = join(process.cwd(), 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 4311);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';

  const full = normalize(join(ROOT, path));
  if (!full.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(full);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: path + '/' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('no existe: ' + path);
  }
}).listen(PORT, () => {
  console.log(`public/ servido en http://localhost:${PORT}`);
});
