-- Un negocio con WhatsApp conectado no puede estar esperando activacion (2026-09-18).
--
-- Business.active existia desde antes pero solo lo leia el login. Cuando el alta dejo de exigir
-- clave (commit 91bca98) ese campo paso a decidir dos cosas visibles: el cartel "tu cuenta todavia
-- no esta activada" en el panel del cliente y el 403 al conectar WhatsApp. Lo que nadie miro es que
-- el webhook YA lo leia: whatsapp.ts descarta los mensajes entrantes de un negocio con active=false.
--
-- Resultado: un negocio al que Zaqi le conecto el numero desde la consola de plataforma se quedaba
-- en active=false (ese endpoint escribia las credenciales sin tocar el campo), y entonces veia el
-- cartel siendo un cliente que ya paga, Y tenia el bot mudo sin que ningun error lo dijera. Se
-- reporto desde produccion el 2026-09-18.
--
-- Esta migracion arregla las filas que ya quedaron asi. El endpoint se arreglo en el mismo commit,
-- que es lo que impide que vuelva a pasar.
--
-- Por que es seguro activar por tener numero: conectar WhatsApp nunca fue algo que un cliente
-- pudiera hacer solo estando inactivo (la ruta del panel devuelve 403), asi que un numero puesto
-- solo puede venir de antes de la funcion o de que Zaqi lo conecto a mano. Las dos cosas son una
-- cuenta activada de verdad.
UPDATE "Business"
SET "active" = true
WHERE "whatsappPhoneNumberId" IS NOT NULL
  AND "active" = false;
