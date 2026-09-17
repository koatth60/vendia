# Rediseño del panel — plan de implementación

Dirección **A** (consola), tema claro y oscuro. Este archivo es el contrato entre
el diseño y el código: si algo no está acá, no está decidido.

Entradas:

- `design/tokens.css` — el sistema de color/tipografía/espacio. **Es la fuente de verdad.**
- El lienzo de diseño (22 artboards) — exportá los PNG y dejalos en `design/onix-a/`
  con el nombre de la pantalla (`inicio.png`, `crm-bandeja.png`, …). Claude Code
  trabaja mejor con el PNG al lado del código que con una descripción.

---

## La decisión que hace barato el dark mode

**Ningún color literal fuera de `tokens.css`.** Ni un `#1fa855`, ni un `rgba(...)`,
ni un `white`. Todo pasa por `var(--onix-*)`.

Con eso, claro y oscuro no son dos hojas de estilo ni dos componentes: son el
mismo CSS leyendo otro valor. Las 9 pantallas claras del lienzo se generaron así
—sustituyendo tokens sobre las oscuras— justamente para probar que alcanza.

Guardia para que no se degrade (corré esto antes de cada commit):

```bash
grep -nEi '#[0-9a-f]{3,8}\b|rgba?\(' public/admin/css/admin.css \
  | grep -v '^design/tokens.css' \
  && echo "FALLA: hay color literal fuera de tokens.css" && exit 1
```

Poné ese grep en `.github/workflows` junto a `tsc --noEmit`. Es la única regla
que necesita vigilancia automática; el resto se ve a simple vista.

---

## El cambio estructural (lo único que no es cosmético)

El panel pasa de **tabs horizontales arriba** a **barra lateral de 248 px**.
Eso toca el layout raíz de `public/admin/index.html` y el router de `admin.js`
(los `#/inicio`, `#/conversations`, … siguen igual; cambia dónde se pintan).

Todo lo demás —tarjetas, filas, chips, campos, gráficos— es reemplazo de estilos
sobre el mismo DOM. Hacelo en ese orden: primero el esqueleto, después el relleno.

---

## Fases

Cada fase es **una rama y un PR**. No juntes dos: si el tema oscuro sale mal en
la fase 4 querés poder mirar solo esa fase.

### Fase 0 · Tokens y toggle

1. `cp design/tokens.css public/admin/css/tokens.css` y enlazalo **antes** de
   `admin.css` en `index.html`, `login.html`, `signup.html`, `forgot-password.html`.
2. Toggle de tema. Tres estados: `claro`, `oscuro`, `sistema` (por defecto).
   Guardalo en `localStorage` bajo `onix-theme`.
3. **Evitá el flashazo blanco**: este script va *inline en el `<head>`*, antes de
   cualquier CSS. Si lo ponés al final del body, el usuario ve un fogonazo en
   cada carga.

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem('onix-theme');
      if (t === 'light' || t === 'dark') {
        document.documentElement.setAttribute('data-theme', t);
      }
    } catch (e) { /* modo incógnito: se queda en 'sistema', que es correcto */ }
  })();
</script>
```

4. El control va en el pie de la barra lateral, junto al email.

**Listo cuando:** el toggle cambia el tema en las cuatro páginas, sobrevive al
refresh, y `admin.css` sigue intacto (todavía fea, pero funcionando).

### Fase 1 · Esqueleto

Barra lateral 248 px + barra superior 60 px + área de contenido.
Subnavegación en píldoras para CRM, Bot y Negocio.
Iconos: SVG inline, trazo 1,6 px, grilla de 18 px. **Fuera los emoji** —
hoy `🏠💬📦🤖🏢` son la mitad de la sensación de "plantilla".

**Listo cuando:** las 5 secciones navegan y el chrome es idéntico en todas
(sale del mismo bloque de HTML, no de cinco copias).

### Fase 2 · Inicio

Lista de atención con la fila crítica en `--onix-danger-soft`, franja de 4
métricas, chequeo de configuración en dos columnas.

### Fase 3 · CRM

Bandeja (dos paneles), Clientes (tabla con cabecera), Pedidos (tarjeta de pedido
con total a la derecha). Es la fase más larga: hacela en tres commits.

### Fase 4 · Catálogo

Formulario a la izquierda (520 px fijos), grilla de productos a la derecha.
Las variantes de color llevan muestra circular, no solo texto.

### Fase 5 · Bot

Personalidad, Reglas, FAQ, Pagos, Envíos, Canales, Salud.
Los checkboxes pasan a switches. Salud reutiliza las tarjetas de métrica de Inicio.

### Fase 6 · Negocio y Analytics

Acá hay trabajo real, no solo estilos: **las tablas planas pasan a barras.**

- Embudo por estado: barras horizontales proporcionales al máximo.
- Mensajes por día: barras agrupadas, dos series.
- Productos más consultados: barras horizontales, una sola serie.

Reglas que no son opcionales:

- Series desde `--onix-series-*`. Están validadas para daltonismo **en los dos
  temas**; si inventás un color, rompés eso.
- Un valor de 0 **no dibuja barra**. Ni un pixel «para que se vea algo».
- Dos series o más ⇒ leyenda siempre presente.
- Tooltip al hover en cada barra (el diseño es estático, la implementación no).
- Nunca dos ejes Y.

### Fase 7 · Auth

`login.html`, `signup.html`, `forgot-password.html`. Campos de 46 px,
botón de 48 px, panel derecho con la demo de conversación.

### Fase 8 · Landing en oscuro

`public/index.html`. Mismo `tokens.css`, mismo toggle, mismo `localStorage`
(así el tema viaja de la landing al panel sin que el usuario lo vuelva a elegir).
La estructura no se toca: solo tokens y el halo verde del hero.

### Fase 9 · Marca

Cuando esté elegida la construcción del logo: SVG nuevo en `public/img/`,
más `favicon.ico` a 16/32/48 con la versión simplificada.

---

## Cómo trabajar esto con Claude Code

**Agregá esto a `CLAUDE.md`** (el repo ya tiene reglas de costo; esto se suma):

```md
# Rediseño (dirección A)

- Ningún color literal fuera de `public/admin/css/tokens.css`. Siempre `var(--onix-*)`.
- Claro y oscuro comparten el CSS: si una regla necesita `[data-theme]` fuera de
  tokens.css, el token que falta es el problema — agregalo, no bifurques la regla.
- Chrome (sidebar, topbar, subnav) se escribe una vez y se reutiliza. Nunca copiar.
- Iconos: SVG inline, trazo 1,6px. Nunca emoji.
- Números en `.onix-num` (monoespaciada, tabular).
- El plan y el estado de cada fase están en `design/ONIX-REDESIGN-PLAN.md`.
```

**El prompt de cada fase** — mismo molde, cambiando el número:

> Fase 3 del rediseño. Leé `design/ONIX-REDESIGN-PLAN.md` y `design/tokens.css`,
> y mirá `design/onix-a/crm-bandeja.png`, `crm-clientes.png` y `crm-pedidos.png`.
> Implementá esas tres vistas en `public/admin/` respetando los valores exactos
> del diseño: no redondees paddings ni radios a múltiplos de 4. Un commit por
> vista. Al terminar corré el grep de color literal y `npx tsc --noEmit`.

Tres cosas que te van a ahorrar plata y dolores de cabeza:

1. **Una fase por sesión.** `admin.js` pesa 164 KB y `admin/index.html` 47 KB;
   si abrís las tres cosas a la vez en una sesión, el contexto se llena de
   archivo y no de trabajo. El propio `CLAUDE.md` del repo ya lo dice: leer con
   `offset`/`limit` o `Grep`, no volcar el archivo entero.
2. **Nada de esto toca el bot.** `src/ai/*`, el prompt de Onix y las
   herramientas quedan igual. No corras `npm run regression` ni `test:paid` por
   un cambio de CSS — son llamadas reales a DeepSeek y cuestan.
3. **Revisá cada fase en los dos temas antes de mergear.** Es un vistazo de
   treinta segundos y es donde aparecen el 100% de los errores de contraste.

---

## Checklist por fase

- [ ] El grep de color literal pasa
- [ ] Se ve bien en claro **y** en oscuro
- [ ] El chrome no se duplicó
- [ ] Cero emoji como iconos
- [ ] Los números usan `.onix-num`
- [ ] Toque mínimo de 44 px en móvil
- [ ] `npx tsc --noEmit` limpio
- [ ] `npm test` (solo al cerrar la fase, no en cada commit)

---

## Lo que queda pendiente de decisión tuya

1. **Construcción del logo** (A calada / B suelta a dos verdes / C en anillo).
   Hasta que elijas, las pantallas siguen con la gota actual.
2. **Las tres cifras del hero de la landing.** Si no querés publicarlas, se borra
   esa franja y el hero queda igual de sólido.
3. **Tema por defecto.** Mi recomendación: `sistema`. El panel se usa de día y de
   noche, y respetar el sistema operativo evita la discusión.
