# Prompt para desplegar el rediseño

Abrí una terminal, entrá a la carpeta del proyecto y arrancá Claude Code:

```
cd "C:\Users\Koatth\Desktop\APP BOT"
claude
```

Y pegá esto tal cual:

---

Los cambios del rediseño completo del panel ya están escritos en el working tree,
sin commitear. No los hiciste vos: vinieron de otra sesión. **No rediseñes nada
ni "mejores" el CSS.** Tu trabajo es verificar, commitear y desplegar.

Contexto de qué cambió, para que sepas qué mirar:

- `public/admin/css/tokens.css` (nuevo) — el sistema de color/tipografía. Tema
  claro y oscuro. Ningún otro archivo puede tener un color literal.
- `public/admin/css/auth.css` (nuevo) — login, registro y recuperar contraseña,
  que antes tenían el mismo `<style>` inline copiado tres veces.
- `public/admin/js/theme.js` (nuevo) — el conmutador de tema.
- `public/admin/css/admin.css` — reescrito sobre tokens. Las variables viejas
  (`--brand`, `--card`, …) quedaron como alias de los tokens.
- `public/admin/index.html` — las pestañas horizontales pasaron a barra lateral.
  El router de `admin.js` no se tocó: sigue funcionando por `data-tab`,
  `data-section` y `data-section-group`.
- `public/admin/js/admin.js` — **un solo cambio**: `loadAnalytics()` reescrita.
  Las tablas planas ahora son barras.
- `public/index.html`, `login.html`, `signup.html`, `forgot-password.html` —
  migradas a tokens, con el conmutador de tema.
- `public/img/zaqi-mark.svg`, `favicon.ico`, `favicon-32.png`,
  `apple-touch-icon.png` — marca nueva (hoja).
- `src/index.ts` — cabeceras de `Cache-Control` en `express.static`, para que
  después de desplegar nadie se quede con el CSS viejo.

Reglas duras:

- **No toques `src/ai/`.** Nada del rediseño lo afecta.
- **No corras `npm run regression` ni `npm run test:paid`.** Llaman a la API de
  DeepSeek de verdad y cuestan dinero real.
- No commitees `.env`.
- Si algo falla, **pará y explicámelo en castellano simple, sin jerga.** No
  intentes arreglarlo por tu cuenta salvo que sea obvio y de una línea.

Hacé esto, en orden:

**1.** `git status` para ver el alcance, y creá la rama `redesign/completo`.

**2.** Commiteá todo con el mensaje:
`Rediseno completo del panel: tokens, tema claro/oscuro, responsive, analytics con graficos, marca nueva`

**3.** Corré `npm run build` y `npm test`. Si alguno falla, pará y contame.

**4.** Levantá `npm run dev` y verificá estas seis cosas, que son donde el
rediseño tocó contratos con el JavaScript. Contame el resultado de cada una:

   1. Las 5 secciones (Inicio, CRM, Catálogo, Bot, Negocio) navegan, y los
      contadores de CRM y Catálogo muestran números reales.
   2. En CRM → Bandeja, abrí una conversación: el nombre del cliente NO se monta
      sobre "Cerrar venta" / "Tomar control". Probá editar el nombre con el
      lápiz, guardar y cancelar. Probalo también angostando la ventana a ~390px.
   3. Negocio → Analytics: las tres barras (estados, mensajes por día, productos)
      cargan con datos reales. Esta es la única función de JS que se reescribió.
   4. Bot → Personalidad: prendé y apagá un interruptor, dale Guardar cambios,
      recargá la página y confirmá que quedó guardado.
   5. Catálogo: agregá un producto con una variante de color.
   6. El botón de tema (sol / luna / monitor) cicla entre los tres estados y
      sobrevive al refresh. Probá el panel entero en claro y en oscuro.

**5.** Si los seis pasan, desplegá a producción como está documentado en el
README: empaquetar el proyecto sin `node_modules`, `.env` ni `dist`, subirlo por
SSH al droplet de DigitalOcean, y en el servidor correr `npm ci`,
`npx prisma migrate deploy`, `npm run build` y `pm2 restart vendia --update-env`.
Si no encontrás el host o la clave SSH configurados, **pará y preguntame**; no
adivines credenciales.

**6.** Después de desplegar, abrí `https://zaqisolutions.com` y
`https://zaqisolutions.com/admin` en una ventana **normal** (no incógnito) y
confirmá que se ve el diseño nuevo sin forzar recarga. Esa es la prueba de que
las cabeceras de caché quedaron bien. Verificá también que el favicon cambió.

Al final, un resumen corto: qué commiteaste, qué pasó en cada una de las seis
verificaciones, y si el deploy quedó arriba.
