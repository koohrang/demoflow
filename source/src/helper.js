// Talks to the optional Demoflow Click Helper extension through window messages.
// With it installed, recordings know exactly where each click landed.
import { makeZip } from './zip.js';

let present = false, version = '';
const listeners = new Set();
const waiters = new Set();

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== 'demoflow-helper') return;
  if (e.data.type === 'hello') {
    present = true; version = e.data.version || '';
    waiters.forEach((f) => f(true)); waiters.clear();
  } else if (e.data.type === 'event' && e.data.ev) listeners.forEach((f) => f(e.data.ev));
});

function ping() { window.postMessage({ source: 'demoflow-app', type: 'ping' }, '*'); }
ping();

export function helperPresent() { return present; }
export function helperVersion() { return version; }

// Resolves true once the extension answers (or false after the timeout).
export function detectHelper(ms = 600) {
  if (present) return Promise.resolve(true);
  return new Promise((resolve) => {
    const f = (v) => resolve(v);
    waiters.add(f);
    ping();
    setTimeout(() => { if (waiters.delete(f)) resolve(false); }, ms);
  });
}

// Keeps asking until the extension answers (e.g. right after it's installed).
// Returns a function that stops watching.
export function watchHelper(cb, every = 1200) {
  let stop = false;
  const tick = async () => {
    if (stop) return;
    if (await detectHelper(500)) { if (!stop) cb(true); return; }
    setTimeout(tick, every);
  };
  tick();
  return () => { stop = true; };
}

export function onHelperEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setHelperRecording(on) { window.postMessage({ source: 'demoflow-app', type: 'recording', on: !!on }, '*'); }

export async function helperZip() {
  const files = window.DF_EXT || {};
  const list = Object.keys(files).map((name) => {
    const v = files[name];
    if (/\.png$/.test(name)) {
      const bin = atob(v); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return { name: `demoflow-click-helper/${name}`, data: u };
    }
    return { name: `demoflow-click-helper/${name}`, data: v };
  });
  return makeZip(list);
}
