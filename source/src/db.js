// Demoflow local storage (kept under its original name so existing demos carry over): IndexedDB in the extension's origin.
// Shared by the background service worker and the editor app.
//   demos  : demo JSON documents (keyed by id)
//   blobs  : screenshots and audio (keyed by id) -> { id, blob, type }

const DB_NAME = 'trailmark';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('demos')) db.createObjectStore('demos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const r = fn(os);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  getDemo: (id) => run('demos', 'readonly', (s) => s.get(id)),
  putDemo: (demo) => run('demos', 'readwrite', (s) => s.put(demo)),
  deleteDemo: (id) => run('demos', 'readwrite', (s) => s.delete(id)),
  listDemos: () => run('demos', 'readonly', (s) => s.getAll()).then((all) =>
    (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))),
  getBlob: (id) => run('blobs', 'readonly', (s) => s.get(id)).then((r) => (r ? r.blob : null)),
  putBlob: (id, blob) => run('blobs', 'readwrite', (s) => s.put({ id, blob, type: blob.type })),
  deleteBlob: (id) => run('blobs', 'readwrite', (s) => s.delete(id)),
  allBlobIds: () => run('blobs', 'readonly', (s) => s.getAllKeys()),
};

export function uid(prefix = '') {
  const a = crypto.getRandomValues(new Uint8Array(9));
  return prefix + Array.from(a, (b) => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');
}

// Remove blobs no demo references any more (after deleting steps or demos).
export async function collectGarbage() {
  const demos = await db.listDemos();
  const used = new Set();
  for (const d of demos) {
    if (d.coverId) used.add(d.coverId);
    if (d.brand && d.brand.logoId) used.add(d.brand.logoId);
    if (d.music && d.music.audioId) used.add(d.music.audioId);
    if (d.full) { if (d.full.videoId) used.add(d.full.videoId); if (d.full.posterId) used.add(d.full.posterId); }
    for (const s of d.steps || []) {
      if (s.imageId) used.add(s.imageId);
      if (s.voice && s.voice.audioId) used.add(s.voice.audioId);
      if (s.videoId) used.add(s.videoId);
      if (s.imageId) used.add(s.imageId);
      if (s.motion && s.motion.videoId) used.add(s.motion.videoId);
    }
  }
  const ids = await db.allBlobIds();
  for (const id of ids) if (!used.has(id)) await db.deleteBlob(id);
}
