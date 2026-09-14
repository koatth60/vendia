import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { readFileSync, writeFileSync } from 'node:fs';

/* Audita el panel REAL: toma index.html, le saca los scripts (no hay backend
   acá), destapa todos los tab-panel y subnav a la vez y mide en cada ancho:
     - desborde horizontal de la página
     - elementos que se salen del viewport por la derecha
     - hermanos que se solapan (el bug que reportó Carlos)
     - blancos táctiles por debajo de 44px en móvil
   No juzga estética: solo reporta lo que está roto geométricamente. */

const WIDTHS = [
  [360, 'celular chico'],
  [390, 'celular'],
  [768, 'tablet vertical'],
  [1024, 'tablet'],
  [1440, 'escritorio'],
];

let html = readFileSync('../out/public/admin/index.html', 'utf8');
html = html
  // Bajo file:// las rutas absolutas no resuelven: la sonda tiene que apuntar
  // a las copias locales o mide una página SIN estilos (y todo parece roto).
  .replace(/href="\/admin\/css\//g, 'href="')
  .replace(/<script src="[^"]*"[^>]*><\/script>/g, '')
  .replace(/<script>\s*\(function \(\) \{\s*try \{\s*var t = localStorage[\s\S]*?<\/script>/, '');

// Destapa todo y rellena lo que normalmente pinta el JS, con contenido largo
// a propósito: los nombres cortos no rompen nada, los reales sí.
html = html.replace('</body>', `
<script>
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('active'));
  document.querySelectorAll('.subnav').forEach(s => s.classList.add('active'));
  document.querySelectorAll('[hidden]').forEach(e => { if (!e.classList.contains('modal-title-input')) e.hidden = false; });
  document.querySelectorAll('.modal-overlay').forEach(m => m.remove());
  var badge = document.getElementById('session-badge');
  if (badge) badge.innerHTML = '<span class="session-email">koatth60@gmail.com</span><span class="role-pill">Dueño</span>';
  var t = document.getElementById('modal-title');
  if (t) t.textContent = 'Ximena Alejandra Velásquez Numpaque';
  var st = document.getElementById('modal-subtitle');
  if (st) st.innerHTML = '<span>573114975521</span> · <span class="stage-pill stage-COMPRADOR">Comprador</span>';
  var hb = document.getElementById('modal-handoff-btn');
  if (hb) hb.textContent = 'Tomar control';
  var dash = document.getElementById('dashboard-container');
  if (dash) dash.innerHTML = \`
    <div class="section-title">Requiere tu atención</div>
    <button type="button" class="action-card is-urgent"><div class="count">9</div><div style="min-width:0;">
      <div class="title">Preguntas del bot sin responder</div>
      <div class="sample">Diana Rincón · Pedro Antonio Gutiérrez · Vanessa</div></div></button>
    <button type="button" class="action-card"><div class="count">1</div><div style="min-width:0;">
      <div class="title">Pedidos pendientes de envío</div><div class="sample">David</div></div></button>
    <div class="section-title">Este mes</div>
    <div class="metric-grid">
      <div class="metric-card"><div class="label">Ventas del mes</div><div class="value">$1.374.300</div><div class="sub">10 pedidos</div></div>
      <div class="metric-card"><div class="label">Conversión (30 días)</div><div class="value">87.5%</div><div class="sub">14 vendidas / 2 perdidas</div></div>
      <div class="metric-card"><div class="label">Conversaciones activas</div><div class="value">21</div></div>
      <div class="metric-card"><div class="label">Satisfacción</div><div class="value">3.0/3</div><div class="sub">9 respuestas</div></div>
    </div>\`;
  var cl = document.getElementById('crm-list') || document.querySelector('#customers-list');
  if (cl) cl.innerHTML = Array.from({length:3}).map(() => \`
    <button class="crm-row"><div class="crm-row-main">
      <div class="crm-row-name">Ximena Alejandra Velásquez Numpaque</div>
      <div class="crm-row-meta">573114975521 · ximena.velasquez.numpaque@gmail.com</div></div>
      <span class="stage-pill stage-COMPRADOR">Comprador</span>
      <div class="crm-row-side">1 pedido<br/>hace 20 h</div></button>\`).join('');
</script>
</body>`);

writeFileSync('panel.html', html);

const DETECTOR = () => {
  const out = { overflow: [], overlap: [], tiny: [], wide: [] };
  const vw = document.documentElement.clientWidth;

  const inSvg = (e) => e.closest('svg') !== null;
  // Una barra que scrollea a propósito (nav, subnav, tabla ancha) SÍ tiene hijos
  // más allá del borde: eso es la feature, no el bug.
  const inScroller = (e) => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX;
      if (ov === 'auto' || ov === 'scroll') return true;
    }
    return false;
  };
  const visible = (e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (e) => {
    const id = e.id ? '#' + e.id : '';
    const cls = typeof e.className === 'string' && e.className
      ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return e.tagName.toLowerCase() + id + cls;
  };

  // 1. ¿Algo se sale por la derecha?
  for (const e of document.querySelectorAll('body *')) {
    if (!visible(e) || inSvg(e)) continue;
    const s = getComputedStyle(e);
    if (s.position === 'fixed') continue;
    const r = e.getBoundingClientRect();
    if (inScroller(e)) continue;
    if (r.width > vw + 1.5) { out.wide.push({ el: label(e), w: Math.round(r.width) }); continue; }
    if (r.right > vw + 1.5) out.overflow.push({ el: label(e), right: Math.round(r.right), padre: e.parentElement ? label(e.parentElement) : '-' });
  }

  // 2. Hermanos que se pisan (sin contar los que se superponen a propósito)
  for (const parent of document.querySelectorAll('body *')) {
    if (inSvg(parent) || parent.tagName.toLowerCase() === 'svg') continue;
    const ps = getComputedStyle(parent);
    if (ps.position === 'relative' && parent.querySelector(':scope > [style*="position: absolute"]')) continue;
    const kids = [...parent.children].filter(k => {
      if (!visible(k)) return false;
      const s = getComputedStyle(k);
      return s.position === 'static' || s.position === 'relative';
    });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) {
          out.overlap.push({ a: label(kids[i]), b: label(kids[j]), px: Math.round(ox) + 'x' + Math.round(oy) });
        }
      }
    }
  }

  // 3. Blancos táctiles chicos
  if (vw <= 640) {
    for (const e of document.querySelectorAll('button, a, input[type=checkbox], input[type=radio], select')) {
      if (!visible(e)) continue;
      // El blanco táctil de una casilla es su <label>, no el cuadradito.
      const hit = e.closest('label') || e;
      const r = hit.getBoundingClientRect();
      if (r.height < 40) out.tiny.push({ el: label(e), h: Math.round(r.height), padre: e.parentElement ? label(e.parentElement) : '-' });
    }
  }

  return {
    pageOverflow: Math.round(document.documentElement.scrollWidth - vw),
    wide: out.wide.slice(0, 8),
    overflow: out.overflow.slice(0, 12),
    overlap: out.overlap.slice(0, 12),
    tiny: out.tiny.slice(0, 12),
    counts: { wide: out.wide.length, overflow: out.overflow.length, overlap: out.overlap.length, tiny: out.tiny.length },
  };
};

const browser = await chromium.launch();
let bad = 0;
for (const [w, name] of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 } });
  await page.goto('file://' + process.cwd() + '/panel.html');
  await page.waitForTimeout(500);
  const r = await page.evaluate(DETECTOR);
  const ok = r.pageOverflow <= 1 && r.counts.overlap === 0 && r.counts.tiny === 0 && r.counts.wide === 0;
  if (!ok) bad++;
  console.log(`\n${String(w).padStart(5)}px ${name.padEnd(16)} ${ok ? 'OK' : 'PROBLEMAS'}`);
  console.log(`      desborde de pagina: ${r.pageOverflow}px · mas anchos que la pantalla: ${r.counts.wide} · se salen: ${r.counts.overflow} · se pisan: ${r.counts.overlap} · tactil chico: ${r.counts.tiny}`);
  for (const o of r.wide) console.log(`      ANCHO ${o.el} mide ${o.w}px`);
  for (const o of r.overflow) console.log(`      sale  ${o.el} (right ${o.right}) dentro de ${o.padre}`);
  for (const o of r.overlap) console.log(`      pisa  ${o.a}  ×  ${o.b}  (${o.px})`);
  for (const o of r.tiny) console.log(`      chico ${o.el} (${o.h}px) dentro de ${o.padre}`);
  await page.close();
}
await browser.close();
console.log(bad ? `\n${bad} de ${WIDTHS.length} anchos con problemas` : '\nTodos los anchos limpios');
