// Screen-share recorder for the single-file app.
// The person shares the browser tab with their app. Demoflow watches the
// shared video: whenever the screen settles and then visibly changes (a click
// that opens a menu, a page load), the settled frame becomes a step and the
// hotspot goes where the change happened. "Capture step" adds one by hand.
//
// With movement recording on, the motion between two steps (page loads,
// menus opening, scrolling, animations) is also saved as a short video clip
// and played when the viewer clicks the hotspot.
import { db, uid } from './db.js';
import { newDemo, newScreenStep, newVideoStep, addCards, describeStep } from './model.js';
import { onHelperEvent, setHelperRecording } from './helper.js';
import { CaptureWorker, workerCaptureSupported } from './capture.js';

const SMALL_W = 160;          // analysis width
const PIX_DIFF = 16;          // grey-level difference that counts as changed (on a smoothly downscaled thumbnail)
const ANY_CHANGE = 0.0015;    // share of pixels: the screen is still moving
const STEP_CHANGE = 0.012;    // share of pixels: something happened, make a step
const SETTLE_MS = 600;        // quiet time before a screen counts as settled
const MAX_W = 1920;           // stored screenshot width cap
const ROTATE_MS = 700;        // standby recorders restart this often (pre-roll 0.7–1.4 s)

export function screenRecordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

export function videoRecordingSupported() {
  return !!(window.MediaRecorder && pickMime());
}

function pickMime() {
  if (!window.MediaRecorder) return '';
  for (const m of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

// A timer that keeps running at full speed while this tab is in the background.
function ticker(ms, fn) {
  try {
    const src = `const t = setInterval(() => postMessage(0), ${ms}); onmessage = () => clearInterval(t);`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = fn;
    return () => { w.terminate(); URL.revokeObjectURL(url); };
  } catch {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shareTab(frameRate) {
  return navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', frameRate: { ideal: frameRate, max: 30 }, cursor: 'always' },
    audio: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    preferCurrentTab: false,
  });
}

// Real length of a recorded clip. Tab capture only delivers frames when the
// page changes, so wall-clock time overstates it. MediaRecorder files often
// report an unknown duration until asked to seek to the end.
export function mediaDuration(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;
    const done = (d) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(Number.isFinite(d) && d > 0 ? d : 0); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) { done(v.duration); return; }
      v.ondurationchange = () => { if (Number.isFinite(v.duration) && v.duration > 0) done(v.duration); };
      try { v.currentTime = 1e101; } catch { done(0); }
    };
    v.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    v.src = url;
  });
}

function startMediaRecorder(stream, mime) {
  const r = { chunks: [], t0: performance.now() };
  r.mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  r.mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
  r.done = new Promise((resolve) => { r.mr.onstop = resolve; });
  r.mr.start(250);
  return r;
}
function stopMediaRecorder(r) {
  try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch { /* already stopped */ }
  return r.done;
}

export class ScreenRecorder {
  // trigger: 'change' = a new step whenever the screen settles on something new;
  //          'click'  = a new step only when you click (needs the Click Helper).
  constructor({ onUpdate, motion = true, full = true, trigger = 'change' } = {}) {
    this.trigger = trigger;
    this.full = full || trigger === 'click';
    this.onUpdate = onUpdate || (() => {});
    this.motion = motion && videoRecordingSupported();
    this.steps = [];          // committed: { small, w, h, hotspot, highlight, unsure, blobPromise, motion }
    this.prev = null;         // { small, bmp, t }
    this.cand = null;         // settled frame waiting for a change
    this.lastChangeAt = 0;
    this.lastChangeTs = 0;
    this.nFrames = 0;
    this.stopped = false;
    this.finishing = false;
    this.moving = false;
    this.warm = [];           // standby recorders (motion mode)
    this.active = null;       // the movement being captured right now
    this.clipJobs = [];
    this.protect = new Set(); // clip start times still being cut (codec mode)
    this.clicks = [];         // exact clicks from the Click Helper extension
    this.changeStartAt = 0;
  }

  _onHelper(ev) {
    if (this.stopped || this.finishing || !ev || typeof ev.t !== 'number') return;
    const c = { ...ev, pt: performance.now() - (Date.now() - ev.t) };
    this.clicks.push(c);
    if (this.trigger === 'click' && c.kind === 'click') this._clickStep(c);
  }

  // Frame timestamps (µs) and performance.now() (ms) run on different clocks.
  _tsAt(pt) { return this.tsOff == null ? null : (pt + this.tsOff) * 1000; }

  // Click mode: the screen as it was when you clicked becomes a step.
  _clickStep(c) {
    if (this.surface !== 'browser') return;
    const s = this.track && this.track.getSettings ? this.track.getSettings() : {};
    if (s.width && s.height && c.vw && c.vh && Math.abs(c.vw / c.vh - s.width / s.height) / (s.width / s.height) > 0.04) return; // a click in another tab
    const last = this.steps[this.steps.length - 1];
    if (last && last.click && c.pt - last.click.pt < 400) return; // double-click
    const frame = this.prev || this.latest;
    if (!frame) return;
    const step = { small: frame.small, unsure: false, hotspot: { x: c.x, y: c.y }, highlight: null, click: c, clickTs: this._tsAt(c.pt), frameT: c.pt, leftAt: c.pt };
    const b = c.box;
    if (b && b.w > 0.004 && b.h > 0.004 && b.w * b.h < 0.2) step.highlight = { x: Math.max(0, b.x - 0.004), y: Math.max(0, b.y - 0.004), w: Math.min(1, b.w + 0.008), h: Math.min(1, b.h + 0.008) };
    // Worker mode: a snapshot of the newest frame, which is still the screen before the click.
    step.shot = this.cw ? this._shot({}) : this._shot(frame);
    this.steps.push(step);
    this.onUpdate(this);
  }

  async start() {
    this.stream = await shareTab(this.motion ? 30 : 10);
    this.track = this.stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => { if (!this.stopped && this.onEnded) this.onEnded(); });
    try { this.surface = (this.track.getSettings() || {}).displaySurface || ''; } catch { this.surface = ''; }
    this.offHelper = onHelperEvent((ev) => this._onHelper(ev));
    setHelperRecording(true);
    // Preferred: a worker reads, encodes and samples frames off the page's thread.
    if (workerCaptureSupported()) {
      try {
        this.cw = new CaptureWorker();
        this.cw.onFrame = (bmp, ts) => this._enqueue(async () => ({ bmp, ts }), () => bmp.close());
        // keepAll: hold on to every frame so the whole session can be saved as one video.
        const codec = await this.cw.start(this.track, { encode: this.motion, analyse: true, analyseEveryMs: 120, keepAll: this.motion && this.full });
        this.encoding = this.motion && !!codec;
        this.codec = codec;
      } catch (e) {
        console.warn('Trailmark capture worker', e);
        this.cw = null;
      }
    }
    if (this.motion && !this.encoding) {
      // Fallback for browsers without WebCodecs: short MediaRecorder clips.
      this.mime = pickMime();
      this._rotate();
      this.rotTimer = setInterval(() => this._rotate(), ROTATE_MS);
    }
    this.stopTick = ticker(150, () => this._settleCheck(performance.now()));
    if (this.cw) return;
    if (window.MediaStreamTrackProcessor) {
      // Frame-driven: keeps working while this tab is in the background.
      const proc = new window.MediaStreamTrackProcessor({ track: this.track });
      this.reader = proc.readable.getReader();
      this._pump();
    } else {
      this.video = document.createElement('video');
      this.video.muted = true; this.video.playsInline = true;
      this.video.srcObject = this.stream;
      await this.video.play();
      this.timer = setInterval(() => {
        if (this.video.readyState >= 2) this._enqueue(async () => ({ bmp: await createImageBitmap(this.video), ts: performance.now() * 1000 }), null);
      }, 150);
    }
  }

  async _pump() {
    while (!this.stopped) {
      let r;
      try { r = await this.reader.read(); } catch { break; }
      if (r.done) break;
      const frame = r.value;
      const ts = frame.timestamp;
      // A few frames per second is plenty to spot changes, but the last frame
      // before a pause is always analysed (sent once the interval passes).
      if (this.heldFrame) { this.heldFrame.close(); this.heldFrame = null; clearTimeout(this.heldTimer); }
      if (ts - (this.lastSampled || -Infinity) < 120000) {
        this.heldFrame = frame;
        this.heldTimer = setTimeout(() => {
          const f = this.heldFrame; if (!f) return;
          this.heldFrame = null; this.lastSampled = f.timestamp;
          const t2 = f.timestamp;
          this._enqueue(async () => { try { return { bmp: await createImageBitmap(f), ts: t2 }; } finally { f.close(); } }, () => f.close());
        }, 130);
        continue;
      }
      this.lastSampled = ts;
      this._enqueue(async () => { try { return { bmp: await createImageBitmap(frame), ts }; } finally { frame.close(); } }, () => frame.close());
    }
  }

  _enqueue(getBitmap, drop) {
    // Analyse the newest frame only; release any frame that gets skipped.
    if (this.pending && this.pending.drop) this.pending.drop();
    this.pending = { get: getBitmap, drop };
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      while (this.pending && !this.stopped) {
        const job = this.pending; this.pending = null;
        try { this._analyse(await job.get()); } catch (e) { console.warn('Trailmark frame', e); }
      }
      if (this.pending && this.pending.drop) { this.pending.drop(); this.pending = null; }
      this.running = false;
    };
    loop();
  }

  _small(bmp) {
    const h = Math.max(1, Math.round(SMALL_W * bmp.height / bmp.width));
    if (!this.sc || this.sc.height !== h) { this.sc = new OffscreenCanvas(SMALL_W, h); this.sctx = this.sc.getContext('2d', { willReadFrequently: true }); this.sctx.imageSmoothingQuality = 'high'; }
    this.sctx.drawImage(bmp, 0, 0, SMALL_W, h);
    const d = this.sctx.getImageData(0, 0, SMALL_W, h).data;
    const g = new Uint8Array(SMALL_W * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return { g, w: SMALL_W, h };
  }

  _diff(a, b) {
    if (!a || !b || a.g.length !== b.g.length) return { share: 1, box: null };
    let n = 0, x0 = a.w, y0 = a.h, x1 = -1, y1 = -1;
    for (let i = 0; i < a.g.length; i++) {
      if (Math.abs(a.g[i] - b.g[i]) > PIX_DIFF) {
        n++;
        const x = i % a.w, y = (i / a.w) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { share: n / a.g.length, box: n ? { x: x0 / a.w, y: y0 / a.h, w: (x1 - x0 + 1) / a.w, h: (y1 - y0 + 1) / a.h } : null };
  }

  _settleCheck(now) {
    if (this.stopped || this.finishing || !this.prev) return;
    if (now - this.lastChangeAt < SETTLE_MS) return;
    // Movement has stopped: close the clip that captured it.
    if (this.moving) this._motionEnd(now);
    // The latest frame has been on screen, unchanged, long enough: it's settled.
    // Handle each still screen once (thumbnails keep arriving while a caret blinks).
    if (this.settledSmall && this._diff(this.prev.small, this.settledSmall).share <= ANY_CHANGE) return;
    this.settledSmall = this.prev.small;
    if (this.trigger !== 'click') this._setCandidate(this.prev);
  }

  _analyse({ bmp, ts }) {
    if (this.stopped || this.finishing) { bmp.close(); return; }
    const now = performance.now();
    const small = this._small(bmp);
    // Worker frames are thumbnails used only for detection; free them at once.
    if (this.cw) { bmp.close(); bmp = null; }
    const cur = { small, bmp, t: now, ts };
    const off = ts / 1000 - now;
    if (this.tsOff == null || off > this.tsOff) this.tsOff = off; // least-delayed frame wins
    if (this.trigger === 'click' && !this.startStep) {
      // The screen when recording began, in case there's movement before the first click.
      this.startStep = { small, unsure: false, hotspot: { x: 0.5, y: 0.5 }, highlight: null, start: true, clickTs: ts, frameT: now };
      this.startStep.shot = this.cw ? this._shot({}) : this._shot(cur);
    }
    this._settleCheck(now);
    const vsPrev = this._diff(small, this.prev && this.prev.small);
    if (this.prev && vsPrev.share > ANY_CHANGE) {
      if (now - this.lastChangeAt > 300) this.changeStartAt = now; // a new burst of change begins
      (this.changeTs = this.changeTs || []).push(ts);
      if (!this.moving) this._motionStart(now, ts);
      this.lastChangeAt = now;
      this.lastChangeTs = ts;
    }
    if (this.trigger === 'click') { /* steps come from clicks only */ } else if (this.cand) {
      const vsCand = this._diff(small, this.cand.small);
      if (vsCand.share > STEP_CHANGE) {
        const old = this.cand;
        this._commit(old, vsCand.box);
        if (this.active && this.active.stepIdx == null) this.active.stepIdx = this.steps.length - 1;
        this.cand = null;
        if (old !== this.prev) close(old);
      }
    } else if (!this.prev) {
      this.lastChangeAt = now; // first frame: wait for it to settle
    }
    if (this.prev && this.prev !== this.cand) close(this.prev);
    this.prev = cur;
    this.latest = cur;
  }

  /* ---------- movement clips ---------- */
  _rotate() {
    if (!this.motion || this.moving || this.stopped) return;
    this.warm.push(startMediaRecorder(this.stream, this.mime));
    while (this.warm.length > 2) stopMediaRecorder(this.warm.shift());
  }

  _motionStart(now, ts) {
    this.moving = true;
    if (!this.motion) return;
    if (this.encoding) {
      // Keep the frames from a little before this point until the clip is cut.
      this.active = { startTs: ts, protectTs: ts - 600000, stepIdx: null };
      this.cw.protect(this.active.protectTs);
      return;
    }
    // Keep the oldest standby recorder: it already holds a moment of pre-roll.
    const keep = this.warm.shift() || startMediaRecorder(this.stream, this.mime);
    this.warm.forEach(stopMediaRecorder);
    this.warm = [];
    keep.motionAt = now;
    keep.stepIdx = null;
    this.active = keep;
  }

  _motionEnd(now) {
    this.moving = false;
    const a = this.active;
    this.active = null;
    if (a && this.encoding) {
      if (a.stepIdx == null) { this.cw.release(a.protectTs); return; } // a hover, not a step
      const endTs = this.lastChangeTs;
      this.clipJobs.push((async () => {
        await sleep(300); // let the last frames reach the encoder
        // Every transition keeps its video, including fast page loads.
        const r = await this.cw.clip(a.startTs, endTs + 250000, 1);
        this.cw.release(a.protectTs);
        const step = this.steps[a.stepIdx];
        if (!step || !r || !r.blob) return;
        step.motion = { blob: r.blob, dur: r.duration, start: 0, exact: true };
      })());
      return;
    }
    if (a) {
      a.t1 = now;
      const done = stopMediaRecorder(a);
      // Only movement that led to a new step is kept (hover flickers are dropped).
      if (a.stepIdx != null) {
        this.clipJobs.push(done.then(() => {
          const step = this.steps[a.stepIdx];
          if (!step || !a.chunks.length) return;
          step.motion = {
            blob: new Blob(a.chunks, { type: this.mime.split(';')[0] }),
            dur: Math.max(0.3, (a.t1 - a.t0) / 1000),
            start: 0,
          };
        }));
      }
    }
    this._rotate();
  }

  /* ---------- steps ---------- */
  _setCandidate(frame) {
    if (this.cand && this.cand !== frame && this.cand !== this.prev) close(this.cand);
    // Skip a settled screen identical to the last step (e.g. a hover came and went).
    const last = this.steps[this.steps.length - 1];
    this.cand = (last && this._diff(frame.small, last.small).share < ANY_CHANGE * 2) ? null : frame;
    // Take the screenshot now, while nothing is moving, so the work never
    // competes with the movement that's about to be recorded.
    if (this.cand && this.cw) this._shot(this.cand);
  }

  // Full-size JPEG of a frame: from its own bitmap, or (worker mode) a snapshot
  // of the newest frame, taken while the screen is still.
  _shot(frame) {
    if (frame.shot) return frame.shot;
    const src = frame.bmp ? Promise.resolve(frame.bmp) : this.cw ? this.cw.snapshot() : Promise.resolve(null);
    const own = !frame.bmp;
    frame.shot = src.then(async (bmp) => {
      if (!bmp) return null;
      const scale = Math.min(1, MAX_W / bmp.width);
      const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      if (own) bmp.close();
      return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }), w: c.width, h: c.height };
    });
    return frame.shot;
  }

  _commit(frame, box, manual = false) {
    const step = { small: frame.small, unsure: true, hotspot: { x: 0.5, y: 0.5 }, highlight: null };
    if (box && box.w * box.h < 0.3) {
      // A local change (menu, dialog, field): point at it.
      step.hotspot = { x: box.x + box.w / 2, y: box.y + Math.min(box.h / 2, 0.06) };
      step.highlight = { x: Math.max(0, box.x - 0.005), y: Math.max(0, box.y - 0.005), w: Math.min(1, box.w + 0.01), h: Math.min(1, box.h + 0.01) };
      step.unsure = box.w * box.h > 0.08;
    }
    if (manual) step.unsure = true;
    step.frameT = frame.t || performance.now();
    step.leftAt = manual ? performance.now() : Math.max(step.frameT, this.changeStartAt || performance.now());
    step.shot = this._shot(frame);
    this.steps.push(step);
    this.onUpdate(this);
  }

  captureNow() {
    const f = this.latest;
    if (!f) return false;
    if (this.trigger === 'click') {
      const now = performance.now();
      const step = { small: f.small, unsure: true, hotspot: { x: 0.5, y: 0.5 }, highlight: null, clickTs: this._tsAt(now), frameT: now, leftAt: now };
      step.shot = this.cw ? this._shot({}) : this._shot(f);
      this.steps.push(step);
      this.onUpdate(this);
      return true;
    }
    if (this.cand && this.cand !== f) { this._commit(this.cand, null); if (this.cand !== this.prev) close(this.cand); }
    this._commit(f, null, true);
    this.cand = null;
    this.lastChangeAt = performance.now();
    return true;
  }

  // Stops recording and returns ready-to-use step objects (blobs already stored).
  // finalStep: treat the last screen as the closing step of a new demo.
  async collectSteps({ finalStep = true, auto = false } = {}) {
    if (this.stopped || this.finishing) return [];
    if (this.trigger === 'click') return this._collectClickSteps({ finalStep, auto });
    this.finishing = true;
    const final = this.cand || this.latest;
    if (final) {
      const last = this.steps[this.steps.length - 1];
      if (!last || this._diff(final.small, last.small).share > ANY_CHANGE * 2) this._commit(final, null);
      const tail = this.steps[this.steps.length - 1];
      if (tail && finalStep) { tail.hotspot = { x: 0.5, y: 0.5 }; tail.final = true; }
    }
    if (this.moving) this._motionEnd(performance.now());
    await Promise.all(this.clipJobs);
    // The whole session as one continuous video.
    this.fullVideo = null;
    if (this.encoding && this.full && !this.cw.fullLost) {
      await sleep(200);
      const r = await this.cw.clip(-Infinity, Infinity, 1);
      if (r && r.blob) this.fullVideo = { blob: r.blob, dur: r.duration };
    }
    this._stop();
    const out = [];
    let prevLeft = -Infinity;
    for (const r of this.steps) {
      const shot = await r.shot;
      if (!shot) continue;
      const blob = shot.blob;
      const s = newScreenStep({
        imgW: shot.w, imgH: shot.h, action: 'click',
        hotspot: { x: r.hotspot.x, y: r.hotspot.y, style: r.final ? 'none' : 'beacon' },
        highlight: r.highlight,
      });
      s.imageId = 'img_' + s.id;
      s.tooltip.text = r.final ? 'That’s it. You’re all set.' : 'Click here to continue.';
      const exact = r.final ? null : this._exactClick(r, prevLeft, shot);
      prevLeft = r.leftAt != null ? r.leftAt : prevLeft;
      if (exact) {
        const c = exact.click;
        s.hotspot.x = c.x; s.hotspot.y = c.y;
        const b = c.box;
        if (b && b.w > 0.004 && b.h > 0.004 && b.w * b.h < 0.2) {
          s.highlight = { x: Math.max(0, b.x - 0.004), y: Math.max(0, b.y - 0.004), w: Math.min(1, b.w + 0.008), h: Math.min(1, b.h + 0.008) };
        }
        s.element = { label: c.label || '', text: c.label || '', kind: c.el || 'button', tag: c.tag || '' };
        s.pageUrl = c.url || ''; s.pageTitle = c.title || '';
        if (exact.typed) { s.action = 'type'; s.typed = exact.typed; }
        s.tooltip.text = describeStep(s);
        r.unsure = false;
        s.exactClick = true;
      }
      if (r.unsure && !r.final) s.hotspotUnsure = true;
      if (auto) { s.play = 'auto'; delete s.hotspotUnsure; }
      await db.putBlob(s.imageId, blob);
      if (r.motion) {
        const real = r.motion.exact ? r.motion.dur : await mediaDuration(r.motion.blob);
        if (real === 0 || real >= 0.15) {
          const vid = uid('vid_');
          await db.putBlob(vid, r.motion.blob);
          s.motion = { videoId: vid, dur: real || r.motion.dur, start: 0, play: true };
        }
      }
      out.push(s);
    }
    return out;
  }

  // Ends the recording and returns the new demo id (or null when empty).
  async finish({ title, auto = false } = {}) {
    const steps = await this.collectSteps({ finalStep: true, auto });
    if (!steps.length) return null;
    const demo = newDemo({ title: title || `Recorded demo, ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` });
    demo.steps = steps;
    demo.coverId = steps[0].imageId;
    const full = await this.saveFull(steps);
    if (full) demo.full = full;
    addCards(demo, { auto });
    await db.putDemo(demo);
    return demo.id;
  }

  // Click mode. Step k shows the screen when you made click k; everything that
  // happened on screen until click k+1 is its movement: one continuous recording,
  // shared by every step, so nothing is skipped and deleting a step loses no video.
  async _collectClickSteps({ finalStep, auto }) {
    this.finishing = true;
    const endPt = performance.now();
    const final = this.latest || this.prev;
    const last = this.steps[this.steps.length - 1];
    if (final && (!last || this._diff(final.small, last.small).share > ANY_CHANGE * 2 || finalStep)) {
      const st = { small: final.small, unsure: false, hotspot: { x: 0.5, y: 0.5 }, highlight: null, final: true, clickTs: this._tsAt(endPt), frameT: endPt };
      st.shot = this.cw ? this._shot({}) : this._shot(final);
      this.steps.push(st);
    }
    // Movement before the first click plays as a short video-only step.
    const firstClick = this.steps[0];
    if (this.startStep && firstClick && firstClick.clickTs != null) {
      const moved = (this.changeTs || []).filter((t) => t > this.startStep.clickTs && t <= firstClick.clickTs);
      if (moved.length > 3 && moved[moved.length - 1] - moved[0] > 400000) this.steps.unshift(this.startStep);
    }
    await Promise.all(this.steps.map((s) => s.shot));
    this.fullVideo = null;
    let first = 0;
    if (this.encoding && !this.cw.fullLost) {
      await sleep(250);
      const r = await this.cw.clip(-Infinity, Infinity, 1);
      if (r && r.blob) { this.fullVideo = { blob: r.blob, dur: r.duration }; first = r.first || 0; }
    }
    this._stop();
    if (this.fullVideo) { this.fullVideo.id = uid('vid_'); await db.putBlob(this.fullVideo.id, this.fullVideo.blob); }
    const changes = this.changeTs || [];
    const out = [];
    for (let i = 0; i < this.steps.length; i++) {
      const r = this.steps[i];
      const shot = await r.shot;
      if (!shot) continue;
      const s = newScreenStep({ imgW: shot.w, imgH: shot.h, action: 'click', hotspot: { x: r.hotspot.x, y: r.hotspot.y, style: r.final ? 'none' : 'beacon' }, highlight: r.highlight });
      s.imageId = 'img_' + s.id;
      await db.putBlob(s.imageId, shot.blob);
      if (r.final) s.tooltip.text = 'That’s it. You’re all set.';
      else if (r.start) {
        s.play = 'auto'; s.hold = 0.4; s.hotspot.style = 'none'; s.tooltip.text = '';
        const next = this.steps[i + 1];
        const moved = changes.filter((t) => t > r.clickTs && t <= next.clickTs);
        if (this.fullVideo && moved.length) {
          const start = Math.max(0, (moved[0] - 150000 - first) / 1e6);
          const end = Math.min(this.fullVideo.dur, (Math.min(next.clickTs, moved[moved.length - 1] + 350000) - first) / 1e6);
          if (end - start >= 0.1) s.motion = { videoId: this.fullVideo.id, dur: this.fullVideo.dur, start: +start.toFixed(3), end: +end.toFixed(3), play: true, shared: true };
        }
      } else {
        const c = r.click || { pt: r.frameT };
        if (!r.click) { s.tooltip.text = 'Click here to continue.'; s.hotspotUnsure = true; }
        s.element = { label: c.label || '', text: c.label || '', kind: c.el || 'button', tag: c.tag || '' };
        s.pageUrl = c.url || ''; s.pageTitle = c.title || '';
        const nextPt = this.steps[i + 1] ? (this.steps[i + 1].click ? this.steps[i + 1].click.pt : this.steps[i + 1].frameT) : endPt;
        const typed = this.clicks.filter((x) => x.kind === 'type' && x.pt > c.pt && x.pt <= nextPt + 300).pop();
        if (typed && c.el === 'input' && typed.value) { s.action = 'type'; s.typed = typed.value; }
        if (r.click) { s.tooltip.text = describeStep(s); s.exactClick = true; }
        // Movement: from the click until the screen last changed before the next step.
        const next = this.steps[i + 1];
        if (this.fullVideo && r.clickTs != null && next && next.clickTs != null) {
          const from = r.clickTs - 60000;
          const moved = changes.filter((t) => t > r.clickTs && t <= next.clickTs);
          if (moved.length) {
            const to = Math.min(next.clickTs, moved[moved.length - 1] + 350000);
            const start = Math.max(0, (from - first) / 1e6), end = Math.min(this.fullVideo.dur, (to - first) / 1e6);
            if (end - start >= 0.1) s.motion = { videoId: this.fullVideo.id, dur: this.fullVideo.dur, start: +start.toFixed(3), end: +end.toFixed(3), play: true, shared: true };
          }
        }
      }
      if (auto) s.play = 'auto';
      out.push(s);
    }
    return out;
  }

  // Store the continuous session video; the first screenshot is its poster.
  async saveFull(steps) {
    if (!this.fullVideo || !steps.length) return null;
    const videoId = this.fullVideo.id || uid('vid_');
    if (!this.fullVideo.id) await db.putBlob(videoId, this.fullVideo.blob);
    const first = steps.find((x) => x.imageId) || {};
    return { videoId, dur: this.fullVideo.dur, posterId: first.imageId || null, w: first.imgW || 1280, h: first.imgH || 800, at: Date.now() };
  }

  // The click that moved the recording off this screen, if the Click Helper saw it.
  _exactClick(r, prevLeft, shot) {
    if (!this.clicks.length || this.surface !== 'browser' || r.leftAt == null) return null;
    const ar = shot.w / shot.h;
    const lo = prevLeft + 250, hi = r.leftAt + 250;
    const fits = (c) => c.vw && c.vh && Math.abs(c.vw / c.vh - ar) / ar < 0.04;
    const inWin = this.clicks.filter((c) => c.pt > lo && c.pt <= hi && fits(c));
    const click = inWin.filter((c) => c.kind !== 'type').pop();
    if (!click) return null;
    const typedEv = inWin.filter((c) => c.kind === 'type' && c.pt >= click.pt - 30000).pop();
    return { click, typed: click.el === 'input' && typedEv && typedEv.value ? typedEv.value : '' };
  }

  discard() { this._stop(); this.steps = []; }

  _stop() {
    this.stopped = true;
    if (this.offHelper) { this.offHelper(); this.offHelper = null; setHelperRecording(false); }
    clearInterval(this.timer);
    clearInterval(this.rotTimer);
    if (this.stopTick) this.stopTick();
    if (this.cw) this.cw.stop();
    this.warm.forEach(stopMediaRecorder);
    this.warm = [];
    if (this.active) { stopMediaRecorder(this.active); this.active = null; }
    try { this.reader && this.reader.cancel(); } catch { /* ignore */ }
    if (this.pending && this.pending.drop) { this.pending.drop(); this.pending = null; }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    for (const f of [this.prev, this.cand, this.latest]) close(f);
  }

  get count() { return this.steps.length; }
  get clips() { return this.clipJobs.length; }
}

// Records one continuous video of the shared tab: a "video clip" step.
// Uses the frame-accurate encoder when available (smooth 30 fps), otherwise MediaRecorder.
export class ClipRecorder {
  async start() {
    this.stream = await shareTab(30);
    this.track = this.stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => { if (!this.stopped && this.onEnded) this.onEnded(); });
    this.t0 = performance.now();
    if (workerCaptureSupported()) {
      try {
        this.cw = new CaptureWorker();
        this.posterReady = new Promise((resolve) => {
          this.cw.onPoster = async (bmp) => {
            const scale = Math.min(1, MAX_W / bmp.width);
            const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            bmp.close();
            resolve({ blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 }), w: c.width, h: c.height });
          };
        });
        const codec = await this.cw.start(this.track, { encode: true, analyse: false, poster: true, keepAll: true });
        if (codec) return;
        await this.cw.stop();
      } catch (e) { console.warn('Trailmark capture worker', e); }
      this.cw = null;
    }
    this.mime = pickMime();
    if (!this.mime) throw new Error('This browser can’t record video. Use a current version of Chrome, Edge or Firefox.');
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    this.rec = startMediaRecorder(this.stream, this.mime);
    this.poster = await this._grab();
  }

  async _grab() {
    const v = this.video;
    for (let i = 0; i < 40 && !(v.videoWidth && v.readyState >= 2); i++) await sleep(50);
    const scale = Math.min(1, MAX_W / (v.videoWidth || MAX_W));
    const c = new OffscreenCanvas(Math.round((v.videoWidth || 1280) * scale), Math.round((v.videoHeight || 800) * scale));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 }), w: c.width, h: c.height };
  }

  get seconds() { return this.stopped ? this.dur : (performance.now() - this.t0) / 1000; }

  // Returns a stored video step, or null when nothing was recorded.
  async finish() {
    if (this.stopped) return null;
    this.dur = (performance.now() - this.t0) / 1000;
    let blob, dur, poster;
    if (this.cw) {
      await sleep(150);
      const r = await this.cw.clip(-Infinity, Infinity, 1);
      this.stopped = true;
      await this.cw.stop();
      this.stream.getTracks().forEach((t) => t.stop());
      if (!r || !r.blob) return null;
      blob = r.blob; dur = r.duration;
      poster = await Promise.race([this.posterReady, sleep(3000).then(() => null)]);
      if (!poster) return null;
    } else {
      this.stopped = true;
      await stopMediaRecorder(this.rec);
      this.stream.getTracks().forEach((t) => t.stop());
      if (!this.rec.chunks.length) return null;
      blob = new Blob(this.rec.chunks, { type: this.mime.split(';')[0] });
      dur = (await mediaDuration(blob)) || this.dur;
      poster = this.poster;
    }
    const s = newVideoStep({ imgW: poster.w, imgH: poster.h, dur });
    s.videoId = uid('vid_');
    s.imageId = 'img_' + s.id;
    await db.putBlob(s.videoId, blob);
    await db.putBlob(s.imageId, poster.blob);
    return s;
  }

  discard() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.rec) stopMediaRecorder(this.rec);
    if (this.cw) this.cw.stop();
    this.stream.getTracks().forEach((t) => t.stop());
  }
}

function close(frame) { try { if (frame && frame.bmp) frame.bmp.close(); } catch { /* already closed */ } }
