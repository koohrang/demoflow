import { db, uid, collectGarbage } from './db.js';
import { newDemo, newScreenStep, addCards } from './model.js';
import { h, icon, toast, menu, modal, confirmDialog, timeAgo, downloadBlob, slug } from './ui.js';
import { blobUrl } from './store.js';
import { fileToStepImage } from './media.js';
import { standaloneHtml } from './pack.js';
import { openRecordDialog } from './record-ui.js';
import { topnav } from './nav.js';
import { exportBackup, importBackup } from './backup.js';

export async function renderLibrary(root) {
  let demos = await db.listDemos();
  let query = '';

  const grid = h('div', { class: 'grid' });
  const countLine = h('p');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search demos', 'aria-label': 'Search demos', oninput: (e) => { query = e.target.value.toLowerCase(); draw(); } });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => createFromImages([...e.target.files]) });
  const restoreInput = h('input', { type: 'file', accept: '.demoflow,.zip,application/zip', hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); } });
  const backupNote = h('div', { class: 'backup-note', hidden: true });

  const stats = h('div', { class: 'stats', 'aria-label': 'Summary' });
  const listTitle = h('h2', { class: 'section-title' }, 'Your demos');
  const page = h('main', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Demos'), countLine),
      h('div', { class: 'lib-tools', id: 'lib-tools' },
        h('label', { class: 'search' }, icon('search', 16), search),
        h('button', { class: 'btn btn-outline', type: 'button', onclick: () => fileInput.click() }, icon('image', 17), 'Create from images'),
        h('button', { class: 'btn btn-outline', type: 'button', 'aria-label': 'Back up or restore', onclick: (e) => menu(e.currentTarget, [
          { label: 'Back up all demos', icon: 'download', run: () => backup() },
          { label: 'Restore from a backup', icon: 'upload', run: () => restoreInput.click() },
        ], { align: 'right' }) }, icon('download', 17), 'Backup'),
        h('button', { class: 'btn btn-blaze', type: 'button', onclick: recordDialog }, h('span', { class: 'rec-dot-sm' }), 'Record a demo'))),
    backupNote, stats, listTitle, grid, fileInput, restoreInput);
  window.__dfRestore = () => restoreInput.click();

  root.append(h('div', { class: 'shell' }, topnav('library'), page));
  draw();


  function draw() {
    const list = demos.filter((d) => !query || (d.title || '').toLowerCase().includes(query));
    countLine.textContent = demos.length
      ? `${demos.length} demo${demos.length === 1 ? '' : 's'} saved in this browser.`
      : 'Click-through product tours, recorded from your own app.';
    page.querySelector('#lib-tools').hidden = !demos.length;
    stats.hidden = listTitle.hidden = !demos.length;
    drawStats();
    drawBackupNote();
    grid.replaceChildren();
    if (!demos.length) { grid.replaceWith(emptyState()); return; }
    if (!list.length) { grid.append(h('p', { class: 'modal-text' }, `No demos match “${query}”.`)); return; }
    for (const d of list) grid.append(card(d));
  }

  // Demos live only in this browser: nudge towards a backup now and then.
  function drawBackupNote() {
    let last = 0;
    try { last = +localStorage.getItem('df.lastBackup') || 0; } catch { /* ignore */ }
    const newest = demos.reduce((m, d) => Math.max(m, d.updatedAt || 0), 0);
    const stale = demos.length && newest > last && Date.now() - last > 7 * 864e5;
    backupNote.hidden = !stale;
    if (!stale) return;
    backupNote.replaceChildren(
      icon('shield', 18),
      h('div', null, h('strong', null, last ? 'Time for a fresh backup' : 'Keep a backup of your demos'),
        h('span', null, 'They’re stored only in this browser. A backup file keeps them safe and moves them to another computer.')),
      h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => backup() }, 'Back up now'));
  }

  async function backup(ids) {
    const t = toast('Packing your demos…', { timeout: 600000 });
    try {
      const { blob, count } = await exportBackup({ ids });
      const day = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, ids && ids.length === 1 ? `${slug(demos.find((d) => d.id === ids[0]).title)}.demoflow` : `demoflow-backup-${day}.demoflow`);
      if (!ids) { try { localStorage.setItem('df.lastBackup', String(Date.now())); } catch { /* ignore */ } }
      t.remove();
      toast(`Backed up ${count} demo${count === 1 ? '' : 's'} (${(blob.size / 1048576).toFixed(1)} MB)`, { kind: 'ok' });
      drawBackupNote();
    } catch (e) { t.remove(); toast(e.message, { kind: 'error', timeout: 8000 }); }
  }

  async function restore(file) {
    const t = toast('Restoring…', { timeout: 600000 });
    try {
      const r = await importBackup(file);
      demos = await db.listDemos();
      t.remove();
      const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.skipped && `${r.skipped} already up to date`].filter(Boolean);
      toast(`Restore finished: ${parts.join(', ') || 'nothing to add'}`, { kind: 'ok', timeout: 7000 });
      if (document.querySelector('.empty')) { root.replaceChildren(); renderLibrary(root); } else draw();
    } catch (e) { t.remove(); toast(e.message, { kind: 'error', timeout: 8000 }); }
  }

  function drawStats() {
    const steps = demos.reduce((n, d) => n + d.steps.length, 0);
    const clips = demos.reduce((n, d) => n + d.steps.filter((s) => s.type === 'video' || (s.motion && s.motion.videoId)).length, 0);
    const shared = demos.reduce((n, d) => n + (d.exports || 0), 0);
    const last = demos[0];
    const stat = (cls, ic, label, val, sub) => h('div', { class: `stat ${cls}` },
      h('div', { class: 'lbl' }, icon(ic, 16), label), h('div', { class: 'val' }, val), h('div', { class: 'sub' }, sub));
    stats.replaceChildren(
      stat('stat-indigo', 'film', 'Demos', demos.length.toLocaleString(), 'Saved in this browser'),
      stat('stat-amber', 'target', 'Steps', steps.toLocaleString(), demos.length ? `About ${Math.round(steps / demos.length)} per demo` : ''),
      stat('stat-blue', 'play', 'Video clips', clips.toLocaleString(), 'Recorded on-screen movement'),
      stat('stat-emerald', 'download', 'Exports', shared.toLocaleString(), last ? `Last edit: ${last.title}` : ''));
  }

  function card(d) {
    const cover = h('button', { class: 'card-cover', type: 'button', 'aria-label': `Edit ${d.title}`, onclick: () => (location.hash = `#/edit/${d.id}`) },
      h('span', { class: 'steps-pill' }, `${d.steps.length} step${d.steps.length === 1 ? '' : 's'}`));
    if (d.coverId) blobUrl(d.coverId).then((u) => { if (u) cover.style.backgroundImage = `url(${u})`; });
    const meta = h('div', { class: 'card-meta' }, h('span', null, `Edited ${timeAgo(d.updatedAt)}`));
    const more = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `More actions for ${d.title}`, onclick: (e) => {
      menu(e.currentTarget, [
        { label: 'Edit', icon: 'cursor', run: () => (location.hash = `#/edit/${d.id}`) },
        { label: 'Duplicate', icon: 'dup', run: () => duplicate(d) },
        { label: 'Download as HTML', icon: 'html', run: () => exportHtml(d) },
        { label: 'Back up this demo', icon: 'download', run: () => backup([d.id]) },
        '-',
        { label: 'Delete', icon: 'trash', danger: true, run: () => remove(d) },
      ], { align: 'right' });
    } }, icon('more'));
    return h('article', { class: 'card' }, cover,
      h('div', { class: 'card-body' },
        h('div', { class: 'card-text' }, h('a', { class: 'card-title', href: `#/edit/${d.id}` }, d.title || 'Untitled demo'), meta),
        more));
  }

  async function duplicate(d) {
    const copy = JSON.parse(JSON.stringify(d));
    copy.id = uid('d_');
    copy.title = `${d.title} (copy)`;
    copy.createdAt = copy.updatedAt = Date.now();
    copy.published = null;
    await db.putDemo(copy);
    demos = await db.listDemos();
    draw();
    toast('Demo duplicated', { kind: 'ok' });
  }

  async function remove(d) {
    const ok = await confirmDialog({ title: 'Delete this demo?', text: `“${d.title}” and its ${d.steps.length} screenshots will be removed from this browser.` });
    if (!ok) return;
    await db.deleteDemo(d.id);
    await collectGarbage();
    demos = await db.listDemos();
    draw();
    toast('Demo deleted');
  }

  async function exportHtml(d) {
    const t = toast('Preparing HTML file…', { timeout: 60000 });
    try {
      const html = await standaloneHtml(d);
      downloadBlob(new Blob([html], { type: 'text/html' }), `${slug(d.title)}.html`);
      t.remove();
      toast('HTML file downloaded', { kind: 'ok' });
    } catch (e) { t.remove(); toast(e.message, { kind: 'error' }); }
  }

  async function createFromImages(files) {
    files = files.filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const demo = newDemo({ title: 'Demo from screenshots' });
    for (const f of files) {
      const img = await fileToStepImage(f);
      const step = newScreenStep({ imgW: img.w, imgH: img.h, action: 'upload' });
      step.imageId = 'img_' + step.id;
      step.tooltip.text = '';
      await db.putBlob(step.imageId, img.blob);
      demo.steps.push(step);
    }
    demo.coverId = demo.steps[0].imageId;
    addCards(demo);
    await db.putDemo(demo);
    location.hash = `#/edit/${demo.id}`;
  }

  function recordDialog() { openRecordDialog({ onDone: (id) => { location.hash = `#/edit/${id}`; } }); }

  return () => {};
}

function emptyState() {
  const art = h('div', { class: 'empty-art', 'aria-hidden': 'true', html: TRAIL_ART });
  return h('section', { class: 'empty' },
    h('div', null,
      h('h2', null, 'Turn a walkthrough of your app into a demo anyone can click through'),
      h('p', null, 'Record once, polish the tooltips, then export an interactive page you can host anywhere, a video, or a GIF. Everything runs in this one file, on your computer.'),
      h('ol', { class: 'trail' },
        h('li', null, h('span', { class: 'n' }, '1'), h('div', null, h('strong', null, 'Press Record and pick the tab with your app'), h('span', { class: 'd' }, 'Demoflow watches that tab through screen sharing.'))),
        h('li', null, h('span', { class: 'n' }, '2'), h('div', null, h('strong', null, 'Click through the flow you want to show'), h('span', { class: 'd' }, 'Each screen change becomes a step with a hotspot you can adjust.'))),
        h('li', null, h('span', { class: 'n' }, '3'), h('div', null, h('strong', null, 'Edit, then export'), h('span', { class: 'd' }, 'Write tooltips (or let AI draft them), blur private data, add buttons and branches.')))),
      h('div', { class: 'empty-actions' },
        h('button', { class: 'btn btn-blaze', type: 'button', onclick: () => document.querySelector('#lib-tools .btn-blaze').click() }, 'Record a demo'),
        h('button', { class: 'btn btn-outline', type: 'button', onclick: () => document.querySelector('input[type=file]').click() }, icon('image', 17), 'Create from images')),
      h('p', { class: 'empty-restore' }, 'Moving from another computer? ', h('button', { class: 'link-btn', type: 'button', onclick: () => window.__dfRestore && window.__dfRestore() }, 'Restore a backup'))),
    art);
}

// Topographic contours with a marked trail: the product's one illustration.
const TRAIL_ART = `<svg viewBox="0 0 400 320" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
  <g fill="none" stroke="#4F5B8C" stroke-width="1.2" opacity=".85">
    <path d="M-20 260 C 60 220, 120 300, 200 250 S 330 200, 430 240"/>
    <path d="M-20 230 C 70 190, 130 270, 205 222 S 320 170, 430 205"/>
    <path d="M-20 198 C 80 160, 140 238, 210 192 S 312 140, 430 170"/>
    <path d="M-20 166 C 90 130, 150 205, 215 162 S 305 110, 430 136"/>
    <path d="M-20 134 C 100 100, 160 172, 222 132 S 300 82, 430 102"/>
    <path d="M-20 102 C 110 72, 172 140, 230 104 S 300 56, 430 68"/>
    <path d="M-20 70 C 120 44, 186 108, 240 76 S 305 30, 430 34"/>
    <ellipse cx="300" cy="64" rx="42" ry="20"/><ellipse cx="300" cy="64" rx="22" ry="9"/>
  </g>
  <path d="M60 280 C 110 250, 90 210, 150 196 S 210 150, 236 128 S 270 86, 300 66" fill="none" stroke="#FFB21A" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"/>
  <g>
    <circle cx="60" cy="280" r="9" fill="#FFB21A" stroke="#1E2A4A" stroke-width="3"/>
    <circle cx="150" cy="196" r="9" fill="#FFB21A" stroke="#1E2A4A" stroke-width="3"/>
    <circle cx="236" cy="128" r="9" fill="#FFB21A" stroke="#1E2A4A" stroke-width="3"/>
    <circle cx="300" cy="66" r="22" fill="none" stroke="#FFB21A" stroke-width="2" opacity=".5"/>
    <circle cx="300" cy="66" r="11" fill="#FFB21A" stroke="#fff" stroke-width="3"/>
  </g>
  <g transform="translate(170 214)">
    <rect width="132" height="44" rx="9" fill="#fff"/>
    <rect x="12" y="12" width="84" height="7" rx="3.5" fill="#1E2A4A" opacity=".85"/>
    <rect x="12" y="25" width="56" height="7" rx="3.5" fill="#1E2A4A" opacity=".3"/>
    <rect x="100" y="22" width="22" height="13" rx="4" fill="#4F46E5"/>
  </g>
</svg>`;
