// EL SERVICE WORKER DE ONIX (2026-09-18).
//
// Dos trabajos, y ninguno mas:
//
//   1. Que el panel abra sin esperar a la red. El cascaron (HTML, CSS, JS, iconos) se guarda una vez
//      y se sirve desde el telefono; la version nueva se busca por detras.
//   2. Avisar cuando hay version nueva, sin sacar a nadie de la sesion. El aviso lo muestra el panel
//      (ver el banner "Hay una version nueva") y recien cuando la persona toca Actualizar este worker
//      toma el control.
//
// LO QUE NUNCA SE CACHEA: todo lo que cuelga de /admin/api y /auth. Son los datos del negocio y las
// respuestas de la sesion; servir una version vieja de eso seria mostrarle a la duena un pedido que ya
// no existe. Solo se cachea lo que es igual para todos.
//
// BUILD lo inyecta el servidor con el hash de los archivos del panel (ver src/index.ts). No es un
// numero que alguien tenga que acordarse de subir: cambia solo cuando cambia el panel, y no cambia
// cuando el proceso se reinicia sin cambios.
const BUILD = "__BUILD__";
const CACHE = `onix-${BUILD}`;

// El minimo para que la aplicacion abra estando sin señal. El resto entra al cache a medida que se usa.
const CASCARON = [
  "/admin/",
  "/admin/index.html",
  "/admin/css/admin.css",
  "/admin/css/tokens.css",
  "/admin/js/admin.js",
  "/admin/js/theme.js",
  "/img/pwa/onix-192.png",
  "/img/pwa/onix-512.png",
];

self.addEventListener("install", (event) => {
  // Sin skipWaiting: un worker nuevo NO toma el control solo. Cambiar el codigo debajo de una persona
  // que esta escribiendo un mensaje es exactamente lo que este diseño evita; espera a que toque
  // Actualizar.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CASCARON)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const nombres = await caches.keys();
      await Promise.all(nombres.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// El panel pide tomar el control cuando la persona toca Actualizar.
self.addEventListener("message", (event) => {
  if (event.data === "onix:activar-ahora") self.skipWaiting();
});

function esDeDatos(url) {
  return url.pathname.startsWith("/admin/api") || url.pathname.startsWith("/auth") || url.pathname.startsWith("/socket.io");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (esDeDatos(url)) return;

  // Cascaron: se sirve lo guardado de una y se revalida por detras (stale-while-revalidate). Asi la
  // aplicacion abre instantanea y la version nueva queda lista para el proximo arranque.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const guardado = await cache.match(req);
      const red = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (guardado) {
        event.waitUntil(red);
        return guardado;
      }
      const res = await red;
      // Sin red y sin cache: si es una navegacion, al menos sale el panel guardado.
      if (!res && req.mode === "navigate") return (await cache.match("/admin/index.html")) || Response.error();
      return res || Response.error();
    })()
  );
});
