// Capture pipeline that runs in its own Worker, so nothing happening on the
// page (change detection, screenshots, the editor) can delay or drop frames.
// The worker reads every frame of the shared tab, encodes it once, keeps the
// recent encoded frames, and hands clips back on request. It also sends a few
// full-size frames per second to the page for step detection.
import { webmSource } from './webm.js';

export function workerCaptureSupported() {
  return !!(window.Worker && window.MediaStreamTrackProcessor && window.VideoEncoder && window.VideoFrame);
}

// Runs inside the worker (serialised with toString; must be self-contained).
function captureWorkerMain() {
  let KEY_EVERY_US = 2000000;     // a key frame at least every 2 s (pauses also start one)
  const QUIET_KEY_US = 250000;    // and on the first frame after any pause
  const KEEP_US = 1500000;        // history kept when no clip is being cut
  let enc = null, cfg = null, codecName = '', failed = false;
  let BITRATE = 6000000;
  let chunks = [], lastTs = -Infinity, lastKeyTs = -Infinity;
  let canvas = null, ctx = null;
  let stopped = false, reader = null, keepAll = false;
  let latest = null;              // newest frame, kept for full-size snapshots
  let pendingThumb = null, pendingTimer = 0;
  function sendThumb(frame) {
    const ts = frame.timestamp;
    const sw = 160, sh = Math.max(1, Math.round(160 * frame.displayHeight / frame.displayWidth));
    createImageBitmap(frame, { resizeWidth: sw, resizeHeight: sh, resizeQuality: 'high' })
      .then((bmp) => { frame.close(); self.postMessage({ type: 'frame', bmp, ts }, [bmp]); }, () => frame.close());
  }
  const protect = new Map();
  const FULL_LIMIT = 700 * 1024 * 1024; // stop keeping the full session beyond this
  let bytes = 0;

  async function setupEncoder(width, height, maxW) {
    const scale = Math.min(1, maxW / width);
    const w = Math.max(2, Math.round(width * scale / 2) * 2);
    const h = Math.max(2, Math.round(height * scale / 2) * 2);
    const tries = [
      ['vp09.00.10.08', 'V_VP9', 'prefer-hardware'],
      ['vp8', 'V_VP8', 'prefer-hardware'],
      ['vp8', 'V_VP8', 'prefer-software'],
      ['vp09.00.10.08', 'V_VP9', 'prefer-software'],
    ];
    for (const [codec, webm, hw] of tries) {
      const c = { codec, width: w, height: h, bitrate: BITRATE, framerate: 30, latencyMode: 'realtime', hardwareAcceleration: hw };
      try {
        const r = await VideoEncoder.isConfigSupported(c);
        if (!r.supported) continue;
        const e = new VideoEncoder({
          output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({ ts: chunk.timestamp, key: chunk.type === 'key', data });
            bytes += data.length;
            if (keepAll && bytes > FULL_LIMIT) { keepAll = false; self.postMessage({ type: 'fullLost' }); }
          },
          error: () => { failed = true; },
        });
        e.configure(c);
        enc = e; cfg = c; codecName = webm;
        return `${codec} (${hw.replace('prefer-', '')})`;
      } catch (err) { /* try the next one */ }
    }
    return '';
  }

  function encode(frame) {
    if (!enc || failed || enc.state !== 'configured') return;
    if (enc.encodeQueueSize > 20) return;
    const ts = frame.timestamp;
    const key = ts - lastKeyTs >= KEY_EVERY_US || ts - lastTs >= QUIET_KEY_US;
    lastTs = ts;
    if (key) lastKeyTs = ts;
    let src = frame, own = null;
    if (frame.displayWidth !== cfg.width || frame.displayHeight !== cfg.height) {
      if (!canvas) { canvas = new OffscreenCanvas(cfg.width, cfg.height); ctx = canvas.getContext('2d'); }
      ctx.drawImage(frame, 0, 0, cfg.width, cfg.height);
      own = src = new VideoFrame(canvas, { timestamp: ts });
    }
    try { enc.encode(src, { keyFrame: key }); } catch (err) { failed = true; }
    if (own) own.close();
  }

  function prune(latestTs) {
    if (keepAll) return;
    let keep = latestTs - KEEP_US;
    for (const t of protect.keys()) keep = Math.min(keep, t);
    let cut = -1;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].ts > keep) break;
      if (chunks[i].key) cut = i;
    }
    if (cut > 0) { for (let i = 0; i < cut; i++) bytes -= chunks[i].data.length; chunks.splice(0, cut); }
  }

  function slice(fromTs, toTs) {
    let start = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.ts > fromTs) { if (start < 0 && c.key) start = i; break; }
      if (c.key) start = i;
    }
    if (start < 0) start = chunks.findIndex((c) => c.key);
    if (start < 0) return [];
    const out = [];
    for (let i = start; i < chunks.length && chunks[i].ts <= toTs; i++) out.push(chunks[i]);
    return out;
  }

  async function flush() { try { if (enc && enc.state === 'configured') await enc.flush(); } catch (err) { /* closed */ } }

  self.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'start') {
      keepAll = !!m.keepAll;
      if (m.keyEveryMs) KEY_EVERY_US = m.keyEveryMs * 1000;
      if (m.bitrate) BITRATE = m.bitrate;
      const codec = m.encode ? await setupEncoder(m.width, m.height, m.maxW) : '';
      self.postMessage({ type: 'ready', codec });
      reader = m.readable.getReader();
      let lastSent = -Infinity, n = 0, first = true;
      const every = (m.analyseEveryMs || 0) * 1000;
      while (!stopped) {
        let r;
        try { r = await reader.read(); } catch (err) { break; }
        if (r.done) break;
        const f = r.value;
        encode(f);
        const ts = f.timestamp;
        if (m.poster && first) {
          const copy = f.clone();
          createImageBitmap(copy).then((bmp) => { copy.close(); self.postMessage({ type: 'poster', bmp, ts }, [bmp]); }, () => copy.close());
        }
        if (m.analyse) {
          // Change detection only needs a few thumbnails a second, but the last
          // frame before a pause must always be seen (e.g. a page that finishes
          // loading and then sits still), so a skipped frame is sent once the
          // interval passes if nothing newer has arrived.
          if (pendingThumb) { pendingThumb.close(); pendingThumb = null; clearTimeout(pendingTimer); }
          if (ts - lastSent >= every) { lastSent = ts; sendThumb(f.clone()); }
          else {
            pendingThumb = f.clone();
            pendingTimer = setTimeout(() => {
              if (!pendingThumb) return;
              const p = pendingThumb; pendingThumb = null;
              lastSent = p.timestamp;
              sendThumb(p);
            }, Math.max(1, (every - (ts - lastSent)) / 1000));
          }
        }
        if (m.analyse) { if (latest) latest.close(); latest = f.clone(); }
        first = false;
        f.close();
        if (++n % 30 === 0) prune(lastTs);
      }
    } else if (m.type === 'snapshot') {
      // Full-size copy of the newest frame (asked for while the screen is still).
      let bmp = null, ts = 0;
      if (latest) { try { bmp = await createImageBitmap(latest); ts = latest.timestamp; } catch (err) { bmp = null; } }
      self.postMessage({ type: 'snap', id: m.id, bmp, ts }, bmp ? [bmp] : []);
    } else if (m.type === 'protect') {
      protect.set(m.ts, true);
    } else if (m.type === 'release') {
      protect.delete(m.ts);
    } else if (m.type === 'clip') {
      await flush();
      const frames = slice(m.from, m.to);
      let blob = null, duration = 0;
      if (frames.length >= (m.min || 1)) {
        const built = buildWebM({ codec: codecName, width: cfg.width, height: cfg.height, frames });
        if (built) { blob = built.blob; duration = built.duration; }
      }
      self.postMessage({ type: 'clip', id: m.id, blob, duration, frames: frames.length, first: frames.length ? frames[0].ts : 0 });
    } else if (m.type === 'stop') {
      stopped = true;
      try { if (reader) reader.cancel(); } catch (err) { /* ignore */ }
      if (latest) { latest.close(); latest = null; }
      if (pendingThumb) { pendingThumb.close(); pendingThumb = null; clearTimeout(pendingTimer); }
      try { if (enc && enc.state !== 'closed') enc.close(); } catch (err) { /* ignore */ }
      self.postMessage({ type: 'stopped' });
    }
  };
}

export class CaptureWorker {
  constructor() {
    const src = `${webmSource()}\n(${captureWorkerMain.toString()})();`;
    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.w = new Worker(this.url);
    this.waits = new Map();
    this.seq = 0;
    this.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'frame') { if (this.onFrame) this.onFrame(m.bmp, m.ts); else m.bmp.close(); }
      else if (m.type === 'poster') { if (this.onPoster) this.onPoster(m.bmp, m.ts); else m.bmp.close(); }
      else if (m.type === 'ready') this._resolve('ready', m);
      else if (m.type === 'clip') this._resolve('clip' + m.id, m);
      else if (m.type === 'snap') this._resolve('snap' + m.id, m.bmp);
      else if (m.type === 'fullLost') { this.fullLost = true; if (this.onFullLost) this.onFullLost(); }
      else if (m.type === 'stopped') this._resolve('stopped', m);
    };
  }

  _wait(key, ms = 15000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waits.delete(key); resolve(null); }, ms);
      this.waits.set(key, (v) => { clearTimeout(t); resolve(v); });
    });
  }
  _resolve(key, v) { const f = this.waits.get(key); if (f) { this.waits.delete(key); f(v); } }

  // Returns the encoder description ('' when frames are analysed but not encoded).
  async start(track, { encode = true, analyse = true, analyseEveryMs = 120, poster = false, keepAll = false, maxW = 1920 } = {}) {
    const tune = window.TM_CAPTURE_TUNE || {}; // test hook: { keyEveryMs, bitrate, maxW }
    if (tune.maxW) maxW = tune.maxW;
    const st = track.getSettings ? track.getSettings() : {};
    const processor = new window.MediaStreamTrackProcessor({ track });
    const ready = this._wait('ready');
    this.w.postMessage({
      type: 'start', readable: processor.readable, encode, analyse, analyseEveryMs, poster, keepAll, maxW, keyEveryMs: tune.keyEveryMs, bitrate: tune.bitrate,
      width: st.width || 1280, height: st.height || 800,
    }, [processor.readable]);
    const r = await ready;
    if (!r) throw new Error('The capture worker didn’t start.');
    this.codec = r.codec;
    // With a hardware encoder there's headroom for 60 fps: smoother movement.
    if (encode && /hardware/.test(r.codec || '') && track.applyConstraints) {
      try { await track.applyConstraints({ frameRate: { ideal: 60, max: 60 } }); this.fps = 60; } catch { this.fps = 30; }
    } else this.fps = 30;
    return r.codec;
  }

  snapshot() {
    const id = ++this.seq;
    const p = this._wait('snap' + id, 5000);
    this.w.postMessage({ type: 'snapshot', id });
    return p;
  }

  protect(ts) { this.w.postMessage({ type: 'protect', ts }); }
  release(ts) { this.w.postMessage({ type: 'release', ts }); }

  async clip(from, to, min = 1) {
    const id = ++this.seq;
    const p = this._wait('clip' + id, 20000);
    this.w.postMessage({ type: 'clip', id, from, to, min });
    return p;
  }

  async stop() {
    const p = this._wait('stopped', 3000);
    this.w.postMessage({ type: 'stop' });
    await p;
    this.w.terminate();
    URL.revokeObjectURL(this.url);
  }
}
