import { db, uid, collectGarbage } from './db.js';
import { newScreenStep, newChapterStep, newVideoStep, newButton, stepVoiceText, DEFAULT_THEME, addCards, newOpeningCard, newClosingCard, THEMES, FONTS, ANNO_COLORS, newDemo } from './model.js';
import { h, icon, toast, menu, modal, confirmDialog, debounce, timeAgo, downloadBlob, slug } from './ui.js';
import { blobUrl, loadSettings } from './store.js';
import { fileToStepImage, shrinkImage } from './media.js';
import { aiReady, ttsReady, writeStep, writeTitle, synthesize, translateTexts } from './ai.js';
import { packDemo, voiceIsFresh } from './pack.js';
import { openExportDialog } from './export-dialog.js';
import { openRecordDialog, openClipDialog } from './record-ui.js';
import { motionPlays } from './pack.js';

const TP = () => window.TrailmarkPlayer;
const ACCENTS = ['#4F46E5', '#2C6BE0', '#1E2A4A', '#16A36A', '#1F5E52', '#C2410C', '#BE185D'];
const HOTS = ['#FFB21A', '#FF5A5F', '#22C55E', '#3B82F6', '#A855F7', '#FFFFFF'];

export async function renderEditor(root, demoId) {
  let demo = await db.getDemo(demoId);
  if (!demo) {
    root.append(h('div', { class: 'shell' }, h('main', { class: 'page' },
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Demo not found'), h('p', null, 'It may have been deleted, or it was recorded in a different Chrome profile.'))),
      h('a', { class: 'btn btn-outline', href: '#/' }, 'Back to demos'))));
    return () => {};
  }
  migrate(demo);
  if (!demo.cardsInit) { addCards(demo); await db.putDemo(demo); }
  let settings = await loadSettings();
  let sel = 0;
  let tool = 'select';
  let selBlur = null;
  let selAnno = null;
  let annoColor = ANNO_COLORS[0];
  let tab = 'step';
  const undoStack = [];
  const redoStack = [];
  let lastCoalesce = null, lastCoalesceAt = 0;
  let busy = {}; // spinners by key

  /* ---------- persistence ---------- */
  const saveState = h('span', { class: 'save-state', 'aria-live': 'polite' }, 'Saved');
  const persist = debounce(async () => {
    demo.updatedAt = Date.now();
    const first = demo.steps.find((s) => s.type === 'screen');
    demo.coverId = first ? first.imageId : null;
    await db.putDemo(demo);
    saveState.replaceChildren(icon('check', 14), 'Saved');
  }, 350);
  function dirty() { saveState.textContent = 'Saving…'; persist(); }

  function mutate(fn, { coalesce = null, render = 'all' } = {}) {
    const now = Date.now();
    if (!(coalesce && coalesce === lastCoalesce && now - lastCoalesceAt < 1200)) {
      undoStack.push(JSON.stringify(demo));
      if (undoStack.length > 120) undoStack.shift();
      redoStack.length = 0;
    }
    lastCoalesce = coalesce; lastCoalesceAt = now;
    fn();
    dirty();
    if (render === 'all') renderAll();
    else if (render === 'canvas') { renderCanvas(); renderRail(); }
    else if (render === 'rail') renderRail();
    updateUndo();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(demo));
    demo = JSON.parse(undoStack.pop());
    lastCoalesce = null;
    sel = Math.min(sel, demo.steps.length - 1);
    dirty(); renderAll(); updateUndo();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(demo));
    demo = JSON.parse(redoStack.pop());
    lastCoalesce = null;
    sel = Math.min(sel, demo.steps.length - 1);
    dirty(); renderAll(); updateUndo();
  }

  const step = () => demo.steps[sel];

  /* ---------- top bar ---------- */
  const titleInput = h('input', { value: demo.title, 'aria-label': 'Demo title', maxlength: 120,
    oninput: (e) => {
      const op = demo.steps.find((x) => x.role === 'opening' && x.titleLinked !== false);
      mutate(() => { demo.title = e.target.value; if (op) op.title = e.target.value; }, { coalesce: 'title', render: op ? 'rail' : 'none' });
      if (op && step() === op) renderCanvas();
    },
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
  const undoBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: undo }, icon('undo'));
  const redoBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: redo }, icon('redo'));
  function updateUndo() { undoBtn.disabled = !undoStack.length; redoBtn.disabled = !redoStack.length; }
  const top = h('header', { class: 'ed-top' },
    h('a', { class: 'icon-btn', href: '#/', title: 'All demos', 'aria-label': 'Back to all demos', onclick: () => persist.flush() }, icon('back')),
    h('div', { class: 'ed-title' }, titleInput, saveState),
    undoBtn, redoBtn, h('span', { class: 'ed-sep' }),
    h('button', { class: 'btn btn-outline', type: 'button', onclick: openPreview }, icon('play', 15), 'Preview'),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => { await persist.flush(); openExportDialog({ demo, settings }); } }, icon('download', 17), 'Export and share'));

  /* ---------- rail ---------- */
  const railList = h('ol', { class: 'rail-list', 'aria-label': 'Steps' });
  const uploadInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => addImages([...e.target.files]) });
  const rail = h('aside', { class: 'rail' },
    h('div', { class: 'rail-head', title: 'Drag steps to reorder them' }, h('span', { class: 'rail-count' })),
    railList,
    h('div', { class: 'rail-foot' },
      h('button', { class: 'btn btn-primary btn-sm btn-block', type: 'button', onclick: (e) => insertMenu(e.currentTarget, sel + 1, 'up') }, icon('plus', 16), 'Add a step after this one'),
      uploadInput));

  let dragFrom = null;
  function renderRail() {
    rail.querySelector('.rail-count').textContent = `${demo.steps.length} step${demo.steps.length === 1 ? '' : 's'}`;
    railList.replaceChildren();
    const gap = (at) => h('li', { class: 'rail-gap' },
      h('button', { class: 'gap-btn', type: 'button', title: 'Insert a step here', 'aria-label': `Insert a step at position ${at + 1}`, onclick: (e) => { e.stopPropagation(); insertMenu(e.currentTarget, at); } },
        h('span', { class: 'gap-line' }), h('span', { class: 'gap-plus' }, icon('plus', 12)), h('span', { class: 'gap-line' })));
    demo.steps.forEach((s, i) => {
      railList.append(gap(i));
      const thumb = h('div', { class: 'rail-thumb' + (s.type === 'chapter' ? ' chapter' : '') });
      if (s.type === 'screen' || s.type === 'video') {
        blobUrl(s.imageId).then((u) => { if (u) thumb.style.backgroundImage = `url(${u})`; });
        if (s.type === 'screen' && s.play === 'auto') { /* no hotspot drawn */ }
        else if (s.type === 'screen' && s.hotspot.style === 'area' && s.highlight) thumb.append(h('span', { class: 'area', style: { left: s.highlight.x * 100 + '%', top: s.highlight.y * 100 + '%', width: s.highlight.w * 100 + '%', height: s.highlight.h * 100 + '%' } }));
        else if (s.type === 'screen' && s.hotspot.style !== 'none') thumb.append(h('span', { class: 'dot', style: { left: s.hotspot.x * 100 + '%', top: s.hotspot.y * 100 + '%' } }));
        if (s.type === 'screen' && s.play === 'auto') thumb.append(h('span', { class: 'auto-badge', title: 'Video only: plays by itself' }, icon('play', 10), 'Auto'));
        if (s.type === 'video') thumb.append(h('span', { class: 'film-badge' }, icon('play', 11), fmtDur(s.dur)));
        else if (s.motion && s.motion.videoId) thumb.append(h('span', { class: 'film-badge' + (motionPlays(s) ? '' : ' off'), title: motionPlays(s) ? 'Plays recorded movement after the click' : 'Movement video is off for this step' }, icon('film', 11), 'Movement'));
      } else {
        thumb.textContent = s.title || (s.role === 'opening' ? 'Opening' : s.role === 'closing' ? 'Closing' : 'Section');
        if (s.role) { thumb.classList.add('card-' + s.role); thumb.append(h('span', { class: 'role-badge' }, s.role === 'opening' ? 'Opening' : 'Closing')); }
      }
      const branches = (s.buttons || []).some((b) => b.action && b.action.type === 'step') || (s.next && s.next.type === 'step');
      const cap = s.type === 'chapter' ? (s.text || 'Section card')
        : s.play === 'auto' ? ((s.caption && s.tooltip.text) ? s.tooltip.text.replace(/\*\*/g, '') : (motionPlays(s) ? `Plays ${secs(s.motion.dur)} of movement` : 'Shows, then moves on'))
          : ((s.tooltip.text || '').replace(/\*\*/g, '') || (s.type === 'video' ? 'Video clip' : 'No tooltip text'));
      const li = h('li', {
        class: 'rail-item', 'aria-current': i === sel ? 'true' : 'false', draggable: 'true', tabindex: '0',
        'aria-label': `Step ${i + 1}: ${cap}`,
        onclick: () => select(i),
        onkeydown: (e) => {
          if (e.key === 'Enter') select(i);
          if ((e.key === 'Delete' || e.key === 'Backspace') && i === sel) { e.preventDefault(); deleteStep(i); }
        },
        oncontextmenu: (e) => { e.preventDefault(); stepMenu(li, i); },
        ondragstart: (e) => { dragFrom = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); },
        ondragend: () => { li.classList.remove('dragging'); railList.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); },
        ondragover: (e) => {
          if (dragFrom == null) return;
          e.preventDefault();
          const r = li.getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2;
          railList.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
          li.classList.add(before ? 'drop-before' : 'drop-after');
        },
        ondrop: (e) => {
          e.preventDefault();
          if (dragFrom == null) return;
          const r = li.getBoundingClientRect();
          let to = e.clientY < r.top + r.height / 2 ? i : i + 1;
          const from = dragFrom; dragFrom = null;
          if (to > from) to--;
          if (to === from) { renderRail(); return; }
          const curId = step().id;
          mutate(() => {
            const [m] = demo.steps.splice(from, 1);
            demo.steps.splice(to, 0, m);
            sel = demo.steps.findIndex((x) => x.id === curId);
          });
        },
      },
      h('span', { class: 'idx' }, i + 1),
      h('div', null, thumb, h('div', { class: 'rail-cap' }, cap)),
      branches ? h('span', { class: 'branch', title: 'Has a branch' }, icon('next', 13)) : null);
      railList.append(li);
    });
    railList.append(gap(demo.steps.length));
    const cur = railList.querySelectorAll('.rail-item')[sel];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function stepMenu(anchor, i) {
    menu(anchor, [
      { label: 'Insert a step before', icon: 'plus', run: () => insertMenu(anchor, i) },
      { label: 'Insert a step after', icon: 'plus', run: () => insertMenu(anchor, i + 1) },
      { label: 'Duplicate step', icon: 'dup', run: () => duplicateStep(i) },
      '-',
      { label: 'Delete step', icon: 'trash', danger: true, run: () => deleteStep(i) },
    ]);
  }

  function select(i) {
    if (i < 0 || i >= demo.steps.length) return;
    sel = i; selBlur = null;
    if (step().type !== 'screen' && tool !== 'select') tool = 'select';
    renderAll();
  }

  function duplicateStep(i) {
    mutate(() => {
      const c = JSON.parse(JSON.stringify(demo.steps[i]));
      c.id = uid('s_');
      (c.buttons || []).forEach((b) => { b.id = uid('b_'); });
      (c.blurs || []).forEach((b) => { b.id = uid('bl_'); });
      demo.steps.splice(i + 1, 0, c);
      sel = i + 1;
    });
  }

  async function deleteStep(i) {
    if (demo.steps.length === 1) { toast('A demo needs at least one step.'); return; }
    const s = demo.steps[i];
    mutate(() => {
      demo.steps.splice(i, 1);
      // Re-point anything that jumped to the deleted step.
      for (const x of demo.steps) {
        if (x.next && x.next.type === 'step' && x.next.stepId === s.id) x.next = { type: 'next' };
        for (const b of x.buttons || []) if (b.action && b.action.type === 'step' && b.action.stepId === s.id) b.action = { type: 'next' };
      }
      sel = Math.min(i, demo.steps.length - 1);
    });
    toast('Step deleted', { action: { label: 'Undo', run: undo } });
  }

  // Insert-anywhere: everything that can become a step at position `at`.
  function insertMenu(anchor, at, dir) {
    const where = at <= 0 ? 'at the start' : at >= demo.steps.length ? 'at the end' : `between steps ${at} and ${at + 1}`;
    menu(anchor, [
      { heading: `Add a step ${where}` },
      { label: 'Record steps here', icon: 'cursor', hint: 'Click through your app; each screen becomes a step', run: () => openRecordDialog({ onSteps: (steps, full) => {
        insertSteps(at, steps, 'recorded');
        if (full && !demo.full) mutate(() => { demo.full = full; }, { render: 'none' });
      } }) },
      { label: 'Record a video clip here', icon: 'film', hint: 'Capture on-screen movement as one video step', run: () => openClipDialog({ onStep: (st) => insertSteps(at, [st], 'video') }) },
      { label: 'Add screenshots here', icon: 'image', hint: 'Upload one or more images', run: () => { insertAt = at; uploadInput.click(); } },
      { label: 'Add a section card here', icon: 'chapter', hint: 'A title card, optionally with choices', run: () => addChapter(at) },
      at > 0 ? { label: 'Copy the step above', icon: 'dup', run: () => duplicateStep(at - 1) } : null,
    ].filter(Boolean), { align: 'left', up: dir === 'up' });
  }

  // New steps go between the opening and closing cards.
  function insideCards(at) {
    const op = demo.steps.findIndex((x) => x.role === 'opening');
    const cl = demo.steps.findIndex((x) => x.role === 'closing');
    if (op >= 0 && at <= op) at = op + 1;
    if (cl >= 0 && at > cl) at = cl;
    return Math.max(0, Math.min(demo.steps.length, at));
  }

  function insertSteps(at, steps, kind) {
    at = insideCards(at);
    mutate(() => { demo.steps.splice(at, 0, ...steps); sel = at; });
    const n = steps.length;
    toast(kind === 'video' ? 'Video clip added' : `Added ${n} step${n === 1 ? '' : 's'}`, { kind: 'ok', action: { label: 'Undo', run: undo } });
  }

  function addChapter(at = sel + 1) {
    at = insideCards(at);
    mutate(() => {
      const c = newChapterStep();
      if (at <= 1 && demo.steps.length && demo.steps[0].type !== 'chapter' && !demo.steps.some((x) => x.type === 'chapter')) {
        c.title = demo.title || 'Welcome';
        c.text = 'Take a quick, interactive tour.';
      }
      demo.steps.splice(at, 0, c);
      sel = at;
    });
  }

  let insertAt = null;
  async function addImages(files) {
    files = files.filter((f) => f.type.startsWith('image/'));
    const at = insideCards(insertAt == null ? sel + 1 : insertAt);
    insertAt = null;
    if (!files.length) return;
    const created = [];
    for (const f of files) {
      const img = await fileToStepImage(f);
      const s = newScreenStep({ imgW: img.w, imgH: img.h, action: 'upload' });
      s.imageId = 'img_' + s.id;
      s.tooltip.text = '';
      await db.putBlob(s.imageId, img.blob);
      created.push(s);
    }
    mutate(() => { demo.steps.splice(at, 0, ...created); sel = at; });
    uploadInput.value = '';
  }

  /* ---------- canvas ---------- */
  const area = h('div', { class: 'canvas-area' });
  const stageFoot = h('div', { class: 'stage-foot' });
  const stageWrap = h('section', { class: 'stage-wrap', 'aria-label': 'Step canvas' }, area, stageFoot);

  // No tool row: the only mode is blur drawing, started from the Blur section.
  // While it's on, a small chip on the screenshot says so and ends it.
  const TOOL_TEXT = { blur: 'Drag over anything private', box: 'Drag to draw a box', arrow: 'Drag from the start to the tip', label: 'Click where the label goes' };
  function blurChip() {
    if (!TOOL_TEXT[tool]) return null;
    return h('div', { class: 'mode-chip', role: 'status', onpointerdown: (e) => e.stopPropagation() },
      tool === 'blur' ? icon('blur', 14) : h('span', { class: 'chip-dot', style: { background: annoColor } }), TOOL_TEXT[tool],
      h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); tool = 'select'; selBlur = null; renderCanvas(); } }, 'Done'));
  }
  const drawing = () => tool === 'box' || tool === 'arrow' || tool === 'label';

  function aspectFor(i) {
    const s = demo.steps[i];
    const visual = (x) => x && x.type !== 'chapter' && x.imgW && x.imgH;
    if (visual(s)) return s.imgW / s.imgH;
    const near = demo.steps.slice(i).find(visual) || [...demo.steps.slice(0, i)].reverse().find(visual);
    return near ? near.imgW / near.imgH : 16 / 10;
  }

  function applyTheme(elm) {
    const t = demo.theme || DEFAULT_THEME;
    elm.style.setProperty('--tmp-accent', t.accent);
    elm.style.setProperty('--tmp-accent-ink', TP().contrastInk(t.accent));
    elm.style.setProperty('--tmp-hot', t.hotspot);
    elm.style.setProperty('--tmp-tip-bg', t.tooltipBg || '#fff');
    elm.style.setProperty('--tmp-tip-ink', t.tooltipText || '#17211E');
    elm.style.setProperty('--tmp-radius', (t.radius != null ? t.radius : 12) + 'px');
    elm.style.setProperty('--tmp-font', t.font || '"Inter TM", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
  }

  let canvasEl = null, cw = 0, ch = 0;
  function sizeCanvas() {
    if (!canvasEl) return;
    const ar = aspectFor(sel);
    const aw = area.clientWidth - 52, ah = area.clientHeight - 28;
    let w = aw, hh = aw / ar;
    if (hh > ah) { hh = ah; w = ah * ar; }
    cw = Math.max(200, Math.floor(w)); ch = Math.max(120, Math.floor(hh));
    canvasEl.style.width = cw + 'px'; canvasEl.style.height = ch + 'px';
    canvasEl.style.setProperty('--tmp-w', cw + 'px');
    placeTip();
  }

  function frac(e) {
    const r = canvasEl.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  }

  function renderCanvas() {
    const s = step();
    if (tool === 'hotspot' || (s && s.type !== 'screen')) tool = 'select';
    area.replaceChildren();
    canvasEl = h('div', { class: 'canvas mode-' + tool });
    applyTheme(canvasEl);
    area.append(canvasEl);
    stageFoot.replaceChildren(
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous step', disabled: sel === 0, onclick: () => select(sel - 1) }, icon('back', 16)),
      h('span', null, `Step ${sel + 1} of ${demo.steps.length}`),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next step', disabled: sel >= demo.steps.length - 1, onclick: () => select(sel + 1) }, icon('next', 16)));
    if (!s) return;
    if (s.type === 'chapter') renderChapterCanvas(s);
    else if (s.type === 'video') renderVideoCanvas(s);
    else renderScreenCanvas(s);
    const chip = blurChip();
    if (chip) canvasEl.append(chip);
    sizeCanvas();
  }

  function renderScreenCanvas(s) {
    const img = h('img', { alt: '' });
    blobUrl(s.imageId).then((u) => { img.src = u; });
    canvasEl.append(img);

    // blur boxes
    for (const b of s.blurs || []) canvasEl.append(blurBox(s, b));
    renderAnnos(s);
    if (s.zoom && s.zoom.scale > 1) canvasEl.append(zoomFrame(s));

    if (s.play === 'auto') {
      const playable = motionPlays(s);
      canvasEl.append(h('div', { class: 'auto-chip' }, playable ? `Video only · ${secsShort(s.motion.dur)} of movement` : 'Video only'));
      if (s.caption && s.tooltip.text) {
        const cap = h('div', { class: 'tmp-tip tmp-cap tmp-cap-only' }, h('p', { class: 'tmp-text', html: TP().rich(s.tooltip.text) }));
        canvasEl.append(cap);
      }
      canvasEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (tool === 'blur') drawBlur(e, s); else if (drawing()) drawAnno(e, s);
        else if ((e.target === canvasEl || e.target.tagName === 'IMG') && selAnno) { selAnno = null; renderAnnos(s); }
      });
      return;
    }
    // hotspot
    const hs = s.hotspot;
    if ((hs.style === 'spotlight' || hs.style === 'area') && s.highlight) {
      const r = s.highlight;
      const sp = h('div', { class: hs.style === 'area' ? 'tmp-area' : 'tmp-spot', title: 'Drag to move. Drag the corner to resize.', style: { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' } });
      const rs = h('div', { class: 'spot-rs', 'aria-hidden': 'true' });
      const posRs = () => { rs.style.left = `calc(${(s.highlight.x + s.highlight.w) * 100}% - 7px)`; rs.style.top = `calc(${(s.highlight.y + s.highlight.h) * 100}% - 7px)`; };
      posRs();
      dragRect(sp, () => s.highlight, (r2) => { s.highlight = r2; s.hotspot.x = r2.x + r2.w / 2; s.hotspot.y = r2.y + r2.h / 2; sp.style.left = r2.x * 100 + '%'; sp.style.top = r2.y * 100 + '%'; posRs(); placeTip(); }, 'move');
      dragRect(rs, () => s.highlight, (r2) => { s.highlight = r2; s.hotspot.x = r2.x + r2.w / 2; s.hotspot.y = r2.y + r2.h / 2; sp.style.width = r2.w * 100 + '%'; sp.style.height = r2.h * 100 + '%'; posRs(); placeTip(); }, 'resize');
      canvasEl.append(sp, rs);
    } else if (hs.style !== 'none' || tool === 'select') {
      const b = h('button', { class: 'tmp-beacon', type: 'button', 'aria-label': 'Hotspot. Drag to move, or use arrow keys.', style: { left: hs.x * 100 + '%', top: hs.y * 100 + '%', opacity: hs.style === 'none' ? '0.35' : '1' }, html: '<span class="tmp-ring"></span><span class="tmp-ring"></span><span class="tmp-core"></span>' });
      b.addEventListener('pointerdown', (e) => {
        if (tool !== 'select') return;
        e.preventDefault(); e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        undoStack.push(JSON.stringify(demo)); redoStack.length = 0; lastCoalesce = null;
        const move = (ev) => { const p = frac(ev); s.hotspot.x = p.x; s.hotspot.y = p.y; b.style.left = p.x * 100 + '%'; b.style.top = p.y * 100 + '%'; placeTip(); };
        const up = () => { b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up); if (s.hotspotUnsure) { delete s.hotspotUnsure; renderInspector(); } dirty(); renderRail(); updateUndo(); };
        b.addEventListener('pointermove', move); b.addEventListener('pointerup', up);
      });
      b.addEventListener('keydown', (e) => {
        const d = e.shiftKey ? 0.02 : 0.004;
        const map = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
        if (!map[e.key]) return;
        e.preventDefault(); e.stopPropagation();
        mutate(() => { delete s.hotspotUnsure; s.hotspot.x = clamp(s.hotspot.x + map[e.key][0]); s.hotspot.y = clamp(s.hotspot.y + map[e.key][1]); }, { coalesce: 'nudge', render: 'none' });
        b.style.left = s.hotspot.x * 100 + '%'; b.style.top = s.hotspot.y * 100 + '%'; placeTip();
      });
      canvasEl.append(b);
    }

    // tooltip, editable in place
    const tip = h('div', { class: 'tmp-tip' }, h('span', { class: 'tmp-arrow' }));
    const text = h('p', { class: 'tmp-text', contenteditable: 'plaintext-only', spellcheck: 'true', role: 'textbox', 'aria-label': 'Tooltip text', 'aria-multiline': 'true' });
    text.innerHTML = TP().rich(s.tooltip.text || '');
    text.addEventListener('focus', () => { text.textContent = s.tooltip.text || ''; placeTip(); });
    text.addEventListener('input', () => {
      mutate(() => { s.tooltip.text = text.innerText.replace(/\n{3,}/g, '\n\n').replace(/\n$/, ''); }, { coalesce: 'tip-' + s.id, render: 'none' });
      const ta = document.getElementById('tip-text'); if (ta) ta.value = s.tooltip.text;
      placeTip(); renderRail();
    });
    text.addEventListener('blur', () => { text.innerHTML = TP().rich(s.tooltip.text || ''); placeTip(); renderInspector(); });
    text.addEventListener('keydown', (e) => { if (e.key === 'Escape') text.blur(); e.stopPropagation(); });
    tip.append(text);
    if (s.buttons.length) {
      const row = h('div', { class: 'tmp-ctas' });
      s.buttons.forEach((b) => row.append(h('span', { class: 'tmp-btn' + (b.style === 'primary' ? '' : ' tmp-secondary') }, b.label || 'Button')));
      tip.append(row);
    }
    const foot = h('div', { class: 'tmp-foot' },
      h('span', { class: 'tmp-count' }, demo.settings.showStepCount !== false ? stepLabel(sel) : ''));
    if (demo.settings.showBack !== false && sel > 0) foot.append(h('span', { class: 'tmp-btn tmp-icon', html: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' }));
    foot.append(h('span', { class: 'tmp-btn' }, sel === demo.steps.length - 1 ? 'Finish' : 'Next'));
    tip.append(foot);
    canvasEl.append(tip);

    // canvas-level interactions for tools
    // Double-click the screenshot to move the hotspot there.
    canvasEl.addEventListener('dblclick', (e) => {
      if (tool !== 'select' || !(e.target === canvasEl || e.target.tagName === 'IMG')) return;
      const p = frac(e);
      mutate(() => {
        delete s.hotspotUnsure;
        s.hotspot.x = p.x; s.hotspot.y = p.y;
        if ((s.hotspot.style === 'spotlight' || s.hotspot.style === 'area') && s.highlight) {
          s.highlight.x = clamp(p.x - s.highlight.w / 2, 0, 1 - s.highlight.w); s.highlight.y = clamp(p.y - s.highlight.h / 2, 0, 1 - s.highlight.h);
        }
        if (s.hotspot.style === 'none') s.hotspot.style = 'beacon';
      });
    });
    canvasEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (tool === 'hotspot') {
        const p = frac(e);
        mutate(() => {
          delete s.hotspotUnsure;
          s.hotspot.x = p.x; s.hotspot.y = p.y;
          if (s.hotspot.style === 'spotlight' && s.highlight) { s.highlight.x = clamp(p.x - s.highlight.w / 2); s.highlight.y = clamp(p.y - s.highlight.h / 2); }
          if (s.hotspot.style === 'none') s.hotspot.style = 'beacon';
        });
        tool = 'select'; renderCanvas();
        return;
      }
      if (tool === 'blur') { drawBlur(e, s); return; }
      if (drawing()) { drawAnno(e, s); return; }
      if (e.target === canvasEl || e.target.tagName === 'IMG') {
        if (selBlur) { selBlur = null; renderCanvas(); }
        if (selAnno) { selAnno = null; renderAnnos(s); }
      }
    });
  }

  function blurBox(s, b) {
    const el = h('div', { class: 'blur-box' + (selBlur === b.id ? ' sel' : ''), title: 'Blurred area', style: { left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' } });
    const del = h('button', { class: 'del', type: 'button', 'aria-label': 'Remove blur', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); removeBlur(s, b.id); } }, icon('close', 13));
    const rs = h('span', { class: 'rs' });
    el.append(del, rs);
    el.addEventListener('pointerdown', (e) => { if (tool === 'select' || tool === 'blur') { e.stopPropagation(); if (selBlur !== b.id) { selBlur = b.id; canvasEl.querySelectorAll('.blur-box').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); } } });
    dragRect(el, () => b, (r) => { Object.assign(b, r); el.style.left = r.x * 100 + '%'; el.style.top = r.y * 100 + '%'; }, 'move');
    dragRect(rs, () => b, (r) => { Object.assign(b, r); el.style.width = r.w * 100 + '%'; el.style.height = r.h * 100 + '%'; }, 'resize');
    return el;
  }

  function removeBlur(s, id) {
    mutate(() => { s.blurs = s.blurs.filter((x) => x.id !== id); }, { render: 'canvas' });
    selBlur = null;
    renderInspector();
  }

  // Generic drag for move/resize of a fractional rect.
  function dragRect(handle, get, set, kind) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !(tool === 'select' || tool === 'blur')) return;
      if (e.target.closest && e.target.closest('.del')) return;
      if (kind === 'move' && e.target !== handle) return;
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      undoStack.push(JSON.stringify(demo)); redoStack.length = 0; lastCoalesce = null;
      const start = frac(e); const r0 = { ...get() };
      const move = (ev) => {
        const p = frac(ev); const dx = p.x - start.x, dy = p.y - start.y;
        if (kind === 'move') set({ x: clamp(r0.x + dx, 0, 1 - r0.w), y: clamp(r0.y + dy, 0, 1 - r0.h), w: r0.w, h: r0.h });
        else set({ x: r0.x, y: r0.y, w: clamp(r0.w + dx, 0.01, 1 - r0.x), h: clamp(r0.h + dy, 0.01, 1 - r0.y) });
      };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); dirty(); updateUndo(); renderRail(); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
    });
  }

  function drawBlur(e, s) {
    e.preventDefault();
    const start = frac(e);
    const box = h('div', { class: 'draft-box' });
    canvasEl.append(box);
    canvasEl.setPointerCapture(e.pointerId);
    let r = { x: start.x, y: start.y, w: 0, h: 0 };
    const move = (ev) => {
      const p = frac(ev);
      r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      Object.assign(box.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
    };
    const up = () => {
      canvasEl.removeEventListener('pointermove', move); canvasEl.removeEventListener('pointerup', up);
      box.remove();
      if (r.w * cw < 8 || r.h * ch < 8) return;
      const b = { id: uid('bl_'), ...r };
      mutate(() => { s.blurs = s.blurs || []; s.blurs.push(b); }, { render: 'canvas' });
      selBlur = b.id;
      renderCanvas(); renderInspector();
    };
    canvasEl.addEventListener('pointermove', move); canvasEl.addEventListener('pointerup', up);
  }

  /* ----- Annotations: boxes, arrows and labels ----- */
  // The picture comes from the player so it matches exports exactly; handles sit on top.
  function renderAnnos(s) {
    if (!canvasEl) return;
    canvasEl.querySelectorAll('.tmp-annos, .anno-h').forEach((x) => x.remove());
    const list = s.annotations || [];
    const vis = TP().annotations(list, s.imgW, s.imgH);
    const img = canvasEl.querySelector('img');
    if (img && img.nextSibling) canvasEl.insertBefore(vis, img.nextSibling); else canvasEl.append(vis);
    for (const a of list) {
      const on = selAnno === a.id;
      const pick = (e) => {
        e.stopPropagation();
        if (selAnno === a.id) return;
        selAnno = a.id;
        canvasEl.querySelectorAll('.anno-h').forEach((x) => x.classList.toggle('sel', x.dataset.id === a.id));
      };
      if (a.kind === 'box') {
        const el = h('div', { class: 'anno-h anno-box' + (on ? ' sel' : ''), 'data-id': a.id, title: 'Box. Drag to move, drag the corner to resize.', style: { left: a.x * 100 + '%', top: a.y * 100 + '%', width: a.w * 100 + '%', height: a.h * 100 + '%' } });
        const rs = h('span', { class: 'rs' });
        el.append(rs);
        el.addEventListener('pointerdown', pick);
        dragRect(el, () => a, (r) => { Object.assign(a, r); Object.assign(el.style, { left: r.x * 100 + '%', top: r.y * 100 + '%' }); refreshVis(s); }, 'move');
        dragRect(rs, () => a, (r) => { Object.assign(a, r); Object.assign(el.style, { width: r.w * 100 + '%', height: r.h * 100 + '%' }); refreshVis(s); }, 'resize');
        canvasEl.append(el);
      } else if (a.kind === 'arrow') {
        const pt = (kx, ky, label) => {
          const d = h('div', { class: 'anno-h anno-pt' + (on ? ' sel' : ''), 'data-id': a.id, title: label, style: { left: a[kx] * 100 + '%', top: a[ky] * 100 + '%' } });
          d.addEventListener('pointerdown', (e) => { pick(e); dragPoint(d, e, (p) => { a[kx] = p.x; a[ky] = p.y; refreshVis(s); }); });
          canvasEl.append(d);
        };
        pt('x1', 'y1', 'Arrow start. Drag to move.'); pt('x2', 'y2', 'Arrow tip. Drag to move.');
      } else if (a.kind === 'label') {
        const d = h('div', { class: 'anno-h anno-lbl' + (on ? ' sel' : ''), 'data-id': a.id, title: 'Label. Drag to move. Edit the text on the right.', style: { left: a.x * 100 + '%', top: a.y * 100 + '%' } });
        d.addEventListener('pointerdown', (e) => { pick(e); dragPoint(d, e, (p) => { a.x = p.x; a.y = p.y; refreshVis(s); }); });
        d.addEventListener('dblclick', (e) => { e.stopPropagation(); tab = 'step'; openGroups.set('anno', true); renderInspector(); setTimeout(() => { const f = document.getElementById('anno-' + a.id); if (f) { f.focus(); f.select(); } }, 30); });
        canvasEl.append(d);
      }
    }
  }
  function refreshVis(s) {
    const old = canvasEl && canvasEl.querySelector('.tmp-annos');
    if (old) old.replaceWith(TP().annotations(s.annotations || [], s.imgW, s.imgH));
  }
  function dragPoint(handle, e, set) {
    if (e.button !== 0 || tool !== 'select') return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    undoStack.push(JSON.stringify(demo)); redoStack.length = 0; lastCoalesce = null;
    const move = (ev) => { const p = frac(ev); handle.style.left = p.x * 100 + '%'; handle.style.top = p.y * 100 + '%'; set(p); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); dirty(); updateUndo(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  }
  function drawAnno(e, s) {
    e.preventDefault();
    const start = frac(e);
    if (tool === 'label') {
      const a = { id: uid('an_'), kind: 'label', x: start.x, y: start.y, text: 'New label', color: annoColor };
      mutate(() => { s.annotations = s.annotations || []; s.annotations.push(a); }, { render: 'none' });
      selAnno = a.id; tool = 'select'; openGroups.set('anno', true);
      renderCanvas(); renderInspector();
      setTimeout(() => { const f = document.getElementById('anno-' + a.id); if (f) { f.focus(); f.select(); } }, 30);
      return;
    }
    const kind = tool;
    canvasEl.setPointerCapture(e.pointerId);
    let a = kind === 'box' ? { id: uid('an_'), kind, color: annoColor, x: start.x, y: start.y, w: 0, h: 0 } : { id: uid('an_'), kind, color: annoColor, x1: start.x, y1: start.y, x2: start.x, y2: start.y };
    const tmp = (s.annotations || []).concat([a]);
    const move = (ev) => {
      const p = frac(ev);
      if (kind === 'box') Object.assign(a, { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
      else Object.assign(a, { x2: p.x, y2: p.y });
      const old = canvasEl.querySelector('.tmp-annos');
      if (old) old.replaceWith(TP().annotations(tmp, s.imgW, s.imgH));
    };
    const up = () => {
      canvasEl.removeEventListener('pointermove', move); canvasEl.removeEventListener('pointerup', up);
      const big = kind === 'box' ? (a.w * cw >= 8 && a.h * ch >= 8) : Math.hypot((a.x2 - a.x1) * cw, (a.y2 - a.y1) * ch) >= 14;
      if (!big) { renderAnnos(s); return; }
      mutate(() => { s.annotations = s.annotations || []; s.annotations.push(a); }, { render: 'none' });
      selAnno = a.id; openGroups.set('anno', true);
      renderCanvas(); renderInspector();
    };
    canvasEl.addEventListener('pointermove', move); canvasEl.addEventListener('pointerup', up);
  }
  // A dashed frame showing what the viewer sees when the step zooms in.
  function zoomFrame(s) {
    const z = s.zoom.scale;
    let fx = s.hotspot.x, fy = s.hotspot.y;
    if ((s.hotspot.style === 'area' || s.hotspot.style === 'spotlight') && s.highlight) { fx = s.highlight.x + s.highlight.w / 2; fy = s.highlight.y + s.highlight.h / 2; }
    const ox = clamp(fx - 0.5 / z, 0, 1 - 1 / z), oy = clamp(fy - 0.5 / z, 0, 1 - 1 / z);
    return h('div', { class: 'zoom-frame', 'aria-hidden': 'true', style: { left: ox * 100 + '%', top: oy * 100 + '%', width: 100 / z + '%', height: 100 / z + '%' } }, h('span', null, `Zoom ${z}×`));
  }

  function placeTip() {
    const s = step();
    if (!canvasEl || !s || s.type === 'chapter') return;
    const tip = canvasEl.querySelector('.tmp-tip');
    if (!tip) return;
    const W = cw, H = ch;
    if (s.type === 'video' || s.play === 'auto') {
      tip.style.left = Math.round(Math.max(10, (W - tip.offsetWidth) / 2)) + 'px';
      tip.style.top = Math.round(Math.max(10, H - tip.offsetHeight - 16)) + 'px';
      return;
    }
    canvasEl.classList.toggle('tmp-docked', false);
    let ax = s.hotspot.x * W, ay = s.hotspot.y * H, gap = 22, pl = s.tooltip.placement || 'auto';
    if ((s.hotspot.style === 'spotlight' || s.hotspot.style === 'area') && s.highlight) {
      const r = s.highlight;
      ax = (r.x + r.w / 2) * W; ay = (r.y + r.h / 2) * H;
      if (pl === 'auto') pl = (H - (r.y + r.h) * H) >= r.y * H ? 'bottom' : 'top';
      gap = (pl === 'left' || pl === 'right') ? (r.w * W) / 2 + 14 : (r.h * H) / 2 + 14;
    } else if (s.hotspot.style === 'none') gap = 10;
    TP().layoutTip(tip, W, H, ax, ay, pl, gap);
  }

  function renderVideoCanvas(s) {
    const v = h('video', { class: 'tmp-video', muted: true, playsinline: true, preload: 'auto' });
    v.muted = true;
    blobUrl(s.imageId).then((u) => { if (u) v.poster = u; });
    blobUrl(s.videoId).then((u) => { if (u) v.src = u; });
    const play = h('button', { class: 'vid-play', type: 'button', 'aria-label': 'Play clip' }, icon('play', 16), h('span', null, `Play clip, ${fmtDur(s.dur)}`));
    const sync = () => { play.lastChild.textContent = v.paused ? `Play clip, ${fmtDur(s.dur)}` : 'Pause'; play.setAttribute('aria-label', v.paused ? 'Play clip' : 'Pause clip'); };
    play.addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });
    v.addEventListener('play', sync); v.addEventListener('pause', sync); v.addEventListener('ended', sync);
    const tip = h('div', { class: 'tmp-tip tmp-cap' });
    const text = h('p', { class: 'tmp-text', contenteditable: 'plaintext-only', spellcheck: 'true', role: 'textbox', 'aria-label': 'Caption', 'aria-multiline': 'true' });
    text.innerHTML = TP().rich(s.tooltip.text || '');
    text.dataset.empty = 'Add a caption (optional)…';
    text.addEventListener('focus', () => { text.textContent = s.tooltip.text || ''; placeTip(); });
    text.addEventListener('input', () => {
      mutate(() => { s.tooltip.text = text.innerText.replace(/\n$/, ''); }, { coalesce: 'cap-' + s.id, render: 'none' });
      const ta = document.getElementById('tip-text'); if (ta) ta.value = s.tooltip.text;
      placeTip(); renderRail();
    });
    text.addEventListener('blur', () => { text.innerHTML = TP().rich(s.tooltip.text || ''); placeTip(); renderInspector(); });
    text.addEventListener('keydown', (e) => { if (e.key === 'Escape') text.blur(); e.stopPropagation(); });
    tip.append(text, h('div', { class: 'tmp-foot' },
      h('span', { class: 'tmp-count' }, demo.settings.showStepCount !== false ? stepLabel(sel) : ''),
      h('span', { class: 'tmp-btn' }, sel === demo.steps.length - 1 ? 'Finish' : 'Next')));
    canvasEl.append(v, play, tip);
  }

  // "3 of 6": opening and closing cards aren't counted.
  function stepLabel(i) {
    const content = demo.steps.filter((x) => !x.role);
    const n = content.indexOf(demo.steps[i]);
    return n < 0 ? '' : `${n + 1} of ${content.length}`;
  }

  function renderChapterCanvas(s) {
    const near = demo.steps.slice(sel).find((x) => x.type === 'screen') || [...demo.steps.slice(0, sel)].reverse().find((x) => x.type === 'screen');
    const bg = h('div', { class: 'bg' });
    if (near) blobUrl(near.imageId).then((u) => { if (u) bg.style.backgroundImage = `url(${u})`; });
    const veil = h('div', { class: 'veil', style: { background: `color-mix(in srgb, ${demo.theme.accent} 62%, rgba(8,16,14,.55))` } });
    const title = h('h2', { contenteditable: 'plaintext-only', role: 'textbox', 'aria-label': 'Card title' }, s.title || '');
    const text = h('p', { contenteditable: 'plaintext-only', role: 'textbox', 'aria-label': 'Card text' }, s.text || '');
    title.addEventListener('input', () => mutate(() => { s.title = title.innerText.trim(); if (s.role === 'opening') s.titleLinked = false; }, { coalesce: 'ct-' + s.id, render: 'rail' }));
    text.addEventListener('input', () => mutate(() => { s.text = text.innerText.trim(); }, { coalesce: 'cx-' + s.id, render: 'rail' }));
    [title, text].forEach((x) => { x.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') x.blur(); }); x.addEventListener('blur', () => renderInspector()); });
    const choices = h('div', { class: 'tmp-choices' });
    const btns = s.buttons.length ? s.buttons : [{ label: 'Continue', style: 'primary' }];
    btns.forEach((b) => {
      const hidden = b.action && b.action.type === 'url' && !(b.action.url || '').trim();
      choices.append(h('span', { class: 'tmp-btn' + (b.style === 'primary' ? '' : ' tmp-secondary') + (hidden ? ' is-hidden-btn' : ''), title: hidden ? 'Hidden until you add its link' : null }, b.label || 'Button'));
    });
    const content = demo.steps.filter((x) => !x.role).length;
    const meta = s.role === 'opening' ? h('div', { class: 'tmp-meta' }, `${content} step${content === 1 ? '' : 's'}`) : null;
    const foot = !s.role && demo.settings.showStepCount !== false ? h('div', { class: 'tmp-foot' }, h('span', { class: 'tmp-count' }, stepLabel(sel))) : null;
    const card = h('div', { class: 'tmp-card' }, meta, title, text, choices, foot);
    canvasEl.append(h('div', { class: 'chapter-edit' + (s.role ? ' tmp-' + s.role : '') }, bg, veil, card));
  }

  /* ---------- inspector ---------- */
  const inspBody = h('div', { class: 'insp-body' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const insp = h('aside', { class: 'insp', 'aria-label': 'Properties' }, tabsEl, inspBody);

  function renderTabs() {
    tabsEl.replaceChildren(
      h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === 'step'), onclick: () => { tab = 'step'; renderInspector(); } }, step() && step().role ? (step().role === 'opening' ? 'Opening' : 'Closing') : step() && step().type === 'chapter' ? 'Section' : 'Step'),
      h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === 'demo'), onclick: () => { tab = 'demo'; renderInspector(); } }, 'Demo'));
  }

  // Element.append() would print an empty (null) section as the text "null".
  function addToInspector(...parts) { inspBody.append(...parts.flat().filter((x) => x != null && x !== false)); }

  /* ----- Building blocks: collapsible groups that show their value at a glance ----- */
  const openGroups = new Map(); // remembers which groups are open, per kind of group
  function group(key, title, summary, defaultOpen, ...kids) {
    const isOpen = openGroups.has(key) ? openGroups.get(key) : defaultOpen;
    const d = h('details', { class: 'grp', open: isOpen },
      h('summary', null, h('span', { class: 'grp-title' }, title), summary ? h('span', { class: 'grp-val' }, summary) : null),
      h('div', { class: 'grp-body' }, ...kids));
    d.addEventListener('toggle', () => openGroups.set(key, d.open));
    return d;
  }
  const help = (text) => h('p', { class: 'hint' }, text);
  const field = (label, ...kids) => h('div', { class: 'field' }, label ? h('span', { class: 'field-label' }, label) : null, ...kids);

  function seg(options, value, onPick, label) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onPick(v) }, l)));
  }

  function aiButton(key, label, run) {
    return h('button', { class: 'link-btn', type: 'button', disabled: !!busy[key], onclick: async () => {
      if (!aiReady(settings)) {
        toast('Add an AI key in Settings to write text automatically.', { action: { label: 'Open Settings', run: () => { persist.flush(); location.hash = '#/settings/ai'; } }, timeout: 6000 });
        return;
      }
      busy[key] = true; renderInspector();
      try { await run(); } catch (e) { toast(e.message, { kind: 'error', timeout: 7000 }); }
      finally { delete busy[key]; renderInspector(); }
    } }, busy[key] ? [h('span', { class: 'spin' }), 'Writing…'] : label);
  }

  function stepTargetSelect(cur, onPick, excludeId) {
    const sl = h('select', { class: 'select', 'aria-label': 'Target step', onchange: (e) => onPick(e.target.value) });
    demo.steps.forEach((x, i) => {
      if (x.id === excludeId) return;
      const lab = x.type === 'chapter' ? (x.title || 'Section') : ((x.tooltip.text || '').replace(/\*\*/g, '') || 'Screen');
      sl.append(h('option', { value: x.id, selected: x.id === cur }, `${i + 1}. ${lab.slice(0, 40)}`));
    });
    return sl;
  }

  const ACTIONS = [['next', 'Go to the next step'], ['step', 'Jump to a step'], ['url', 'Open a link'], ['restart', 'Start over'], ['end', 'End the demo']];
  function actionName(a) {
    a = a || { type: 'next' };
    if (a.type === 'step') { const i = demo.steps.findIndex((x) => x.id === a.stepId); return i >= 0 ? `Jump to ${i + 1}` : 'Jump'; }
    return ({ next: 'Next step', url: 'Open link', restart: 'Start over', end: 'End' })[a.type] || 'Next step';
  }

  function actionEditor(action, onChange, sId) {
    const wrap = h('div', { class: 'stack' });
    wrap.append(h('select', { class: 'select', 'aria-label': 'Action', onchange: (e) => {
      const t = e.target.value;
      const a = { type: t };
      if (t === 'step') { const other = demo.steps.find((x) => x.id !== sId); a.stepId = other ? other.id : null; }
      if (t === 'url') a.url = '';
      onChange(a, true);
    } }, ACTIONS.map(([v, l]) => h('option', { value: v, selected: v === action.type }, l))));
    if (action.type === 'step') wrap.append(stepTargetSelect(action.stepId, (id) => onChange({ type: 'step', stepId: id }, true), sId));
    if (action.type === 'url') wrap.append(h('input', { class: 'input', type: 'url', placeholder: 'https://…', value: action.url || '', 'aria-label': 'Link address', oninput: (e) => onChange({ type: 'url', url: e.target.value }, false) }));
    return wrap;
  }

  function buttonsEditor(s, { chapter = false } = {}) {
    const list = h('div', { class: 'stack' });
    s.buttons.forEach((b, bi) => {
      list.append(h('div', { class: 'cta-item' },
        h('div', { class: 'row' },
          h('input', { class: 'input grow', value: b.label, 'aria-label': 'Button label', maxlength: 40, oninput: (e) => mutate(() => { b.label = e.target.value; }, { coalesce: 'bl-' + b.id, render: 'canvas' }) }),
          h('select', { class: 'select select-sm', 'aria-label': 'Button style', onchange: (e) => mutate(() => { b.style = e.target.value; }, { render: 'canvas' }) },
            h('option', { value: 'primary', selected: b.style === 'primary' }, 'Filled'),
            h('option', { value: 'secondary', selected: b.style !== 'primary' }, 'Light')),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove button', title: 'Remove', onclick: () => mutate(() => { s.buttons.splice(bi, 1); }) }, icon('trash', 16))),
        actionEditor(b.action || { type: 'next' }, (a, re) => mutate(() => { b.action = a; }, { coalesce: re ? null : 'ba-' + b.id, render: re ? 'all' : 'rail' }), s.id)));
    });
    list.append(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => mutate(() => {
      s.buttons.push(newButton(chapter ? { label: s.buttons.length ? 'Show me something else' : 'Start the tour', style: s.buttons.length ? 'secondary' : 'primary' } : { label: 'Learn more', style: 'secondary', action: { type: 'url', url: '' } }));
    }) }, chapter ? 'Add a choice' : 'Add a button'));
    return list;
  }

  function voiceGroup(s) {
    const mode = demo.settings.voice;
    if (mode === 'off') {
      return group('voice', 'Voiceover', 'Off', false,
        help('Voiceover is off for this demo.'),
        h('button', { class: 'link-btn', type: 'button', onclick: () => { tab = 'demo'; openGroups.set('d-voice', true); renderInspector(); } }, 'Turn it on'));
    }
    const same = s.voice.sameAsTooltip !== false;
    const kids = [
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: same, onchange: (e) => mutate(() => { s.voice.sameAsTooltip = e.target.checked; if (!e.target.checked && !s.voice.text) s.voice.text = stepVoiceText({ ...s, voice: { sameAsTooltip: true } }); }) }),
        h('span', null, s.type === 'chapter' ? 'Read the card text aloud' : 'Read the text on screen aloud')),
    ];
    if (!same) kids.push(h('textarea', { class: 'textarea', rows: 3, 'aria-label': 'Voiceover script', placeholder: 'What the narrator says', oninput: (e) => mutate(() => { s.voice.text = e.target.value; }, { coalesce: 'vt-' + s.id, render: 'none' }) }, s.voice.text || ''));
    let summary = 'Browser voice';
    if (mode === 'audio') {
      const fresh = voiceIsFresh(s);
      summary = fresh ? 'Audio ready' : 'No audio yet';
      kids.push(h('div', { class: 'row' },
        fresh ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => { const u = await blobUrl(s.voice.audioId); new Audio(u).play(); } }, 'Play') : null,
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: !!busy['v-' + s.id], onclick: () => generateVoice(s) }, busy['v-' + s.id] ? [h('span', { class: 'spin' }), 'Generating…'] : (fresh ? 'Regenerate' : 'Generate audio'))));
      if (s.voice.audioId && !fresh) kids.push(help('The text changed since this audio was made.'));
    }
    return group('voice', 'Voiceover', summary, false, ...kids);
  }

  async function generateVoice(s) {
    if (!ttsReady(settings)) {
      toast('Add a voice key in Settings to generate audio.', { action: { label: 'Open Settings', run: () => { persist.flush(); location.hash = '#/settings/voice'; } }, timeout: 6000 });
      return;
    }
    const key = 'v-' + s.id;
    busy[key] = true; renderInspector();
    try {
      const text = stepVoiceText(s);
      const blob = await synthesize(settings, text);
      const id = uid('aud_');
      await db.putBlob(id, blob);
      mutate(() => { s.voice.audioId = id; s.voice.audioText = text; }, { render: 'none' });
      toast('Voiceover ready', { kind: 'ok' });
    } catch (e) { toast(e.message, { kind: 'error', timeout: 7000 }); }
    finally { delete busy[key]; renderInspector(); }
  }

  // Movement recorded between this screen and the next one.
  function motionGroup(s) {
    if (!s.motion || !s.motion.videoId) return null;
    const m = s.motion;
    const blocked = s.blurs && s.blurs.length;
    const vid = h('video', { class: 'motion-prev', muted: true, playsinline: true, controls: true, preload: 'metadata' });
    vid.muted = true;
    blobUrl(m.videoId).then((u) => { if (u) vid.src = u; });
    const full = +m.dur || 0;
    const t0 = +m.start || 0, t1 = m.end != null ? +m.end : full;
    const len = Math.max(0, t1 - t0);
    const summary = blocked ? 'Left out' : m.play === false ? 'Off' : secsShort(len) + (t0 > 0.05 || t1 < full - 0.05 ? ' (trimmed)' : '');
    const outS = h('output', null, secsShort(t0)), outE = h('output', null, secsShort(t1));
    const seek = (t) => { try { vid.currentTime = t; } catch { /* not loaded */ } };
    const trim = full > 0.3 ? h('div', { class: 'trim' },
      field(h('span', null, 'Start at ', outS), h('input', { type: 'range', class: 'range', min: 0, max: full, step: 0.05, value: t0, 'aria-label': 'Clip start',
        oninput: (e) => { let v = +e.target.value; const end = m.end != null ? +m.end : full; if (v > end - 0.2) { v = Math.max(0, end - 0.2); e.target.value = v; } outS.textContent = secsShort(v); seek(v); mutate(() => { m.start = v; }, { coalesce: 'ts-' + s.id, render: 'rail' }); } })),
      field(h('span', null, 'End at ', outE), h('input', { type: 'range', class: 'range', min: 0, max: full, step: 0.05, value: t1, 'aria-label': 'Clip end',
        oninput: (e) => { let v = +e.target.value; const st = +m.start || 0; if (v < st + 0.2) { v = Math.min(full, st + 0.2); e.target.value = v; } outE.textContent = secsShort(v); seek(v); mutate(() => { m.end = v >= full - 0.02 ? null : v; }, { coalesce: 'te-' + s.id, render: 'rail' }); } })),
      (t0 > 0.05 || t1 < full - 0.05) ? h('button', { class: 'link-btn', type: 'button', onclick: () => mutate(() => { m.start = 0; m.end = null; }) }, 'Undo trim') : null) : null;
    return group('move', 'Movement video', summary, false,
      vid, trim,
      blocked ? help('Video can’t be blurred, so this clip is left out because the step has blurred areas.')
        : help(s.play === 'auto' ? 'Plays automatically, then the next step appears.' : 'Plays after the viewer clicks, then the next step appears.'),
      h('div', { class: 'row' },
        h('label', { class: 'check', style: { flex: 1 } }, h('input', { type: 'checkbox', checked: m.play !== false, onchange: (e) => mutate(() => { m.play = e.target.checked; }, { render: 'rail' }) }), h('span', null, 'Play in the demo')),
        h('button', { class: 'link-btn danger', type: 'button', onclick: () => mutate(() => { delete s.motion; }) }, 'Delete clip')));
  }

  const ANNO_NAMES = { box: 'Box', arrow: 'Arrow', label: 'Label' };
  function annoGroup(s) {
    const list = s.annotations || [];
    const startTool = (t) => { tool = t; selBlur = null; renderCanvas(); };
    const colorRow = (cur, pick, label) => h('div', { class: 'swatches swatches-sm', role: 'group', 'aria-label': label },
      ANNO_COLORS.map((c) => h('button', { class: 'swatch', type: 'button', style: { background: c }, 'aria-label': c, 'aria-pressed': String(cur === c), onclick: () => pick(c) })));
    return group('anno', 'Annotations', list.length ? `${list.length}` : 'None', false,
      help('Point things out with arrows, boxes and labels.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'aria-pressed': String(tool === 'arrow'), onclick: () => startTool('arrow') }, 'Arrow'),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'aria-pressed': String(tool === 'box'), onclick: () => startTool('box') }, 'Box'),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'aria-pressed': String(tool === 'label'), onclick: () => startTool('label') }, 'Label')),
      field('Colour for new ones', colorRow(annoColor, (c) => { annoColor = c; renderInspector(); if (TOOL_TEXT[tool]) renderCanvas(); }, 'Annotation colour')),
      list.length ? h('div', { class: 'anno-list' }, list.map((a) => h('div', { class: 'anno-item' + (selAnno === a.id ? ' sel' : '') },
        h('span', { class: 'anno-kind' }, h('i', { style: { background: a.color } }), ANNO_NAMES[a.kind]),
        a.kind === 'label' ? h('input', { id: 'anno-' + a.id, class: 'input input-sm grow', value: a.text || '', maxlength: 60, 'aria-label': 'Label text', oninput: (e) => { mutate(() => { a.text = e.target.value; }, { coalesce: 'at-' + a.id, render: 'none' }); refreshVis(s); } }) : h('span', { class: 'grow' }),
        h('select', { class: 'select select-sm', 'aria-label': 'Colour', onchange: (e) => mutate(() => { a.color = e.target.value; }, { render: 'canvas' }) },
          ANNO_COLORS.map((c, ci) => h('option', { value: c, selected: a.color === c }, ['Red', 'Amber', 'Indigo', 'Green', 'Black'][ci]))),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove', title: 'Remove', onclick: () => mutate(() => { s.annotations = s.annotations.filter((x) => x.id !== a.id); }) }, icon('trash', 15))))) : null);
  }

  function zoomGroup(s) {
    const z = s.zoom && s.zoom.scale > 1 ? s.zoom.scale : 1;
    return group('zoom', 'Zoom', z > 1 ? `${z}×` : 'Off', false,
      seg([[1, 'Off'], [1.5, '1.5×'], [2, '2×'], [2.5, '2.5×']], z, (v) => mutate(() => { s.zoom = v > 1 ? { scale: v } : null; }), 'Zoom level'),
      help(z > 1 ? 'The view glides in on the hotspot when this step appears. The dashed frame shows what viewers see.' : 'Glide in on the hotspot to draw the eye to small details.'));
  }

  function blurGroup(s) {
    const n = s.blurs.length;
    return group('blur', 'Blur', n ? `${n} area${n === 1 ? '' : 's'}` : 'None', false,
      help('Hide emails, names or numbers. Blur is permanent in exports.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { tool = 'blur'; renderCanvas(); } }, 'Draw a blur area'),
        n ? h('button', { class: 'link-btn danger', type: 'button', onclick: () => mutate(() => { s.blurs = []; }) }, 'Remove all') : null));
  }

  function textFields(s, { linkTitle = false, ai = false } = {}) {
    return [
      field('Title', h('input', { id: 'ch-title', class: 'input', value: s.title || '', oninput: (e) => mutate(() => { s.title = e.target.value; if (linkTitle) s.titleLinked = false; }, { coalesce: 'ct-' + s.id, render: 'canvas' }) })),
      linkTitle && s.titleLinked !== false ? help('Matches the demo name until you change it.') : null,
      field('Text', h('textarea', { id: 'ch-text', class: 'textarea', rows: 2, oninput: (e) => mutate(() => { s.text = e.target.value; }, { coalesce: 'cx-' + s.id, render: 'canvas' }) }, s.text || '')),
      ai ? aiButton('ai-' + s.id, 'Write with AI', async () => { const r = await writeStep(settings, demo, sel); mutate(() => { if (r.title) s.title = r.title; if (r.text) s.text = r.text; }); }) : null,
    ];
  }

  function playSwitch(s) {
    return h('div', { class: 'mode-switch' },
      seg([['click', 'Click to continue'], ['auto', 'Video only']], s.play === 'auto' ? 'auto' : 'click', (v) => mutate(() => {
        s.play = v;
        if (v === 'auto') { delete s.hotspotUnsure; if (s.hold == null) s.hold = 0.8; }
      }), 'How this step plays'));
  }

  const HOT_NAMES = { beacon: 'Pointer', area: 'Area', spotlight: 'Spotlight', none: 'Hidden' };
  const HOT_HELP = {
    beacon: 'A pulsing dot on the exact spot to click.',
    area: 'A pulsing outline around a region. Drag to move, drag the corner to resize.',
    spotlight: 'Dims everything except the highlighted box.',
    none: 'No hotspot. Viewers use the Next button.',
  };

  function renderStepInspector() {
    const s = step();
    if (!s) return;

    if (s.type === 'chapter') {
      const role = s.role;
      addToInspector(
        group('text', role === 'opening' ? 'Opening card' : role === 'closing' ? 'Closing card' : 'Section card', null, true, ...textFields(s, { linkTitle: role === 'opening', ai: !role })),
        group('choices', role ? 'Buttons' : 'Choices', `${s.buttons.length}`, true,
          role === 'closing' ? help('Link buttons stay hidden until their link is filled in.') : !role ? help('Two or more choices let viewers pick their own path.') : null,
          buttonsEditor(s, { chapter: true })),
        voiceGroup(s));
      return;
    }

    if (s.type === 'video') {
      addToInspector(
        group('cap', 'Video clip', fmtDur(s.dur), true,
          field('Caption', h('textarea', { id: 'tip-text', class: 'textarea', rows: 2, placeholder: 'Optional, shown under the video', oninput: (e) => mutate(() => { s.tooltip.text = e.target.value; }, { coalesce: 'cap-' + s.id, render: 'canvas' }) }, s.tooltip.text || '')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.autoNext !== false, onchange: (e) => mutate(() => { s.autoNext = e.target.checked; }, { render: 'none' }) }), h('span', null, 'Continue when the clip ends'))),
        group('click', 'After the clip', actionName(s.next), false, actionEditor(s.next || { type: 'next' }, (a, re) => mutate(() => { s.next = a; }, { coalesce: re ? null : 'nx-' + s.id, render: re ? 'all' : 'rail' }), s.id)),
        group('btn', 'Buttons', s.buttons.length ? `${s.buttons.length}` : 'None', false, buttonsEditor(s)),
        voiceGroup(s));
      return;
    }

    if (s.play === 'auto') {
      const playable = motionPlays(s);
      const holdOut = h('output', null, `${(+s.hold || 0).toFixed(1)} s`);
      addToInspector(playSwitch(s),
        group('timing', 'Timing', `${(+s.hold || 0).toFixed(1)} s`, true,
          field(h('span', null, 'Show the screenshot for ', holdOut),
            h('input', { type: 'range', min: 0, max: 5, step: 0.1, value: s.hold != null ? s.hold : 0.8, class: 'range', 'aria-label': 'Seconds before the movement plays',
              oninput: (e) => { holdOut.textContent = `${(+e.target.value).toFixed(1)} s`; mutate(() => { s.hold = +e.target.value; }, { coalesce: 'hold-' + s.id, render: 'rail' }); } })),
          help(playable ? `Then its ${secsShort(s.motion.dur)} movement video plays.` : 'No movement video here, so it shows for at least 2.5 s.')),
        group('cap', 'Caption', s.caption ? 'On' : 'Off', false,
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s.caption, onchange: (e) => mutate(() => { s.caption = e.target.checked; }) }), h('span', null, 'Show a caption')),
          s.caption ? h('textarea', { id: 'tip-text', class: 'textarea', rows: 2, 'aria-label': 'Caption text', placeholder: 'Shown at the bottom', oninput: (e) => mutate(() => { s.tooltip.text = e.target.value; }, { coalesce: 'tip-' + s.id, render: 'canvas' }) }, s.tooltip.text || '') : null),
        zoomGroup(s), annoGroup(s), motionGroup(s), blurGroup(s), voiceGroup(s));
      return;
    }

    const ta = h('textarea', { id: 'tip-text', class: 'textarea', rows: 3, placeholder: 'What should the viewer click, and why?', oninput: (e) => mutate(() => { s.tooltip.text = e.target.value; }, { coalesce: 'tip-' + s.id, render: 'canvas' }) }, s.tooltip.text || '');
    const pos = h('select', { class: 'select select-sm', 'aria-label': 'Tooltip position', onchange: (e) => mutate(() => { s.tooltip.placement = e.target.value; }, { render: 'canvas' }) },
      [['auto', 'Auto'], ['top', 'Above'], ['bottom', 'Below'], ['left', 'Left'], ['right', 'Right']].map(([v, l]) => h('option', { value: v, selected: (s.tooltip.placement || 'auto') === v }, l)));
    addToInspector(
      playSwitch(s),
      group('tip', 'Tooltip', null, true, ta,
        h('div', { class: 'row between' },
          aiButton('ai-' + s.id, 'Write with AI', async () => { const t = await writeStep(settings, demo, sel); if (t) mutate(() => { s.tooltip.text = t; }); }),
          h('label', { class: 'inline-label' }, 'Position', pos))),
      group('hot', 'Hotspot', HOT_NAMES[s.hotspot.style] || 'Pointer', true,
        s.hotspotUnsure ? h('p', { class: 'hint hint-warn' }, 'Placed automatically. Drag it onto the right spot, or double-click there.') : null,
        seg([['beacon', 'Pointer'], ['area', 'Area'], ['spotlight', 'Spotlight'], ['none', 'Hidden']], s.hotspot.style, (v) => mutate(() => {
          delete s.hotspotUnsure;
          s.hotspot.style = v;
          const r0 = s.highlight;
          const covers = r0 && s.hotspot.x >= r0.x && s.hotspot.x <= r0.x + r0.w && s.hotspot.y >= r0.y && s.hotspot.y <= r0.y + r0.h && r0.w > 0.03 && r0.h > 0.03 && r0.w <= 0.5 && r0.h <= 0.5;
          if ((v === 'spotlight' || v === 'area') && !covers) s.highlight = { x: clamp(s.hotspot.x - 0.09, 0, 0.82), y: clamp(s.hotspot.y - 0.04, 0, 0.92), w: 0.18, h: 0.08 };
          if (v === 'spotlight' || v === 'area') { s.hotspot.x = s.highlight.x + s.highlight.w / 2; s.hotspot.y = s.highlight.y + s.highlight.h / 2; }
        }), 'Hotspot style'),
        help(HOT_HELP[s.hotspot.style] || '')),
      group('click', 'When clicked', actionName(s.next), false,
        actionEditor(s.next || { type: 'next' }, (a, re) => mutate(() => { s.next = a; }, { coalesce: re ? null : 'nx-' + s.id, render: re ? 'all' : 'rail' }), s.id)),
      group('btn', 'Buttons', s.buttons.length ? `${s.buttons.length}` : 'None', false,
        s.buttons.length ? null : help('Add a call to action or a branch, like “Book a demo”.'),
        buttonsEditor(s)),
      zoomGroup(s), annoGroup(s), motionGroup(s), blurGroup(s), voiceGroup(s),
      (s.pageUrl || s.element) ? group('info', 'Recorded page', null, false, h('dl', { class: 'kv' },
        s.pageTitle ? [h('dt', null, 'Page'), h('dd', { title: s.pageTitle }, s.pageTitle)] : null,
        s.pageUrl ? [h('dt', null, 'Address'), h('dd', { title: s.pageUrl }, s.pageUrl)] : null,
        s.element && s.element.label ? [h('dt', null, s.action === 'type' ? 'Field' : 'Clicked'), h('dd', { title: s.element.label }, s.element.label)] : null,
        s.typed ? [h('dt', null, 'Typed'), h('dd', null, s.typed)] : null)) : null);
  }

  function renderDemoInspector() {
    const t = demo.theme, st = demo.settings;
    const swatches = (list, cur, onPick, label) => h('div', { class: 'swatches', role: 'group', 'aria-label': label },
      list.map((c) => h('button', { class: 'swatch', type: 'button', style: { background: c }, 'aria-label': c, 'aria-pressed': String(cur.toLowerCase() === c.toLowerCase()), onclick: () => onPick(c) })),
      h('label', { class: 'swatch swatch-custom', title: 'Custom colour', 'aria-pressed': String(!list.some((c) => c.toLowerCase() === cur.toLowerCase())) },
        h('input', { type: 'color', value: cur, 'aria-label': 'Custom colour', onchange: (e) => onPick(e.target.value) })));
    const chk = (label, val, set) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: val, onchange: (e) => mutate(() => set(e.target.checked)) }), h('span', null, label));
    const screens = demo.steps.filter((x) => x.type === 'screen');
    const autoN = screens.filter((x) => x.play === 'auto').length;
    const playLabel = !screens.length ? '' : autoN === screens.length ? 'Video only' : autoN ? 'Mixed' : 'Click-through';
    const op = demo.steps.findIndex((x) => x.role === 'opening');
    const cl = demo.steps.findIndex((x) => x.role === 'closing');
    const themeOn = (th) => th.accent.toLowerCase() === (t.accent || '').toLowerCase() && th.tooltipBg.toLowerCase() === (t.tooltipBg || '').toLowerCase() && th.hotspot.toLowerCase() === (t.hotspot || '').toLowerCase();
    addToInspector(
      group('d-brand', 'Branding', demo.brand.logoId ? 'Logo added' : null, true,
        field('Ready-made looks', h('div', { class: 'themes' }, THEMES.map((th) => h('button', { class: 'theme-chip', type: 'button', 'aria-pressed': String(themeOn(th)), title: th.name,
          onclick: () => mutate(() => { Object.assign(t, { accent: th.accent, hotspot: th.hotspot, tooltipBg: th.tooltipBg, tooltipText: th.tooltipText, radius: th.radius }); }) },
          h('span', { class: 'theme-sw', style: { background: `linear-gradient(135deg, ${th.accent} 0 50%, ${th.tooltipBg} 50% 100%)`, boxShadow: `inset 0 0 0 2px ${th.hotspot}` } }), th.name)))),
        logoField(),
        field('Font', h('select', { class: 'select', 'aria-label': 'Font', onchange: (e) => mutate(() => { t.font = e.target.value; }) },
          FONTS.map((f) => h('option', { value: f.value, selected: (t.font || '') === f.value }, f.name))))),
      group('d-look', 'Colours and style', null, false,
        field('Brand colour', swatches(ACCENTS, t.accent, (c) => mutate(() => { t.accent = c; }), 'Brand colour')),
        field('Hotspot colour', swatches(HOTS, t.hotspot, (c) => mutate(() => { t.hotspot = c; }), 'Hotspot colour')),
        field('Corners', seg([[4, 'Sharp'], [12, 'Soft'], [20, 'Round']], t.radius, (v) => mutate(() => { t.radius = v; }), 'Corner style')),
        field('Tooltips', seg([['light', 'Light'], ['dark', 'Dark']], t.tooltipBg === '#17211E' ? 'dark' : 'light', (v) => mutate(() => {
          if (v === 'dark') { t.tooltipBg = '#17211E'; t.tooltipText = '#F3F5F4'; } else { t.tooltipBg = '#FFFFFF'; t.tooltipText = '#1D2433'; }
        }), 'Tooltip theme'))),
      group('d-play', 'How it plays', playLabel, false,
        help(autoN === screens.length && screens.length ? 'Every step plays by itself, like a video.' : autoN ? `${autoN} of ${screens.length} steps play by themselves.` : 'Viewers click through every step.'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: !screens.length || autoN === screens.length, onclick: () => {
            mutate(() => { for (const x of screens) { x.play = 'auto'; delete x.hotspotUnsure; if (x.hold == null) x.hold = 0.8; } });
            toast('Every step now plays by itself', { kind: 'ok', action: { label: 'Undo', run: undo } });
          } }, 'Make all video only'),
          h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: !autoN, onclick: () => {
            mutate(() => { for (const x of screens) x.play = 'click'; });
            toast('Clicks are back on every step', { kind: 'ok', action: { label: 'Undo', run: undo } });
          } }, 'Make all click-through'))),
      group('d-cards', 'Opening and closing', [op >= 0 ? 'Opening' : null, cl >= 0 ? 'Closing' : null].filter(Boolean).join(' + ') || 'None', false,
        h('div', { class: 'row wrap' },
          op >= 0 ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { tab = 'step'; select(op); } }, 'Edit opening')
            : h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => mutate(() => { demo.steps.unshift(newOpeningCard(demo)); sel = 0; tab = 'step'; }) }, 'Add opening card'),
          cl >= 0 ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { tab = 'step'; select(cl); } }, 'Edit closing')
            : h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => mutate(() => { demo.steps.push(newClosingCard()); sel = demo.steps.length - 1; tab = 'step'; }) }, 'Add closing card'))),
      fullRecordingGroup(),
      group('d-player', 'Player controls', null, false,
        chk('Progress bar', st.showProgress !== false, (v) => { st.showProgress = v; }),
        chk('Step counter (“3 of 12”)', st.showStepCount !== false, (v) => { st.showStepCount = v; }),
        chk('Back button', st.showBack !== false, (v) => { st.showBack = v; })),
      group('d-voice', 'Voiceover', ({ off: 'Off', browser: 'Browser voice', audio: 'Generated' })[st.voice] || 'Off', false,
        seg([['off', 'Off'], ['browser', 'Browser'], ['audio', 'Generated']], st.voice, (v) => mutate(() => { st.voice = v; }), 'Voiceover mode'),
        help(st.voice === 'off' ? 'Viewers read the text.' : st.voice === 'browser' ? 'Free. Uses the viewer’s built-in voice.' : 'Studio-quality audio from your voice provider.'),
        st.voice !== 'off' ? chk('Move on after each voiceover', !!st.autoAdvance, (v) => { st.autoAdvance = v; }) : null,
        st.voice === 'audio' ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: !!busy.allVoice, onclick: generateAllVoices }, busy.allVoice ? [h('span', { class: 'spin' }), 'Generating…'] : 'Generate all voiceovers') : null),
      musicGroup(),
      gateGroup(),
      group('d-ai', 'AI writing', aiReady(settings) ? 'On' : 'Not set up', false,
        aiReady(settings) ? null : help('Add an Anthropic or OpenAI key in Settings to draft text from your screenshots.'),
        h('div', { class: 'row wrap' },
          aiButton('allText', 'Write every tooltip', writeAll),
          aiButton('title', 'Suggest a name', async () => { const tt = await writeTitle(settings, demo); if (tt) { mutate(() => { demo.title = tt; }, { render: 'none' }); titleInput.value = tt; toast('Name updated', { kind: 'ok' }); } })),
        translateRow()));
  }

  /* ----- Branding, music, lead form, translation ----- */
  function logoField() {
    const b = demo.brand;
    const pickFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true, onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const blob = await shrinkImage(f, 480);
        const id = uid('logo_');
        await db.putBlob(id, blob);
        mutate(() => { b.logoId = id; });
        toast('Logo added', { kind: 'ok' });
      } catch (err) { toast('That image couldn’t be read. Try a PNG or SVG.', { kind: 'error' }); }
    } });
    const prev = h('div', { class: 'logo-prev' });
    if (b.logoId) blobUrl(b.logoId).then((u) => { if (u) prev.append(h('img', { src: u, alt: 'Your logo' })); });
    return field('Logo',
      b.logoId ? h('div', { class: 'stack' },
        h('div', { class: 'logo-row' }, prev,
          h('div', { class: 'stack' },
            h('button', { class: 'link-btn', type: 'button', onclick: () => pickFile.click() }, 'Replace'),
            h('button', { class: 'link-btn danger', type: 'button', onclick: () => mutate(() => { b.logoId = null; }) }, 'Remove'))),
        seg([['tl', 'Top left'], ['bl', 'Bottom left'], ['br', 'Bottom right']], b.position || 'tl', (v) => mutate(() => { b.position = v; }), 'Logo position'))
        : h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => pickFile.click() }, 'Upload a logo'),
      pickFile,
      b.logoId ? null : help('Shown in a corner of every step. PNG or SVG with a transparent background looks best.'));
  }

  function musicGroup() {
    const m = demo.music;
    const pick = h('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) { toast('That file is over 15 MB. Pick a shorter or more compressed track.', { kind: 'error' }); return; }
      const id = uid('mus_');
      await db.putBlob(id, f.slice(0, f.size, f.type || 'audio/mpeg'));
      mutate(() => { demo.music = { audioId: id, name: f.name, volume: m && m.volume != null ? m.volume : 0.25 }; });
    } });
    if (!m || !m.audioId) {
      return group('d-music', 'Background music', 'None', false,
        help('A quiet track that loops under the demo and its video exports. Use music you have the rights to.'),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => pick.click() }, 'Choose an audio file'), pick);
    }
    const volOut = h('output', null, `${Math.round((m.volume != null ? m.volume : 0.25) * 100)}%`);
    let audio = null;
    return group('d-music', 'Background music', 'On', false,
      h('div', { class: 'row' }, h('span', { class: 'file-name grow', title: m.name }, m.name || 'Audio track'),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async (e) => {
          if (audio && !audio.paused) { audio.pause(); e.currentTarget.textContent = 'Play'; return; }
          audio = new Audio(await blobUrl(m.audioId)); audio.volume = m.volume != null ? m.volume : 0.25; audio.play(); e.currentTarget.textContent = 'Stop';
        } }, 'Play')),
      field(h('span', null, 'Volume ', volOut), h('input', { type: 'range', class: 'range', min: 0.05, max: 1, step: 0.05, value: m.volume != null ? m.volume : 0.25, 'aria-label': 'Music volume',
        oninput: (e) => { const v = +e.target.value; volOut.textContent = `${Math.round(v * 100)}%`; if (audio) audio.volume = v; mutate(() => { m.volume = v; }, { coalesce: 'mv', render: 'none' }); } })),
      h('div', { class: 'row' },
        h('button', { class: 'link-btn', type: 'button', onclick: () => pick.click() }, 'Replace'),
        h('button', { class: 'link-btn danger', type: 'button', onclick: () => { if (audio) audio.pause(); mutate(() => { demo.music = null; }); } }, 'Remove')), pick);
  }

  function gateGroup() {
    const g = demo.gate;
    const txt = (label, key, ph, type = 'text') => field(label, h('input', { class: 'input', type, value: g[key] || '', placeholder: ph, oninput: (e) => mutate(() => { g[key] = e.target.value; }, { coalesce: 'g-' + key, render: 'none' }) }));
    const chk = (label, key) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!g[key], onchange: (e) => mutate(() => { g[key] = e.target.checked; }) }), h('span', null, label));
    return group('d-gate', 'Lead form', g.enabled ? 'On' : 'Off', false,
      chk('Ask for an email before the demo starts', 'enabled'),
      g.enabled ? [
        txt('Heading', 'title', demo.title || 'Interactive demo'),
        txt('Message', 'text', 'Enter your email to watch the demo.'),
        chk('Also ask for a name', 'askName'),
        chk('Also ask for a company', 'askCompany'),
        txt('Button', 'button', 'Start the demo'),
        txt('Send each sign-up to (webhook)', 'webhook', 'https://hooks.zapier.com/…', 'url'),
        help('Each sign-up is posted as JSON to this address. Zapier, Make, Google Apps Script and most form tools can receive it and add it to a sheet or CRM.'),
        txt('Small print (optional)', 'privacy', 'We’ll only use this to follow up about the demo.'),
        help('People who already signed up skip the form next time.'),
      ] : help('Turn this on for sales demos to collect who watched.'));
  }

  const LANGS = ['Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Polish', 'Turkish', 'Arabic', 'Persian', 'Hindi', 'Japanese', 'Korean', 'Chinese (Simplified)'];
  function translateRow() {
    const sl = h('select', { class: 'select select-sm', 'aria-label': 'Language' }, LANGS.map((l) => h('option', { value: l }, l)));
    return h('div', { class: 'translate' },
      h('span', { class: 'field-label' }, 'Translate'),
      h('div', { class: 'row' }, sl, aiButton('translate', 'Make a translated copy', () => translateCopy(sl.value))));
  }

  async function translateCopy(lang) {
    await persist.flush();
    const copy = JSON.parse(JSON.stringify(demo));
    copy.id = newDemo().id;
    copy.createdAt = copy.updatedAt = Date.now();
    copy.published = null;
    const slots = [];
    const add = (obj, key) => { if (obj && typeof obj[key] === 'string' && obj[key].trim()) slots.push([obj, key]); };
    add(copy, 'title');
    for (const st of copy.steps) {
      add(st, 'title'); add(st, 'text');
      if (st.tooltip) add(st.tooltip, 'text');
      if (st.voice) { add(st.voice, 'text'); st.voice.audioId = null; st.voice.audioText = ''; }
      (st.buttons || []).forEach((b) => add(b, 'label'));
      (st.annotations || []).forEach((a) => add(a, 'text'));
    }
    if (copy.gate) ['title', 'text', 'button', 'privacy'].forEach((k) => add(copy.gate, k));
    const out = await translateTexts(settings, slots.map(([o, k]) => o[k]), lang);
    slots.forEach(([o, k], i) => { o[k] = out[i]; });
    copy.title = `${copy.title} (${lang})`;
    for (const st of copy.steps) if (st.role === 'opening') st.titleLinked = false;
    await db.putDemo(copy);
    toast(`Made a ${lang} copy`, { kind: 'ok', timeout: 8000, action: { label: 'Open it', run: () => { location.hash = '#/edit/' + copy.id; } } });
  }

  // The continuous video of the whole recording session.
  function fullRecordingGroup() {
    const f = demo.full;
    if (!f || !f.videoId) return null;
    const vid = h('video', { class: 'motion-prev', muted: true, playsinline: true, controls: true, preload: 'metadata' });
    vid.muted = true;
    blobUrl(f.videoId).then((u) => { if (u) vid.src = u; });
    if (f.posterId) blobUrl(f.posterId).then((u) => { if (u) vid.poster = u; });
    return group('d-full', 'Full recording', fmtDur(f.dur), true,
      vid,
      help('Everything that happened on screen while you recorded, as one video.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: addFullAsStep }, 'Add to the demo'),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => {
          const blob = await db.getBlob(f.videoId);
          if (blob) downloadBlob(blob, `${slug(demo.title)}-full-recording.webm`);
        } }, 'Download'),
        h('button', { class: 'link-btn danger', type: 'button', onclick: async () => {
          const ok = await confirmDialog({ title: 'Delete the full recording?', text: 'The steps and their movement clips stay. Only the continuous video is removed.' });
          if (ok) mutate(() => { delete demo.full; });
        } }, 'Delete')));
  }

  function addFullAsStep() {
    const f = demo.full;
    const st = newVideoStep({ videoId: f.videoId, imageId: f.posterId, imgW: f.w, imgH: f.h, dur: f.dur, autoNext: true });
    insertSteps(demo.steps.findIndex((x) => x.role === 'closing') >= 0 ? demo.steps.findIndex((x) => x.role === 'closing') : demo.steps.length, [st], 'video');
    tab = 'step'; renderInspector();
  }

  async function writeAll() {
    const ok = await confirmDialog({ title: 'Rewrite every tooltip?', text: 'AI will draft new text for all steps from their screenshots, replacing what’s there. You can undo afterwards.', confirm: 'Write all', kind: 'btn-primary' });
    if (!ok) return;
    undoStack.push(JSON.stringify(demo)); redoStack.length = 0; lastCoalesce = null;
    let done = 0;
    for (let i = 0; i < demo.steps.length; i++) {
      saveState.textContent = `Writing ${i + 1} of ${demo.steps.length}…`;
      const r = await writeStep(settings, demo, i);
      const s = demo.steps[i];
      if (s.type === 'chapter') { if (r.title) s.title = r.title; if (r.text) s.text = r.text; }
      else if (r) s.tooltip.text = r;
      done++;
      renderRail(); if (i === sel) renderCanvas();
    }
    dirty(); renderAll(); updateUndo();
    toast(`Wrote ${done} tooltip${done === 1 ? '' : 's'}`, { kind: 'ok', action: { label: 'Undo', run: undo } });
  }

  async function generateAllVoices() {
    if (!ttsReady(settings)) {
      toast('Add a voice provider key in Settings to generate audio.', { action: { label: 'Open Settings', run: () => { persist.flush(); location.hash = '#/settings/voice'; } }, timeout: 6000 });
      return;
    }
    busy.allVoice = true; renderInspector();
    let n = 0;
    try {
      for (const s of demo.steps) {
        if (voiceIsFresh(s)) continue;
        const text = stepVoiceText(s);
        if (!text) continue;
        saveState.textContent = `Recording voice ${n + 1}…`;
        const blob = await synthesize(settings, text);
        const id = uid('aud_');
        await db.putBlob(id, blob);
        s.voice.audioId = id; s.voice.audioText = text;
        n++;
      }
      dirty();
      toast(n ? `Generated ${n} voiceover${n === 1 ? '' : 's'}` : 'All voiceovers are already up to date', { kind: 'ok' });
    } catch (e) { toast(e.message, { kind: 'error', timeout: 7000 }); dirty(); }
    finally { delete busy.allVoice; renderInspector(); }
  }

  function renderInspector() {
    const scroll = inspBody.scrollTop;
    renderTabs();
    inspBody.replaceChildren();
    if (tab === 'step') renderStepInspector(); else renderDemoInspector();
    inspBody.scrollTop = scroll;
  }

  function renderAll() {
    renderRail();
    renderCanvas();
    renderInspector();
  }

  /* ---------- preview ---------- */
  async function openPreview() {
    await persist.flush();
    const { data } = await packDemo(demo, { mode: 'blob' });
    const holder = h('div', { style: { width: '100%', height: '100%' } });
    const stage = h('div', { class: 'preview-stage' }, holder);
    let player;
    const mount = () => { if (player) player.destroy(); player = TP().mount(holder, data, { fit: 'contain', globalKeys: true, startStep: demo.steps[sel] && demo.steps[sel].id, skipStart: false }); };
    const dev = (key, label) => h('button', { type: 'button', 'aria-pressed': String(key === 'desktop'), onclick: (e) => {
      ov.querySelectorAll('.devices button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      e.currentTarget.setAttribute('aria-pressed', 'true');
      stage.classList.toggle('mobile', key === 'mobile');
      mount();
    } }, label);
    const close = () => { if (player) player.destroy(); ov.remove(); document.removeEventListener('keydown', onKey, true); data.steps.forEach((s) => { if (s.image) URL.revokeObjectURL(s.image); if (s.voice && s.voice.audio) URL.revokeObjectURL(s.voice.audio); }); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const ov = h('div', { class: 'preview', role: 'dialog', 'aria-label': 'Preview' },
      h('div', { class: 'preview-top' },
        h('span', { class: 't' }, 'Preview: ', demo.title),
        h('div', { class: 'devices', role: 'group', 'aria-label': 'Screen size' }, dev('desktop', 'Desktop'), dev('mobile', 'Mobile')),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: close }, 'Close preview')),
      stage);
    document.body.append(ov);
    document.addEventListener('keydown', onKey, true);
    mount();
    setTimeout(() => { const r = holder.querySelector('.tmp-root'); if (r) r.focus(); }, 50);
  }

  /* ---------- layout + keys ---------- */
  root.append(h('div', { class: 'editor' }, top, rail, stageWrap, insp));
  renderAll();
  updateUndo();
  const ro = new ResizeObserver(() => sizeCanvas());
  ro.observe(area);

  const onKey = (e) => {
    if (document.querySelector('.modal-back, .preview')) return;
    const inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { if (inField && e.target.tagName !== 'INPUT' && !e.target.isContentEditable) return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (inField) return;
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateStep(sel); return; }
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === 'ArrowRight' && !e.target.closest('.tmp-beacon'))) { e.preventDefault(); select(Math.min(demo.steps.length - 1, sel + 1)); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp' || (e.key === 'ArrowLeft' && !e.target.closest('.tmp-beacon'))) { e.preventDefault(); select(Math.max(0, sel - 1)); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selBlur) { e.preventDefault(); removeBlur(step(), selBlur); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selAnno && step() && step().annotations) { e.preventDefault(); const id = selAnno; selAnno = null; mutate(() => { step().annotations = step().annotations.filter((x) => x.id !== id); }); }
    else if (!mod && step() && step().type === 'screen' && e.key.toLowerCase() === 'b') {
      tool = tool === 'blur' ? 'select' : 'blur'; selBlur = null; renderCanvas();
    } else if (e.key === 'Escape' && tool !== 'select') { tool = 'select'; renderCanvas(); }
  };
  document.addEventListener('keydown', onKey);
  const onSettings = async () => { settings = await loadSettings(); renderInspector(); };
  window.addEventListener('trailmark-settings', onSettings);
  const beforeUnload = () => persist.flush();
  window.addEventListener('beforeunload', beforeUnload);

  return () => {
    persist.flush();
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('trailmark-settings', onSettings);
    window.removeEventListener('beforeunload', beforeUnload);
    collectGarbage().catch(() => {});
  };
}

function clamp(v, lo = 0, hi = 1) { return Math.min(hi, Math.max(lo, v)); }
function secsShort(n) { n = Math.max(0.1, n || 0); return n < 10 ? `${n.toFixed(1)} s` : `${Math.round(n)} s`; }
function secs(n) { n = Math.max(0.1, n || 0); return n < 10 ? `${n.toFixed(1)} seconds` : `${Math.round(n)} seconds`; }
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

// Fill in fields added after a demo was created.
function migrate(demo) {
  demo.theme = { ...DEFAULT_THEME, ...(demo.theme || {}) };
  demo.settings = demo.settings || {};
  demo.settings.endScreen = { enabled: true, title: 'That’s the tour', text: '', ctaLabel: '', ctaUrl: '', showRestart: true, ...(demo.settings.endScreen || {}) };
  if (!demo.settings.voice) demo.settings.voice = 'off';
  demo.brand = { logoId: null, position: 'tl', name: '', ...(demo.brand || {}) };
  demo.gate = { enabled: false, title: '', text: 'Enter your email to watch the demo.', askName: false, askCompany: false, button: 'Start the demo', webhook: '', privacy: '', ...(demo.gate || {}) };
  for (const s of demo.steps) {
    s.buttons = s.buttons || [];
    s.voice = s.voice || { text: '', sameAsTooltip: true, audioId: null, audioText: '' };
    if (s.type === 'screen') {
      s.blurs = s.blurs || [];
      s.annotations = s.annotations || [];
      s.tooltip = s.tooltip || { text: '', placement: 'auto' };
      s.hotspot = s.hotspot || { x: 0.5, y: 0.5, style: 'beacon' };
      s.next = s.next || { type: 'next' };
    }
  }
}
