-- El webhook de WhatsApp manda en cada mensaje el nombre de perfil del cliente
-- (contacts[0].profile.name) y hasta ahora lo tirabamos. Por eso la bandeja mostraba numeros crudos y
-- el bot tenia que gastar un turno preguntando como se llama la persona.
--
-- Campo propio y no reutilizar `name`: ese es el nombre autoritativo (lo que la clienta dijo, o lo que
-- el dueno escribio a mano), mientras que este se refresca en cada mensaje y la persona lo puede cambiar
-- cuando quiera. Compartir campo significaria que un cambio de perfil ajeno borra el nombre bueno.
ALTER TABLE "Customer" ADD COLUMN "whatsappProfileName" TEXT;
