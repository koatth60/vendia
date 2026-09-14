/* Conmutador de tema. Tres estados: sistema (por defecto) → claro → oscuro.
   Vive aparte de admin.js a propósito: no necesita nada del panel y así funciona
   igual en la landing y en las páginas de login. */
(function () {
  'use strict';

  var KEY = 'onix-theme';
  var ORDER = ['system', 'light', 'dark'];

  var LABEL = {
    system: 'Tema del sistema',
    light: 'Tema claro',
    dark: 'Tema oscuro'
  };

  /* Iconos a 20px, trazo 1.7, mismo estilo que el resto del panel. */
  var ICON = {
    system: '<rect x="3" y="5" width="18" height="12.5" rx="2.5"></rect><path d="M8.5 20.5h7"></path><path d="M12 17.5v3"></path>',
    light: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2.5M12 19v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12H5M19 12h2.5M4.2 19.8 6 18M18 6l1.8-1.8"></path>',
    dark: '<path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z"></path>'
  };

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return ORDER.indexOf(v) === -1 ? 'system' : v;
    } catch (e) {
      /* Incógnito o cookies bloqueadas: se queda en 'system', que es correcto. */
      return 'system';
    }
  }

  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* nada que hacer */ }
  }

  function apply(v) {
    if (v === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', v);
  }

  function paint(btn, v) {
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICON[v] + '</svg>';
    btn.setAttribute('title', LABEL[v]);
    btn.setAttribute('aria-label', LABEL[v]);
  }

  function init() {
    var current = read();
    apply(current);

    var btn = document.getElementById('theme-toggle');
    if (!btn) return;

    paint(btn, current);
    btn.addEventListener('click', function () {
      current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
      write(current);
      apply(current);
      paint(btn, current);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
