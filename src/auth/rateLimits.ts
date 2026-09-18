import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

// E29 (2026-09-18). LIMITE DE TASA EN EL PANEL.
//
// `authRouter` tenia limitador desde siempre; TODO el resto de `/admin/api/*` no tenia ninguno. O sea
// que la puerta de entrada estaba cuidada y adentro no habia nada: una sesion valida podia pedir lo que
// quisiera, tan rapido como quisiera. Con varios clientes en el mismo servidor, un panel con un bucle
// (una pestana que recarga mal, un script de alguien) baja el panel de todos.
//
// LA CLAVE ES EL NEGOCIO, NO LA IP, cuando hay sesion. Con la IP como unica clave, dos empleadas del
// mismo local detras del mismo router comparten cupo y se limitan entre ellas, mientras que un mismo
// negocio desde cuatro conexiones distintas tiene cuatro cupos. El recurso que se protege es el
// servidor compartido, y quien lo consume es el inquilino.

/**
 * Clave: el negocio cuando hay sesion, la IP cuando no. `ipKeyGenerator` y no `req.ip` pelado porque
 * express-rate-limit v8 normaliza IPv6 ahi -- sin eso, cada peticion desde IPv6 puede verse como una
 * direccion distinta y el limite no limita nada.
 */
function porNegocioOIp(req: Request): string {
  const businessId = req.session?.businessId;
  return businessId ? `business:${businessId}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * El limite general del panel. Alto a proposito: la Bandeja abierta hace muchas peticiones legitimas
 * (conversaciones, mensajes, contadores) y un limite apretado seria un panel que se traba solo. Esto no
 * esta para frenar el uso normal, esta para que un bucle no se lleve puesto el servidor de todos.
 */
export const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: porNegocioOIp,
  message: { error: "Demasiadas peticiones. Espera unos segundos." },
});

/**
 * Lo que cuesta plata o disco: subidas de archivo y "mejorar redacción", que llama al modelo.
 *
 * Va aparte y mucho mas bajo porque el limite general no lo cubre: 300 peticiones por minuto son nada
 * para leer conversaciones y son 300 llamadas al modelo o 300 archivos a S3 si el limite es uno solo.
 * El techo de gasto (`checkSpendCeiling`) tampoco alcanza: corta cuando ya se gasto.
 */
export const adminCostlyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: porNegocioOIp,
  message: { error: "Demasiadas subidas seguidas. Espera unos segundos." },
});
