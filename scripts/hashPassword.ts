// E29 (2026-09-18). Genera el hash bcrypt de la contrasena de la consola de plataforma.
//
//   npm run hash:password -- 'la-contrasena-de-verdad'
//
// Se pega el resultado en PLATFORM_ADMIN_PASSWORD_HASH y SE BORRA PLATFORM_ADMIN_PASSWORD. Mientras las
// dos esten, manda el hash y la de texto plano se ignora -- pero sigue estando en el entorno, que es
// justamente lo que esta etapa vino a sacar.
//
// La contrasena se pasa como argumento y no se pide por entrada estandar a proposito: asi el comando
// tambien sirve desde un script. Queda en el historial del shell, asi que conviene borrarla de ahi
// despues (o escribir el comando con un espacio adelante, que en bash con HISTCONTROL=ignorespace no lo
// guarda).
import { hashPassword } from "../src/auth/service";

const clave = process.argv[2];
if (!clave) {
  console.error("Falta la contrasena.\n\n  npm run hash:password -- 'la-contrasena'\n");
  process.exit(1);
}

hashPassword(clave).then((hash) => {
  console.log("\nPonelo en el entorno del servidor y borra PLATFORM_ADMIN_PASSWORD:\n");
  console.log(`PLATFORM_ADMIN_PASSWORD_HASH='${hash}'\n`);
});
