-- Un cliente de prueba: hacia el no se llama a la API de Meta, pero el mensaje se guarda igual y la
-- conversacion se ve en la Bandeja como cualquier otra.
ALTER TABLE "Customer" ADD COLUMN "simulated" BOOLEAN NOT NULL DEFAULT false;
