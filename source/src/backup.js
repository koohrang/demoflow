// Back up every demo (with its screenshots, clips and audio) into one .demoflow
// file, and restore from it. The file is a plain zip:
//   demoflow.json        { app, format, exportedAt, demos: [...], blobs: { id: type } }
//   blobs/<id>           the media files
import { db } from './db.js';
import { makeZip, readZip } from './zip.js';

function blobIds(d) {
  const ids = new Set();
  const add = (x) => { if (x) ids.add(x); };
  add(d.coverId);
  if (d.full) { add(d.full.videoId); add(d.full.posterId); }
  if (d.brand) add(d.brand.logoId);
  if (d.music) add(d.music.audioId);
  for (const s of d.steps || []) {
    add(s.imageId); add(s.videoId);
    if (s.voice) add(s.voice.audioId);
    if (s.motion) add(s.motion.videoId);
  }
  return ids;
}

export async function exportBackup({ ids = null, onProgress } = {}) {
  let demos = await db.listDemos();
  if (ids) demos = demos.filter((d) => ids.includes(d.id));
  const types = {};
  const files = [];
  const all = new Set();
  demos.forEach((d) => blobIds(d).forEach((id) => all.add(id)));
  let n = 0;
  for (const id of all) {
    const b = await db.getBlob(id);
    n++;
    if (onProgress) onProgress(0.5 * n / all.size);
    if (!b) continue;
    types[id] = b.type || '';
    files.push({ name: `blobs/${id}`, data: b });
  }
  const manifest = { app: 'Demoflow', format: 1, exportedAt: new Date().toISOString(), version: window.DF_VERSION || '', demos, blobs: types };
  files.unshift({ name: 'demoflow.json', data: JSON.stringify(manifest) });
  const zip = await makeZip(files, { onProgress: (p) => onProgress && onProgress(0.5 + p * 0.5) });
  return { blob: new Blob([zip], { type: 'application/octet-stream' }), count: demos.length };
}

// Demos already here are only replaced when the backup's copy is newer.
export async function importBackup(file, { onProgress } = {}) {
  const z = await readZip(file);
  const raw = await z.text('demoflow.json');
  if (!raw) throw new Error('This file isn’t a Demoflow backup.');
  let m;
  try { m = JSON.parse(raw); } catch { throw new Error('The backup file is damaged.'); }
  if (!m || !Array.isArray(m.demos)) throw new Error('This file isn’t a Demoflow backup.');
  const have = new Map((await db.listDemos()).map((d) => [d.id, d]));
  const existingBlobs = new Set(await db.allBlobIds());
  let added = 0, updated = 0, skipped = 0, i = 0;
  for (const d of m.demos) {
    i++;
    const cur = have.get(d.id);
    if (cur && (cur.updatedAt || 0) >= (d.updatedAt || 0)) { skipped++; continue; }
    for (const id of blobIds(d)) {
      if (existingBlobs.has(id)) continue;
      const b = await z.get(`blobs/${id}`, (m.blobs && m.blobs[id]) || '');
      if (b) { await db.putBlob(id, b); existingBlobs.add(id); }
    }
    await db.putDemo(d);
    if (cur) updated++; else added++;
    if (onProgress) onProgress(i / m.demos.length);
  }
  return { added, updated, skipped, total: m.demos.length };
}
