import { h } from './ui.js';
import { renderLibrary } from './library.js';
import { renderEditor } from './editor.js';
import { renderSettings } from './settings.js';
import { topnav } from './nav.js';
import { markStarted, autoCheck, restartApp } from './update.js';
import { toast } from './ui.js';

const app = document.getElementById('app');
let cleanup = null;

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, view, id] = hash.split('/');
  app.replaceChildren();
  window.scrollTo(0, 0);
  try {
    if (view === 'edit' && id) cleanup = await renderEditor(app, id);
    else if (view === 'settings') cleanup = await renderSettings(app, id);
    else cleanup = await renderLibrary(app);
  } catch (e) {
    console.error(e);
    app.replaceChildren(h('div', { class: 'shell' }, topnav(''), h('main', { class: 'page' },
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Something went wrong'), h('p', null, String(e && e.message || e)))),
      h('a', { class: 'btn btn-outline', href: '#/' }, 'Back to demos'))));
  }
}

window.addEventListener('hashchange', route);
route().then(() => {
  markStarted();
  setTimeout(() => autoCheck((u) => {
    toast(u.status === 'reload' ? `Demoflow ${u.version} is available.` : `Demoflow ${u.version} is ready.`, {
      kind: 'ok', timeout: 15000,
      action: { label: u.status === 'reload' ? 'Reload to update' : 'Restart to update', run: restartApp },
    });
  }).catch(() => {}), 2500);
});
