import helmet from "helmet";
import type { RequestHandler } from "express";

// Fase 8, punto 8 del plan maestro (2026-09-15): la aplicacion no mandaba ninguna cabecera de
// seguridad. Sin Content-Security-Policy, cualquier inyeccion de HTML en el panel puede cargar y
// ejecutar un script de otro dominio; sin X-Content-Type-Options el navegador adivina el tipo de una
// respuesta y puede ejecutar como script algo que no lo es; sin frame-ancestors la pagina se puede
// embeber en un iframe ajeno.
//
// Honestidad sobre el alcance: script-src lleva 'unsafe-inline'. El panel tiene bloques <script>
// embebidos y unos 200 manejadores onclick= en el HTML; una CSP sin 'unsafe-inline' lo deja inservible.
// Sacarlo es un trabajo aparte (mover los handlers a addEventListener y los bloques a archivos), no
// parte de esta fase. Lo que si aporta hoy: ningun script de un origen que no este en esta lista se
// ejecuta, que es lo que corta un XSS que intente traer su carga util de afuera.
const FACEBOOK_SDK = "https://connect.facebook.net";
const FACEBOOK_FRAMES = "https://*.facebook.com";
// Los medios se sirven con URLs prefirmadas de S3 (ver src/media/s3.ts), no desde nuestro dominio.
const S3_MEDIA = "https://*.amazonaws.com";

export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", FACEBOOK_SDK],
      // Las fuentes vienen de Google Fonts (ver public/admin/index.html) y hay ~99 atributos style= en
      // el marcado.
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:", S3_MEDIA, FACEBOOK_FRAMES],
      "media-src": ["'self'", "blob:", S3_MEDIA],
      // 'self' cubre tambien el WebSocket de Socket.IO al mismo origen.
      "connect-src": ["'self'", FACEBOOK_SDK, "https://graph.facebook.com"],
      // El popup de Embedded Signup crea iframes ocultos del lado de Facebook.
      "frame-src": [FACEBOOK_SDK, FACEBOOK_FRAMES],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'self'"],
      "upgrade-insecure-requests": [],
    },
  },
  // same-origin a secas rompe el popup de Embedded Signup: el popup necesita window.opener para
  // devolver el `code`. -allow-popups conserva el aislamiento y deja pasar ese caso.
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  // El SDK de Facebook y las fuentes son recursos de terceros que carga el navegador, no que servimos
  // nosotros; esta cabecera aplica a NUESTRAS respuestas y no las afecta.
  crossOriginResourcePolicy: { policy: "same-origin" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
});
