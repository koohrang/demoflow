// Small DOM + UI helpers for the Demoflow app.

// An empty optional section must never show up as the word "null" on screen:
// append(), prepend() and replaceChildren() skip null, undefined and false.
for (const name of ['append', 'prepend', 'replaceChildren']) {
  const orig = Element.prototype[name];
  Element.prototype[name] = function (...kids) { return orig.apply(this, kids.flat().filter((k) => k != null && k !== false)); };
}

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

export const icon = (name, size = 18) => {
  const s = h('span', { class: 'ic', 'aria-hidden': 'true', html: ICONS[name] || '' });
  s.style.setProperty('--s', size + 'px');
  return s;
};

const P = (d, extra = '') => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ICONS = {
  back: P('<path d="M12 4l-6 6 6 6"/>'),
  next: P('<path d="M8 4l6 6-6 6"/>'),
  plus: P('<path d="M10 4v12M4 10h12"/>'),
  play: P('<path d="M6 4l10 6-10 6z" fill="currentColor" stroke="none"/>'),
  share: P('<path d="M7.5 10.8l5-2.9M7.5 9.2l5 2.9"/><circle cx="5.5" cy="10" r="2.3"/><circle cx="14.5" cy="5.5" r="2.3"/><circle cx="14.5" cy="14.5" r="2.3"/>'),
  download: P('<path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12"/>'),
  upload: P('<path d="M10 13V4M6 7.5l4-4 4 4M4 16.5h12"/>'),
  trash: P('<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 10h7.6l.7-10"/>'),
  copy: P('<rect x="7" y="7" width="9" height="9" rx="1.6"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6a1.5 1.5 0 0 0 1.5 1.5H7"/>'),
  dup: P('<rect x="3.5" y="6.5" width="10" height="10" rx="1.6"/><path d="M6.5 3.5h8.5a1.5 1.5 0 0 1 1.5 1.5v8.5"/>'),
  more: P('<circle cx="5" cy="10" r=".9" fill="currentColor"/><circle cx="10" cy="10" r=".9" fill="currentColor"/><circle cx="15" cy="10" r=".9" fill="currentColor"/>'),
  sparkle: P('<path d="M9 2.5l1.5 4 4 1.5-4 1.5L9 13.5 7.5 9.5l-4-1.5 4-1.5zM15 12.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  voice: P('<rect x="7.5" y="2.5" width="5" height="9" rx="2.5"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/>'),
  cursor: P('<path d="M5 3l10 6.5-4.3 1L8.6 15z"/>'),
  target: P('<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2" fill="currentColor"/>'),
  blur: P('<rect x="3" y="4" width="14" height="12" rx="2" stroke-dasharray="2.2 2"/><path d="M7 8h6M6 11h8" opacity=".6"/>'),
  chapter: P('<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M6.5 8.5h7M6.5 11.5h4.5"/>'),
  image: P('<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="M4 15l4.5-4 3 2.5L14 11l2.5 2.5"/>'),
  settings: P('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>'),
  chart: P('<path d="M3.5 16.5h13M6 13.5v-4M10 13.5V5.5M14 13.5v-6"/>'),
  close: P('<path d="M5 5l10 10M15 5L5 15"/>'),
  check: P('<path d="M4.5 10.5l3.5 3.5 7.5-8"/>'),
  undo: P('<path d="M7 5L3.5 8.5 7 12"/><path d="M3.5 8.5H12a4.5 4.5 0 0 1 0 9H9"/>'),
  redo: P('<path d="M13 5l3.5 3.5L13 12"/><path d="M16.5 8.5H8a4.5 4.5 0 0 0 0 9h3"/>'),
  link: P('<path d="M8.5 11.5l3-3M9 6.5l1.3-1.3a3 3 0 0 1 4.2 4.2L13.5 10.7M11 13.5l-1.3 1.3a3 3 0 0 1-4.2-4.2L6.5 9.3"/>'),
  code: P('<path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/>'),
  film: P('<rect x="3" y="4.5" width="14" height="11" rx="2"/><path d="M8.5 7.8v4.4l3.6-2.2z" fill="currentColor"/>'),
  gif: P('<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M8 8.5H6.5v3H8v-1.3M10.5 8.5v3M13 11.5v-3h1.8M13 10h1.4"/>'),
  html: P('<path d="M4 3.5h12l-1 12.5-5 1.5-5-1.5z"/><path d="M7.5 7h5l-.4 4.5-2.1.7-2.1-.7-.1-1.3"/>'),
  eye: P('<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/>'),
  grip: P('<circle cx="7.5" cy="6" r=".8" fill="currentColor"/><circle cx="12.5" cy="6" r=".8" fill="currentColor"/><circle cx="7.5" cy="10" r=".8" fill="currentColor"/><circle cx="12.5" cy="10" r=".8" fill="currentColor"/><circle cx="7.5" cy="14" r=".8" fill="currentColor"/><circle cx="12.5" cy="14" r=".8" fill="currentColor"/>'),
  search: P('<circle cx="9" cy="9" r="5"/><path d="M13 13l3.5 3.5"/>'),
  stop: P('<rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>'),
  shield: P('<path d="M10 2.5l6 2.3v4.6c0 3.8-2.6 6.6-6 8.1-3.4-1.5-6-4.3-6-8.1V4.8z"/><path d="M7.3 10l1.9 1.9 3.6-3.8"/>'),
  rocket: P('<path d="M11.5 14.5l-3-3M8.5 11.5L5 11l2.5-3.5h4M8.5 11.5l.5 3.5 3.5-2.5v-4M11.5 7.5c1.6-2.6 3.4-4 5-4-.1 1.7-1.5 3.4-4 5"/><path d="M5.5 14.5c-.9.9-1.3 2.2-1.3 2.2s1.4-.4 2.2-1.3"/>'),
  puzzle: P('<path d="M4 6.5h3a1.6 1.6 0 1 1 3 0h3v3a1.6 1.6 0 1 1 0 3v3H4z"/>'),
  refresh: P('<path d="M15.5 8A6 6 0 0 0 4.6 6.6M4.5 3.5v3.2h3.2M4.5 12a6 6 0 0 0 10.9 1.4M15.5 16.5v-3.2h-3.2"/>'),
  globe: P('<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2.2 2.8 4.6 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.6-2.8-7S8 5.2 10 3z"/>'),
};

// ---------- Toasts ----------
let toastBox;
export function toast(message, { kind = 'info', action, timeout = 3600 } = {}) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: `toast toast-${kind}` }, h('span', null, message));
  if (action) t.append(h('button', { class: 'toast-act', type: 'button', onclick: () => { action.run(); t.remove(); } }, action.label));
  toastBox.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 250); }, timeout);
  return t;
}

// ---------- Modal ----------
export function modal({ title, body, actions = [], wide = false, onClose, dismissable = true }) {
  const prevFocus = document.activeElement;
  const close = (v) => {
    back.classList.remove('in');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => back.remove(), 180);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose(v);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(null); }
    if (e.key === 'Tab') {
      const f = [...dlg.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  const foot = actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) =>
    h('button', { type: 'button', class: `btn ${a.kind || 'btn-quiet'}`, onclick: async (e) => {
      if (a.run) { const r = await a.run(e, close); if (r === false) return; }
      if (a.close !== false) close(a.value);
    } }, a.label))) : null;
  const dlg = h('div', { class: 'modal' + (wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      dismissable ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, icon('close')) : null),
    h('div', { class: 'modal-body' }, body),
    foot);
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back && dismissable) close(null); } }, dlg);
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    back.classList.add('in');
    const first = dlg.querySelector('[autofocus]') || dlg.querySelector('.modal-body input, .modal-body textarea, .modal-body select, .modal-foot .btn-primary') || dlg.querySelector('button');
    if (first) first.focus();
  });
  return { close, el: dlg };
}

export function confirmDialog({ title, text, confirm = 'Delete', kind = 'btn-danger' }) {
  return new Promise((resolve) => {
    modal({
      title, body: h('p', { class: 'modal-text' }, text),
      actions: [
        { label: 'Cancel', kind: 'btn-quiet', value: false },
        { label: confirm, kind, value: true },
      ],
      onClose: (v) => resolve(!!v),
    });
  });
}

// ---------- Popover menu ----------
export function menu(anchor, items, { align = 'left' } = {}) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.heading) { m.append(h('div', { class: 'menu-head' }, it.heading)); continue; }
    m.append(h('button', {
      type: 'button', role: 'menuitem', class: 'menu-item' + (it.danger ? ' danger' : ''), disabled: it.disabled,
      onclick: (e) => { e.stopPropagation(); m.remove(); it.run(); },
    }, it.icon ? icon(it.icon, 17) : null, h('span', { class: 'menu-label' }, it.label, it.hint ? h('small', null, it.hint) : null)));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(window.innerWidth - mw - 8, left));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = left + 'px'; m.style.top = top + 'px';
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); cleanup(); } };
  const esc = (e) => { if (e.key === 'Escape') { m.remove(); cleanup(); anchor.focus(); } };
  const cleanup = () => { document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', esc, true); };
  setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', esc, true); });
  const first = m.querySelector('.menu-item:not([disabled])');
  if (first) first.focus();
  return m;
}

export function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24); if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function copyText(text) {
  return navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', { kind: 'ok' }), () => toast('Couldn’t copy. Select the text and copy it manually.', { kind: 'error' }));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function slug(s) {
  return String(s || 'demo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'demo';
}
