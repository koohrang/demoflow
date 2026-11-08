// Updates without reinstalling. This file always carries a working copy of
// Demoflow. When a newer version is published (to GitHub, or any web address),
// it is downloaded once, kept in this browser, and used from the next start.
// Your demos never move: they stay in the same browser storage.
import { loadSettings, saveSettings } from './store.js';

export const APP_VERSION = window.DF_VERSION || '0.0.0';
const BUILT_FEED = window.DF_FEED || '';
const DB = 'demoflow-app';

export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const hosted = () => location.protocol === 'https:' || location.protocol === 'http:';

export async function feedUrl() {
  const s = await loadSettings();
  if (s.updates.feed) return s.updates.feed;
  if (BUILT_FEED) return BUILT_FEED;
  if (hosted()) return new URL('version.json', location.href).href;
  return '';
}

function idb() {
  return new Promise((resolve, reject) => {
    const q = indexedDB.open(DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('app');
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}
async function idbDo(mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('app', mode);
    const r = fn(tx.objectStore('app'));
    tx.oncomplete = () => { d.close(); resolve(r && r.result); };
    tx.onerror = () => { d.close(); reject(tx.error); };
  });
}

// The newer copy kept in this browser, if any: { version, notes, at, size }.
export async function storedUpdate() {
  try {
    const rec = await idbDo('readonly', (os) => os.get('current'));
    return rec ? { version: rec.version, notes: rec.notes || [], at: rec.at, size: rec.html ? rec.html.length : 0, source: rec.source || '' } : null;
  } catch { return null; }
}
export async function removeStoredUpdate() { await idbDo('readwrite', (os) => os.delete('current')); }

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function versionInHtml(html) {
  const m = /window\.DF_VERSION\s*=\s*["']([\d.]+)["']/.exec(html);
  return m ? m[1] : null;
}

async function keep(html, version, notes, source) {
  if (!/data-demoflow-app/.test(html.slice(0, 4000)) || !versionInHtml(html)) throw new Error('That file isn’t a Demoflow app file.');
  await idbDo('readwrite', (os) => os.put({ version, html, notes: notes || [], at: Date.now(), source }, 'current'));
  try { localStorage.removeItem('df.bad'); localStorage.removeItem('df.bootPending'); } catch { /* ignore */ }
}

// Checks the update address. Returns
//   { status: 'none' | 'latest' | 'ready' | 'reload', version, notes, error }
export async function checkForUpdate({ download = true } = {}) {
  const url = await feedUrl();
  if (!url) return { status: 'none' };
  const s = await loadSettings();
  s.updates.lastCheck = Date.now();
  await saveSettings(s);
  let man;
  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`The update address answered ${res.status}.`);
    man = await res.json();
  } catch (e) {
    return { status: 'error', error: /Failed to fetch|NetworkError/i.test(e.message) ? 'Couldn’t reach the update address. Check your internet connection.' : e.message };
  }
  if (!man || !man.version) return { status: 'error', error: 'The update address didn’t describe a version.' };
  const running = APP_VERSION;
  const stored = await storedUpdate();
  const best = stored && cmpVersion(stored.version, running) > 0 ? stored.version : running;
  if (cmpVersion(man.version, best) <= 0) {
    return stored && cmpVersion(stored.version, running) > 0
      ? { status: 'ready', version: stored.version, notes: stored.notes }
      : { status: 'latest', version: running };
  }
  // Served from the web next to version.json: a reload picks up the new copy.
  if (hosted() && new URL(man.url || 'index.html', url).origin === location.origin) return { status: 'reload', version: man.version, notes: man.notes || [] };
  if (!download) return { status: 'available', version: man.version, notes: man.notes || [] };
  try {
    const appUrl = new URL(man.url || 'Demoflow.html', url).href;
    const res = await fetch(appUrl + (appUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Downloading the update failed (${res.status}).`);
    const html = await res.text();
    if (man.sha256 && (await sha256(html)) !== man.sha256) throw new Error('The downloaded update was incomplete. Try again later.');
    const v = versionInHtml(html);
    if (v !== man.version) throw new Error('The downloaded file doesn’t match the announced version.');
    await keep(html, v, man.notes, appUrl);
    return { status: 'ready', version: v, notes: man.notes || [] };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// A newer Demoflow file the person downloaded themselves.
export async function installFromFile(file) {
  const html = await file.text();
  const v = versionInHtml(html);
  if (!v || !/data-demoflow-app/.test(html.slice(0, 4000))) throw new Error('That file isn’t a Demoflow app file.');
  if (cmpVersion(v, APP_VERSION) <= 0) throw new Error(`That file is version ${v}. You’re already running ${APP_VERSION}.`);
  await keep(html, v, [], file.name);
  return v;
}

export function restartApp() { location.reload(); }

// Called once the app has drawn: the stored copy works, so stop guarding it.
export function markStarted() {
  try { localStorage.removeItem('df.bootPending'); } catch { /* ignore */ }
}

// Quiet daily check when Demoflow opens.
export async function autoCheck(onReady) {
  const s = await loadSettings();
  if (!s.updates.auto) return;
  if (Date.now() - (s.updates.lastCheck || 0) < 20 * 3600 * 1000) {
    const st = await storedUpdate();
    if (st && cmpVersion(st.version, APP_VERSION) > 0) onReady({ status: 'ready', version: st.version, notes: st.notes });
    return;
  }
  const r = await checkForUpdate();
  if (r.status === 'ready' || r.status === 'reload') onReady(r);
}
