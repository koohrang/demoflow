import { detectHelper, watchHelper } from './helper.js';
import { helperSetupSteps } from './helper-ui.js';
import { h, icon, modal, toast } from './ui.js';
import { ScreenRecorder, ClipRecorder, screenRecordingSupported, videoRecordingSupported } from './recorder.js';

const CTRL_CSS = `
*{box-sizing:border-box}
body{margin:0;font:500 14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#1E2A4A;color:#fff}
.c{display:grid;gap:10px;padding:14px}
.top{display:flex;align-items:center;gap:9px}
.dot{width:10px;height:10px;border-radius:50%;background:#FF4D4D;box-shadow:0 0 0 3px rgba(255,77,77,.25);flex:none;animation:p 1.6s infinite}
@keyframes p{50%{opacity:.45}}
.st{font-weight:600;flex:1}
.n{min-width:26px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.14);text-align:center;font-variant-numeric:tabular-nums}
.n.bump{background:#FFB21A;color:#1E2A4A}
.v{padding:3px 8px;border-radius:999px;background:rgba(124,118,255,.3);color:#E0E3FB;font-size:12px;font-variant-numeric:tabular-nums}
.hint{color:rgba(207,214,234,.85);font-size:12.5px;font-weight:400}
.row{display:flex;gap:6px}
button{flex:1;border:0;border-radius:9px;padding:9px 10px;font:600 13px/1 inherit;font-family:inherit;cursor:pointer;color:#fff;background:rgba(255,255,255,.12)}
button:hover{background:rgba(255,255,255,.2)}
button.fin{background:#FFB21A;color:#1E2A4A}
button.fin:hover{background:#FFC54D}
button.x{flex:0 0 auto;color:rgba(255,255,255,.7)}
button:focus-visible{outline:2px solid #FFB21A;outline-offset:2px}
@media (prefers-reduced-motion: reduce){.dot{animation:none}}`;

// Recording controls, rendered into this tab and (when possible) a floating window.
function controls(doc, { label, hint, count, extra, buttons }) {
  const el = (tag, cls, txt) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const wrap = el('div', 'c');
  const top = el('div', 'top');
  const n = el('span', 'n', count());
  const x = extra ? el('span', 'v', extra()) : null;
  top.append(el('span', 'dot'), el('span', 'st', label));
  if (x) top.append(x);
  top.append(n);
  const row = el('div', 'row');
  for (const b of buttons) {
    const btn = el('button', b.cls || null, b.text);
    if (b.title) { btn.title = b.title; btn.setAttribute('aria-label', b.title); }
    btn.onclick = b.run;
    row.append(btn);
  }
  wrap.append(top, el('div', 'hint', hint), row);
  return {
    root: wrap,
    update(bump) {
      n.textContent = count();
      if (x) x.textContent = extra();
      if (bump) { n.classList.add('bump'); setTimeout(() => n.classList.remove('bump'), 400); }
    },
  };
}

function needDesktop() {
  modal({ title: 'Recording needs a desktop browser', body: h('p', { class: 'modal-text' }, 'Open this file in Chrome, Edge or Firefox on a computer to record. You can still build a demo from screenshots with “Create from images”.'), actions: [{ label: 'OK', kind: 'btn-primary' }] });
}

let motionPref = true;
try { motionPref = localStorage.getItem('trailmark.motion') !== 'off'; } catch { /* storage blocked */ }

// Record clickable steps. New demo: onDone(demoId). Insert into a demo: onSteps(steps).
export function openRecordDialog({ onDone, onSteps }) {
  if (!screenRecordingSupported()) { needDesktop(); return; }
  const canVideo = videoRecordingSupported();
  const motion = h('input', { type: 'checkbox', checked: canVideo && motionPref, disabled: !canVideo });
  let style = 'click';
  const motionRow = h('label', { class: 'check check-card' }, motion,
    h('span', null, 'Also record on-screen movement as video',
      h('small', null, canVideo
        ? 'Page loads, menus and scrolling play as smooth video between steps.'
        : 'This browser can’t record video, so only screenshots will be captured.')));
  const pick = (v) => {
    style = v;
    styleBox.querySelectorAll('.opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    motionRow.hidden = v === 'auto' || trigger !== 'change';
  };
  const opt = (v, ic, title, sub) => h('button', { class: 'opt', type: 'button', dataset: { v }, 'aria-pressed': String(v === style), onclick: () => pick(v) }, icon(ic, 20), h('strong', null, title), h('small', null, sub));
  const styleBox = h('div', { class: 'opt-grid', style: { gridTemplateColumns: '1fr 1fr', marginBottom: '12px' } },
    opt('click', 'cursor', 'Click-through demo', 'Viewers click a hotspot on each step to move on.'),
    canVideo ? opt('auto', 'film', 'Video walkthrough', 'No clicks: plays your screens and movement by itself, like a video.') : null);
  // With the Click Helper, steps follow your clicks instead of every screen change.
  let triggerPref = '';
  try { triggerPref = localStorage.getItem('df.trigger') || ''; } catch { /* ignore */ }
  let hasHelper = false;
  const helperLine = h('div', { class: 'helper-line' }, h('span', { class: 'spin' }), 'Checking for the Click Helper…');
  const setup = h('div', { class: 'helper-setup', hidden: true },
    h('p', { class: 'modal-text' }, h('strong', null, 'One-time setup (about a minute): '), 'Chrome doesn’t let one tab see clicks in another, so Demoflow uses a small helper extension to turn your clicks into steps.'),
    helperSetupSteps());
  const triggerBox = h('div', { class: 'trigger-box', hidden: true });
  const drawTrigger = () => {
    const btn = (v, title, sub, disabled) => h('button', { type: 'button', class: 'trig', disabled: !!disabled, 'aria-pressed': String(trigger === v), onclick: () => { trigger = v; try { localStorage.setItem('df.trigger', v); } catch { /* ignore */ } drawTrigger(); } },
      h('strong', null, title), h('small', null, sub));
    motionRow.hidden = style === 'auto' || trigger !== 'change'; // movement is always recorded unless steps follow screen changes
    triggerBox.replaceChildren(
      h('span', { class: 'field-label' }, 'Make a new step'),
      h('div', { class: 'trig-grid' },
        btn('click', 'When I click', hasHelper ? 'Each click becomes a step. Moving, hovering and scrolling are smooth video in between.' : 'Needs the Click Helper (set it up above).', !hasHelper),
        btn('manual', 'When I press Capture step', 'Press it in the floating controls just before each click.'),
        btn('change', 'Whenever the screen changes', 'Every new screen becomes a step, even without a click. Hovering can add extra steps.')));
  };
  const showHelper = (on) => {
    hasHelper = on;
    helperLine.classList.toggle('on', on);
    helperLine.replaceChildren(icon(on ? 'check' : 'puzzle', 16), on
      ? h('span', null, h('strong', null, 'Click Helper is on. '), 'Every click you make becomes a step, with the hotspot exactly where you clicked.')
      : h('span', null, h('strong', null, 'Click Helper not installed. '), 'Without it, Demoflow can’t tell when you click, so steps are only made when you press Capture step.'));
    setup.hidden = on;
    if (on) trigger = triggerPref === 'change' ? 'change' : 'click';
    else if (trigger === 'click' || !trigger) trigger = triggerPref === 'change' ? 'change' : 'manual';
    triggerBox.hidden = false; drawTrigger();
  };
  let trigger = '';
  let stopWatch = null;
  detectHelper(700).then((on) => {
    showHelper(on);
    if (!on) stopWatch = watchHelper(() => { showHelper(true); toast('Click Helper found. Your clicks will become steps.', { kind: 'ok' }); });
  });
  const dlg = modal({
    title: onSteps ? 'Record steps here' : 'Record a demo',
    onClose: () => { if (stopWatch) stopWatch(); },
    body: h('div', null,
      h('ol', { class: 'trail', style: { marginTop: '6px' } },
        h('li', null, h('span', { class: 'n' }, '1'), h('div', null, h('strong', null, 'Open your app in another tab'))),
        h('li', null, h('span', { class: 'n' }, '2'), h('div', null, h('strong', null, 'Press Start, choose “Chrome Tab” and pick your app'), h('span', { class: 'd' }, 'Only that tab is recorded, never Demoflow’s controls or the rest of your screen.'))),
        h('li', null, h('span', { class: 'n' }, '3'), h('div', null, h('strong', null, 'Use your app at a relaxed pace'), h('span', { class: 'd' }, 'Steps are made the way you choose below. Everything in between is saved as smooth video.')))),
      h('span', { class: 'field-label', style: { display: 'block', margin: '4px 0 8px' } }, 'How should it play?'),
      styleBox,
      motionRow,
      helperLine,
      setup,
      triggerBox,
      h('p', { class: 'hint' }, 'Link opens a new tab? Click “Share this tab instead” at the top of it. Nothing is uploaded; everything stays on this computer.')),

    actions: [
      { label: 'Cancel', kind: 'btn-quiet' },
      { label: 'Start', kind: 'btn-blaze', close: false, run: async () => {
        motionPref = motion.checked;
        if (trigger === 'manual' || trigger === 'click') { try { localStorage.setItem('df.trigger', trigger); } catch { /* ignore */ } }
        try { localStorage.setItem('trailmark.motion', motionPref ? 'on' : 'off'); } catch { /* ignore */ }
        if (stopWatch) stopWatch();
        dlg.close();
        await beginSteps({ onDone, onSteps, motion: style === 'auto' || trigger !== 'change' ? true : motion.checked, auto: style === 'auto', trigger });
      } },
    ],
  });
}

// Record one continuous video clip. onStep(videoStep).
export function openClipDialog({ onStep }) {
  if (!screenRecordingSupported()) { needDesktop(); return; }
  if (!videoRecordingSupported()) { toast('This browser can’t record video. Use a current version of Chrome, Edge or Firefox.', { kind: 'error' }); return; }
  const dlg = modal({
    title: 'Record a video clip',
    body: h('div', null,
      h('p', { class: 'modal-text' }, 'Records everything that happens in the tab you share, as one video step. Good for animations, drag-and-drop, scrolling, or anything that’s easier to show than to click through.'),
      h('ol', { class: 'trail', style: { marginTop: '12px' } },
        h('li', null, h('span', { class: 'n' }, '1'), h('div', null, h('strong', null, 'Press Start and pick your app’s tab'), h('span', { class: 'd' }, 'Recording begins as soon as you share it.'))),
        h('li', null, h('span', { class: 'n' }, '2'), h('div', null, h('strong', null, 'Do the thing you want to show'), h('span', { class: 'd' }, 'Then press Stop, or use “Stop sharing” in Chrome’s bar.'))))),
    actions: [
      { label: 'Cancel', kind: 'btn-quiet' },
      { label: 'Start', kind: 'btn-blaze', close: false, run: async () => { dlg.close(); await beginClip(onStep); } },
    ],
  });
}

function startError(e, retry) {
  if (e && e.name === 'NotTabError') {
    modal({
      title: 'Pick a Chrome tab',
      body: h('div', null,
        h('p', { class: 'modal-text' }, e.surface === 'monitor'
          ? 'You picked your whole screen. That records everything, including Demoflow’s own controls, and makes the video less smooth.'
          : 'You picked a window. That records Demoflow’s own controls too, and Demoflow can’t follow your clicks.'),
        h('p', { class: 'modal-text' }, 'In Chrome’s sharing window, open the “Chrome Tab” section, pick the tab with your app, and press Share.')),
      actions: [{ label: 'Cancel', kind: 'btn-quiet' }, retry ? { label: 'Try again', kind: 'btn-blaze', run: retry } : null].filter(Boolean),
    });
    return;
  }
  if (e && e.name === 'NotAllowedError') toast('Screen sharing was cancelled, so recording didn’t start.');
  else toast(`Recording couldn’t start: ${e && e.message || e}`, { kind: 'error', timeout: 7000 });
}

// The recording had no clicks or captured steps: say why, plainly.
function noStepsHelp(trigger, skipped) {
  const body = trigger === 'click'
    ? (skipped
      ? 'Your clicks were seen, but they happened in a different tab from the one you shared. Share the same tab you click in (or use “Share this tab instead” in Chrome’s bar when a link opens a new tab).'
      : 'The Click Helper didn’t report any clicks from the tab you shared. Make sure you click inside that tab, and if you opened Demoflow from a file, turn on “Allow access to file URLs” for the Click Helper.')
    : 'In this mode a step is only made when you press Capture step in the floating controls, and it wasn’t pressed. To have every click become a step automatically, set up the Click Helper (Settings → Click Helper, about a minute, once).';
  modal({
    title: 'No steps were recorded',
    body: h('div', null, h('p', { class: 'modal-text' }, body), h('p', { class: 'modal-text' }, 'The video you recorded is kept in the demo, so nothing is lost.')),
    actions: [{ label: 'OK', kind: 'btn-primary' }],
  });
}

// Shared shell: in-page panel with preview, plus a floating controls window.
function recordingPanel(stream, spec) {
  let pip = null;
  const sets = [];
  const status = h('span', { class: 'status-line' });
  const popBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: () => openPip() }, icon('upload', 16), 'Pop out the controls');
  const inpage = controls(document, spec);
  sets.push(inpage);
  const host = h('div', { class: 'rec-ctrls' });
  const shadow = host.attachShadow({ mode: 'open' });
  const st = document.createElement('style');
  st.textContent = CTRL_CSS.replace('body{', ':host{display:block;border-radius:12px;overflow:hidden;');
  shadow.append(st, inpage.root);
  const mini = h('div', { class: 'rec-pill' }, h('span', { class: 'rec-dot-sm' }), 'Recording. Use the floating controls to capture steps or finish.');
  const panel = h('div', { class: 'rec-panel', role: 'dialog', 'aria-label': 'Recording' }, mini,
    h('div', { class: 'rec-card' }, host,
      h('p', { class: 'modal-text', style: { margin: '12px 0 10px' } }, 'Now switch to your app’s tab. ',
        window.documentPictureInPicture ? 'The small floating controls stay on top of it and are never recorded.' : 'Come back to this tab to finish, or use “Stop sharing” in Chrome’s bar.'),
      h('div', { class: 'row' }, window.documentPictureInPicture ? popBtn : null, status)));
  document.body.append(panel);

  async function openPip() {
    if (!window.documentPictureInPicture || pip) return;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: 340, height: 152 });
      const s2 = pip.document.createElement('style'); s2.textContent = CTRL_CSS;
      pip.document.head.append(s2);
      pip.document.title = 'Demoflow recording';
      const c = controls(pip.document, spec);
      sets.push(c);
      pip.document.body.append(c.root);
      pip.addEventListener('pagehide', () => { pip = null; sets.splice(sets.indexOf(c), 1); popBtn.hidden = false; panel.classList.remove('rec-mini'); });
      popBtn.hidden = true;
      panel.classList.add('rec-mini'); // the floating controls take over: no box in the middle
    } catch { popBtn.hidden = false; }
  }
  openPip(); // works if the Start click still counts as a user action

  return {
    update: (bump) => sets.forEach((c) => c.update(bump)),
    status: (t) => { status.textContent = t; },
    close() { panel.remove(); if (pip) { try { pip.close(); } catch { /* ignore */ } } },
  };
}

async function beginSteps({ onDone, onSteps, motion, auto, trigger = 'change' }) {
  const rec = new ScreenRecorder({ motion, trigger });
  try { await rec.start(); } catch (e) { startError(e, () => beginSteps({ onDone, onSteps, motion, auto, trigger })); return; }
  let ended = false;
  const finish = async () => {
    if (ended) return; ended = true;
    ui.status('Saving steps…');
    try {
      if (onSteps) {
        const steps = await rec.collectSteps({ finalStep: false, auto });
        const full = await rec.saveFull(steps);
        ui.close();
        if (!steps.length) { toast('No steps were captured.'); return; }
        onSteps(steps, full);
      } else {
        const id = await rec.finish({ auto });
        ui.close();
        if (!id) { toast('No steps were captured, so nothing was saved.'); return; }
        if (rec.explicit && rec.madeSteps === 0) {
          noStepsHelp(trigger, rec.skippedClicks);
          onDone(id);
          return;
        }
        toast(auto ? `Recorded ${rec.count} step${rec.count === 1 ? '' : 's'} as a video walkthrough. Press Preview to watch it.` : `Recorded ${rec.count} step${rec.count === 1 ? '' : 's'}. Drag any hotspot that’s off.`, { kind: 'ok', timeout: 6000 });
        onDone(id);
      }
      try { window.focus(); } catch { /* ignore */ }
    } catch (e) {
      ui.close();
      toast(`Saving the recording failed: ${e.message || e}`, { kind: 'error', timeout: 8000 });
    }
  };
  const discard = () => {
    if (ended) return;
    if (!confirm('Discard this recording?')) return;
    ended = true; rec.discard(); ui.close(); toast('Recording discarded');
  };
  const ui = recordingPanel(rec.stream, {
    label: 'Recording',
    hint: trigger === 'manual' ? 'Press Capture step just before each click.'
      : trigger === 'click' ? 'Each click makes a step. New tab? Use “Share this tab instead”.'
      : 'Link opened a new tab? Click “Share this tab instead” at the top of that tab.',
    count: () => `${rec.count}`,
    extra: rec.motion && trigger === 'change' ? () => `${rec.clips} clip${rec.clips === 1 ? '' : 's'}` : null,
    buttons: [
      { text: 'Capture step', run: () => { if (rec.captureNow()) ui.update(true); } },
      { text: 'Finish', cls: 'fin', run: finish },
      { text: '✕', cls: 'x', title: 'Discard recording', run: discard },
    ],
  });
  rec.onEnded = finish; // "Stop sharing" in Chrome's bar
  rec.onUpdate = () => ui.update(true);
  const tick = setInterval(() => { if (ended) clearInterval(tick); else ui.update(false); }, 700);
}

async function beginClip(onStep) {
  const rec = new ClipRecorder();
  try { await rec.start(); } catch (e) { startError(e); return; }
  let ended = false;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const finish = async () => {
    if (ended) return; ended = true;
    ui.status('Saving clip…');
    try {
      const step = await rec.finish();
      ui.close();
      if (!step) { toast('Nothing was recorded.'); return; }
      onStep(step);
      try { window.focus(); } catch { /* ignore */ }
    } catch (e) {
      ui.close();
      toast(`Saving the clip failed: ${e.message || e}`, { kind: 'error', timeout: 8000 });
    }
  };
  const discard = () => {
    if (ended) return;
    if (!confirm('Discard this clip?')) return;
    ended = true; rec.discard(); ui.close(); toast('Clip discarded');
  };
  const ui = recordingPanel(rec.stream, {
    label: 'Recording video',
    hint: 'Everything in the shared tab is being recorded.',
    count: () => fmt(rec.seconds),
    buttons: [
      { text: 'Stop and save', cls: 'fin', run: finish },
      { text: '✕', cls: 'x', title: 'Discard clip', run: discard },
    ],
  });
  rec.onEnded = finish;
  const tick = setInterval(() => { if (ended) clearInterval(tick); else ui.update(false); }, 500);
}
