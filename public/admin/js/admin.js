let statusHideTimer = null;
function setStatus(msg, isError) {
  const el = document.getElementById('status');
  if (statusHideTimer) clearTimeout(statusHideTimer);
  if (!msg) { el.classList.remove('is-visible'); return; }

  const icon = isError
    ? '<svg class="status-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    : '<svg class="status-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const cleanMsg = msg.replace(/\s*✓\s*$/, '');
  el.innerHTML = `${icon}<span>${escapeHtml(cleanMsg)}</span>`;
  el.classList.toggle('is-error', !!isError);
  el.classList.add('is-visible');
  statusHideTimer = setTimeout(() => { el.classList.remove('is-visible'); }, isError ? 4500 : 2600);
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Sesión expirada');
  }
  if (!res.ok) {
    let message = `Error (${res.status})`;
    try {
      const data = await res.clone().json();
      if (data?.error) message = data.error;
    } catch {}
    throw new Error(message);
  }
  return res;
}

function fitChatSplit() {
  const split = document.getElementById('chat-split');
  if (!split) return;
  const top = split.getBoundingClientRect().top;
  const bottomMargin = 16;
  const available = window.innerHeight - top - bottomMargin;
  split.style.height = `${Math.max(480, available)}px`;
}
window.addEventListener('resize', () => {
  if (document.querySelector('.tab-btn[data-tab="conversations"]').classList.contains('active')) fitChatSplit();
});

// Fase 1 reorg (ver ONIX-CRM-REORG-PLAN.md): 5 secciones primarias (Inicio/CRM/Catálogo/Bot/Negocio)
// en vez de 10 pestañas planas. Cada pestaña de siempre (mismo nombre, mismo data-tab) ahora vive
// dentro de una seccion; PANEL_SECTION dice cual, SECTION_DEFAULT cual pestaña se abre por defecto
// al clickear la seccion. switchTab() sigue siendo la única función que cambia qué panel se ve -
// switchSection() sólo resuelve la pestaña por defecto y delega en switchTab().
const PANEL_SECTION = {
  inicio: 'inicio',
  conversations: 'crm', customers: 'crm', orders: 'crm',
  catalog: 'catalogo',
  business: 'bot', rules: 'bot', faq: 'bot', payments: 'bot', shipping: 'bot', whatsapp: 'bot', health: 'bot',
  negocio: 'negocio', team: 'negocio', 'ai-usage': 'negocio', analytics: 'negocio',
};
const SECTION_DEFAULT = {
  inicio: 'inicio', crm: 'conversations', catalogo: 'catalog', bot: 'business', negocio: 'negocio',
};

function switchSection(section) {
  switchTab(SECTION_DEFAULT[section] || section);
}

// Se removieron los botones "Actualizar" de Inicio/Clientes/Salud/Analytics/Consumo IA - esas
// vistas se refrescan solas mientras están abiertas, sin que el dueño tenga que pedirlo. Un solo
// timer activo a la vez (switchTab reinicia el de la pestaña nueva y cancela el de la anterior),
// y se salta el refresh si la pestaña del navegador está en segundo plano (document.hidden).
// "Actualizar lista de plantillas" (WhatsApp) queda aparte a propósito: sincroniza con la API de
// Meta, no con datos propios - no tiene sentido pollearla sola.
const AUTO_REFRESH = {
  inicio: { load: () => loadDashboard(), intervalMs: 20000 },
  customers: { load: () => refreshCustomerListIfVisible(), intervalMs: 30000 },
  health: { load: () => loadHealth(), intervalMs: 30000 },
  analytics: { load: () => loadAnalytics(), intervalMs: 45000 },
  'ai-usage': { load: () => loadAiUsage(), intervalMs: 45000 },
};
let autoRefreshTimer = null;

function startAutoRefresh(name) {
  stopAutoRefresh();
  const cfg = AUTO_REFRESH[name];
  if (!cfg) return;
  autoRefreshTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    // El dueño reportó que Bot > Salud "se recarga" cada tanto mientras leía la conversación con el
    // bot (2026-09-13): loadHealth() reemplaza el innerHTML entero en cada tick, así que el scroll
    // (el de la página y el del cuadro de chat, que tiene su propio overflow-y) volvía a cero. Se
    // guarda antes del refresh y se restaura después, para cualquier vista con auto-refresh, no solo
    // Salud - Inicio y Clientes tienen el mismo problema de fondo si la lista es larga.
    const pageScrollY = window.scrollY;
    const scrollEl = document.querySelector('.tab-panel.active .chat-thread, .tab-panel.active [data-scroll-preserve]');
    const innerScrollTop = scrollEl ? scrollEl.scrollTop : null;

    await cfg.load();

    window.scrollTo(0, pageScrollY);
    if (innerScrollTop !== null) {
      const freshScrollEl = document.querySelector('.tab-panel.active .chat-thread, .tab-panel.active [data-scroll-preserve]');
      if (freshScrollEl) freshScrollEl.scrollTop = innerScrollTop;
    }
  }, cfg.intervalMs);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

// No refresca la lista de Clientes mientras el dueño tiene una ficha abierta editando - perdería
// lo que esté escribiendo. La ficha en sí no necesita poll: sus propios datos no cambian tan
// seguido, y abrir/cerrar ya la vuelve a traer fresca. Tampoco refresca si el dueño ya avanzó a la
// página 2+: forzarlo de vuelta a la página 1 cada 30s sería peor que el "se recarga" que se está
// arreglando - se salta el tick en vez de arrancarlo de la página en la que está.
function refreshCustomerListIfVisible() {
  const detail = document.getElementById('customer-detail-view');
  if (detail && !detail.hidden) return;
  if (crmCursorHistory.length > 1) return;
  return fetchCustomerPage(undefined, true);
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === name));
  document.querySelector('main').classList.toggle('wide', name === 'conversations');
  document.body.classList.toggle('no-scroll', name === 'conversations');
  if (name === 'conversations') {
    requestAnimationFrame(fitChatSplit);
    markConversationReadIfViewing();
  }
  // Carga perezosa de las vistas nuevas: nada de esto se pide hasta que el dueño entra a la seccion.
  if (name === 'customers' && !crmLoadedOnce) {
    loadCrmTagOptions();
    loadTagManager();
    loadCustomerList(true);
  }
  if (name === 'inicio') loadDashboard();
  if (name === 'health') loadHealth();
  if (name === 'shipping') loadShipping();
  // Sin boton "Actualizar": la vista se refresca sola mientras está abierta (ver AUTO_REFRESH). Se
  // reinicia en cada cambio de pestaña, así que entrar de nuevo a la misma vista no acumula timers.
  startAutoRefresh(name);
  try { localStorage.setItem('onix-admin-tab', name); } catch {}
  // replaceState (no pushState) a proposito: refleja la vista actual en la URL para poder compartir
  // el enlace o refrescar sin perder el lugar, sin llenar el historial del navegador con cada click.
  try { history.replaceState(null, '', '#/' + name); } catch {}

  const section = PANEL_SECTION[name] || 'inicio';
  document.querySelectorAll('.primary-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  document.querySelectorAll('.subnav').forEach(s => s.classList.toggle('active', s.dataset.sectionGroup === section));
}

async function loadBusiness() {
  try {
    const res = await apiFetch('/admin/api/business');
    const business = await res.json();
    document.getElementById('business-name').value = business.name || '';
    document.getElementById('business-description').value = business.description || '';
    document.getElementById('business-instructions').value = business.customInstructions || '';
    document.getElementById('bot-assistant-name').value = business.assistantName || '';
    document.getElementById('bot-tone').value = business.botTone || 'cercano';
    document.getElementById('bot-dialect').value = business.botDialect || 'neutro';
    document.getElementById('bot-greeting').value = business.botGreeting || '';
    document.getElementById('bot-never-say').value = business.botNeverSay || '';
    document.getElementById('bot-photo-mode').value = business.offerPhotosBeforeSending
      ? 'offer'
      : (business.autoSendPhotoOnQuote !== false ? 'auto' : 'reactive');
    document.getElementById('bot-require-proof').checked = business.requirePaymentProof !== false;
    document.getElementById('bot-category').value = business.businessCategory || '';
    document.getElementById('bot-gendered-address').checked = Boolean(business.genderedAddressEnabled);
    document.getElementById('bot-female-term').value = business.femaleAddressTerm || '';
    document.getElementById('bot-male-term').value = business.maleAddressTerm || '';
    toggleGenderedAddressFields();
    const modalities = business.shippingPaymentModalities || [];
    document.getElementById('ship-modality-prepaid-all').checked = modalities.includes('PREPAID_ALL');
    document.getElementById('ship-modality-prepaid-product-cod-shipping').checked = modalities.includes('PREPAID_PRODUCT_COD_SHIPPING');
    document.getElementById('ship-modality-cod-all').checked = modalities.includes('COD_ALL');
    renderInstructionChips();
    updateTallaFieldVisibility();
    renderGreetPreview();
    watchBusinessDirty();
    document.getElementById('business-contact-name').value = business.contactName || '';
    document.getElementById('business-contact-phone').value = business.contactPhone || '';
    document.getElementById('business-followup-template').dataset.saved = business.followUpTemplateName || '';
    document.getElementById('business-followup-language').value = business.followUpTemplateLanguage || 'es';
    document.getElementById('business-followup-hours').value = business.followUpDelayHours || 24;
    loadWhatsappTemplates();
    loadTemplateList();
  } catch (err) {
    setStatus(`No se pudo cargar el negocio: ${err.message}`, true);
  }
}

// La vista previa arma el mismo saludo que verá el cliente: el propio si el
// dueño escribió uno, si no el que sale del nombre y el tono.
const TONE_GREETING = {
  cercano: (n, b) => `¡Hola! Buenas tardes. Bienvenido a ${b}, ¿en qué te puedo ayudar hoy?`,
  formal: (n, b) => `Buenas tardes, le saluda ${n} de ${b}. ¿En qué puedo ayudarle?`,
  juvenil: (n, b) => `¡Holaa! Soy ${n} de ${b} 👋 ¿Qué estás buscando?`,
  profesional: (n, b) => `Hola, soy ${n} de ${b}. ¿En qué te puedo ayudar?`,
};

function renderGreetPreview() {
  const bubble = document.getElementById('greet-preview-bubble');
  if (!bubble) return;
  const name = (document.getElementById('bot-assistant-name').value || '').trim() || 'tu bot';
  const businessName = (document.getElementById('business-name').value || '').trim() || 'tu negocio';
  const custom = (document.getElementById('bot-greeting').value || '').trim();
  const tone = document.getElementById('bot-tone').value || 'cercano';
  const build = TONE_GREETING[tone] || TONE_GREETING.cercano;
  bubble.textContent = custom || build(name, businessName);
  document.getElementById('greet-preview-name').textContent = name;
}

// Marca "cambios sin guardar" en cuanto algo del panel cambia.
function watchBusinessDirty() {
  const panel = document.querySelector('[data-tab-panel="business"]');
  const flag = document.getElementById('business-dirty');
  if (!panel || !flag || panel.dataset.dirtyWatched) return;
  panel.dataset.dirtyWatched = '1';
  panel.addEventListener('input', () => {
    flag.hidden = false;
    renderGreetPreview();
  });
  panel.addEventListener('change', () => {
    flag.hidden = false;
    renderGreetPreview();
  });
}

async function loadWhatsappTemplates() {
  const select = document.getElementById('business-followup-template');
  const hint = document.getElementById('followup-template-hint');
  const savedValue = select.dataset.saved ?? select.value;
  hint.textContent = 'Cargando plantillas...';
  try {
    const res = await apiFetch('/admin/api/whatsapp-templates');
    const data = await res.json();
    const templates = data.templates || [];
    select.innerHTML = '<option value="">-- Sin seguimiento (desactivado) --</option>'
      + templates.map((t) => `<option value="${escapeHtml(t.name)}" data-lang="${escapeHtml(t.language)}" data-body="${escapeHtml(t.bodyText)}">${escapeHtml(t.name)} (${escapeHtml(t.language)})</option>`).join('');
    if (savedValue && !templates.some((t) => t.name === savedValue)) {
      select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(savedValue)}">${escapeHtml(savedValue)} (no encontrada o no aprobada)</option>`);
    }
    select.value = savedValue || '';
    hint.textContent = data.note || (templates.length === 0 ? 'No se encontraron plantillas aprobadas en tu cuenta de WhatsApp.' : 'Elegí una plantilla para ver exactamente qué dice.');
    onFollowupTemplateChange();
  } catch (err) {
    hint.textContent = `No se pudo cargar la lista de plantillas: ${err.message}`;
  }
}

// Nombres como "seguimiento_post_venta" no dicen nada por sí solos - esto muestra el texto real
// aprobado por Meta (con el {{1}} tal cual, para que quede claro qué parte es dinámica), así el dueño
// sabe exactamente qué le va a llegar al cliente antes de activarlo.
function onFollowupTemplateChange() {
  const select = document.getElementById('business-followup-template');
  const preview = document.getElementById('followup-template-preview');
  const opt = select.selectedOptions[0];
  const lang = opt?.dataset?.lang;
  const body = opt?.dataset?.body;
  if (lang) document.getElementById('business-followup-language').value = lang;
  if (body) {
    preview.textContent = body;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
}

// Mirrors normalizeTemplateName in src/whatsapp/client.ts - Meta only accepts lowercase
// letters/digits/underscores for template names, this shows the owner the real name live instead of
// them finding out after submitting.
function normalizeTemplateNamePreview(raw) {
  return raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 512);
}

function onTplNamePreview() {
  const raw = document.getElementById('tpl-new-name').value;
  const normalized = normalizeTemplateNamePreview(raw);
  document.getElementById('tpl-name-preview').textContent = normalized ? `Se va a crear como: ${normalized}` : '';
}

function tplStatusBadge(status) {
  const cls = status === 'APPROVED' ? 'tpl-status-approved' : status === 'REJECTED' ? 'tpl-status-rejected' : 'tpl-status-pending';
  const label = status === 'APPROVED' ? '🟢 Aprobada' : status === 'REJECTED' ? '🔴 Rechazada' : '🟡 Pendiente';
  return `<span class="tpl-status ${cls}">${label}</span>`;
}

function templateRowHtml(t) {
  return `<div class="tpl-row">
    <div class="tpl-row-top">
      <span class="tpl-row-name">${escapeHtml(t.name)}</span>
      ${tplStatusBadge(t.status)}
      <button class="tpl-row-delete owner-only" onclick="deleteWhatsappTemplate('${escapeHtml(t.name)}')">🗑 Eliminar</button>
    </div>
    <div class="tpl-row-body">${escapeHtml(t.bodyText || '(sin texto)')}</div>
  </div>`;
}

async function loadTemplateList() {
  const container = document.getElementById('tpl-list');
  try {
    const res = await apiFetch('/admin/api/whatsapp-templates/all');
    const data = await res.json();
    const templates = data.templates || [];
    container.innerHTML = templates.length === 0
      ? `<p style="font-size:12.5px; color:var(--muted-soft);">${data.note || 'Todavía no has creado ninguna plantilla.'}</p>`
      : templates.map(templateRowHtml).join('');
  } catch (err) {
    container.innerHTML = `<p style="font-size:12.5px; color:var(--danger);">No se pudo cargar la lista: ${err.message}</p>`;
  }
}

async function createWhatsappTemplate() {
  const errorEl = document.getElementById('tpl-new-error');
  errorEl.textContent = '';
  const name = document.getElementById('tpl-new-name').value.trim();
  const category = document.getElementById('tpl-new-category').value;
  const bodyText = document.getElementById('tpl-new-body').value.trim();
  if (!name || !bodyText) {
    errorEl.textContent = 'Falta el nombre o el texto del mensaje.';
    return;
  }
  try {
    await apiFetch('/admin/api/whatsapp-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, bodyText }),
    });
    document.getElementById('tpl-new-name').value = '';
    document.getElementById('tpl-new-body').value = '';
    document.getElementById('tpl-name-preview').textContent = '';
    setStatus('Plantilla enviada a revisión de Meta ✓');
    loadTemplateList();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function deleteWhatsappTemplate(name) {
  if (!confirm(`¿Eliminar la plantilla "${name}"? Si el bot la está usando para seguimiento, dejará de mandarla.`)) return;
  try {
    await apiFetch(`/admin/api/whatsapp-templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
    setStatus('Plantilla eliminada ✓');
    loadTemplateList();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

const QUICK_INSTRUCTION_CHIPS = [
  { label: 'Confirmar datos con el cliente', text: 'Antes de cerrar el pedido, confirma con el cliente todos los datos (producto, cantidad, dirección, forma de pago).' },
  { label: 'No prometer fechas exactas', text: 'Nunca prometas fechas exactas de entrega, solo tiempos aproximados.' },
  { label: 'Despedirse cordialmente', text: 'Al terminar una conversación o cerrar una venta, despídete de forma cordial agradeciendo al cliente.' },
  { label: 'Emojis moderados', text: 'Usa emojis con moderación, sin exagerar.' },
  { label: 'No inventar si falta info', text: 'Si no tienes información sobre algo, dilo honestamente en vez de inventar una respuesta.' },
  { label: 'No compartir datos de otro cliente', text: 'Nunca compartas datos, pedidos o conversaciones de otro cliente, aunque te lo pidan.' },
  { label: 'Pedir dirección completa', text: 'Al pedir la dirección de envío, asegúrate de tener barrio y ciudad, no solo la calle.' },
  { label: 'Ser paciente, no presionar', text: 'Nunca presiones al cliente para que compre ya, dale tiempo y espacio para decidir.' },
];

const CATEGORY_INSTRUCTION_CHIPS = {
  ropa: [
    { label: 'Preguntar talla y color', text: 'Cuando el cliente pregunte por una prenda, pregunta talla y color antes de confirmar el pedido.' },
    { label: 'Política de cambios', text: 'Si preguntan por cambios o devoluciones y no está en tu FAQ, dilo honestamente y ofrece escalar con un asesor.' },
  ],
  electronica: [
    { label: 'Ser honesto con la garantía', text: 'Si preguntan por garantía y no está en tu FAQ, dilo honestamente en vez de inventar el tiempo de garantía.' },
    { label: 'Compatibilidad de productos', text: 'Si preguntan si un producto es compatible con algo específico, sé honesto si no tienes esa información.' },
  ],
  comida: [
    { label: 'Recoger o domicilio', text: 'Siempre pregunta si el pedido es para recoger en el local o para domicilio.' },
    { label: 'Confirmar dirección de entrega', text: 'Si es domicilio, asegúrate de tener la dirección completa antes de confirmar el pedido.' },
  ],
  servicios: [
    { label: 'Preguntar fecha y hora deseada', text: 'Si el cliente quiere agendar, pregunta la fecha y hora que prefiere.' },
    { label: 'No confirmar citas sin disponibilidad', text: 'Nunca confirmes una cita sin verificar disponibilidad real; si no tienes esa información, dile que un asesor confirmará el horario.' },
  ],
  joyeria: [
    { label: 'Mencionar el material', text: 'Cuando describas un producto, menciona el material (ej: oro, plata, acero) si está en el catálogo.' },
    { label: 'Cuidados del producto', text: 'Si preguntan por cuidados del producto y no tienes esa información, dilo honestamente.' },
  ],
};

let currentChips = QUICK_INSTRUCTION_CHIPS;

function renderInstructionChips() {
  const container = document.getElementById('instruction-chips');
  const current = document.getElementById('business-instructions').value;
  const category = document.getElementById('bot-category').value;
  currentChips = QUICK_INSTRUCTION_CHIPS.concat(CATEGORY_INSTRUCTION_CHIPS[category] || []);
  container.innerHTML = currentChips.map((chip, i) => {
    const already = current.includes(chip.text);
    return `<button type="button" class="chip${already ? ' chip-added' : ''}" title="${escapeHtml(chip.text)}" onclick="addChipInstruction(${i})">${already ? '✓ ' : '+ '}${escapeHtml(chip.label)}</button>`;
  }).join('');
}

function addChipInstruction(i) {
  const chip = currentChips[i];
  const textarea = document.getElementById('business-instructions');
  if (textarea.value.includes(chip.text)) return;
  textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n- ${chip.text}` : `- ${chip.text}`;
  renderInstructionChips();
}

async function improveInstructions() {
  const textarea = document.getElementById('business-instructions');
  const text = textarea.value.trim();
  if (!text) { setStatus('Escribe algo primero para poder mejorarlo', true); return; }
  const btn = document.getElementById('improve-btn');
  btn.disabled = true;
  btn.textContent = 'Mejorando...';
  try {
    const res = await apiFetch('/admin/api/improve-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    // Never auto-replace the real textarea - show the proposal for the owner to review/edit and
    // explicitly accept or discard first (ONIX-RELIABILITY-PLAN.md Track B, Fase 7.2).
    document.getElementById('improve-preview-text').value = data.improved;
    document.getElementById('improve-preview').style.display = 'block';
    setStatus('Revisa la propuesta antes de usarla');
  } catch (err) {
    setStatus(`No se pudo mejorar: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l1.8 5.7 5.7 1.8-5.7 1.8L12 17.5l-1.8-5.7-5.7-1.8 5.7-1.8L12 2.5z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/></svg> Mejorar redacción';
  }
}

function acceptImprovedInstructions() {
  const improved = document.getElementById('improve-preview-text').value;
  document.getElementById('business-instructions').value = improved;
  document.getElementById('improve-preview').style.display = 'none';
  renderInstructionChips();
  setStatus('Redacción actualizada - no olvides Guardar para confirmarla ✓');
}

function discardImprovedInstructions() {
  document.getElementById('improve-preview').style.display = 'none';
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

async function saveBusiness() {
  const name = document.getElementById('business-name').value.trim();
  const description = document.getElementById('business-description').value.trim();
  const customInstructions = document.getElementById('business-instructions').value.trim();
  const assistantName = document.getElementById('bot-assistant-name').value.trim();
  const botTone = document.getElementById('bot-tone').value;
  const botDialect = document.getElementById('bot-dialect').value;
  const botGreeting = document.getElementById('bot-greeting').value.trim();
  const botNeverSay = document.getElementById('bot-never-say').value.trim();
  const photoMode = document.getElementById('bot-photo-mode').value;
  const autoSendPhotoOnQuote = photoMode === 'auto';
  const offerPhotosBeforeSending = photoMode === 'offer';
  const requirePaymentProof = document.getElementById('bot-require-proof').checked;
  const businessCategory = document.getElementById('bot-category').value;
  const contactName = document.getElementById('business-contact-name').value.trim();
  const contactPhone = document.getElementById('business-contact-phone').value.trim();
  const followUpTemplateName = document.getElementById('business-followup-template').value.trim();
  const followUpTemplateLanguage = document.getElementById('business-followup-language').value.trim() || 'es';
  const followUpDelayHours = Number(document.getElementById('business-followup-hours').value) || 24;
  const genderedAddressEnabled = document.getElementById('bot-gendered-address').checked;
  const femaleAddressTerm = document.getElementById('bot-female-term').value.trim();
  const maleAddressTerm = document.getElementById('bot-male-term').value.trim();
  const shippingPaymentModalities = [
    document.getElementById('ship-modality-prepaid-all').checked ? 'PREPAID_ALL' : null,
    document.getElementById('ship-modality-prepaid-product-cod-shipping').checked ? 'PREPAID_PRODUCT_COD_SHIPPING' : null,
    document.getElementById('ship-modality-cod-all').checked ? 'COD_ALL' : null,
  ].filter(Boolean);
  if (!name) { setStatus('El nombre es obligatorio', true); return; }
  try {
    await apiFetch('/admin/api/business', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, description, customInstructions, assistantName, botTone, botDialect, botGreeting, botNeverSay,
        autoSendPhotoOnQuote, offerPhotosBeforeSending, requirePaymentProof, businessCategory, contactName, contactPhone,
        followUpTemplateName, followUpTemplateLanguage, followUpDelayHours,
        genderedAddressEnabled, femaleAddressTerm, maleAddressTerm, shippingPaymentModalities,
      }),
    });
    setStatus('Negocio guardado ✓');
    const flag = document.getElementById('business-dirty');
    if (flag) flag.hidden = true;
  } catch (err) {
    setStatus(`No se pudo guardar: ${err.message}`, true);
  }
}

async function resetTestData() {
  const sure = confirm('¿Seguro? Se van a borrar TODAS las conversaciones, clientes y pedidos de este negocio. No se puede deshacer.');
  if (!sure) return;
  try {
    await apiFetch('/admin/api/reset-test-data', { method: 'DELETE' });
    setStatus('Datos de prueba borrados ✓');
    document.getElementById('reset-confirm-text').value = '';
    document.getElementById('reset-data-btn').disabled = true;
  } catch (err) {
    setStatus(`No se pudo borrar: ${err.message}`, true);
  }
}

let editingId = null;
let productsCache = [];
// Paginación (feedback del dueño, 2026-09-13: un catálogo real puede pasar de cientos de SKUs).
let productsPage = 1;
let productsSearchTimer = null;

function focusNewProductForm() {
  const card = document.getElementById('new-product-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const name = document.getElementById('p-name');
  if (name) name.focus({ preventScroll: true });
}

function onProductsSearchInput() {
  if (productsSearchTimer) clearTimeout(productsSearchTimer);
  productsSearchTimer = setTimeout(() => { productsPage = 1; loadProducts(); }, 300);
}

async function goToNextProductsPage() {
  productsPage++;
  await loadProducts();
}

async function goToPrevProductsPage() {
  if (productsPage <= 1) return;
  productsPage--;
  await loadProducts();
}

async function loadProducts() {
  const container = document.getElementById('products-container');
  const searchInput = document.getElementById('products-search');
  const q = searchInput ? searchInput.value.trim() : '';
  const params = new URLSearchParams({ page: String(productsPage) });
  if (q) params.set('q', q);
  try {
    const res = await apiFetch(`/admin/api/products?${params.toString()}`);
    const { items, total, pageSize } = await res.json();
    productsCache = items;
    // El badge de la pestaña Catálogo debe mostrar el total real del negocio, no el tamaño de la
    // página actual - por eso usa `total` (del servidor) en vez de items.length.
    document.getElementById('tab-count-catalog').textContent = total;
    const totalCount = document.getElementById('products-total-count');
    if (totalCount) totalCount.textContent = total;

    container.innerHTML = items.length === 0
      ? `<div class="card empty-state">${q ? 'Ningún producto coincide con la búsqueda.' : 'Todavía no cargaste productos. Agregá el primero en el formulario de la izquierda.'}</div>`
      : `<div class="product-grid">${items.map(renderCard).join('')}</div>`;

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    document.getElementById('products-page-label').textContent = `Página ${productsPage} de ${totalPages}`;
    document.getElementById('products-prev-btn').disabled = productsPage <= 1;
    document.getElementById('products-next-btn').disabled = productsPage >= totalPages;
  } catch (err) {
    container.innerHTML = `<div class="card empty-state" style="color:var(--danger);">No se pudo cargar el catálogo: ${escapeHtml(err.message)}</div>`;
  }
}

// Shows the Talla input on the add/edit product forms only for businesses whose category is "ropa" -
// other verticals (electronica, joyeria, etc) rarely need per-product size, so it stays hidden by
// default instead of cluttering every business's form with a field they'll never use. Color stays
// always visible since it's relevant across most verticals, not just clothing.
function updateTallaFieldVisibility() {
  const isRopa = document.getElementById('bot-category').value === 'ropa';
  const addWrapper = document.getElementById('p-size-wrapper');
  const editWrapper = document.getElementById('edit-size-wrapper');
  const draftSize = document.getElementById('p-draft-variant-size');
  if (addWrapper) addWrapper.hidden = !isRopa;
  if (editWrapper) editWrapper.hidden = !isRopa;
  if (draftSize) draftSize.hidden = !isRopa;
}

function toggleGenderedAddressFields() {
  const fields = document.getElementById('gendered-address-fields');
  if (fields) fields.hidden = !document.getElementById('bot-gendered-address').checked;
}

function renderCard(p) {
  const variants = p.variants || [];
  // ONE gallery per product, general photos and every variant's own photos together - each thumbnail
  // carries its real current assignment (null = general, or a variant id) via renderMediaAssignSelect,
  // so reassigning a color never moves a photo to a second, separate strip elsewhere on the card. See
  // renderVariantSection for why that split UI got removed.
  const allMedia = [
    ...(p.media || []).map(m => ({ ...m, variantId: null })),
    ...variants.flatMap(v => (v.media || []).map(m => ({ ...m, variantId: v.id }))),
  ];
  const media = p.media || [];
  const thumbs = allMedia.map(m => `
    <span class="thumb-wrap">
      ${m.type === 'VIDEO'
        ? `<video class="thumb" src="${m.url}" onclick="openVideoLightbox('${m.url}')"></video>`
        : `<img class="thumb" src="${m.url}" onclick="openImageLightbox('${m.url}')" />`}
      <button class="thumb-remove" onclick="deleteMedia('${m.id}')">×</button>
      ${renderMediaAssignSelect(m.id, m.variantId, variants)}
    </span>
  `).join('');

  // Once a product has variants, each sale decrements only that variant's own stock (see
  // orders/service.ts) - p.stock itself is never touched and would show a frozen, wrong number here
  // forever. Show the real total (sum of active variants) instead.
  const totalStock = variants.length > 0 ? variants.filter(v => v.active).reduce((sum, v) => sum + v.stock, 0) : p.stock;

  return `
    <div class="product-card ${p.active ? '' : 'inactive'}" data-product-id="${p.id}">
      <div class="thumb-strip">
        ${thumbs}
        <label class="thumb-add">
          +
          <input type="file" accept="image/jpeg,image/png,video/*" onchange="uploadMedia('${p.id}', this)" />
        </label>
      </div>
      <div class="product-body">
        ${media.length > 0 ? `<button class="btn-ghost" style="align-self:flex-start; padding:2px 0; font-size:11.5px; font-weight:600; color:var(--brand-dark);" onclick="detectColorsForProduct('${p.id}')">+ Detectar colores desde la foto</button>` : ''}
        <div id="color-suggestions-${p.id}"></div>
        <div class="product-name">${escapeHtml(p.name)}</div>
        <div class="product-desc">${escapeHtml(p.description)}</div>
        <div class="product-meta">
          <span class="price-tag">${p.currency} ${formatPriceValue(p.price, p.currency)}</span>
          <span class="stock-badge ${totalStock > 0 ? 'stock-ok' : 'stock-zero'}" ${variants.length > 0 ? `title="Suma de ${variants.filter(v=>v.active).length} variante(s)"` : ''}>${totalStock > 0 ? totalStock + ' en stock' : 'sin stock'}</span>
        </div>
        <div class="product-meta">
          ${p.category ? `<span class="category-tag">${escapeHtml(p.category)}</span>` : ''}
          ${p.size ? `<span class="category-tag">Talla: ${escapeHtml(p.size)}</span>` : ''}
        </div>
        ${variants.length > 0 && (p.stock > 0 || p.color) ? `
          <div class="hint" style="background:var(--warn-light); color:var(--warn); padding:8px 10px; border-radius:var(--radius-md); margin-top:4px;">
            Este producto tenía ${p.color ? `color <strong>${escapeHtml(p.color)}</strong>` : ''}${p.color && p.stock > 0 ? ' y ' : ''}${p.stock > 0 ? `<strong>${p.stock} en stock</strong>` : ''} antes de tener colores separados - no se perdió, pero no cuenta arriba hasta que lo repartas entre los colores de abajo.
            <button class="btn-ghost" style="padding:2px 0; margin-top:2px; font-weight:700; color:var(--warn); text-decoration:underline;" onclick="clearLeftoverStock('${p.id}')">Ya lo repartí, quitar este aviso</button>
          </div>
        ` : ''}
        ${renderVariantSection(p.id, variants, p)}
      </div>
      <div class="product-footer">
        <button class="btn-secondary" onclick="startEdit('${p.id}')">Editar</button>
        <button class="btn-secondary" onclick="toggleActive('${p.id}', ${!p.active})">${p.active ? 'Desactivar' : 'Activar'}</button>
        <button class="btn-danger" onclick="removeProduct('${p.id}')">Eliminar</button>
      </div>
    </div>
  `;
}

// Common Spanish color names -> a real swatch color, so a variant row shows an actual dot instead of
// making the admin read the word to know what they're looking at. Unmatched names (a brand name typed
// into the color field, a typo) fall back to a dashed "unknown" swatch rather than guessing wrong.
const COLOR_SWATCH_HEX = {
  negro: '#1c1c1e', blanco: '#f5f5f5', gris: '#8e8e93', plateado: '#c7c9cc', plata: '#c7c9cc',
  rojo: '#e5322d', rosa: '#f472b6', rosado: '#f472b6', fucsia: '#e6399b',
  azul: '#2563eb', celeste: '#38bdf8', turquesa: '#14b8a6', verde: '#22c55e', menta: '#6ee7b7',
  amarillo: '#eab308', dorado: '#d4a437', oro: '#d4a437', naranja: '#f97316',
  morado: '#8b5cf6', violeta: '#8b5cf6', lila: '#c4b5fd', purpura: '#8b5cf6',
  cafe: '#7c5842', marron: '#7c5842', chocolate: '#5c3a21', beige: '#e8dcc8', crema: '#f3e9d2',
  transparente: '#dbe4de',
};
function colorSwatchHtml(colorName) {
  const key = (colorName || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip accents: "café" -> "cafe", "marrón" -> "marron"
  const hex = Object.keys(COLOR_SWATCH_HEX).find(k => key.includes(k));
  return hex
    ? `<span class="variant-swatch" style="background:${COLOR_SWATCH_HEX[hex]};"></span>`
    : `<span class="variant-swatch is-unknown"></span>`;
}

// Lets an ALREADY-UPLOADED photo be re-pointed to a different variant (or back to "general", the
// fallback every variant without its own media uses) without re-uploading the file - see
// assignProductMedia in products.ts. Shown on every thumbnail, general or variant-owned, only once the
// product actually has variants to choose between (otherwise there's nothing to reassign to).
function renderMediaAssignSelect(mediaId, currentVariantId, variants) {
  if (!variants || variants.length === 0) return '';
  const options = [`<option value="" ${!currentVariantId ? 'selected' : ''}>General</option>`]
    .concat(variants.map(v => `<option value="${v.id}" ${v.id === currentVariantId ? 'selected' : ''}>${escapeHtml(v.color || v.size || '(sin nombre)')}</option>`));
  return `<select class="thumb-assign" title="A qué color pertenece esta foto" onchange="assignMedia('${mediaId}', this.value)">${options.join('')}</select>`;
}

async function assignMedia(mediaId, variantId) {
  try {
    await apiFetch(`/admin/api/media/${mediaId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: variantId || null }),
    });
    setStatus('Foto reasignada ✓');
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo reasignar la foto: ${err.message}`, true);
  }
}

// Variants are for a product sold in several colors/sizes under one name, each with its OWN stock and
// OWN photos (e.g. one headband model in red/yellow/green) - see ProductVariant in schema.prisma. Most
// products never use this; it only renders rows when they exist, plus a small always-available form to
// add the first one.
//
// A product with just ONE color (product.color/product.stock, no real ProductVariant rows) used to
// show that color as a separate tag up near the price - a different visual system from the row-based
// list here for the exact same kind of information, reported directly as inconsistent. `product` (its
// color/stock) renders as one more row in this same list instead, wired to update the product's own
// fields (updateProductField) rather than a variant - the moment a real second color gets added via
// "Agregar" below, this synthetic row disappears and the real variant rows (plus the leftover-stock
// warning in renderCard) take over, since the product has graduated to real per-color tracking.
function renderVariantSection(productId, variants, product) {
  // Only "ropa" businesses use talla at all (see updateTallaFieldVisibility) - showing an always-empty
  // Talla input on every variant row for every other vertical (tecnologia, joyeria, etc) was pure
  // clutter.
  const showTalla = document.getElementById('bot-category')?.value === 'ropa';
  const singleColorRow = variants.length === 0 && product && product.color ? `
    <div class="variant-row">
      ${colorSwatchHtml(product.color)}
      <input class="variant-name-input" placeholder="Color" value="${escapeHtml(product.color)}" onchange="updateProductField('${productId}', 'color', this.value)" />
      ${showTalla && product.size ? `<span class="variant-size-input">${escapeHtml(product.size)}</span>` : ''}
      <div class="variant-stock-wrap">
        <label>Stock</label>
        <input class="variant-stock-input" type="number" value="${product.stock}" onchange="updateProductField('${productId}', 'stock', this.value)" />
      </div>
      <button class="variant-delete-btn" title="Quitar este color (el stock queda en el producto)" onclick="updateProductField('${productId}', 'color', '')">×</button>
    </div>
  ` : '';
  // Photos live in ONE place - the gallery at the top of the card (see renderCard's unified `thumbs`,
  // built from product + every variant's media together) - each thumbnail carries its own color select
  // there. A second, separate photo strip per variant row here used to show the exact same underlying
  // files again, which read as duplicated even though nothing was duplicated in storage - reported
  // directly as confusing. Variant rows are now just color/talla/stock/delete; assign an existing photo
  // to a color from the gallery above instead.
  const rows = variants.map(v => `
    <div class="variant-row">
      ${colorSwatchHtml(v.color)}
      <input class="variant-name-input" placeholder="Color" value="${escapeHtml(v.color || '')}" onchange="updateVariant('${v.id}', 'color', this.value)" />
      ${showTalla ? `<input class="variant-size-input" placeholder="Talla" value="${escapeHtml(v.size || '')}" onchange="updateVariant('${v.id}', 'size', this.value)" />` : ''}
      <div class="variant-stock-wrap">
        <label>Stock</label>
        <input class="variant-stock-input" type="number" value="${v.stock}" onchange="updateVariant('${v.id}', 'stock', this.value)" />
      </div>
      <button class="variant-delete-btn" title="Eliminar variante" onclick="deleteVariant('${v.id}', '${productId}')">×</button>
    </div>
  `).join('');

  return `
    <div class="variant-section">
      <div class="variant-section-title">${showTalla ? 'Colores/tallas' : 'Colores'} - las fotos se asignan desde la galería de arriba</div>
      <div class="variant-list">${singleColorRow}${rows}</div>
      <div class="variant-add-row">
        ${colorSwatchHtml('')}
        <input id="new-variant-color-${productId}" type="text" placeholder="Color nuevo" style="flex:1; min-width:0;" />
        <input id="new-variant-size-${productId}" type="text" placeholder="Talla" style="width:60px;" ${showTalla ? '' : 'hidden'} />
        <input id="new-variant-stock-${productId}" type="number" placeholder="Stock" value="0" style="width:60px;" />
        <button class="btn-secondary" style="padding:6px 12px; flex-shrink:0;" onclick="addVariant('${productId}')">Agregar</button>
      </div>
    </div>
  `;
}

// Detects variant colors from the product's first photo (see /api/products/:id/detect-colors) and
// creates a real variant row per color directly - no separate "click to add" chip step. A chip-based
// confirm step made the admin identify each color by name text alone before they could act on it,
// which is exactly the extra friction a colorblind admin (reported directly) doesn't need when the
// real variant row already has everything required to fix a bad guess: an editable color name, a
// stock field, and a delete button (see renderVariantSection above) - land there straight away instead
// of a second, weaker UI in front of it. Stock starts at 0 (not a guessed 1) since only the admin
// actually knows the real count.
async function detectColorsForProduct(productId) {
  const product = productsCache.find(p => p.id === productId);
  const imageUrl = product && product.media && product.media[0] && product.media[0].url;
  if (!imageUrl) return;
  const box = document.getElementById(`color-suggestions-${productId}`);
  box.innerHTML = `<div class="hint">Analizando foto...</div>`;
  try {
    const res = await apiFetch(`/admin/api/products/${productId}/detect-colors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl }),
    });
    const { colors } = await res.json();
    if (!colors || colors.length === 0) {
      box.innerHTML = `<div class="hint">No se distinguieron colores de producto en la foto.</div>`;
      return;
    }

    const existing = new Set((product.variants || []).map(v => (v.color || '').trim().toLowerCase()).filter(Boolean));
    const newColors = colors.filter(c => !existing.has(c.toLowerCase()));
    if (newColors.length === 0) {
      box.innerHTML = `<div class="hint">Los colores detectados ya están agregados.</div>`;
      return;
    }

    box.innerHTML = `<div class="hint">Creando ${newColors.length} variante(s) de color...</div>`;
    for (const color of newColors) {
      await apiFetch(`/admin/api/products/${productId}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color, size: '', stock: 0 }),
      });
    }
    box.innerHTML = '';
    setStatus(`${newColors.length} variante(s) creadas - completá el stock de cada una ✓`);
    await loadProducts();
  } catch (err) {
    box.innerHTML = `<div style="font-size:11px; color:var(--danger); margin-top:4px;">No se pudo analizar la foto: ${escapeHtml(err.message)}</div>`;
  }
}

async function addVariant(productId) {
  const color = document.getElementById(`new-variant-color-${productId}`).value.trim();
  const size = document.getElementById(`new-variant-size-${productId}`).value.trim();
  const stock = document.getElementById(`new-variant-stock-${productId}`).value;
  if (!color && !size) {
    setStatus('La variante necesita al menos un color o una talla', true);
    return;
  }
  try {
    await apiFetch(`/admin/api/products/${productId}/variants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color, size, stock }),
    });
    setStatus('Variante agregada ✓');
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo agregar la variante: ${err.message}`, true);
  }
}

async function updateVariant(variantId, field, value) {
  try {
    await apiFetch(`/admin/api/variants/${variantId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    setStatus('Variante actualizada ✓');
    // Without this, productsCache keeps the pre-edit stock/color - the input you just typed into shows
    // the new value (it's just DOM state), but anything computed from the cache (the card's total stock
    // badge, the edit modal's summed stock) stays stale until some other action happens to reload it.
    await loadProducts();
  } catch (err) {
    setStatus(`No se pudo actualizar la variante: ${err.message}`, true);
    loadProducts();
  }
}

// Same pattern as updateVariant, for the synthetic single-color row (see renderVariantSection) which
// edits the PRODUCT's own color/stock fields directly, since there's no real ProductVariant behind it.
async function updateProductField(productId, field, value) {
  try {
    await apiFetch(`/admin/api/products/${productId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    setStatus('Producto actualizado ✓');
    await loadProducts();
  } catch (err) {
    setStatus(`No se pudo actualizar: ${err.message}`, true);
    loadProducts();
  }
}

async function deleteVariant(variantId, productId) {
  if (!confirm('¿Eliminar esta variante y sus fotos?')) return;
  try {
    await apiFetch(`/admin/api/variants/${variantId}`, { method: 'DELETE' });
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo eliminar la variante: ${err.message}`, true);
  }
}

function parsePriceInput(str, currency) {
  if (currency === 'COP') {
    const digits = String(str ?? '').replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  }
  const cleaned = String(str ?? '').replace(/,/g, '').trim();
  return cleaned ? Number(cleaned) : 0;
}

function formatPriceValue(num, currency) {
  const n = Number(num) || 0;
  return currency === 'COP'
    ? n.toLocaleString('es-CO', { maximumFractionDigits: 0 })
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function reformatPriceField(priceId, currencyId) {
  const priceEl = document.getElementById(priceId);
  const currency = document.getElementById(currencyId).value;
  const raw = parsePriceInput(priceEl.value, currency);
  priceEl.value = raw ? formatPriceValue(raw, currency) : '';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// WhatsApp bold is *text* (single asterisk); older messages sent before the formatting fix may still
// have **text** (Markdown-style). Render both as <strong> so history looks right either way.
function formatMessageText(str) {
  return escapeHtml(str)
    .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^\n*]+?)\*/g, '<strong>$1</strong>');
}

function startEdit(id) {
  const p = productsCache.find((x) => x.id === id);
  if (!p) return;
  editingId = id;
  document.getElementById('edit-name').value = p.name;
  document.getElementById('edit-desc').value = p.description;
  document.getElementById('edit-currency').value = p.currency;
  document.getElementById('edit-price').value = formatPriceValue(p.price, p.currency);
  const hasVariants = (p.variants || []).length > 0;
  const stockInput = document.getElementById('edit-stock');
  stockInput.value = hasVariants
    ? (p.variants || []).filter(v => v.active).reduce((sum, v) => sum + v.stock, 0)
    : p.stock;
  stockInput.disabled = hasVariants;
  document.getElementById('edit-stock-hint').hidden = !hasVariants;
  document.getElementById('edit-cat').value = p.category || '';
  const colorInput = document.getElementById('edit-color');
  colorInput.value = hasVariants ? (p.variants || []).map(v => v.color).filter(Boolean).join(', ') : (p.color || '');
  colorInput.disabled = hasVariants;
  document.getElementById('edit-color-hint').hidden = !hasVariants;
  document.getElementById('edit-size').value = p.size || '';
  document.getElementById('product-edit-modal').style.display = 'flex';
}

function closeEditModal() {
  editingId = null;
  document.getElementById('product-edit-modal').style.display = 'none';
}

// Dragging the description textarea's own resize handle wider than the card should grow the card
// to match, not just shrink the textarea back down to the card's fixed width. ResizeObserver also
// fires once when the textarea goes from display:none to visible (opening the modal) - that's not a
// user drag, so only grow the card when the width actually increases from its last known (visible)
// size, never on that first post-hidden measurement.
(function watchEditDescWidth() {
  const textarea = document.getElementById('edit-desc');
  const card = document.getElementById('edit-modal-card');
  if (!textarea || !card || typeof ResizeObserver === 'undefined') return;
  let lastWidth = 0;
  new ResizeObserver((entries) => {
    const width = entries[0].contentRect.width;
    if (lastWidth > 0 && width > lastWidth) {
      const needed = Math.ceil(width) + 40; // edit-grid horizontal padding
      if (needed > card.offsetWidth) card.style.width = `${needed}px`;
    }
    lastWidth = width;
  }).observe(textarea);
})();

async function saveEdit() {
  const id = editingId;
  const name = document.getElementById('edit-name').value.trim();
  const description = document.getElementById('edit-desc').value.trim();
  const currency = document.getElementById('edit-currency').value;
  const price = parsePriceInput(document.getElementById('edit-price').value, currency);
  const stock = document.getElementById('edit-stock').value;
  const category = document.getElementById('edit-cat').value.trim();
  const color = document.getElementById('edit-color').value.trim();
  const size = document.getElementById('edit-size').value.trim();

  try {
    await apiFetch(`/admin/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, price, currency, stock, category, color, size }),
    });
    closeEditModal();
    setStatus('Producto actualizado ✓');
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo actualizar: ${err.message}`, true);
  }
}

// Variants typed into the "Agregar producto" form before the product itself exists yet - held here
// (no id, nothing saved) until the product is created, then sent along in the same POST so
// createProduct can insert product+variants together (see products.ts). Removes the earlier
// save-the-product-first-then-add-variants-to-its-card friction entirely.
let draftVariants = [];

function updateDraftVariantSwatch() {
  document.getElementById('p-draft-variant-swatch-wrap').innerHTML = colorSwatchHtml(document.getElementById('p-draft-variant-color').value);
}

function renderDraftVariants() {
  document.getElementById('p-draft-variant-list').innerHTML = draftVariants.map((v, i) => `
    <div class="variant-row">
      ${v.photoPreviewUrl ? `<img src="${v.photoPreviewUrl}" style="width:18px; height:18px; border-radius:50%; object-fit:cover; flex-shrink:0;" />` : colorSwatchHtml(v.color)}
      <span class="variant-name-input" style="padding:4px 2px;">${escapeHtml(v.color || '(sin color)')}</span>
      ${v.size ? `<span class="variant-size-input">${escapeHtml(v.size)}</span>` : ''}
      <div class="variant-stock-wrap"><label>Stock</label><span class="variant-stock-input" style="cursor:default;">${v.stock}</span></div>
      ${v.file ? `<span class="hint" style="margin:0; flex-shrink:0;" title="${escapeHtml(v.file.name)}">📎 con foto</span>` : ''}
      <button class="variant-delete-btn" title="Quitar" onclick="removeDraftVariant(${i})">×</button>
    </div>
  `).join('');
}

// Only ever touches the preview span, never the <input> itself - replacing the input via innerHTML
// would create a brand new element with an empty FileList, silently losing the file the user just
// picked right before addDraftVariant() reads it.
function previewDraftVariantPhoto() {
  const file = document.getElementById('p-draft-variant-photo').files[0];
  const btn = document.getElementById('p-draft-variant-photo-btn');
  const preview = document.getElementById('p-draft-variant-photo-preview');
  if (!file) {
    btn.classList.remove('has-photo');
    preview.innerHTML = '+';
    return;
  }
  btn.classList.add('has-photo');
  const url = URL.createObjectURL(file);
  preview.innerHTML = file.type.startsWith('video') ? `<video src="${url}"></video>` : `<img src="${url}" />`;
}

function addDraftVariant() {
  const color = document.getElementById('p-draft-variant-color').value.trim();
  const size = document.getElementById('p-draft-variant-size').value.trim();
  const stock = Number(document.getElementById('p-draft-variant-stock').value || 0);
  const file = document.getElementById('p-draft-variant-photo').files[0] || null;
  if (!color && !size) {
    setStatus('La variante necesita al menos un color o una talla', true);
    return;
  }
  draftVariants.push({ color, size, stock, file, photoPreviewUrl: file ? URL.createObjectURL(file) : null });
  document.getElementById('p-draft-variant-color').value = '';
  document.getElementById('p-draft-variant-size').value = '';
  document.getElementById('p-draft-variant-stock').value = '0';
  document.getElementById('p-draft-variant-photo').value = '';
  document.getElementById('p-draft-variant-photo-btn').classList.remove('has-photo');
  document.getElementById('p-draft-variant-photo-preview').innerHTML = '+';
  updateDraftVariantSwatch();
  renderDraftVariants();
}

function removeDraftVariant(i) {
  draftVariants.splice(i, 1);
  renderDraftVariants();
}

async function addProduct() {
  const name = document.getElementById('p-name').value.trim();
  const description = document.getElementById('p-description').value.trim();
  const currency = document.getElementById('p-currency').value;
  const price = parsePriceInput(document.getElementById('p-price').value, currency);
  const stock = document.getElementById('p-stock').value;
  const category = document.getElementById('p-category').value.trim();
  const color = document.getElementById('p-color').value.trim();
  const size = document.getElementById('p-size').value.trim();

  if (!name || !description || !price) {
    setStatus('Nombre, descripción y precio son obligatorios', true);
    return;
  }

  let created;
  try {
    const res = await apiFetch('/admin/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // .file/.photoPreviewUrl are local-only (a File object, a blob: URL) - the server never sees
      // them, only the plain fields it stores on ProductVariant.
      body: JSON.stringify({
        name, description, price, currency, stock, category, color, size,
        variants: draftVariants.map(({ color, size, stock }) => ({ color, size, stock })),
      }),
    });
    created = await res.json();
  } catch (err) {
    setStatus(`No se pudo agregar: ${err.message}`, true);
    return;
  }

  // Now that real variant ids exist, upload each queued photo straight to its own variant - matched by
  // color+size since nested-create's returned order isn't guaranteed to match the input array.
  const queuedPhotos = draftVariants.filter((v) => v.file);
  if (queuedPhotos.length > 0 && created?.variants?.length) {
    setStatus(`Subiendo ${queuedPhotos.length} foto(s) de variante...`);
    const usedIds = new Set();
    for (const draft of queuedPhotos) {
      const match = created.variants.find(
        (v) => !usedIds.has(v.id) && (v.color || '') === (draft.color || '') && (v.size || '') === (draft.size || '')
      );
      if (!match) continue;
      usedIds.add(match.id);
      const formData = new FormData();
      formData.append('file', draft.file);
      formData.append('variantId', match.id);
      try {
        await apiFetch(`/admin/api/products/${created.id}/media`, { method: 'POST', body: formData });
      } catch (err) {
        setStatus(`No se pudo subir la foto de "${draft.color || draft.size}": ${err.message}`, true);
      }
    }
  }
  for (const draft of draftVariants) {
    if (draft.photoPreviewUrl) URL.revokeObjectURL(draft.photoPreviewUrl);
  }

  document.getElementById('p-name').value = '';
  document.getElementById('p-description').value = '';
  document.getElementById('p-price').value = '';
  document.getElementById('p-stock').value = '0';
  document.getElementById('p-category').value = '';
  document.getElementById('p-color').value = '';
  document.getElementById('p-size').value = '';
  draftVariants = [];
  renderDraftVariants();

  setStatus(`Producto agregado ✓${created?.variants?.length ? ` con ${created.variants.length} variante(s)` : ''}`);
  // Un producto nuevo aparece primero (orden createdAt desc) - sin volver a la página 1 y limpiar la
  // búsqueda, podría quedar fuera de la página/filtro actual y scrollToAndHighlightProduct no
  // encontraría la tarjeta para resaltarla.
  productsPage = 1;
  const searchInputEl = document.getElementById('products-search');
  if (searchInputEl) searchInputEl.value = '';
  await loadProducts();
  // Jump straight to the new card - if it still needs variant photos, or more variants, they're right
  // there instead of making the owner scroll down to find it.
  scrollToAndHighlightProduct(created?.id);
}

function scrollToAndHighlightProduct(productId) {
  if (!productId) return;
  const card = document.querySelector(`.product-card[data-product-id="${productId}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('is-new');
  setTimeout(() => card.classList.remove('is-new'), 2500);
  const colorInput = document.getElementById(`new-variant-color-${productId}`);
  if (colorInput) setTimeout(() => colorInput.focus(), 400);
}

// Clears the leftover pre-variant stock number once the admin has actually redistributed it among the
// real color variants (see the warning banner in renderCard) - the field itself is otherwise unused
// and disabled once a product has variants (see startEdit), so there's no other way to zero it out.
async function clearLeftoverStock(id) {
  try {
    await apiFetch(`/admin/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock: 0, color: '' }),
    });
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo quitar el aviso: ${err.message}`, true);
  }
}

async function toggleActive(id, active) {
  try {
    await apiFetch(`/admin/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo actualizar: ${err.message}`, true);
  }
}

async function removeProduct(id) {
  if (!confirm('¿Eliminar este producto?')) return;
  try {
    await apiFetch(`/admin/api/products/${id}`, { method: 'DELETE' });
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

async function uploadMedia(productId, input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  setStatus('Subiendo archivo...');
  try {
    await apiFetch(`/admin/api/products/${productId}/media`, {
      method: 'POST',
      body: formData,
    });
    setStatus('Archivo subido ✓');
    loadProducts();
  } catch (err) {
    setStatus(`Error subiendo archivo: ${err.message}`, true);
  }
}

const CROP_VIEWPORT = 240;
let cropState = null;

function onProfilePhotoFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = document.getElementById('crop-image');
    img.onload = () => {
      const baseScale = Math.max(CROP_VIEWPORT / img.naturalWidth, CROP_VIEWPORT / img.naturalHeight);
      cropState = {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        baseScale,
        scale: baseScale,
        offsetX: (CROP_VIEWPORT - img.naturalWidth * baseScale) / 2,
        offsetY: (CROP_VIEWPORT - img.naturalHeight * baseScale) / 2,
        dragging: false,
      };
      document.getElementById('crop-zoom').value = 100;
      applyCropTransform();
      document.getElementById('photo-crop-modal').style.display = 'flex';
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function clampCropOffsets() {
  if (!cropState) return;
  const w = cropState.naturalWidth * cropState.scale;
  const h = cropState.naturalHeight * cropState.scale;
  cropState.offsetX = Math.min(0, Math.max(CROP_VIEWPORT - w, cropState.offsetX));
  cropState.offsetY = Math.min(0, Math.max(CROP_VIEWPORT - h, cropState.offsetY));
}

function applyCropTransform() {
  if (!cropState) return;
  const img = document.getElementById('crop-image');
  img.style.width = `${cropState.naturalWidth * cropState.scale}px`;
  img.style.height = `${cropState.naturalHeight * cropState.scale}px`;
  img.style.transform = `translate(${cropState.offsetX}px, ${cropState.offsetY}px)`;
}

function onCropZoomChange(value) {
  if (!cropState) return;
  const centerX = (CROP_VIEWPORT / 2 - cropState.offsetX) / cropState.scale;
  const centerY = (CROP_VIEWPORT / 2 - cropState.offsetY) / cropState.scale;
  cropState.scale = cropState.baseScale * (Number(value) / 100);
  cropState.offsetX = CROP_VIEWPORT / 2 - centerX * cropState.scale;
  cropState.offsetY = CROP_VIEWPORT / 2 - centerY * cropState.scale;
  clampCropOffsets();
  applyCropTransform();
}

function initCropDrag() {
  const viewport = document.getElementById('crop-viewport');
  let startX = 0, startY = 0, startOffsetX = 0, startOffsetY = 0;

  viewport.addEventListener('pointerdown', (e) => {
    if (!cropState) return;
    cropState.dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startOffsetX = cropState.offsetX;
    startOffsetY = cropState.offsetY;
    viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = 'grabbing';
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!cropState || !cropState.dragging) return;
    cropState.offsetX = startOffsetX + (e.clientX - startX);
    cropState.offsetY = startOffsetY + (e.clientY - startY);
    clampCropOffsets();
    applyCropTransform();
  });
  const stopDrag = () => {
    if (cropState) cropState.dragging = false;
    viewport.style.cursor = 'grab';
  };
  viewport.addEventListener('pointerup', stopDrag);
  viewport.addEventListener('pointercancel', stopDrag);
}
initCropDrag();

function closePhotoCropModal() {
  document.getElementById('photo-crop-modal').style.display = 'none';
  cropState = null;
}

async function confirmPhotoCrop() {
  if (!cropState) return;
  const img = document.getElementById('crop-image');
  const outputSize = 512;
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  const sx = -cropState.offsetX / cropState.scale;
  const sy = -cropState.offsetY / cropState.scale;
  const sSize = CROP_VIEWPORT / cropState.scale;
  ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, outputSize, outputSize);

  canvas.toBlob(async (blob) => {
    if (!blob) return;
    closePhotoCropModal();
    const status = document.getElementById('profile-photo-status');
    status.textContent = 'Subiendo...';
    const formData = new FormData();
    formData.append('file', blob, 'profile.jpg');
    try {
      await apiFetch('/admin/api/business/profile-photo', { method: 'POST', body: formData });
      status.textContent = 'Foto actualizada ✓';
    } catch (err) {
      status.textContent = '';
      setStatus(`No se pudo actualizar la foto: ${err.message}`, true);
    }
  }, 'image/jpeg', 0.92);
}

async function deleteMedia(mediaId) {
  try {
    await apiFetch(`/admin/api/media/${mediaId}`, { method: 'DELETE' });
    loadProducts();
  } catch (err) {
    setStatus(`No se pudo eliminar el archivo: ${err.message}`, true);
  }
}

const STATUS_LABELS = {
  NEW: 'Nuevo', INTERESTED: 'Interesado', QUOTED: 'Cotizado',
  NEGOTIATING: 'Negociando', SOLD: 'Vendido', LOST: 'Perdido',
};

const INTENT_LABELS = { PQR: '⚠️ PQR', DEVOLUCION: '↩️ Devolución', NO_RECIBIDO: '📦 No recibido', SOLICITA_AGENTE: '🙋 Pide agente' };
const CSAT_EMOJI = { 1: '😞', 2: '😐', 3: '😃' };

const AVATAR_COLORS = ['#1fa855', '#16803f', '#2f8f6f', '#9c6a1f', '#7a6a9c', '#4f7a9c', '#8f7a2f', '#5c6e65'];
function avatarColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

// One badge per row, by priority: an escalated intent outranks "tú atiendes", which outranks the plain
// funnel status - before this, a row could show both the intent AND the "en vivo" badge at once (and
// with SOLICITA_AGENTE, the same 🙋 emoji twice), see ONIX-CONVERSATIONS-GROUPING-PLAN.md Fase 5.
// `conversationId` (the row's activeConversationId, or the open thread's own id) powers the ✕ that
// dismisses a resolved intent - omitted (e.g. a future read-only context) simply hides the ✕.
function statusBadgeHtml({ status, intent, humanControl, conversationId }) {
  if (intent) {
    const dismiss = conversationId
      ? `<span class="intent-dismiss" title="Marcar como resuelto" onclick="event.stopPropagation(); dismissIntent('${conversationId}')">✕</span>`
      : '';
    return `<span class="status-badge intent-badge intent-${intent}">${INTENT_LABELS[intent] || intent}${dismiss}</span>`;
  }
  if (humanControl) {
    return '<span class="status-badge handoff-badge">✋ Tú atiendes</span>';
  }
  return `<span class="status-badge status-${status}">${STATUS_LABELS[status] || status}</span>`;
}

// One row per CUSTOMER (grouping this customer's Conversation rows - see
// [[onix-conversations-group-by-customer]] and ONIX-CONVERSATIONS-GROUPING-PLAN.md), shared between the
// initial list render and the realtime conversation:new handler for a genuinely new customer.
function customerRowHtml(c) {
  const displayName = c.customer.name || c.customer.phoneNumber;
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';
  const preview = c.lastMessage
    ? `${c.lastMessage.role === 'ASSISTANT' ? 'Tú (bot): ' : ''}${escapeHtml(c.lastMessage.content).slice(0, 80)}`
    : 'Sin mensajes';
  const unread = c.unreadCount || 0;
  // Discreet recurring-customer hint (decision 2026-09-13: text, not another colored badge - the row
  // already carries enough of those).
  const orders = c.orderCount > 0 ? `<div class="conv-orders">${c.orderCount} compra${c.orderCount === 1 ? '' : 's'}</div>` : '';
  return `
    <div class="conv-row${c.customerId === currentCustomerId ? ' active' : ''}" data-customer-id="${c.customerId}" data-active-conversation-id="${c.activeConversationId}" data-unread="${unread}" onclick="openCustomer('${c.customerId}')">
      <div class="conv-avatar" style="background:${avatarColor(c.customer.phoneNumber)};">${escapeHtml(initial)}</div>
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(displayName)}</div>
        <div class="conv-preview">${preview}</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time" data-updated-at="${c.updatedAt}">${timeAgo(c.updatedAt)}</div>
        ${orders}
        ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        <div class="conv-badges">${statusBadgeHtml({ status: c.status, intent: c.intent, humanControl: c.humanControl, conversationId: c.activeConversationId })}</div>
      </div>
    </div>
  `;
}

// Turns a single-conversation realtime payload (conversation:new/updated - see ConversationRow in
// src/realtime/events.ts) into the shape customerRowHtml needs, for the one case where the customer
// genuinely has no row yet (their very first conversation ever) - orderCount is always 0 there.
function customerRowFromConversationEvent(c) {
  return {
    customerId: c.customer.id,
    activeConversationId: c.id,
    status: c.status,
    intent: c.intent,
    humanControl: c.humanControl,
    updatedAt: c.updatedAt,
    unreadCount: c.unreadCount,
    orderCount: 0,
    customer: c.customer,
    lastMessage: c.lastMessage,
  };
}

async function loadCustomers() {
  const container = document.getElementById('conversations-list');
  try {
    const res = await apiFetch('/admin/api/customers');
    const customers = await res.json();
    document.getElementById('tab-count-conversations').textContent = customers.length;

    if (!Array.isArray(customers) || customers.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="big">💬</div>Todavía no hay conversaciones.<br/>Van a aparecer acá apenas un cliente le escriba al bot.</div>';
      updateTotalUnreadBadge();
      return;
    }

    container.innerHTML = customers.map(customerRowHtml).join('');
    const inboxCount = document.getElementById('inbox-count');
    if (inboxCount) inboxCount.textContent = customers.length;
    applyInboxFilter();
    updateTotalUnreadBadge();
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:var(--danger);">No se pudieron cargar las conversaciones: ${escapeHtml(err.message)}</div>`;
  }
}

// La lista no está paginada (loadCustomers trae todos los clientes), así que
// filtrar acá no esconde filas que estén en otra página: no hay otra página.
function applyInboxFilter() {
  const select = document.getElementById('inbox-filter');
  const list = document.getElementById('conversations-list');
  if (!select || !list) return;
  const unreadOnly = select.value === 'unread';
  let shown = 0;
  list.querySelectorAll('.conv-row').forEach((row) => {
    const hide = unreadOnly && !row.classList.contains('has-unread');
    row.hidden = hide;
    if (!hide) shown++;
  });
  let empty = list.querySelector('.inbox-filter-empty');
  if (unreadOnly && shown === 0) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty-state inbox-filter-empty';
      empty.textContent = 'No hay conversaciones sin leer.';
      list.appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

let currentConversationId = null; // always the open customer's activeConversationId - every action
                                   // (composer, handoff, close-sale) keeps targeting this, unchanged.
let currentCustomerId = null;
let currentCustomerTags = [];
let currentCustomerName = '';
let currentCustomerPhone = '';
let conversationPollTimer = null;
let renderedMessageIds = new Set();
// Merged-thread state (see ONIX-CONVERSATIONS-GROUPING-PLAN.md Fase 2/4): threadCycleBlocks holds one
// pre-rendered message-bubbles block per loaded cycle, oldest-first; threadCyclesMeta is the full
// per-cycle metadata (status/order) used to label the separators between blocks; threadHasMore says
// whether an even older cycle exists beyond what's loaded.
let threadCycleBlocks = [];
let threadCyclesMeta = [];
let threadHasMore = false;

function openImageLightbox(url) {
  const video = document.getElementById('image-lightbox-video');
  video.pause();
  video.style.display = 'none';
  video.src = '';
  document.getElementById('image-lightbox-img').style.display = '';
  document.getElementById('image-lightbox-img').src = url;
  document.getElementById('image-lightbox').style.display = 'flex';
}

function openVideoLightbox(url) {
  document.getElementById('image-lightbox-img').style.display = 'none';
  document.getElementById('image-lightbox-img').src = '';
  const video = document.getElementById('image-lightbox-video');
  video.style.display = '';
  video.src = url;
  document.getElementById('image-lightbox').style.display = 'flex';
}

function closeImageLightbox() {
  document.getElementById('image-lightbox').style.display = 'none';
  document.getElementById('image-lightbox-img').src = '';
  const video = document.getElementById('image-lightbox-video');
  video.pause();
  video.src = '';
}

function messageBubbleHtml(m) {
  const isAudio = m.mediaUrl && m.mediaType === 'AUDIO';
  const isVideo = m.mediaUrl && m.mediaType === 'VIDEO';
  const img = isAudio
    ? `<audio src="${m.mediaUrl}" controls style="margin-bottom:4px;"></audio>`
    : isVideo
      ? `<video src="${m.mediaUrl}" controls style="max-width:220px; border-radius:6px; display:block; margin-bottom:4px;"></video>`
      : m.mediaUrl ? `<img src="${m.mediaUrl}" style="max-width:220px; border-radius:6px; display:block; margin-bottom:4px; cursor:zoom-in;" onclick="openImageLightbox('${m.mediaUrl}')" />` : '';
  const time = new Date(m.createdAt).toLocaleString('es-CO', { hour: '2-digit', minute: '2-digit' });
  return `<div class="bubble bubble-${m.role}${isAudio ? ' bubble-has-audio' : ''}">${img}<span class="bubble-text">${formatMessageText(m.content)}</span><span class="bubble-time">${time}</span></div>`;
}

// A full re-render on every 4s poll was regenerating every image's S3 presigned URL each time (a new
// signed URL even for the same file), so every photo in the thread reloaded/flickered on a loop. Only
// the genuinely new messages get appended now - already-rendered bubbles (and their image URLs) are
// left untouched.
function renderThreadMessages(thread, messages) {
  const newOnes = messages.filter((m) => !renderedMessageIds.has(m.id));
  if (newOnes.length === 0) return;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  newOnes.forEach((m) => renderedMessageIds.add(m.id));
  const emptyState = thread.querySelector('.chat-thread-empty');
  if (emptyState) emptyState.remove();
  thread.insertAdjacentHTML('beforeend', newOnes.map(messageBubbleHtml).join(''));
  if (nearBottom) thread.scrollTop = thread.scrollHeight;
}

function updateCloseSaleButtonVisibility(status) {
  document.getElementById('close-sale-btn').style.display = status === 'SOLD' ? 'none' : 'inline-block';
}

async function pollConversation() {
  // GET /admin/api/conversations/:id resets that conversation's unread badge as a side effect of
  // viewing it (see getConversationForBusiness) - polling it unconditionally while merely "open" in
  // state (regardless of tab/visibility, same gap the message:new handler had) would silently mark it
  // read every 30s even while the owner is looking at a different tab entirely.
  if (!currentConversationId || !isActivelyViewingConversation(currentConversationId)) return;
  try {
    const res = await apiFetch(`/admin/api/conversations/${currentConversationId}`);
    const conversation = await res.json();
    renderHandoffState(conversation.humanControl);
    updateCloseSaleButtonVisibility(conversation.status);
    renderThreadMessages(document.getElementById('modal-thread'), conversation.messages);
  } catch {
    // silent - next poll retries
  }
}

// Realtime (Socket.IO) is now the primary delivery path for new messages in the open thread - this
// poll only survives as a slow reconciliation safety net (missed/dropped socket events), no longer the
// main mechanism, hence the much longer interval than the old 4s.
function startConversationPolling() {
  stopConversationPolling();
  conversationPollTimer = setInterval(pollConversation, 30000);
}

function stopConversationPolling() {
  if (conversationPollTimer) {
    clearInterval(conversationPollTimer);
    conversationPollTimer = null;
  }
}

function startEditCustomerName() {
  document.getElementById('modal-title').style.display = 'none';
  document.getElementById('edit-name-btn').style.display = 'none';
  const input = document.getElementById('modal-title-input');
  input.value = currentCustomerName;
  input.style.display = 'inline-block';
  document.getElementById('save-name-btn').style.display = 'inline-block';
  input.focus();
  input.select();
}

function cancelEditCustomerName() {
  document.getElementById('modal-title').style.display = '';
  document.getElementById('edit-name-btn').style.display = '';
  document.getElementById('modal-title-input').style.display = 'none';
  document.getElementById('save-name-btn').style.display = 'none';
}

async function saveCustomerNameEdit() {
  if (!currentCustomerId) return;
  const name = document.getElementById('modal-title-input').value.trim();
  try {
    await apiFetch(`/admin/api/customers/${currentCustomerId}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    currentCustomerName = name;
    document.getElementById('modal-title').textContent = name || currentCustomerPhone;
    cancelEditCustomerName();
    loadCustomers();
  } catch (err) {
    setStatus(`No se pudo guardar el nombre: ${err.message}`, true);
  }
}

function renderTags() {
  const box = document.getElementById('modal-tags');
  box.innerHTML = currentCustomerTags.map((t) => `
    <span class="status-badge" style="background:var(--info-light); color:var(--info);">${escapeHtml(t)} <span style="cursor:pointer; margin-left:4px;" onclick="removeTag('${escapeHtml(t)}')">✕</span></span>
  `).join('') + `<input id="modal-tag-input" type="text" placeholder="+ etiqueta" style="border:none; outline:none; font-size:12px; width:80px;" onkeydown="if(event.key==='Enter') addTag();" />`;
}

async function saveTags() {
  try {
    await apiFetch(`/admin/api/customers/${currentCustomerId}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: currentCustomerTags }),
    });
  } catch (err) {
    setStatus(`No se pudieron guardar las etiquetas: ${err.message}`, true);
  }
}

function addTag() {
  const input = document.getElementById('modal-tag-input');
  const value = input.value.trim();
  if (!value || currentCustomerTags.includes(value)) return;
  currentCustomerTags.push(value);
  renderTags();
  saveTags();
}

function removeTag(tag) {
  currentCustomerTags = currentCustomerTags.filter((t) => t !== tag);
  renderTags();
  saveTags();
}

// COP-style money label for a closed cycle's separator - falls back to a plain "amount currency"
// string if Intl doesn't recognize the currency code (shouldn't happen for the currencies this app
// actually uses, but a formatting error here shouldn't ever break rendering the thread).
function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: currency || 'COP', maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency || ''}`;
  }
}

function cycleMetaById(id) {
  return threadCyclesMeta.find((cycle) => cycle.id === id);
}

// Marks where one sales cycle ended and the next began, between that cycle's messages and the next
// block - the whole reason a customer's history now reads as one continuous thread with visible seams
// instead of the confusing "brand new chat" the grouping fix replaces (see plan Fase 1, decision 1).
function cycleSeparatorHtml(cycle) {
  const dateLabel = new Date(cycle.updatedAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
  const label = cycle.status === 'SOLD'
    ? `Venta cerrada · ${dateLabel}${cycle.order ? ` · ${escapeHtml(cycle.order.summary)} · ${formatMoney(cycle.order.totalAmount, cycle.order.currency)}` : ''}`
    : `Conversación cerrada sin venta · ${dateLabel}`;
  return `<div class="cycle-separator"><span>${label}</span></div>`;
}

// Repaints #modal-thread from threadCycleBlocks - called after the initial open AND after loading an
// older cycle, so both paths share one rendering path instead of drifting apart.
function renderMergedThread() {
  const thread = document.getElementById('modal-thread');
  let html = threadHasMore
    ? '<div class="cycle-load-more"><button class="btn-secondary" type="button" onclick="loadOlderCycle()">Ver conversación anterior ↑</button></div>'
    : '';
  threadCycleBlocks.forEach((block, i) => {
    html += block.html;
    if (i < threadCycleBlocks.length - 1) {
      const meta = cycleMetaById(block.conversationId);
      if (meta) html += cycleSeparatorHtml(meta);
    }
  });
  thread.innerHTML = html || '<div class="chat-thread-empty" style="text-align:center; color:var(--muted); font-size:13px; padding:20px;">Sin mensajes todavía.</div>';
}

// Fetches this customer's next-older cycle and prepends it above what's already loaded, preserving
// scroll position (otherwise the view jumps as content is inserted above the visible area) - lazy by
// design (see plan Fase 2): getCustomerThreadForBusiness would otherwise fire a fresh presigned S3 URL
// for every photo across every cycle on a single open.
async function loadOlderCycle() {
  if (!threadHasMore || !currentCustomerId || threadCycleBlocks.length === 0) return;
  const oldest = threadCycleBlocks[0];
  const thread = document.getElementById('modal-thread');
  const prevScrollHeight = thread.scrollHeight;
  try {
    const res = await apiFetch(`/admin/api/customers/${currentCustomerId}/thread?before=${oldest.conversationId}`);
    const data = await res.json();
    threadHasMore = data.hasMore;
    if (!data.conversationId) {
      renderMergedThread();
      return;
    }
    data.messages.forEach((m) => renderedMessageIds.add(m.id));
    threadCycleBlocks.unshift({ conversationId: data.conversationId, html: data.messages.map(messageBubbleHtml).join('') });
    renderMergedThread();
    thread.scrollTop = thread.scrollHeight - prevScrollHeight;
  } catch (err) {
    setStatus(`No se pudo cargar la conversación anterior: ${err.message}`, true);
  }
}

function renderModalSubtitle({ status, intent, conversationId, customerName, customerPhone }) {
  document.getElementById('modal-subtitle').innerHTML =
    (customerName ? `${escapeHtml(customerPhone)} · ` : '') +
    statusBadgeHtml({ status, intent, humanControl: false, conversationId });
}

// The ✕ on an intent badge (list row or chat header) - lets the owner dismiss a resolved PQR/devolución/
// pide-asesor instead of it sitting there until the whole sales cycle closes (plan Fase 5, decision A).
async function dismissIntent(conversationId) {
  try {
    await apiFetch(`/admin/api/conversations/${conversationId}/intent`, { method: 'PUT' });
  } catch (err) {
    setStatus(`No se pudo quitar la etiqueta: ${err.message}`, true);
  }
}

async function openCustomer(customerId) {
  const thread = document.getElementById('modal-thread');
  currentCustomerId = customerId;
  document.getElementById('chat-panel-empty').style.display = 'none';
  document.getElementById('chat-panel-active').style.display = 'flex';
  document.getElementById('chat-split').classList.add('chat-split--open');
  document.querySelectorAll('.conv-row').forEach((row) => row.classList.toggle('active', row.dataset.customerId === customerId));
  thread.innerHTML = '<div style="text-align:center; color:var(--muted); font-size:13px; padding:20px;">Cargando…</div>';
  // Opening it counts as reading it - clear the badge immediately (the server also resets its own
  // counters as a side effect of the fetch below and broadcasts that, this just avoids waiting on the
  // round trip for the person who's looking right at it).
  setRowUnreadCount(customerId, 0);

  try {
    const res = await apiFetch(`/admin/api/customers/${customerId}/thread`);
    const data = await res.json();
    // Every existing action (composer, handoff, close-sale, extract-sale-details, the 30s poll) keeps
    // targeting currentConversationId exactly as before the grouping change - only what feeds the
    // sidebar/thread rendering changed.
    currentConversationId = data.activeConversationId;
    threadCyclesMeta = data.cycles;
    threadHasMore = data.hasMore;
    renderHandoffState(data.humanControl);
    updateCloseSaleButtonVisibility(data.status);
    currentCustomerTags = [...(data.customer.tags || [])];
    currentCustomerName = data.customer.name || '';
    currentCustomerPhone = data.customer.phoneNumber;
    cancelEditCustomerName();
    renderTags();

    const displayName = data.customer.name || data.customer.phoneNumber;
    const initial = displayName.trim().charAt(0).toUpperCase() || '?';
    const avatarEl = document.getElementById('modal-avatar');
    avatarEl.textContent = initial;
    avatarEl.style.background = avatarColor(data.customer.phoneNumber);
    document.getElementById('modal-title').textContent = displayName;
    renderModalSubtitle({
      status: data.status,
      intent: data.intent,
      conversationId: data.conversationId,
      customerName: data.customer.name,
      customerPhone: data.customer.phoneNumber,
    });

    renderedMessageIds = new Set(data.messages.map((m) => m.id));
    threadCycleBlocks = [{ conversationId: data.conversationId, html: data.messages.map(messageBubbleHtml).join('') }];
    renderMergedThread();

    thread.scrollTop = thread.scrollHeight;
    startConversationPolling();
  } catch (err) {
    thread.innerHTML = `<div style="text-align:center; color:var(--danger); font-size:13px; padding:20px;">No se pudo cargar: ${escapeHtml(err.message)}</div>`;
  }
}

function closeConversation() {
  document.getElementById('chat-panel-active').style.display = 'none';
  document.getElementById('chat-panel-empty').style.display = 'flex';
  document.getElementById('chat-split').classList.remove('chat-split--open');
  document.querySelectorAll('.conv-row').forEach((row) => row.classList.remove('active'));
  currentConversationId = null;
  currentCustomerId = null;
  currentCustomerTags = [];
  renderedMessageIds = new Set();
  threadCycleBlocks = [];
  threadCyclesMeta = [];
  threadHasMore = false;
  stopConversationPolling();
  clearComposerFile();
  closeSaleFormCancel();
}

async function openCloseSaleForm() {
  document.getElementById('close-sale-form').style.display = 'block';
  await prefillCloseSaleForm();
}

async function prefillCloseSaleForm() {
  if (!currentConversationId) return;
  const status = document.getElementById('close-sale-status');
  status.textContent = 'Leyendo la conversación...';
  status.style.color = 'var(--muted)';
  try {
    const res = await apiFetch(`/admin/api/conversations/${currentConversationId}/extract-sale-details`);
    const details = await res.json();
    document.getElementById('close-sale-items').value = (details.items || []).map((i) => `${i.quantity}x ${i.productName}`).join('\n');
    document.getElementById('close-sale-address').value = details.shippingAddress || '';
    document.getElementById('close-sale-payment').value = details.paymentMethodLabel || '';
    document.getElementById('close-sale-shipping').value = details.shippingCost ?? '';
    document.getElementById('close-sale-id').value = details.idNumber || '';
    document.getElementById('close-sale-phone').value = details.deliveryPhone || '';
    document.getElementById('close-sale-notes').value = details.notes || '';
    status.textContent = 'Prellenado con la IA - revisa y corrige antes de confirmar ✎';
  } catch (err) {
    status.textContent = `No se pudo prellenar automático (${err.message}) - llena a mano.`;
    status.style.color = 'var(--danger)';
  }
}

function closeSaleFormCancel() {
  document.getElementById('close-sale-form').style.display = 'none';
  document.getElementById('close-sale-items').value = '';
  document.getElementById('close-sale-address').value = '';
  document.getElementById('close-sale-payment').value = '';
  document.getElementById('close-sale-shipping').value = '';
  document.getElementById('close-sale-id').value = '';
  document.getElementById('close-sale-phone').value = '';
  document.getElementById('close-sale-notes').value = '';
  document.getElementById('close-sale-message').value = '';
  document.getElementById('close-sale-status').textContent = '';
  const confirmBtn = document.getElementById('close-sale-confirm-btn');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Confirmar venta';
}

async function confirmCloseSale() {
  if (!currentConversationId) return;
  const items = document.getElementById('close-sale-items').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (items.length === 0) {
    setStatus('Agrega al menos un producto', true);
    return;
  }
  const shippingAddress = document.getElementById('close-sale-address').value.trim();
  const paymentMethodLabel = document.getElementById('close-sale-payment').value.trim();
  const shippingCost = document.getElementById('close-sale-shipping').value.trim();
  const idNumber = document.getElementById('close-sale-id').value.trim();
  const deliveryPhone = document.getElementById('close-sale-phone').value.trim();
  const notes = document.getElementById('close-sale-notes').value.trim();
  const customerMessage = document.getElementById('close-sale-message').value.trim();

  const confirmBtn = document.getElementById('close-sale-confirm-btn');
  const status = document.getElementById('close-sale-status');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Cerrando venta...';
  status.textContent = '';
  try {
    await apiFetch(`/admin/api/conversations/${currentConversationId}/close-sale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, shippingAddress, paymentMethodLabel, shippingCost, idNumber, deliveryPhone, notes, customerMessage }),
    });
    setStatus('Venta cerrada, pedido registrado ✓');
    closeSaleFormCancel();
    openCustomer(currentCustomerId);
  } catch (err) {
    setStatus(`No se pudo cerrar la venta: ${err.message}`, true);
    status.textContent = `Error: ${err.message}`;
    status.style.color = 'var(--danger)';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirmar venta';
  }
}

function renderHandoffState(humanControl) {
  const btn = document.getElementById('modal-handoff-btn');
  const composer = document.getElementById('modal-composer');
  btn.textContent = humanControl ? 'Devolver a la IA' : 'Tomar control';
  btn.dataset.active = humanControl ? 'true' : 'false';
  // El composer está siempre a la vista: escribir ES tomar el control (el POST
  // de /messages hace setHumanControl(true) en el servidor), y el placeholder
  // lo dice en vez de esconder el campo hasta que se toque un botón.
  composer.style.display = 'flex';
  const input = document.getElementById('modal-composer-input');
  if (input) {
    input.placeholder = humanControl
      ? 'Escribe como el negocio…'
      : 'Escribí para tomar el control de la conversación…';
  }
  const hint = document.getElementById('bot-auto-hint');
  if (hint) hint.hidden = humanControl;
}

async function toggleHandoff() {
  if (!currentConversationId) return;
  const btn = document.getElementById('modal-handoff-btn');
  const nextActive = btn.dataset.active !== 'true';
  try {
    const res = await apiFetch(`/admin/api/conversations/${currentConversationId}/handoff`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: nextActive }),
    });
    const data = await res.json();
    renderHandoffState(data.humanControl);
  } catch (err) {
    setStatus(`No se pudo cambiar el control: ${err.message}`, true);
  }
}

let composerFile = null;

function onComposerFileChange(input) {
  composerFile = input.files[0] || null;
  const preview = document.getElementById('modal-composer-preview');
  if (composerFile) {
    preview.style.display = 'flex';
    preview.innerHTML = `📎 ${escapeHtml(composerFile.name)} <span style="cursor:pointer; color:var(--danger);" onclick="clearComposerFile()">✕</span>`;
  } else {
    preview.style.display = 'none';
    preview.innerHTML = '';
  }
}

function clearComposerFile() {
  composerFile = null;
  document.getElementById('modal-composer-file').value = '';
  const preview = document.getElementById('modal-composer-preview');
  preview.style.display = 'none';
  preview.innerHTML = '';
}

async function sendManualMessage() {
  if (!currentConversationId) return;
  const input = document.getElementById('modal-composer-input');
  const text = input.value.trim();
  if (!text && !composerFile) return;
  input.disabled = true;
  try {
    const formData = new FormData();
    formData.append('text', text);
    if (composerFile) formData.append('file', composerFile);
    await apiFetch(`/admin/api/conversations/${currentConversationId}/messages`, {
      method: 'POST',
      body: formData,
    });
    input.value = '';
    clearComposerFile();
    renderHandoffState(true);
    await openCustomer(currentCustomerId);
  } catch (err) {
    setStatus(`No se pudo enviar el mensaje: ${err.message}`, true);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function onPmTypeChange() {
  const type = document.getElementById('pm-type').value;
  const label = document.getElementById('pm-label');
  const details = document.getElementById('pm-details');
  const detailsLabel = document.getElementById('pm-details-label');
  if (type === 'TARJETA') {
    detailsLabel.textContent = 'Link de pago (puedes usar nuestro link de prueba para la demo)';
    details.placeholder = window.location.origin + '/pago-demo.html';
    label.placeholder = 'Ej: Pago con tarjeta';
  } else if (type === 'EFECTIVO') {
    detailsLabel.textContent = 'Instrucciones para el cliente';
    details.placeholder = 'Ej: Pago en efectivo al recibir el pedido (contraentrega)';
    label.placeholder = 'Ej: Contraentrega';
  } else {
    detailsLabel.textContent = 'Datos (número de cuenta, llave, celular, etc.)';
    details.placeholder = 'Ej: 300 123 4567 a nombre de Aurora Joyas';
    label.placeholder = 'Ej: Nequi';
  }
}

function pmTypeLabel(type) {
  return { TRANSFERENCIA: 'Transferencia', TARJETA: 'Tarjeta', EFECTIVO: 'Efectivo' }[type] || type;
}

let paymentMethodsCache = [];
let editingPaymentMethodId = null;

async function loadPaymentMethods() {
  const container = document.getElementById('payment-methods-list');
  try {
    const res = await apiFetch('/admin/api/payment-methods');
    const methods = await res.json();
    paymentMethodsCache = Array.isArray(methods) ? methods : [];

    if (paymentMethodsCache.length === 0) {
      container.innerHTML = '<div style="font-size:13px; color:var(--muted);">Todavía no agregaste ninguna forma de pago.</div>';
      return;
    }

    container.innerHTML = paymentMethodsCache.map((m) => `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md); ${m.active ? '' : 'opacity:.5;'}">
        <div>
          <span class="category-tag" style="margin-right:8px;">${pmTypeLabel(m.type)}</span>
          <strong style="font-size:13.5px;">${escapeHtml(m.label)}</strong>
          <div style="font-size:12px; color:var(--muted); margin-top:2px; max-width:420px; overflow-wrap:anywhere;">${escapeHtml(m.details)}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="btn-secondary" onclick="editPaymentMethod('${m.id}')">Editar</button>
          <button class="btn-secondary" onclick="togglePaymentMethod('${m.id}', ${!m.active})">${m.active ? 'Desactivar' : 'Activar'}</button>
          <button class="btn-danger" onclick="deletePaymentMethod('${m.id}')">Eliminar</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div style="font-size:13px; color:var(--danger);">No se pudieron cargar: ${escapeHtml(err.message)}</div>`;
  }
}

function editPaymentMethod(id) {
  const method = paymentMethodsCache.find((m) => m.id === id);
  if (!method) return;
  editingPaymentMethodId = id;
  document.getElementById('pm-type').value = method.type;
  onPmTypeChange();
  document.getElementById('pm-label').value = method.label;
  document.getElementById('pm-details').value = method.details;
  document.getElementById('pm-submit-btn').textContent = 'Guardar cambios';
  document.getElementById('pm-cancel-btn').style.display = 'inline-block';
  document.getElementById('pm-label').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEditPaymentMethod() {
  editingPaymentMethodId = null;
  document.getElementById('pm-label').value = '';
  document.getElementById('pm-details').value = '';
  document.getElementById('pm-submit-btn').textContent = '+ Agregar método de pago';
  document.getElementById('pm-cancel-btn').style.display = 'none';
}

async function addPaymentMethod() {
  const type = document.getElementById('pm-type').value;
  const label = document.getElementById('pm-label').value.trim();
  const details = document.getElementById('pm-details').value.trim();

  if (!label || !details) {
    setStatus('Completá el nombre y los datos del método de pago', true);
    return;
  }

  try {
    if (editingPaymentMethodId) {
      await apiFetch(`/admin/api/payment-methods/${editingPaymentMethodId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, label, details }),
      });
      setStatus('Método de pago actualizado ✓');
    } else {
      await apiFetch('/admin/api/payment-methods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, label, details }),
      });
      setStatus('Método de pago agregado ✓');
    }
  } catch (err) {
    setStatus(`No se pudo guardar: ${err.message}`, true);
    return;
  }

  cancelEditPaymentMethod();
  loadPaymentMethods();
}

async function togglePaymentMethod(id, active) {
  try {
    await apiFetch(`/admin/api/payment-methods/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    loadPaymentMethods();
  } catch (err) {
    setStatus(`No se pudo actualizar: ${err.message}`, true);
  }
}

async function deletePaymentMethod(id) {
  if (!confirm('¿Eliminar este método de pago?')) return;
  try {
    await apiFetch(`/admin/api/payment-methods/${id}`, { method: 'DELETE' });
    loadPaymentMethods();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

let faqEntriesCache = [];
let editingFaqId = null;

async function loadFaqEntries() {
  const container = document.getElementById('faq-list');
  try {
    const res = await apiFetch('/admin/api/faq');
    const entries = await res.json();
    faqEntriesCache = Array.isArray(entries) ? entries : [];

    if (faqEntriesCache.length === 0) {
      container.innerHTML = '<div style="font-size:13px; color:var(--muted);">Todavía no agregaste ninguna pregunta frecuente.</div>';
      return;
    }

    container.innerHTML = faqEntriesCache.map((f) => `
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md); ${f.active ? '' : 'opacity:.5;'}">
        <div>
          <strong style="font-size:13.5px;">${escapeHtml(f.question)}</strong>
          <div style="font-size:12px; color:var(--muted); margin-top:2px; max-width:480px; overflow-wrap:anywhere;">${escapeHtml(f.answer)}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="btn-secondary" onclick="editFaqEntry('${f.id}')">Editar</button>
          <button class="btn-secondary" onclick="toggleFaqEntry('${f.id}', ${!f.active})">${f.active ? 'Desactivar' : 'Activar'}</button>
          <button class="btn-danger" onclick="deleteFaqEntry('${f.id}')">Eliminar</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div style="font-size:13px; color:var(--danger);">No se pudieron cargar: ${escapeHtml(err.message)}</div>`;
  }
}

function editFaqEntry(id) {
  const entry = faqEntriesCache.find((f) => f.id === id);
  if (!entry) return;
  editingFaqId = id;
  document.getElementById('faq-question').value = entry.question;
  document.getElementById('faq-answer').value = entry.answer;
  document.getElementById('faq-submit-btn').textContent = 'Guardar cambios';
  document.getElementById('faq-cancel-btn').style.display = 'inline-block';
  document.getElementById('faq-question').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEditFaqEntry() {
  editingFaqId = null;
  document.getElementById('faq-question').value = '';
  document.getElementById('faq-answer').value = '';
  document.getElementById('faq-submit-btn').textContent = '+ Agregar pregunta';
  document.getElementById('faq-cancel-btn').style.display = 'none';
}

async function addFaqEntry() {
  const question = document.getElementById('faq-question').value.trim();
  const answer = document.getElementById('faq-answer').value.trim();

  if (!question || !answer) {
    setStatus('Completá la pregunta y la respuesta', true);
    return;
  }

  try {
    if (editingFaqId) {
      await apiFetch(`/admin/api/faq/${editingFaqId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer }),
      });
      setStatus('Pregunta frecuente actualizada ✓');
    } else {
      await apiFetch('/admin/api/faq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer }),
      });
      setStatus('Pregunta frecuente agregada ✓');
    }
  } catch (err) {
    setStatus(`No se pudo guardar: ${err.message}`, true);
    return;
  }

  cancelEditFaqEntry();
  loadFaqEntries();
}

async function toggleFaqEntry(id, active) {
  try {
    await apiFetch(`/admin/api/faq/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    loadFaqEntries();
  } catch (err) {
    setStatus(`No se pudo actualizar: ${err.message}`, true);
  }
}

async function deleteFaqEntry(id) {
  if (!confirm('¿Eliminar esta pregunta frecuente?')) return;
  try {
    await apiFetch(`/admin/api/faq/${id}`, { method: 'DELETE' });
    loadFaqEntries();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

async function loadCategoryAliases() {
  const container = document.getElementById('category-aliases-list');
  try {
    const res = await apiFetch('/admin/api/category-aliases');
    const aliases = await res.json();
    const list = Array.isArray(aliases) ? aliases : [];

    if (list.length === 0) {
      container.innerHTML = '<div style="font-size:13px; color:var(--muted);">Todavía no agregaste ningún sinónimo de categoría.</div>';
      return;
    }

    container.innerHTML = list.map((a) => `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md);">
        <div style="font-size:13.5px;"><strong>${escapeHtml(a.synonym)}</strong> significa lo mismo que <strong>${escapeHtml(a.canonical)}</strong></div>
        <button class="btn-danger" onclick="deleteCategoryAlias('${a.id}')">Eliminar</button>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div style="font-size:13px; color:var(--danger);">No se pudieron cargar: ${escapeHtml(err.message)}</div>`;
  }
}

async function addCategoryAlias() {
  const canonical = document.getElementById('ca-canonical').value.trim();
  const synonym = document.getElementById('ca-synonym').value.trim();

  if (!canonical || !synonym) {
    setStatus('Completá las dos palabras', true);
    return;
  }

  try {
    await apiFetch('/admin/api/category-aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canonical, synonym }),
    });
    document.getElementById('ca-canonical').value = '';
    document.getElementById('ca-synonym').value = '';
    setStatus('Sinónimo agregado ✓');
    loadCategoryAliases();
  } catch (err) {
    setStatus(`No se pudo agregar: ${err.message}`, true);
  }
}

async function deleteCategoryAlias(id) {
  if (!confirm('¿Eliminar este sinónimo?')) return;
  try {
    await apiFetch(`/admin/api/category-aliases/${id}`, { method: 'DELETE' });
    loadCategoryAliases();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

// Sugerencias aprendidas: cada fila trae sus propios campos editables (no reutiliza el formulario de
// arriba) para que "aprobar" sea una sola acción autocontenida, sin tener que rastrear "cuál sugerencia
// estoy editando ahora" en estado compartido.
function candidateRowHtml(c) {
  const freq = c.occurrences > 1
    ? `<span class="unread-badge" style="background:var(--brand); margin-bottom:8px;">preguntado ${c.occurrences} veces</span>`
    : '';
  return `
    <div style="padding:12px; border:1px solid var(--border); border-radius:var(--radius-md);" data-candidate-id="${c.id}">
      ${freq}
      <label style="font-size:12px;">Pregunta</label>
      <input class="candidate-question" value="${escapeHtml(c.question)}" />
      <label style="font-size:12px;">Respuesta</label>
      <textarea class="candidate-answer" rows="2">${escapeHtml(c.answer)}</textarea>
      <div class="actions-row" style="margin-top:8px;">
        <button class="btn-secondary" onclick="discardFaqCandidate('${c.id}')">Descartar</button>
        <button class="btn-primary" onclick="approveFaqCandidate('${c.id}')">Agregar a FAQ</button>
      </div>
    </div>
  `;
}

async function loadFaqCandidates() {
  const card = document.getElementById('faq-candidates-card');
  const container = document.getElementById('faq-candidates-list');
  try {
    const res = await apiFetch('/admin/api/faq-candidates');
    const candidates = await res.json();
    if (!Array.isArray(candidates) || candidates.length === 0) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    container.innerHTML = candidates.map(candidateRowHtml).join('');
  } catch {
    // silent - this is a nice-to-have panel, not worth a visible error banner if it fails to load
  }
}

async function approveFaqCandidate(id) {
  const row = document.querySelector(`[data-candidate-id="${id}"]`);
  if (!row) return;
  const question = row.querySelector('.candidate-question').value.trim();
  const answer = row.querySelector('.candidate-answer').value.trim();
  if (!question || !answer) {
    setStatus('Completá la pregunta y la respuesta', true);
    return;
  }
  try {
    await apiFetch(`/admin/api/faq-candidates/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, answer }),
    });
    setStatus('Agregada al FAQ ✓');
    loadFaqCandidates();
    loadFaqEntries();
  } catch (err) {
    setStatus(`No se pudo agregar: ${err.message}`, true);
  }
}

async function discardFaqCandidate(id) {
  try {
    await apiFetch(`/admin/api/faq-candidates/${id}/discard`, { method: 'POST' });
    loadFaqCandidates();
  } catch (err) {
    setStatus(`No se pudo descartar: ${err.message}`, true);
  }
}

const shipComposerFiles = {};

const ORDER_ICON = {
  note: '<path d="M5 3.5h14v17l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M8.5 8.5h7M8.5 12h7"/>',
  address: '<path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  payment: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/>',
  id: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14.5 10h4M14.5 13.5h4"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5z"/>',
};

function orderIcon(name) {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ORDER_ICON[name]}</svg>`;
}

function orderMetaItem(icon, text) {
  return `<div class="order-meta-item">${orderIcon(icon)}<span title="${escapeHtml(text)}">${escapeHtml(text)}</span></div>`;
}

function orderStatusChip(o) {
  if (o.canceledAt) return '<span class="order-status order-status-canceled">Cancelado</span>';
  if (o.fulfillmentStatus === 'SHIPPED') return '<span class="order-status order-status-sent">Enviado</span>';
  return '<span class="order-status">Pendiente de envío</span>';
}

function orderCardTop(o, actionsHtml = '') {
  const displayName = o.customer.name || o.customer.phoneNumber;
  const initial = (displayName || '?').trim().charAt(0).toUpperCase();
  const date = new Date(o.createdAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  const note = o.summary && o.summary.includes('— Nota:') ? o.summary.split('— Nota:')[1].trim() : '';

  const items = o.items.length > 0
    ? o.items.map((i) => `
        <div class="order-item">
          <span class="order-qty">${i.quantity}×</span>
          <div>
            <div class="order-item-name">${escapeHtml(i.productName)}</div>
            ${i.variantLabel ? `<div class="order-item-sub">${escapeHtml(i.variantLabel)}</div>` : ''}
          </div>
        </div>`).join('')
    : '<div class="order-item-sub">Sin productos identificados en el catálogo</div>';

  const meta = [
    o.shippingAddress ? orderMetaItem('address', o.shippingAddress) : '',
    o.paymentMethodLabel ? orderMetaItem('payment', o.paymentMethodLabel) : '',
    o.customer.idNumber ? orderMetaItem('id', `Cédula ${o.customer.idNumber}`) : '',
    o.customer.deliveryPhone ? orderMetaItem('phone', o.customer.deliveryPhone) : '',
  ].join('');

  const product = Number(o.totalAmount) - Number(o.shippingCost || 0);

  return `
    <div class="order-head">
      <div class="conv-avatar">${escapeHtml(initial)}</div>
      <div class="order-head-name">${escapeHtml(displayName)}</div>
      ${o.customer.id ? `<button class="order-head-link" type="button" onclick="goToCustomerProfile('${o.customer.id}')">ver cliente ›</button>` : ''}
      <div class="order-head-right">
        ${CSAT_EMOJI[o.csatRating] ? `<span title="Calificación del cliente">${CSAT_EMOJI[o.csatRating]}</span>` : ''}
        ${orderStatusChip(o)}
        <span class="order-head-date">${date}</span>
      </div>
    </div>
    <div class="order-body">
      <div class="order-body-main">
        ${items}
        ${note ? `<div class="order-note">${orderIcon('note')}<div>${escapeHtml(note)}</div></div>` : ''}
        ${meta ? `<div class="order-meta-grid">${meta}</div>` : ''}
      </div>
      <div class="order-side">
        <div class="order-sum-row"><span>Producto</span><span class="onix-num">${Number(product).toLocaleString('es-CO')}</span></div>
        ${o.shippingCost ? `<div class="order-sum-row"><span>Envío</span><span class="onix-num">${Number(o.shippingCost).toLocaleString('es-CO')}</span></div>` : ''}
        <div class="order-sum-total"><span>Total</span><span class="onix-num">${escapeHtml(o.currency)} ${Number(o.totalAmount).toLocaleString('es-CO')}</span></div>
        ${actionsHtml ? `<div class="order-side-actions">${actionsHtml}</div>` : ''}
      </div>
    </div>
  `;
}

function pendingOrderCard(o) {
  const actions = `
    <button class="btn-primary" type="button" onclick="openShipComposer('${o.id}')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
      Marcar enviado
    </button>
    <button class="btn-secondary" type="button" onclick="cancelOrder('${o.id}')">Cancelar</button>`;
  return `
    <div class="order-card" data-order-id="${o.id}">
      ${orderCardTop(o, actions)}
      <div class="ship-composer" id="ship-composer-${o.id}" style="display:none;">
        <textarea id="ship-note-${o.id}" placeholder="Mensaje para el cliente (opcional) - ej: número de guía, transportadora..."></textarea>
        <div class="ship-composer-row">
          <input type="file" id="ship-file-${o.id}" accept="image/jpeg,image/png,video/*" style="display:none;" onchange="onShipFileChange('${o.id}', this)" />
          <button class="btn-secondary" type="button" onclick="document.getElementById('ship-file-${o.id}').click()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.5 3.5 0 1 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"/></svg>
            Adjuntar guía/foto
          </button>
          <span id="ship-file-name-${o.id}" style="font-size:12px; color:var(--muted);"></span>
          <div style="flex:1;"></div>
          <button class="btn-secondary" type="button" onclick="closeShipComposer('${o.id}')">Cancelar</button>
          <button class="btn-primary" type="button" onclick="confirmShipOrder('${o.id}')">Confirmar envío</button>
        </div>
      </div>
    </div>
  `;
}

function shippedOrderCard(o) {
  const shippedDate = o.shippedAt ? new Date(o.shippedAt).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const isVideo = o.shipmentMediaUrl && o.shipmentMediaType === 'VIDEO';
  const media = o.shipmentMediaUrl
    ? (isVideo ? `<video src="${o.shipmentMediaUrl}" controls style="max-width:160px; border-radius:8px; display:block; margin-top:6px;"></video>` : `<img src="${o.shipmentMediaUrl}" alt="Prueba de envío" />`)
    : '';
  return `
    <div class="order-card" data-order-id="${o.id}">
      ${orderCardTop(o)}
      <div class="order-card-shipment">
        <div class="order-meta-item">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9"/></svg>
          <span>Enviado ${shippedDate ? `· ${shippedDate}` : ''}</span>
        </div>
        ${o.shipmentNote ? `<div style="margin-top:6px;">${formatMessageText(o.shipmentNote)}</div>` : ''}
        ${media}
      </div>
    </div>
  `;
}

function canceledOrderCard(o) {
  const canceledDate = o.canceledAt ? new Date(o.canceledAt).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return `
    <div class="order-card" data-order-id="${o.id}" style="opacity:.7;">
      ${orderCardTop(o)}
      <div class="order-card-meta" style="margin-top:10px; color:var(--onix-danger);">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg>
        Cancelado ${canceledDate ? `· ${canceledDate}` : ''}
      </div>
    </div>
  `;
}

function openShipComposer(id) {
  document.getElementById(`ship-composer-${id}`).style.display = 'block';
  document.getElementById(`ship-note-${id}`).focus();
}

function closeShipComposer(id) {
  document.getElementById(`ship-composer-${id}`).style.display = 'none';
  document.getElementById(`ship-note-${id}`).value = '';
  document.getElementById(`ship-file-name-${id}`).textContent = '';
  delete shipComposerFiles[id];
}

function onShipFileChange(id, input) {
  const file = input.files[0];
  shipComposerFiles[id] = file || null;
  document.getElementById(`ship-file-name-${id}`).textContent = file ? file.name : '';
}

async function confirmShipOrder(id) {
  const note = document.getElementById(`ship-note-${id}`).value.trim();
  const file = shipComposerFiles[id];
  const formData = new FormData();
  formData.append('note', note);
  if (file) formData.append('file', file);
  try {
    const res = await apiFetch(`/admin/api/orders/${id}/ship`, { method: 'PUT', body: formData });
    const data = await res.json();
    delete shipComposerFiles[id];
    if (data.mediaError) {
      setStatus(`Mensaje enviado, pero el archivo adjunto falló: ${data.mediaError}`, true);
    } else {
      setStatus('Pedido marcado como enviado ✓');
    }
    loadOrderCounts();
    loadOrders(true);
  } catch (err) {
    setStatus(`No se pudo marcar el envío: ${err.message}`, true);
  }
}

async function cancelOrder(id) {
  if (!confirm('¿Cancelar este pedido? El cliente no recibe ningún mensaje automático.')) return;
  try {
    await apiFetch(`/admin/api/orders/${id}/cancel`, { method: 'PUT' });
    loadOrderCounts();
    loadOrders(true);
  } catch (err) {
    setStatus(`No se pudo cancelar: ${err.message}`, true);
  }
}

// Pendientes/Enviados/Cancelados used to be one unbounded list each, all three always fetched in full
// (with a presigned S3 URL per order with shipment media) on every 30s poll and socket reconnect - as
// order history grows over months that payload and S3-call count only ever grows. Now: one paged request
// for whichever sub-tab is open, counts kept separate and cheap (see loadOrderCounts).
const ORDERS_PAGE_SIZE = 20;
let ordersActiveStatus = 'PENDING';
let ordersLoadedCount = 0;
let ordersTotalForStatus = 0;

const ORDER_CARD_RENDERERS = { PENDING: pendingOrderCard, SHIPPED: shippedOrderCard, CANCELED: canceledOrderCard };
const ORDERS_EMPTY_TEXT = {
  PENDING: '<div class="empty-state"><div class="big">📦</div>No hay pedidos pendientes de envío.</div>',
  SHIPPED: '<div class="empty-state" style="padding:24px;">Todavía no hay pedidos enviados.</div>',
  CANCELED: '<div class="empty-state" style="padding:24px;">Sin pedidos cancelados.</div>',
};

function switchOrdersTab(status) {
  ordersActiveStatus = status;
  document.querySelectorAll('.order-subtab-btn').forEach(b => b.classList.toggle('active', b.dataset.orderStatus === status));
  loadOrders(true);
}

async function loadOrderCounts() {
  try {
    const res = await apiFetch('/admin/api/orders/counts');
    const counts = await res.json();
    document.getElementById('orders-pending-count').textContent = counts.PENDING || 0;
    document.getElementById('orders-shipped-count').textContent = counts.SHIPPED || 0;
    document.getElementById('orders-canceled-count').textContent = counts.CANCELED || 0;
  } catch {}
}

async function loadOrders(reset) {
  const listEl = document.getElementById('orders-list');
  const status = ordersActiveStatus;
  const skip = reset ? 0 : ordersLoadedCount;
  try {
    const res = await apiFetch(`/admin/api/orders?status=${status}&skip=${skip}&take=${ORDERS_PAGE_SIZE}`);
    const { orders, total } = await res.json();
    if (status !== ordersActiveStatus) return; // user switched tabs while this was in flight

    const render = ORDER_CARD_RENDERERS[status];
    const html = orders.map(render).join('');
    if (reset) {
      listEl.innerHTML = orders.length ? html : ORDERS_EMPTY_TEXT[status];
      ordersLoadedCount = orders.length;
    } else {
      listEl.insertAdjacentHTML('beforeend', html);
      ordersLoadedCount += orders.length;
    }
    ordersTotalForStatus = total;
    document.getElementById('orders-load-more-wrap').hidden = ordersLoadedCount >= total;
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state" style="color:var(--danger);">No se pudieron cargar los pedidos: ${escapeHtml(err.message)}</div>`;
  }
}

function loadMoreOrders() {
  loadOrders(false);
}

let analyticsRange = 30;
let analyticsLast = null;

function setAnalyticsRange(days) {
  analyticsRange = days;
  document.querySelectorAll('#analytics-range button').forEach((b) => {
    b.classList.toggle('is-active', Number(b.dataset.days) === days);
  });
  loadAnalytics();
}

// El CSV se arma con lo que ya está en pantalla: no hay una segunda consulta
// que pueda dar un número distinto al que el dueño está mirando.
function exportAnalyticsCsv() {
  const s = analyticsLast;
  if (!s) { setStatus('Todavía no hay datos para exportar', true); return; }
  const rows = [['seccion', 'etiqueta', 'valor']];
  Object.entries(s.byStatus).forEach(([k, v]) => rows.push(['conversaciones_por_estado', STATUS_LABELS[k] || k, v]));
  (s.messagesByDay || []).forEach((d) => {
    rows.push(['mensajes_por_dia', `${d.date} clientes`, d.customer]);
    rows.push(['mensajes_por_dia', `${d.date} bot`, d.assistant]);
  });
  (s.topProducts || []).forEach((p) => rows.push(['productos_mas_consultados', p.name, p.inquiryCount]));

  const csv = rows.map((r) => r.map((cell) => {
    const text = String(cell ?? '');
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\r\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `onix-analytics-${analyticsRange}d.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadAnalytics() {
  const container = document.getElementById('analytics-container');
  try {
    const res = await apiFetch(`/admin/api/analytics?days=${analyticsRange}`);
    const s = await res.json();
    analyticsLast = s;

    // --- Embudo por estado -------------------------------------------------
    // Vendido y Perdido llevan color de estado; el resto es "en curso" y va en
    // gris: son etapas, no resultados, y pintarlas de colores solo hace ruido.
    const statusEntries = Object.entries(s.byStatus);
    const statusMax = Math.max(1, ...statusEntries.map(([, c]) => c));
    const statusBars = statusEntries.map(([status, count]) => {
      const tone = status === 'SOLD' ? 'var(--onix-series-bot)'
        : status === 'LOST' ? 'var(--onix-series-lost)'
        : 'var(--onix-series-open)';
      const pct = (count / statusMax) * 100;
      return `
        <div class="bar-row" title="${escapeHtml(STATUS_LABELS[status] || status)}: ${count}">
          <span class="bar-label">${escapeHtml(STATUS_LABELS[status] || status)}</span>
          <span class="bar-track">${count === 0
            ? '<span class="bar-zero"></span>'
            : `<span class="bar-fill" style="width:${pct}%; background:${tone};"></span>`}</span>
          <span class="bar-value onix-num${count === 0 ? ' is-zero' : ''}">${count}</span>
        </div>`;
    }).join('');

    // --- Productos más consultados ----------------------------------------
    const prodMax = Math.max(1, ...s.topProducts.map(p => p.inquiryCount));
    const productBars = s.topProducts.map(p => `
      <div class="bar-row" title="${escapeHtml(p.name)}: ${p.inquiryCount} consultas">
        <span class="bar-label bar-label-wide">${escapeHtml(p.name)}</span>
        <span class="bar-track">${p.inquiryCount === 0
          ? '<span class="bar-zero"></span>'
          : `<span class="bar-fill" style="width:${(p.inquiryCount / prodMax) * 100}%; background:var(--onix-series-clients);"></span>`}</span>
        <span class="bar-value onix-num">${p.inquiryCount}</span>
      </div>`).join('');

    // --- Mensajes por día: dos series, una escala, leyenda obligatoria ------
    const days = [...s.messagesByDay].reverse();
    const dayMax = Math.max(1, ...days.map(d => Math.max(d.customer, d.assistant)));
    const dayCols = days.map(d => {
      const fmt = (n) => `${Math.round((n / dayMax) * 100)}%`;
      const label = new Date(d.date + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
      return `
        <div class="col-group">
          <div class="col-pair">
            <span class="col" title="Clientes el ${escapeHtml(d.date)}: ${d.customer}">
              <span class="col-value onix-num">${d.customer}</span>
              <span class="col-fill" style="height:${fmt(d.customer)}; background:var(--onix-series-clients);"></span>
            </span>
            <span class="col" title="Bot el ${escapeHtml(d.date)}: ${d.assistant}">
              <span class="col-value onix-num">${d.assistant}</span>
              <span class="col-fill" style="height:${fmt(d.assistant)}; background:var(--onix-series-bot);"></span>
            </span>
          </div>
          <span class="col-label onix-num">${escapeHtml(label)}</span>
        </div>`;
    }).join('');

    const inProgress = s.byStatus.NEW + s.byStatus.INTERESTED + s.byStatus.QUOTED + s.byStatus.NEGOTIATING;

    container.innerHTML = `
      <div class="metric-grid" style="margin-bottom:16px;">
        <div class="metric-card">
          <div class="label">Conversaciones (30 días)</div>
          <div class="value">${s.totalConversations}</div>
        </div>
        <div class="metric-card">
          <div class="label">Tasa de conversión</div>
          <div class="value" style="color:var(--onix-accent);">${(s.conversionRate * 100).toFixed(1)}%</div>
          <div class="sub">${s.byStatus.SOLD} vendidas / ${s.byStatus.LOST} perdidas</div>
        </div>
        <div class="metric-card">
          <div class="label">En curso</div>
          <div class="value">${inProgress}</div>
          <div class="sub">nuevo · interesado · cotizado · negociando</div>
        </div>
        <div class="metric-card">
          <div class="label">Satisfacción (CSAT)</div>
          <div class="value">${s.avgCsat !== null ? `${s.avgCsat.toFixed(1)}<span style="font-size:15px; color:var(--onix-dim);">/3</span>` : '—'}</div>
          <div class="sub">${s.csatCount} respuesta${s.csatCount === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div class="chart-grid">
        <section class="card chart-card">
          <div class="chart-head">
            <h3 class="chart-title">Conversaciones por estado</h3>
            <span class="chart-note onix-num">${s.totalConversations} totales</span>
          </div>
          <div class="bar-list">${statusBars}</div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-dot" style="background:var(--onix-series-bot);"></span>Vendido</span>
            <span class="legend-item"><span class="legend-dot" style="background:var(--onix-series-lost);"></span>Perdido</span>
            <span class="legend-item"><span class="legend-dot" style="background:var(--onix-series-open);"></span>En curso</span>
          </div>
        </section>

        <section class="card chart-card">
          <div class="chart-head">
            <h3 class="chart-title">Mensajes por día</h3>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot" style="background:var(--onix-series-clients);"></span>Clientes</span>
              <span class="legend-item"><span class="legend-dot" style="background:var(--onix-series-bot);"></span>Bot</span>
            </div>
          </div>
          ${days.length === 0
            ? '<div class="empty-state">Todavía no hay mensajes registrados.</div>'
            : `<div class="col-chart">${dayCols}</div>`}
        </section>
      </div>

      <section class="card chart-card" style="margin-top:12px;">
        <div class="chart-head">
          <h3 class="chart-title">Productos más consultados</h3>
          <span class="chart-note">consultas en 30 días</span>
        </div>
        ${s.topProducts.length === 0
          ? '<div class="empty-state">Todavía no hay consultas de productos registradas.</div>'
          : `<div class="bar-list">${productBars}</div>`}
      </section>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card empty-state" style="color:var(--onix-danger);">No se pudo cargar el analytics: ${escapeHtml(err.message)}</div>`;
  }
}

function configHealthChecklistHtml(health) {
  const items = [
    { ok: health.hasContactPhone, label: 'Teléfono de contacto configurado', missing: 'Sin esto, ninguna escalación al dueño (ask_owner, PQR, etc) llega a ningún lado - configuralo en Negocio > Identidad.' },
    { ok: health.hasCategoriesConfigured, label: 'Al menos un producto con categoría cargada', missing: 'Sin categorías, el bot depende de una vocabulario derivado de los nombres de producto para reconocer consultas como "¿qué relojes tienen?" - cargar la categoría real en Catálogo es más confiable.' },
    { ok: health.hasPaymentMethods, label: 'Al menos un método de pago activo', missing: 'Sin un método de pago configurado, el bot no puede confirmarle al cliente cómo pagar - agregalo en Bot > Pagos.' },
    {
      ok: health.hasApprovedOwnerAlertTemplate === null ? null : health.hasApprovedOwnerAlertTemplate,
      label: 'Plantilla "onix_owner_alert" aprobada por WhatsApp',
      missing: 'Sin esta plantilla aprobada, una escalación nocturna (fuera de la ventana de 24h del dueño) puede no llegarle nunca - revisá Bot > Canales > Plantillas.',
      unknown: 'No se pudo verificar todavía (conectá WhatsApp Business primero en Bot > Canales).',
    },
  ];
  const ICON = {
    ok: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.8v.2"/>',
    unknown: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 1.8"/>',
  };
  const cells = items.map((item) => {
    const state = item.ok === null ? 'unknown' : item.ok ? 'ok' : 'warn';
    const detail = item.ok === null ? item.unknown : item.ok ? '' : item.missing;
    return `
      <div class="check-item check-${state}">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[state]}</svg>
        <div>
          <div class="check-label">${escapeHtml(item.label)}</div>
          ${detail ? `<div class="check-detail">${escapeHtml(detail)}</div>` : ''}
        </div>
      </div>`;
  }).join('');
  return `<div class="check-grid">${cells}</div>`;
}

function configHealthScore(health) {
  const flags = [
    health.hasContactPhone,
    health.hasCategoriesConfigured,
    health.hasPaymentMethods,
    health.hasApprovedOwnerAlertTemplate,
  ];
  return `${flags.filter(Boolean).length}/${flags.length}`;
}

async function loadAiUsage() {
  const container = document.getElementById('ai-usage-container');
  try {
    const [res, incidentsRes, healthRes] = await Promise.all([
      apiFetch('/admin/api/ai-usage'),
      apiFetch('/admin/api/agent-incidents'),
      apiFetch('/admin/api/config-health'),
    ]);
    const s = await res.json();
    const incidents = await incidentsRes.json();
    const health = await healthRes.json();

    const rows = [...s.byDay].reverse().map(d => `
      <tr>
        <td style="padding:10px 16px; border-top:1px solid var(--border);">${d.date}</td>
        <td style="padding:10px 16px; border-top:1px solid var(--border); text-align:right;">US$ ${d.costUsd.toFixed(4)}</td>
      </tr>
    `).join('');

    const pu = s.planUsage;
    const planLabel = { BASICO: 'Básico', EMPRENDEDOR: 'Emprendedor', NEGOCIO: 'Negocio' }[pu.planTier] || pu.planTier;
    const barColor = pu.usagePercent >= 100 ? 'var(--danger)' : pu.usagePercent >= 70 ? 'var(--onix-warn)' : 'var(--brand)';
    const monthLabel = new Date(pu.periodStart).toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
    const unlimited = pu.messageCap === null;

    container.innerHTML = `
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <div style="font-size:12px; color:var(--muted);">Consumo del plan ${escapeHtml(planLabel)} · ${monthLabel}</div>
          <div style="font-size:12px; color:var(--muted);">${unlimited ? `${pu.messagesUsed.toLocaleString('es-CO')} mensajes · ilimitado` : `${pu.messagesUsed.toLocaleString('es-CO')} / ${pu.messageCap.toLocaleString('es-CO')} mensajes`}</div>
        </div>
        ${unlimited ? '' : `
        <div style="background:var(--border-soft); border-radius:999px; height:10px; margin-top:8px; overflow:hidden;">
          <div style="width:${Math.min(pu.usagePercent, 100)}%; background:${barColor}; height:100%; border-radius:999px;"></div>
        </div>
        <div style="font-size:20px; font-weight:700; margin-top:8px; color:${barColor};">${pu.usagePercent}%</div>
        ${pu.usagePercent >= 100
          ? '<div style="font-size:12px; color:var(--danger); margin-top:4px;">Superaste el límite estimado de tu plan este mes.</div>'
          : pu.usagePercent >= 70
            ? '<div style="font-size:12px; color:var(--onix-warn); margin-top:4px;">Te estás acercando al límite de tu plan.</div>'
            : ''}`}
      </div>
      <div class="grid-3" style="margin-bottom:16px;">
        <div class="card">
          <div style="font-size:12px; color:var(--muted);">Costo total (14 días)</div>
          <div style="font-size:24px; font-weight:700;">US$ ${s.totalCostUsd.toFixed(4)}</div>
        </div>
        <div class="card">
          <div style="font-size:12px; color:var(--muted);">Llamadas a la IA</div>
          <div style="font-size:24px; font-weight:700;">${s.totalCalls}</div>
          <div style="font-size:12px; color:var(--muted);">${s.chatCalls} chat / ${s.visionCalls} fotos</div>
        </div>
        <div class="card">
          <div style="font-size:12px; color:var(--muted);">Tokens (14 días)</div>
          <div style="font-size:24px; font-weight:700;">${(s.totalInputTokens + s.totalOutputTokens).toLocaleString('es-CO')}</div>
          <div style="font-size:12px; color:var(--muted);">${s.totalInputTokens.toLocaleString('es-CO')} entrada / ${s.totalOutputTokens.toLocaleString('es-CO')} salida</div>
          <div style="font-size:12px; color:var(--muted); margin-top:4px;">Cache hit: ${s.cacheHitRatio}%</div>
        </div>
      </div>
      <div class="section-title">Costo por día</div>
      <div class="card" style="padding:0; overflow:hidden;">
        ${s.byDay.length === 0
          ? '<div class="empty-state"><div class="big">📊</div>Todavía no hay uso registrado.</div>'
          : `<table style="width:100%; border-collapse:collapse;">
              <thead><tr><th style="text-align:left; padding:10px 16px; font-size:12px; color:var(--muted);">Fecha</th><th style="text-align:right; padding:10px 16px; font-size:12px; color:var(--muted);">Costo (USD)</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`}
      </div>
      <div class="section-title" style="margin-top:24px;">Salud del bot (últimos 7 días)</div>
      <div class="grid-3">
        <div class="card">
          <div style="font-size:12px; color:var(--muted);">Conversaciones estancadas ahora</div>
          <div style="font-size:24px; font-weight:700; ${incidents.stalledConversations > 0 ? 'color:var(--onix-warn);' : ''}">${incidents.stalledConversations}</div>
          <div style="font-size:12px; color:var(--muted);">Pausadas (humano) esperando respuesta</div>
        </div>
        <div class="card">
          <div style="font-size:12px; color:var(--muted);">Respuestas degradadas</div>
          <div style="font-size:24px; font-weight:700; ${incidents.degradedReplies > 0 ? 'color:var(--danger);' : ''}">${incidents.degradedReplies + incidents.loopExhausted}</div>
          <div style="font-size:12px; color:var(--muted);">${incidents.loopExhausted} agotamiento de herramientas · ${incidents.degradedReplies} genéricas</div>
        </div>
        <div class="card">
          <div style="font-size:12px; color:var(--muted);">Intervenciones de respaldo</div>
          <div style="font-size:24px; font-weight:700;">${incidents.backstopInterventions}</div>
          <div style="font-size:12px; color:var(--muted);">Veces que el bot prometió algo y el sistema lo completó</div>
        </div>
        <div class="card">
          <div style="font-size:12px; color:var(--muted);">Fallos de servicios externos</div>
          <div style="font-size:24px; font-weight:700; ${incidents.externalApiFailures > 0 ? 'color:var(--danger);' : ''}">${incidents.externalApiFailures}</div>
          <div style="font-size:12px; color:var(--muted);">${incidents.lastExternalApiFailure
            ? escapeHtml(incidents.lastExternalApiFailure.detail).slice(0, 140)
            : 'Análisis de fotos y otros servicios respondiendo bien'}</div>
        </div>
      </div>
      <div class="section-title" style="margin-top:24px;">Chequeo de configuración<span class="section-count onix-num">${configHealthScore(health)}</span></div>
      ${configHealthChecklistHtml(health)}
    `;
  } catch (err) {
    container.innerHTML = `<div class="card empty-state" style="color:var(--danger);">No se pudo cargar el consumo: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadTeamMembers() {
  const container = document.getElementById('team-list');
  try {
    const res = await apiFetch('/admin/api/team');
    const members = await res.json();

    if (!Array.isArray(members) || members.length === 0) {
      container.innerHTML = '<div style="font-size:13px; color:var(--muted);">Todavía no agregaste ningún empleado.</div>';
      return;
    }

    container.innerHTML = members.map((m) => `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md); ${m.active ? '' : 'opacity:.5;'}">
        <div>
          <strong style="font-size:13.5px;">${escapeHtml(m.name)}</strong>
          <div style="font-size:12px; color:var(--muted); margin-top:2px;">${escapeHtml(m.email)}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="btn-secondary" onclick="toggleTeamMember('${m.id}', ${!m.active})">${m.active ? 'Desactivar' : 'Activar'}</button>
          <button class="btn-danger" onclick="deleteTeamMember('${m.id}')">Eliminar</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div style="font-size:13px; color:var(--danger);">No se pudieron cargar: ${escapeHtml(err.message)}</div>`;
  }
}

async function addTeamMember() {
  const name = document.getElementById('team-name').value.trim();
  const email = document.getElementById('team-email').value.trim();
  const password = document.getElementById('team-password').value;

  if (!name || !email || !password) {
    setStatus('Completá nombre, email y contraseña', true);
    return;
  }
  if (password.length < 8) {
    setStatus('La contraseña debe tener al menos 8 caracteres', true);
    return;
  }

  try {
    await apiFetch('/admin/api/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
  } catch (err) {
    setStatus(`No se pudo agregar: ${err.message}`, true);
    return;
  }

  document.getElementById('team-name').value = '';
  document.getElementById('team-email').value = '';
  document.getElementById('team-password').value = '';
  setStatus('Empleado agregado ✓');
  loadTeamMembers();
}

async function toggleTeamMember(id, active) {
  try {
    await apiFetch(`/admin/api/team/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    loadTeamMembers();
  } catch (err) {
    setStatus(`No se pudo actualizar: ${err.message}`, true);
  }
}

async function deleteTeamMember(id) {
  if (!confirm('¿Eliminar este empleado?')) return;
  try {
    await apiFetch(`/admin/api/team/${id}`, { method: 'DELETE' });
    loadTeamMembers();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

let isOwner = true;

const OWNER_ONLY_INPUT_IDS = [
  'business-name', 'business-description', 'business-instructions',
  'bot-category', 'bot-assistant-name', 'bot-tone', 'bot-dialect', 'bot-greeting', 'bot-never-say', 'bot-photo-mode', 'bot-require-proof',
  'business-contact-name',
  'business-contact-phone', 'business-followup-template', 'business-followup-language', 'business-followup-hours',
  'pm-type', 'pm-label', 'pm-details',
  'faq-question', 'faq-answer',
  'team-name', 'team-email', 'team-password',
];

async function loadRole() {
  try {
    const res = await fetch('/auth/me');
    if (res.ok) {
      const me = await res.json();
      isOwner = me.role !== 'EMPLOYEE';
      const badge = document.getElementById('session-badge');
      if (badge) {
        const roleIcon = isOwner
          ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 6.6L21 9l-5 4.4L17.4 20 12 16.6 6.6 20 8 13.4 3 9l6.6-.4z"/></svg>'
          : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5"/></svg>';
        badge.innerHTML = `<span class="session-email">${escapeHtml(me.email)}</span><br/><span class="role-pill">${roleIcon}${isOwner ? 'Dueño' : 'Empleado'}</span>`;
      }
    } else {
      isOwner = false;
    }
  } catch {
    isOwner = false;
  }
  document.querySelectorAll('.owner-only').forEach((el) => { el.hidden = !isOwner; });
  OWNER_ONLY_INPUT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !isOwner;
  });
}

// Patches the sidebar row in place (preview text + relative time) and bumps it to the top of the
// list - avoids a full loadCustomers() refetch for the common case (a new message on a customer
// already visible in the sidebar). Returns false if the row isn't in the DOM yet (a brand-new
// customer's first message can arrive before its conversation:new event), so the caller can fall back
// to a one-off refetch.
function bumpCustomerRow(customerId, previewText, isAssistant, updatedAtIso) {
  const row = document.querySelector(`.conv-row[data-customer-id="${customerId}"]`);
  if (!row) return false;
  const previewEl = row.querySelector('.conv-preview');
  if (previewEl) previewEl.textContent = `${isAssistant ? 'Tú (bot): ' : ''}${String(previewText ?? '').slice(0, 80)}`;
  const timeEl = row.querySelector('.conv-time');
  if (timeEl) {
    timeEl.dataset.updatedAt = updatedAtIso;
    timeEl.textContent = timeAgo(updatedAtIso);
  }
  const list = document.getElementById('conversations-list');
  if (list && list.firstElementChild !== row) list.insertBefore(row, list.firstElementChild);
  return true;
}

// Patches a row's unread badge in place and keeps the tab-level total in sync. `data-unread` on the
// row is the source of truth the total is summed from, instead of parsing the badge's own text back
// into a number (which would mis-parse the "99+" cap).
function setRowUnreadCount(customerId, count) {
  const row = document.querySelector(`.conv-row[data-customer-id="${customerId}"]`);
  if (row) {
    row.dataset.unread = String(count);
    let badge = row.querySelector('.unread-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        row.querySelector('.conv-meta').insertBefore(badge, row.querySelector('.conv-badges'));
      }
      badge.textContent = count > 99 ? '99+' : String(count);
    } else if (badge) {
      badge.remove();
    }
  }
  updateTotalUnreadBadge();
}

function updateTotalUnreadBadge() {
  let total = 0;
  document.querySelectorAll('.conv-row').forEach((row) => { total += Number(row.dataset.unread) || 0; });
  const tabBadge = document.getElementById('tab-unread-conversations');
  if (!tabBadge) return;
  if (total > 0) {
    tabBadge.textContent = total > 99 ? '99+' : String(total);
    tabBadge.hidden = false;
  } else {
    tabBadge.hidden = true;
  }
}

function setRealtimeStatus(connected) {
  ['realtime-indicator-conversations', 'realtime-indicator-orders'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-connected', connected);
    el.classList.toggle('is-disconnected', !connected);
    const label = el.querySelector('.realtime-indicator-text');
    if (label) label.textContent = connected ? 'En vivo' : 'Reconectando…';
  });
}

// Socket.IO is the primary realtime channel for the admin panel: new messages, new conversations, and
// order changes push instantly instead of requiring a manual "↻ Actualizar" click or waiting on a
// poll. The connect handler (fires on initial load AND on any reconnect after a dropped connection)
// does one reconciliation refetch so nothing is missed during a gap.
// `conversationId === currentConversationId` alone is NOT "the owner is looking at it right now" -
// currentConversationId stays set after switching to a different tab (Pedidos, Analytics, ...), or
// while the browser tab/window itself is in the background. Without also checking the active tab and
// page visibility, a message arriving for whatever was last opened got silently marked read even
// though nobody was looking - the accumulated badge would vanish on its own.
function isActivelyViewingConversation(conversationId) {
  return conversationId === currentConversationId
    && document.querySelector('.tab-btn[data-tab="conversations"]')?.classList.contains('active')
    && document.visibilityState === 'visible'
    && document.hasFocus();
}

// Catches the conversation back up to "read" once the owner is genuinely looking again - e.g. they
// had a conversation open, switched to another tab while new messages piled up, then switched back.
function markConversationReadIfViewing() {
  if (!currentConversationId || !isActivelyViewingConversation(currentConversationId)) return;
  const row = document.querySelector(`.conv-row[data-customer-id="${currentCustomerId}"]`);
  if (row && Number(row.dataset.unread) > 0) {
    setRowUnreadCount(currentCustomerId, 0);
    apiFetch(`/admin/api/conversations/${currentConversationId}`).catch(() => {});
  }
}

function initRealtime() {
  const socket = io();

  socket.on('connect', () => {
    setRealtimeStatus(true);
    loadCustomers();
    loadOrderCounts();
    loadOrders(true);
  });
  socket.on('disconnect', () => setRealtimeStatus(false));

  document.addEventListener('visibilitychange', markConversationReadIfViewing);
  window.addEventListener('focus', markConversationReadIfViewing);

  // The open thread already has its own reconciliation poll (pollConversation), but nothing was
  // periodically re-syncing the sidebar list itself - if it ever drifted from the server for any
  // reason (a missed event, a brief disconnect that didn't trigger the connect handler's refetch,
  // etc.) there was no self-healing, the stale badge would just sit there until a manual reload.
  setInterval(() => {
    loadCustomers();
    loadOrderCounts();
    loadOrders(true);
  }, 30000);

  socket.on('message:new', ({ conversationId, customerId, message, unreadCount }) => {
    if (conversationId === currentConversationId) {
      // Keep the thread DOM current regardless of visibility, so it's already correct whenever they
      // do look - just don't treat it as read yet unless they're actually looking right now.
      renderThreadMessages(document.getElementById('modal-thread'), [message]);
    }
    if (isActivelyViewingConversation(conversationId)) {
      setRowUnreadCount(customerId, 0);
      if (message.role === 'CUSTOMER') {
        apiFetch(`/admin/api/conversations/${conversationId}`).catch(() => {});
      }
    } else {
      // This is the unread count for THIS conversation, not the customer's summed total - close
      // enough in practice (a closed cycle's own unreadCount never moves again once it's reset), and
      // loadCustomers() below (and the 30s reconciliation poll) corrects any drift.
      setRowUnreadCount(customerId, unreadCount);
    }
    const previewText =
      message.mediaType === 'IMAGE' ? (message.content || '📷 Imagen')
      : message.mediaType === 'VIDEO' ? (message.content || '🎥 Video')
      : message.content;
    const bumped = bumpCustomerRow(customerId, previewText, message.role === 'ASSISTANT', message.createdAt);
    if (!bumped) loadCustomers();
  });

  socket.on('conversation:new', (c) => {
    if (document.querySelector(`.conv-row[data-customer-id="${c.customer.id}"]`)) {
      // This customer already has a row from an earlier sales cycle - the exact case
      // [[onix-conversations-group-by-customer]] fixes: refresh that row (picks up the new
      // activeConversationId/orderCount) instead of inserting a second, visually-duplicate one.
      loadCustomers();
      return;
    }
    const list = document.getElementById('conversations-list');
    const emptyState = list.querySelector('.empty-state');
    if (emptyState) list.innerHTML = '';
    list.insertAdjacentHTML('afterbegin', customerRowHtml(customerRowFromConversationEvent(c)));
    const countEl = document.getElementById('tab-count-conversations');
    if (countEl) countEl.textContent = String(document.querySelectorAll('.conv-row').length);
    updateTotalUnreadBadge();
  });

  socket.on('conversation:updated', (c) => {
    const row = document.querySelector(`.conv-row[data-customer-id="${c.customer.id}"]`);
    if (row) {
      // Patches in place rather than a full outerHTML replace - most emits of this event (handoff
      // toggle, status change, intent change) carry no lastMessage/orderCount, so a blind replace used
      // to blank the preview text back to "Sin mensajes" and reset "N compras" on every such change.
      const displayName = c.customer.name || c.customer.phoneNumber;
      const nameEl = row.querySelector('.conv-name');
      if (nameEl) nameEl.textContent = displayName;
      const avatarEl = row.querySelector('.conv-avatar');
      if (avatarEl) { avatarEl.textContent = displayName.trim().charAt(0).toUpperCase() || '?'; avatarEl.style.background = avatarColor(c.customer.phoneNumber); }
      if (c.lastMessage) {
        const previewEl = row.querySelector('.conv-preview');
        if (previewEl) previewEl.textContent = `${c.lastMessage.role === 'ASSISTANT' ? 'Tú (bot): ' : ''}${String(c.lastMessage.content).slice(0, 80)}`;
      }
      row.dataset.activeConversationId = c.id;
      const badgesEl = row.querySelector('.conv-badges');
      if (badgesEl) badgesEl.innerHTML = statusBadgeHtml({ status: c.status, intent: c.intent, humanControl: c.humanControl, conversationId: c.id });
    } else {
      loadCustomers();
    }
    updateTotalUnreadBadge();
    if (c.id === currentConversationId) {
      renderHandoffState(c.humanControl);
      updateCloseSaleButtonVisibility(c.status);
      // 2026-09-13 fix: a name saved mid-conversation (save_customer_name) used to never reach an
      // already-open chat header - only openCustomer() ever wrote #modal-title, so the owner kept
      // seeing the raw phone number until they closed and reopened the conversation.
      const nameInputOpen = document.getElementById('modal-title-input').style.display !== 'none';
      if (!nameInputOpen) {
        currentCustomerName = c.customer.name || '';
        currentCustomerPhone = c.customer.phoneNumber;
        const displayName = c.customer.name || c.customer.phoneNumber;
        document.getElementById('modal-title').textContent = displayName;
        renderModalSubtitle({
          status: c.status,
          intent: c.intent,
          conversationId: c.id,
          customerName: c.customer.name,
          customerPhone: c.customer.phoneNumber,
        });
        const avatarEl = document.getElementById('modal-avatar');
        avatarEl.textContent = displayName.trim().charAt(0).toUpperCase() || '?';
        avatarEl.style.background = avatarColor(c.customer.phoneNumber);
      }
    }
  });

  socket.on('order:new', () => { loadOrderCounts(); loadOrders(true); });
  socket.on('order:updated', () => { loadOrderCounts(); loadOrders(true); });

  // El backend emitia delivery:failed desde que existe DeliveryFailure, pero el panel del cliente
  // nunca lo escuchaba: un fallo critico (una escalacion que el dueño nunca recibio) solo se veia
  // desde el panel interno de Zaqi. Ahora avisa en el momento y refresca las vistas que lo muestran.
  socket.on('delivery:failed', (failure) => {
    setStatus(
      failure && failure.critical
        ? 'Un mensaje al dueño no se pudo entregar - revisá Bot > Salud'
        : 'Un mensaje a un cliente no se pudo entregar - revisá Bot > Salud',
      true
    );
    if (document.querySelector('.tab-btn[data-tab="health"]')?.classList.contains('active')) loadHealth();
    if (document.querySelector('.tab-btn[data-tab="inicio"]')?.classList.contains('active')) loadDashboard();
  });
}

async function boot() {
  await loadRole();

  // Deep-link (URL hash) gana sobre lo último guardado en localStorage - así un enlace compartido a
  // una sección concreta abre ahí en vez de donde el dueño se quedó la última vez en ESTE navegador.
  let initialTab = 'inicio';
  try {
    const fromHash = location.hash.replace(/^#\/?/, '');
    const saved = localStorage.getItem('onix-admin-tab');
    const candidate =
      (fromHash && document.querySelector(`.tab-btn[data-tab="${fromHash}"]`)) ? fromHash
      : (saved && document.querySelector(`.tab-btn[data-tab="${saved}"]`)) ? saved
      : null;
    if (candidate && !(candidate === 'team' && !isOwner)) initialTab = candidate;
  } catch {}
  switchTab(initialTab);

  loadBusiness();
  loadProducts();
  loadPaymentMethods();
  loadCustomers();
  loadFaqEntries();
  loadFaqCandidates();
  loadCategoryAliases();
  loadOrderCounts();
  loadOrders(true);
  loadAnalytics();
  loadAiUsage();
  if (isOwner) loadTeamMembers();
  initRealtime();
}

// ==============================================================================================
// Fase 2 - CRM de clientes (ver ONIX-CRM-REORG-PLAN.md)
// La lista y la ficha son dos estados del mismo panel. La lista pagina por cursor contra
// /admin/api/crm/customers; la ficha lee /admin/api/crm/customers/:id, que ya trae metricas,
// pedidos y notas en una sola respuesta.
// ==============================================================================================

const STAGE_LABELS = {
  NUEVO: 'Nuevo',
  ACTIVO: 'Activo',
  COMPRADOR: 'Comprador',
  RECURRENTE: 'Recurrente',
  INACTIVO: 'Inactivo',
};

const CHANNEL_LABELS = {
  WHATSAPP: '📲 WhatsApp',
  INSTAGRAM: '📷 Instagram',
  FACEBOOK: '👥 Facebook',
  MERCADOLIBRE: '🛒 Mercado Libre',
};

// Paginación real por ventanas (feedback del dueño, 2026-09-13: "cargar más" apilaba todo en una
// fila interminable). crmCursorHistory[i] = el cursor que trae la página i+1 (índice 0 = página 1,
// sin cursor) - "Anterior" hace pop y vuelve a pedir esa página, en vez de guardar los clientes ya
// vistos en memoria. Orden fijo: por último mensaje (lastContactAt desc), no alfabético - ya es lo
// que devuelve /api/crm/customers desde la Fase 2, no hace falta tocar el backend.
let crmCursorHistory = [undefined];
let crmNextCursor = null;
let crmSearchTimer = null;
let crmLoadedOnce = false;
let currentCrmProfile = null;

function stagePillHtml(stage) {
  const label = STAGE_LABELS[stage] || stage;
  return `<span class="stage-pill stage-${escapeHtml(stage)}">${escapeHtml(label)}</span>`;
}

function channelPillHtml(channel) {
  return `<span class="channel-pill">${escapeHtml(CHANNEL_LABELS[channel] || channel)}</span>`;
}

// Se espera a que el dueño deje de escribir antes de pegarle al servidor: sin esto, "ludy" son cuatro
// consultas y la ultima puede llegar antes que la anterior y pintar resultados viejos.
function onCrmSearchInput() {
  if (crmSearchTimer) clearTimeout(crmSearchTimer);
  crmSearchTimer = setTimeout(() => loadCustomerList(true), 300);
}

function loadCustomerList(reset) {
  if (reset) crmCursorHistory = [undefined];
  return fetchCustomerPage(crmCursorHistory[crmCursorHistory.length - 1], false);
}

// Guarda el último JSON pintado para esta página, mismo motivo que lastHealthSnapshot: un refresh
// de fondo que trae exactamente lo mismo no debe tocar el DOM ni mostrar "Cargando…" (el dueño
// reportó que Salud "se recargaba" sola - Clientes tenía el mismo bug de fondo, aunque nadie lo
// hubiera notado todavía porque la lista es corta por ahora).
let lastCrmListSnapshot = null;

async function fetchCustomerPage(cursor, isBackgroundRefresh) {
  const container = document.getElementById('customers-rows');

  const params = new URLSearchParams();
  const q = document.getElementById('crm-search').value.trim();
  const stage = document.getElementById('crm-stage-filter').value;
  const tag = document.getElementById('crm-tag-filter').value;
  if (q) params.set('q', q);
  if (stage) params.set('stage', stage);
  if (tag) params.set('tag', tag);
  if (cursor) params.set('cursor', cursor);

  if (!isBackgroundRefresh) {
    container.innerHTML = '<div class="empty-state">Cargando…</div>';
  }

  try {
    const res = await apiFetch(`/admin/api/crm/customers?${params.toString()}`);
    const data = await res.json();

    const snapshot = JSON.stringify(data);
    if (isBackgroundRefresh && snapshot === lastCrmListSnapshot) return;
    lastCrmListSnapshot = snapshot;

    crmNextCursor = data.nextCursor;
    crmLoadedOnce = true;

    const rows = data.customers.map((c) => `
      <button type="button" class="crm-row" onclick="openCustomerProfile('${c.id}')">
        <div class="crm-cell-client">
          <div class="conv-avatar">${escapeHtml((c.name || c.phoneNumber || '?').trim().charAt(0).toUpperCase())}</div>
          <div class="crm-row-main">
            <div class="crm-row-name">${escapeHtml(c.name || c.phoneNumber)}</div>
            <div class="crm-row-meta">
              ${escapeHtml(c.phoneNumber)}
              ${c.tags.length ? ' · ' + c.tags.map((t) => escapeHtml(t)).join(', ') : ''}
            </div>
          </div>
        </div>
        <div class="crm-cell-stage">${stagePillHtml(c.stage)}</div>
        <div class="crm-cell-num onix-num">${c.orderCount} pedido${c.orderCount === 1 ? '' : 's'}</div>
        <div class="crm-cell-num onix-num">${c.lastContactAt ? escapeHtml(timeAgo(c.lastContactAt)) : '—'}</div>
      </button>
    `).join('');

    container.innerHTML = rows || '<div class="empty-state">No hay clientes que coincidan.</div>';
    const totalLabel = document.getElementById('customers-total-label');
    if (totalLabel && typeof data.total === 'number') {
      totalLabel.textContent = `${data.total} persona${data.total === 1 ? '' : 's'}`;
    }
    updateCrmPagerUi();
  } catch (err) {
    // Un refresh de fondo fallido no debe borrar una lista buena que ya estaba en pantalla.
    if (!isBackgroundRefresh) {
      container.innerHTML = `<div class="empty-state" style="color:var(--danger);">No se pudieron cargar los clientes: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function updateCrmPagerUi() {
  const page = crmCursorHistory.length;
  document.getElementById('crm-page-label').textContent = `Página ${page}`;
  document.getElementById('crm-prev-btn').disabled = page <= 1;
  document.getElementById('crm-next-btn').disabled = !crmNextCursor;
}

async function goToNextCrmPage() {
  if (!crmNextCursor) return;
  crmCursorHistory.push(crmNextCursor);
  await fetchCustomerPage(crmCursorHistory[crmCursorHistory.length - 1]);
}

async function goToPrevCrmPage() {
  if (crmCursorHistory.length <= 1) return;
  crmCursorHistory.pop();
  await fetchCustomerPage(crmCursorHistory[crmCursorHistory.length - 1]);
}

async function loadCrmTagOptions() {
  try {
    const res = await apiFetch('/admin/api/crm/tags');
    const tags = await res.json();
    const select = document.getElementById('crm-tag-filter');
    const current = select.value;
    select.innerHTML = '<option value="">Todas las etiquetas</option>'
      + tags.map((t) => `<option value="${escapeHtml(t.label)}">${escapeHtml(t.label)}</option>`).join('');
    select.value = current;
  } catch {}
}

async function openCustomerProfile(customerId) {
  document.getElementById('customers-list-view').hidden = true;
  document.getElementById('customer-detail-view').hidden = false;
  document.getElementById('crm-detail-body').innerHTML = '<div class="card empty-state">Cargando…</div>';

  try {
    const res = await apiFetch(`/admin/api/crm/customers/${customerId}`);
    const profile = await res.json();
    currentCrmProfile = profile;
    renderCustomerProfile(profile);
    loadCustomerTimeline(customerId);
  } catch (err) {
    document.getElementById('crm-detail-body').innerHTML =
      `<div class="card empty-state" style="color:var(--danger);">No se pudo cargar la ficha: ${escapeHtml(err.message)}</div>`;
  }
}

function closeCustomerProfile() {
  currentCrmProfile = null;
  document.getElementById('customer-detail-view').hidden = true;
  document.getElementById('customers-list-view').hidden = false;
}

// Enlace cruzado ficha -> chat (P9 del diagnostico: antes no habia forma de saltar de un lado al otro).
// Usa openCustomer(), la misma funcion que abre el hilo desde la Bandeja, para no duplicar esa logica.
function openCustomerChatFromProfile() {
  if (!currentCrmProfile) return;
  const id = currentCrmProfile.id;
  switchTab('conversations');
  openCustomer(id);
}

function renderCustomerProfile(p) {
  const m = p.metrics;
  document.getElementById('crm-detail-name').textContent = p.name || p.phoneNumber;
  document.getElementById('crm-detail-sub').innerHTML =
    `${escapeHtml(p.phoneNumber)} · ${channelPillHtml(p.channel)} · cliente desde ${new Date(p.createdAt).toLocaleDateString('es-CO')}`;
  document.getElementById('crm-open-chat-btn').hidden = !p.activeConversationId;

  const orderRows = p.orders.length === 0
    ? '<div class="empty-state" style="padding:18px;">Todavía no tiene pedidos.</div>'
    : p.orders.map((o) => `
        <div style="display:flex; justify-content:space-between; gap:10px; padding:10px 0; border-bottom:1px solid var(--border-soft);">
          <div style="min-width:0;">
            <div style="font-size:13px; font-weight:600;">${escapeHtml(o.summary)}</div>
            <div style="font-size:11.5px; color:var(--muted); margin-top:2px;">
              ${new Date(o.createdAt).toLocaleDateString('es-CO')} · ${escapeHtml(o.fulfillmentStatus)}
            </div>
          </div>
          <div style="font-weight:700; white-space:nowrap;">${escapeHtml(formatMoney(o.totalAmount, o.currency))}</div>
        </div>
      `).join('');

  const noteItems = p.notes.length === 0
    ? '<div style="font-size:12.5px; color:var(--muted);">Sin notas todavía.</div>'
    : p.notes.map((n) => `
        <div class="note-item">
          <div style="font-size:13px; white-space:pre-wrap;">${escapeHtml(n.body)}</div>
          <div class="note-meta">
            ${escapeHtml(n.authorName || 'Alguien')} · ${escapeHtml(timeAgo(n.createdAt))}
            <button class="btn-ghost" style="padding:0 6px; font-size:11px;" onclick="deleteCrmNote('${n.id}')">Eliminar</button>
          </div>
        </div>
      `).join('');

  document.getElementById('crm-detail-body').innerHTML = `
    <div class="metric-grid" style="margin-bottom:16px;">
      <div class="metric-card">
        <div class="label">Total comprado</div>
        <div class="value">${escapeHtml(formatMoney(m.totalSpent, m.currency))}</div>
        <div class="sub">${m.orderCount} pedido${m.orderCount === 1 ? '' : 's'}</div>
      </div>
      <div class="metric-card">
        <div class="label">Ticket promedio</div>
        <div class="value">${escapeHtml(formatMoney(m.avgTicket, m.currency))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Última compra</div>
        <div class="value" style="font-size:15px;">${m.lastPurchaseAt ? new Date(m.lastPurchaseAt).toLocaleDateString('es-CO') : '—'}</div>
        <div class="sub">${m.firstPurchaseAt ? 'primera: ' + new Date(m.firstPurchaseAt).toLocaleDateString('es-CO') : 'sin compras'}</div>
      </div>
      <div class="metric-card">
        <div class="label">Sin contacto hace</div>
        <div class="value">${m.daysSinceContact === null ? '—' : m.daysSinceContact + ' d'}</div>
      </div>
    </div>

    <div class="section-title">Datos del cliente</div>
    <div class="card">
      <div class="grid-2">
        <div><label>Nombre</label><input id="crm-f-name" value="${escapeHtml(p.name || '')}" /></div>
        <div><label>Etapa</label>
          <select id="crm-f-stage">
            ${Object.entries(STAGE_LABELS).map(([v, l]) => `<option value="${v}" ${p.stage === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
          </select>
        </div>
        <div><label>Email</label><input id="crm-f-email" value="${escapeHtml(p.email || '')}" placeholder="Opcional" /></div>
        <div><label>Cédula</label><input id="crm-f-idNumber" value="${escapeHtml(p.idNumber || '')}" placeholder="Opcional" /></div>
        <div><label>Teléfono de entrega</label><input id="crm-f-deliveryPhone" value="${escapeHtml(p.deliveryPhone || '')}" placeholder="Opcional" /></div>
        <div><label>Cómo llegó</label><input id="crm-f-source" value="${escapeHtml(p.source || '')}" placeholder="Ej: Instagram, referido" /></div>
      </div>
      <label>Dirección</label>
      <input id="crm-f-address" value="${escapeHtml(p.address || '')}" placeholder="Opcional" />
      <label>Etiquetas (separadas por coma)</label>
      <input id="crm-f-tags" value="${escapeHtml(p.tags.join(', '))}" placeholder="Ej: mayorista, vip" />
    </div>

    <div class="section-title">Pedidos</div>
    <div class="card">${orderRows}</div>

    <div class="section-title">Notas internas</div>
    <div class="card">
      <div style="font-size:12.5px; color:var(--muted); margin-bottom:8px;">Solo las ve tu equipo. Nunca se le mandan al cliente ni las usa el bot.</div>
      <textarea id="crm-note-body" placeholder="Ej: Pidió factura a nombre de la empresa" style="min-height:60px;"></textarea>
      <div class="actions-row">
        <button class="btn-secondary" onclick="addCrmNote()">+ Agregar nota</button>
      </div>
      <div style="margin-top:12px;">${noteItems}</div>
    </div>

    <div class="section-title">Línea de tiempo</div>
    <div class="card" id="crm-timeline"><div class="empty-state" style="padding:18px;">Cargando…</div></div>
  `;
}

async function loadCustomerTimeline(customerId) {
  const container = document.getElementById('crm-timeline');
  if (!container) return;
  try {
    const res = await apiFetch(`/admin/api/crm/customers/${customerId}/timeline`);
    const events = await res.json();
    const KIND_LABEL = { MESSAGE: 'Mensaje', ORDER: 'Pedido', NOTE: 'Nota' };
    container.innerHTML = events.length === 0
      ? '<div class="empty-state" style="padding:18px;">Sin actividad todavía.</div>'
      : events.map((e) => `
          <div class="timeline-item">
            <div class="timeline-kind">${escapeHtml(KIND_LABEL[e.kind] || e.kind)}</div>
            <div class="timeline-body">${escapeHtml(String(e.detail || '').slice(0, 220))}</div>
            <div class="timeline-time">${escapeHtml(timeAgo(e.createdAt))}</div>
          </div>
        `).join('');
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:var(--danger); padding:18px;">No se pudo cargar: ${escapeHtml(err.message)}</div>`;
  }
}

async function saveCustomerProfile() {
  if (!currentCrmProfile) return;
  const payload = {
    name: document.getElementById('crm-f-name').value.trim(),
    email: document.getElementById('crm-f-email').value.trim(),
    address: document.getElementById('crm-f-address').value.trim(),
    idNumber: document.getElementById('crm-f-idNumber').value.trim(),
    deliveryPhone: document.getElementById('crm-f-deliveryPhone').value.trim(),
    source: document.getElementById('crm-f-source').value.trim(),
    stage: document.getElementById('crm-f-stage').value,
    tags: document.getElementById('crm-f-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  try {
    await apiFetch(`/admin/api/crm/customers/${currentCrmProfile.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setStatus('Cliente actualizado');
    await openCustomerProfile(currentCrmProfile.id);
  } catch (err) {
    setStatus(`No se pudo guardar: ${err.message}`, true);
  }
}

async function addCrmNote() {
  if (!currentCrmProfile) return;
  const body = document.getElementById('crm-note-body').value.trim();
  if (!body) {
    setStatus('Escribí algo en la nota', true);
    return;
  }
  try {
    await apiFetch(`/admin/api/crm/customers/${currentCrmProfile.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    setStatus('Nota agregada');
    await openCustomerProfile(currentCrmProfile.id);
  } catch (err) {
    setStatus(`No se pudo agregar la nota: ${err.message}`, true);
  }
}

async function deleteCrmNote(noteId) {
  if (!confirm('¿Eliminar esta nota?')) return;
  try {
    await apiFetch(`/admin/api/crm/notes/${noteId}`, { method: 'DELETE' });
    setStatus('Nota eliminada');
    if (currentCrmProfile) await openCustomerProfile(currentCrmProfile.id);
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

// ==============================================================================================
// Fase 3 - Inicio (tablero) y Salud del bot
// ==============================================================================================

const ACTION_META = {
  HUMAN_WAITING: { title: 'Conversaciones esperando a un humano', cta: 'Atender', go: () => switchTab('conversations') },
  OWNER_QUESTION: { title: 'Preguntas del bot sin responder', cta: 'Revisar', go: () => switchTab('health') },
  ORDER_PENDING: { title: 'Pedidos pendientes de envío', cta: 'Marcar enviado', go: () => switchTab('orders') },
  DELIVERY_FAILURE: { title: 'Mensajes que no le llegaron a nadie', cta: 'Ver', go: () => switchTab('health') },
  FAQ_CANDIDATE: { title: 'Sugerencias de FAQ por revisar', cta: 'Revisar', go: () => switchTab('faq') },
};

async function loadDashboard() {
  const container = document.getElementById('dashboard-container');
  if (!container) return;
  try {
    const res = await apiFetch('/admin/api/dashboard');
    const data = await res.json();
    const k = data.kpis;

    const pending = data.actions.filter((a) => a.count > 0);
    const actionsHtml = pending.length === 0
      ? `<div class="card empty-state">
           <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--onix-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>
           Nada pendiente. Todo al día.
         </div>`
      : pending.map((a) => {
          const meta = ACTION_META[a.kind] || { title: a.kind };
          const urgent = a.kind === 'DELIVERY_FAILURE' || a.kind === 'OWNER_QUESTION';
          const sample = a.sample.slice(0, 3).map((s) => escapeHtml(s.label)).join(' · ');
          return `
            <div class="action-card ${urgent ? 'is-urgent' : ''}">
              <div class="count onix-num">${a.count}</div>
              <div style="min-width:0;">
                <div class="title">${escapeHtml(meta.title)}</div>
                <div class="sample">${sample}${a.count > 3 ? ' …' : ''}</div>
              </div>
              <button type="button" class="${a.kind === 'OWNER_QUESTION' ? 'btn-danger-solid' : urgent ? 'btn-danger' : 'btn-secondary'} action-cta" onclick="runDashboardAction('${a.kind}')">${escapeHtml(meta.cta || 'Ver')}</button>
            </div>`;
        }).join('');

    container.innerHTML = `
      <div class="section-title">Requiere tu atención</div>
      ${actionsHtml}

      <div class="section-title">Este mes</div>
      <div class="metric-grid" style="margin-bottom:8px;">
        <div class="metric-card">
          <div class="label">Ventas del mes</div>
          <div class="value">${escapeHtml(formatMoney(k.monthSales, k.currency))}</div>
          <div class="sub">${k.monthOrderCount} pedido${k.monthOrderCount === 1 ? '' : 's'}</div>
        </div>
        <div class="metric-card">
          <div class="label">Conversión (30 días)</div>
          <div class="value">${(k.conversionRate * 100).toFixed(1)}%</div>
          <div class="sub">${k.sold} vendidas / ${k.lost} perdidas</div>
        </div>
        <div class="metric-card">
          <div class="label">Conversaciones activas</div>
          <div class="value">${k.activeConversations}</div>
        </div>
        <div class="metric-card">
          <div class="label">Satisfacción</div>
          <div class="value">${k.avgCsat !== null ? k.avgCsat.toFixed(1) + '/3' : '—'}</div>
          <div class="sub">${k.csatCount} respuesta${k.csatCount === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div class="section-title">Chequeo de configuración<span class="section-count onix-num">${configHealthScore(data.health)}</span></div>
      ${configHealthChecklistHtml(data.health)}
    `;
  } catch (err) {
    container.innerHTML = `<div class="card empty-state" style="color:var(--danger);">No se pudo cargar el tablero: ${escapeHtml(err.message)}</div>`;
  }
}

function runDashboardAction(kind) {
  const meta = ACTION_META[kind];
  if (meta && meta.go) meta.go();
}

// Guarda el último JSON ya pintado - si el auto-refresh (cada 30s) trae exactamente lo mismo, no se
// toca el DOM. El dueño reportó que esta vista "se recargaba" sola mientras leía la conversación con
// el bot (2026-09-13): container.innerHTML se reescribía en cada tick aunque nada hubiera cambiado,
// lo que además arrancaba con un "Cargando…" que hacía parpadear toda la sección. Ahora "Cargando…"
// solo se muestra la primera vez (lastHealthSnapshot todavía null); un refresh de fondo que sí trae
// datos nuevos re-renderiza, pero el scroll ya lo restaura startAutoRefresh() por fuera.
let lastHealthSnapshot = null;

async function loadHealth() {
  const container = document.getElementById('health-container');
  if (!container) return;
  const isFirstLoad = lastHealthSnapshot === null;
  if (isFirstLoad) container.innerHTML = '<div class="card empty-state">Cargando…</div>';
  try {
    const [pendingRes, failuresRes, logRes, incidentsRes] = await Promise.all([
      apiFetch('/admin/api/pending-questions'),
      apiFetch('/admin/api/delivery-failures'),
      apiFetch('/admin/api/owner-log'),
      apiFetch('/admin/api/agent-incidents'),
    ]);
    const pending = await pendingRes.json();
    const failures = await failuresRes.json();
    const log = await logRes.json();
    const incidents = await incidentsRes.json();

    const snapshot = JSON.stringify({ pending, failures, log, incidents });
    if (snapshot === lastHealthSnapshot) return;
    lastHealthSnapshot = snapshot;

    const pendingRows = pending.length === 0
      ? '<div class="empty-state" style="padding:18px;">Nada esperando respuesta. Al día.</div>'
      : pending.map((p) => `
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; padding:11px 0; border-bottom:1px solid var(--border-soft);">
            <div style="min-width:0;">
              <div style="font-size:13px; font-weight:600;">${escapeHtml(p.customer.name || p.customer.phoneNumber)}</div>
              <div style="font-size:12.5px; color:var(--muted); margin-top:3px; white-space:pre-wrap;">${escapeHtml(p.kind === 'PHOTO_PRODUCT' ? '📷 Pidió identificar una foto' : p.question)}</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button class="btn-secondary" onclick="goToCustomerChat('${p.customer.id}')">Ver chat</button>
              <button class="btn-secondary" onclick="resolvePendingQuestion('${p.questionId}')">Marcar resuelta</button>
            </div>
          </div>
        `).join('');

    const failureRows = failures.length === 0
      ? '<div class="empty-state" style="padding:18px;">Ningún mensaje falló. Todo llegó.</div>'
      : failures.map((f) => `
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; padding:11px 0; border-bottom:1px solid var(--border-soft);">
            <div style="min-width:0;">
              <div style="font-size:13px; font-weight:600;">
                ${escapeHtml(f.recipientPhone)}
                ${f.critical ? '<span class="stage-pill" style="background:var(--danger-light); color:var(--danger); margin-left:6px;">Crítico</span>' : ''}
              </div>
              <div style="font-size:12px; color:var(--muted); margin-top:3px;">${escapeHtml(f.errorMessage)}</div>
              <div style="font-size:11px; color:var(--muted-soft); margin-top:2px;">${escapeHtml(timeAgo(f.createdAt))}</div>
            </div>
            <button class="btn-secondary" style="flex-shrink:0;" onclick="resolveFailure('${f.id}')">Marcar resuelto</button>
          </div>
        `).join('');

    const logRows = log.length === 0
      ? '<div class="empty-state" style="padding:18px;">El bot todavía no te escribió.</div>'
      : log.slice(0, 40).map((m) => `
          <div class="bubble bubble-${m.direction === 'OUT' ? 'CUSTOMER' : 'ASSISTANT'}" style="max-width:82%;">
            <div class="bubble-text">${escapeHtml(m.body)}</div>
            <span class="bubble-time">${escapeHtml(timeAgo(m.createdAt))}${m.success === false ? ' · no se pudo entregar' : ''}</span>
          </div>
        `).join('');

    container.innerHTML = `
      <div class="metric-grid" style="margin-bottom:16px;">
        <div class="metric-card">
          <div class="label">Conversaciones estancadas</div>
          <div class="value" ${incidents.stalledConversations > 0 ? 'style="color:var(--warn);"' : ''}>${incidents.stalledConversations}</div>
          <div class="sub">Pausadas esperando a un humano</div>
        </div>
        <div class="metric-card">
          <div class="label">Respuestas degradadas (7 días)</div>
          <div class="value" ${incidents.degradedReplies + incidents.loopExhausted > 0 ? 'style="color:var(--danger);"' : ''}>${incidents.degradedReplies + incidents.loopExhausted}</div>
          <div class="sub">${incidents.loopExhausted} por agotar herramientas · ${incidents.degradedReplies} genéricas</div>
        </div>
        <div class="metric-card">
          <div class="label">Intervenciones de respaldo</div>
          <div class="value">${incidents.backstopInterventions}</div>
          <div class="sub">El bot prometió algo y el sistema lo completó</div>
        </div>
        <div class="metric-card">
          <div class="label">Fallos de servicios externos (7 días)</div>
          <div class="value" ${incidents.externalApiFailures > 0 ? 'style="color:var(--danger);"' : ''}>${incidents.externalApiFailures}</div>
          <div class="sub">${incidents.lastExternalApiFailure
            ? escapeHtml(incidents.lastExternalApiFailure.detail).slice(0, 120)
            : 'Análisis de fotos y otros servicios respondiendo bien'}</div>
        </div>
      </div>

      <div class="section-title">Preguntas del bot sin responder</div>
      <div class="card">
        <div style="font-size:12.5px; color:var(--muted); margin-bottom:6px;">
          El bot no supo qué contestar y te escaló esto. Si ya lo resolviste por fuera (por WhatsApp
          citando el mensaje, por teléfono, en persona), marcalo como resuelto para sacarlo de la lista.
        </div>
        ${pendingRows}
      </div>

      <div class="section-title">Mensajes que no llegaron</div>
      <div class="card">
        <div style="font-size:12.5px; color:var(--muted); margin-bottom:6px;">
          WhatsApp acepta el envío y recién después avisa si falló. Un fallo <strong>crítico</strong> es uno dirigido a tu propio número: suele significar que una escalación nunca te llegó.
        </div>
        ${failureRows}
      </div>

      <div class="section-title">Conversación del bot con vos</div>
      <div class="card chat-thread" style="max-height:420px; overflow-y:auto;">${logRows}</div>
    `;
  } catch (err) {
    // En un refresh de fondo, un error de red no debe borrar contenido bueno que ya estaba en
    // pantalla y reemplazarlo por una caja de error - eso sería peor que no hacer nada.
    if (isFirstLoad) {
      container.innerHTML = `<div class="card empty-state" style="color:var(--danger);">No se pudo cargar la salud del bot: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function resolveFailure(id) {
  try {
    await apiFetch(`/admin/api/delivery-failures/${id}/resolve`, { method: 'POST' });
    setStatus('Marcado como resuelto');
    loadHealth();
  } catch (err) {
    setStatus(`No se pudo marcar: ${err.message}`, true);
  }
}

// "Ver chat" de una pregunta pendiente en Bot > Salud: abre la Bandeja directo en esa conversación,
// en vez de dejar al dueño en una pestaña general sin saber a quién responderle.
function goToCustomerChat(customerId) {
  switchTab('conversations');
  openCustomer(customerId);
}

async function resolvePendingQuestion(questionId) {
  try {
    await apiFetch(`/admin/api/pending-questions/${questionId}/resolve`, { method: 'POST' });
    setStatus('Marcada como resuelta');
    loadHealth();
  } catch (err) {
    setStatus(`No se pudo marcar: ${err.message}`, true);
  }
}

// Enlace cruzado Pedidos -> ficha del cliente, y tambien destino del buscador global (Fase 5). Entra
// a la seccion CRM, cambia a Clientes y abre la ficha directamente, sin que el dueño tenga que
// buscar a esa persona a mano en la lista.
function goToCustomerProfile(customerId) {
  const searchResults = document.getElementById('global-search-results');
  if (searchResults) {
    searchResults.hidden = true;
    document.getElementById('global-search-input').value = '';
  }
  switchTab('customers');
  openCustomerProfile(customerId);
}

// Se invoca al final del archivo a proposito: boot() puede abrir la ultima pestaña usada, incluida
// una de las vistas nuevas del CRM, y sus const/let viven mas abajo (TDZ si se llamara antes).
boot();

// ==============================================================================================
// Fase 4 - Envíos (ShippingRate / ShippingCityRule). El agente ya consultaba estas tablas con
// get_shipping_rates y get_shipping_rate_for_city, pero no había ninguna pantalla para cargarlas
// (ver P8 en ONIX-CRM-REORG-PLAN.md) - hasta ahora solo existía scripts/seed-magimp-shipping.ts.
// ==============================================================================================

let shippingRatesCache = [];
let editingShippingRateId = null;

async function loadShipping() {
  await Promise.all([loadShippingRates(), loadShippingCityRules()]);
}

async function loadShippingRates() {
  const container = document.getElementById('shipping-rates-list');
  const select = document.getElementById('ship-city-rate');
  try {
    const res = await apiFetch('/admin/api/shipping-rates');
    shippingRatesCache = await res.json();

    select.innerHTML = shippingRatesCache.length === 0
      ? '<option value="">Primero agregá una tarifa</option>'
      : shippingRatesCache.map((r) => `<option value="${escapeHtml(r.label)}">${escapeHtml(r.label)} (${escapeHtml(formatMoney(r.cost, 'COP'))})</option>`).join('');

    container.innerHTML = shippingRatesCache.length === 0
      ? '<div style="font-size:13px; color:var(--muted);">Todavía no agregaste ninguna tarifa.</div>'
      : shippingRatesCache.map((r) => `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md);">
            <div>
              <strong style="font-size:13.5px;">${escapeHtml(r.label)}</strong>
              <div style="font-size:12px; color:var(--muted); margin-top:2px;">${escapeHtml(formatMoney(r.cost, 'COP'))}</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button class="btn-secondary" onclick="editShippingRate('${r.id}')">Editar</button>
              <button class="btn-danger" onclick="deleteShippingRate('${r.id}')">Eliminar</button>
            </div>
          </div>
        `).join('');
  } catch (err) {
    container.innerHTML = `<div style="font-size:13px; color:var(--danger);">No se pudieron cargar: ${escapeHtml(err.message)}</div>`;
  }
}

function editShippingRate(id) {
  const rate = shippingRatesCache.find((r) => r.id === id);
  if (!rate) return;
  editingShippingRateId = id;
  document.getElementById('ship-rate-label').value = rate.label;
  document.getElementById('ship-rate-cost').value = rate.cost;
  document.getElementById('ship-rate-submit-btn').textContent = 'Guardar cambios';
  document.getElementById('ship-rate-cancel-btn').style.display = 'inline-block';
  document.getElementById('ship-rate-label').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEditShippingRate() {
  editingShippingRateId = null;
  document.getElementById('ship-rate-label').value = '';
  document.getElementById('ship-rate-cost').value = '';
  document.getElementById('ship-rate-submit-btn').textContent = '+ Agregar tarifa';
  document.getElementById('ship-rate-cancel-btn').style.display = 'none';
}

async function addShippingRate() {
  const label = document.getElementById('ship-rate-label').value.trim();
  const cost = Number(document.getElementById('ship-rate-cost').value);
  if (!label || !Number.isFinite(cost) || cost < 0) {
    setStatus('Completá el nombre y un costo válido', true);
    return;
  }
  try {
    if (editingShippingRateId) {
      await apiFetch(`/admin/api/shipping-rates/${editingShippingRateId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, cost }),
      });
      setStatus('Tarifa actualizada');
    } else {
      await apiFetch('/admin/api/shipping-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, cost }),
      });
      setStatus('Tarifa agregada');
    }
  } catch (err) {
    setStatus(`No se pudo guardar: ${err.message}`, true);
    return;
  }
  cancelEditShippingRate();
  loadShippingRates();
}

async function deleteShippingRate(id) {
  if (!confirm('¿Eliminar esta tarifa? Las reglas de ciudad que apunten a ella dejarán de resolver un costo.')) return;
  try {
    await apiFetch(`/admin/api/shipping-rates/${id}`, { method: 'DELETE' });
    loadShippingRates();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

// Paginación (feedback del dueño, 2026-09-13: "en bot envíos está extremadamente larga" - una sola
// ciudad ambigua de Colombia puede terminar en cientos de reglas). page/pageSize simple en vez de
// cursor: acá no hace falta lo que Clientes sí necesitaba (orden por actividad reciente que se
// mueve todo el tiempo) - createdAt es estable, un número de página normal alcanza.
let shipCityRulesPage = 1;
let shipCityRulesSearchTimer = null;

function onShipCityRulesSearchInput() {
  if (shipCityRulesSearchTimer) clearTimeout(shipCityRulesSearchTimer);
  shipCityRulesSearchTimer = setTimeout(() => { shipCityRulesPage = 1; loadShippingCityRules(); }, 300);
}

async function goToNextShipCityRulesPage() {
  shipCityRulesPage++;
  await loadShippingCityRules();
}

async function goToPrevShipCityRulesPage() {
  if (shipCityRulesPage <= 1) return;
  shipCityRulesPage--;
  await loadShippingCityRules();
}

async function loadShippingCityRules() {
  const container = document.getElementById('shipping-city-rules-list');
  const q = document.getElementById('ship-city-rules-search').value.trim();
  const params = new URLSearchParams({ page: String(shipCityRulesPage) });
  if (q) params.set('q', q);
  try {
    const res = await apiFetch(`/admin/api/shipping-city-rules?${params.toString()}`);
    const { items, total, pageSize } = await res.json();
    container.innerHTML = items.length === 0
      ? '<div style="font-size:13px; color:var(--muted);">Todavía no agregaste ninguna regla de ciudad.</div>'
      : items.map((r) => `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md);">
            <div style="font-size:13.5px;"><strong>${escapeHtml(r.city)}</strong> → ${escapeHtml(r.label)}</div>
            <button class="btn-danger" onclick="deleteShippingCityRule('${r.id}')">Eliminar</button>
          </div>
        `).join('');

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    document.getElementById('ship-city-rules-page-label').textContent = `Página ${shipCityRulesPage} de ${totalPages} (${total})`;
    document.getElementById('ship-city-rules-prev-btn').disabled = shipCityRulesPage <= 1;
    document.getElementById('ship-city-rules-next-btn').disabled = shipCityRulesPage >= totalPages;
  } catch (err) {
    container.innerHTML = `<div style="font-size:13px; color:var(--danger);">No se pudieron cargar: ${escapeHtml(err.message)}</div>`;
  }
}

async function addShippingCityRule() {
  const city = document.getElementById('ship-city-name').value.trim();
  const label = document.getElementById('ship-city-rate').value;
  if (!city || !label) {
    setStatus('Completá la ciudad y elegí una tarifa', true);
    return;
  }
  try {
    await apiFetch('/admin/api/shipping-city-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city, label }),
    });
    setStatus('Regla agregada');
    document.getElementById('ship-city-name').value = '';
    shipCityRulesPage = 1;
    loadShippingCityRules();
  } catch (err) {
    setStatus(`No se pudo agregar: ${err.message}`, true);
  }
}

async function deleteShippingCityRule(id) {
  if (!confirm('¿Eliminar esta regla de ciudad?')) return;
  try {
    await apiFetch(`/admin/api/shipping-city-rules/${id}`, { method: 'DELETE' });
    loadShippingCityRules();
  } catch (err) {
    setStatus(`No se pudo eliminar: ${err.message}`, true);
  }
}

// ==============================================================================================
// Fase 4 - Catálogo de etiquetas (CustomerTag). El modelo y los endpoints ya existían desde la
// Fase 2 (le dan color/autocompletado al String[] tags de Customer, que sigue funcionando igual
// sin ninguna etiqueta creada acá) - lo que faltaba era la pantalla. Vive dentro de Clientes en vez
// de bajo Bot: es dato de segmentación de clientes, no de comportamiento del bot.
// ==============================================================================================

async function loadTagManager() {
  const container = document.getElementById('tag-manager-list');
  if (!container) return;
  try {
    const res = await apiFetch('/admin/api/crm/tags');
    const tags = await res.json();
    container.innerHTML = tags.length === 0
      ? '<div style="font-size:12.5px; color:var(--muted);">Sin etiquetas propias todavía - podés escribir cualquier etiqueta en la ficha del cliente, esto solo le da color y autocompletado.</div>'
      : tags.map((t) => `
          <span class="channel-pill" style="background:${escapeHtml(t.color)}22; color:${escapeHtml(t.color)};">
            ${escapeHtml(t.label)}
            <button class="btn-ghost" style="padding:0 2px; font-size:11px;" onclick="deleteTagFromManager('${t.id}')">✕</button>
          </span>
        `).join(' ');
  } catch (err) {
    container.innerHTML = `<div style="font-size:12.5px; color:var(--danger);">No se pudieron cargar: ${escapeHtml(err.message)}</div>`;
  }
}

async function addTagFromManager() {
  const input = document.getElementById('tag-manager-new-label');
  const color = document.getElementById('tag-manager-new-color');
  const label = input.value.trim();
  if (!label) return;
  try {
    await apiFetch('/admin/api/crm/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, color: color.value }),
    });
    input.value = '';
    loadTagManager();
    loadCrmTagOptions();
  } catch (err) {
    setStatus(`No se pudo crear la etiqueta: ${err.message}`, true);
  }
}

async function deleteTagFromManager(id) {
  try {
    await apiFetch(`/admin/api/crm/tags/${id}`, { method: 'DELETE' });
    loadTagManager();
    loadCrmTagOptions();
  } catch (err) {
    setStatus(`No se pudo eliminar la etiqueta: ${err.message}`, true);
  }
}

// ==============================================================================================
// Fase 5 - Buscador global (topbar). Una consulta a /admin/api/search agrupa clientes, productos,
// pedidos y FAQ. No toca la Bandeja ni el hilo de mensajes (ver nota en src/routes/admin/search.ts).
// ==============================================================================================

let globalSearchTimer = null;
let globalSearchLastQuery = '';

function onGlobalSearchInput() {
  const q = document.getElementById('global-search-input').value.trim();
  if (globalSearchTimer) clearTimeout(globalSearchTimer);
  if (q.length < 2) {
    hideGlobalSearchResults();
    return;
  }
  globalSearchTimer = setTimeout(() => runGlobalSearch(q), 250);
}

function hideGlobalSearchResults() {
  document.getElementById('global-search-results').hidden = true;
}

async function runGlobalSearch(q) {
  globalSearchLastQuery = q;
  try {
    const res = await apiFetch(`/admin/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    // La búsqueda pudo tardar más que la siguiente letra tecleada - si esta respuesta ya no
    // corresponde al texto actual del campo, se descarta en vez de pintar resultados viejos.
    if (document.getElementById('global-search-input').value.trim() !== q) return;
    renderGlobalSearchResults(data);
  } catch (err) {
    // Silencioso a propósito: un buscador global que interrumpe con un error por cada tipeo de
    // más sería peor que no mostrar nada.
  }
}

// Mapa id -> nombre de los productos del último resultado de búsqueda, para que
// goToProductInCatalog pueda buscar por nombre (el catálogo ahora pagina - el producto puede no
// estar en la página que cargue primero). Se guarda acá en vez de meter el nombre en el atributo
// onclick para no tener que escapar comillas/backticks de un nombre de producto arbitrario dentro
// de una cadena JS embebida en HTML.
let lastSearchProductNames = {};

function renderGlobalSearchResults(data) {
  const box = document.getElementById('global-search-results');
  lastSearchProductNames = Object.fromEntries(data.products.map((p) => [p.id, p.name]));
  const groups = [
    { label: 'Clientes', items: data.customers, render: (c) => ({
        title: c.name || c.phoneNumber, meta: c.phoneNumber, action: `goToCustomerProfile('${c.id}')`,
      }) },
    { label: 'Productos', items: data.products, render: (p) => ({
        title: p.name, meta: formatMoney(p.price, p.currency), action: `goToProductInCatalog('${p.id}')`,
      }) },
    { label: 'Pedidos', items: data.orders, render: (o) => ({
        title: o.summary, meta: `${o.customer.name || o.customer.phoneNumber} · ${formatMoney(o.totalAmount, o.currency)}`, action: `goToOrderInList('${o.id}', '${o.fulfillmentStatus}')`,
      }) },
    { label: 'FAQ', items: data.faq, render: (f) => ({
        title: f.question, meta: '', action: `switchTab('faq'); hideGlobalSearchResults();`,
      }) },
  ];

  const nonEmpty = groups.filter((g) => g.items.length > 0);
  if (nonEmpty.length === 0) {
    box.innerHTML = '<div class="global-search-empty">Sin resultados</div>';
  } else {
    box.innerHTML = nonEmpty.map((g) => `
      <div class="global-search-group-label">${escapeHtml(g.label)}</div>
      ${g.items.map((item) => {
        const r = g.render(item);
        return `<button type="button" class="global-search-item" onclick="${r.action}">
          <div>${escapeHtml(r.title)}</div>
          ${r.meta ? `<div class="meta">${escapeHtml(r.meta)}</div>` : ''}
        </button>`;
      }).join('')}
    `).join('');
  }
  box.hidden = false;
}

async function goToProductInCatalog(productId) {
  hideGlobalSearchResults();
  document.getElementById('global-search-input').value = '';
  switchTab('catalog');
  // El catálogo pagina (Fase "revisar dónde falta paginación", 2026-09-13) - el producto puede no
  // estar en la primera página, así que se busca por nombre en vez de asumir que ya está en el DOM.
  const name = lastSearchProductNames[productId];
  if (name) {
    const searchInput = document.getElementById('products-search');
    searchInput.value = name;
    productsPage = 1;
    await loadProducts();
  }
  setTimeout(() => {
    const card = document.querySelector(`.product-card[data-product-id="${productId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid var(--brand)';
      setTimeout(() => { card.style.outline = ''; }, 2000);
    }
  }, 150);
}

function goToOrderInList(orderId, status) {
  hideGlobalSearchResults();
  document.getElementById('global-search-input').value = '';
  switchTab('orders');
  setTimeout(() => {
    switchOrdersTab(status);
    setTimeout(() => {
      const card = document.querySelector(`[data-order-id="${orderId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.outline = '2px solid var(--brand)';
        setTimeout(() => { card.style.outline = ''; }, 2000);
      }
    }, 150);
  }, 150);
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('global-search-wrap');
  if (wrap && !wrap.contains(e.target)) hideGlobalSearchResults();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideGlobalSearchResults();
});
