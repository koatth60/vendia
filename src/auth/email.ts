// E29 (2026-09-18). EL CORREO NO DISTINGUE MAYUSCULAS, Y ESO NO PUEDE DEPENDER DE QUE ALGUIEN SE ACUERDE.
//
// Hasta hoy el alta guardaba el correo tal cual llegaba y el login buscaba tal cual lo escribian. O sea
// que quien se registro como "Milena@gmail.com" no entraba escribiendo "milena@gmail.com" -- le decia
// "Credenciales inválidas", que es mentira: la contrasena era correcta. Y peor: se podian crear DOS
// cuentas con el mismo correo escrito distinto, y las dos eran validas.
//
// ESTA FUNCION NO ES LA GARANTIA, y decirlo importa. La garantia son los indices unicos sobre
// lower("email") de Business y TeamMember (migracion 20260918200000_correo_sin_mayusculas): con ellos,
// dos cuentas que solo difieren en mayusculas NO PUEDEN EXISTIR, aunque una ruta futura se olvide de
// llamar aca. La funcion es para que el error salga como un 400 claro en vez de como una violacion de
// indice.

/**
 * Minusculas y sin espacios alrededor. No se toca nada mas: los puntos de Gmail y los `+etiqueta` son
 * direcciones distintas para otros proveedores, y "arreglarlos" seria decidir por el cliente cual es su
 * correo.
 */
export function normalizarCorreo(valor: unknown): string {
  return String(valor ?? "").trim().toLowerCase();
}
