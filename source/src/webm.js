// Minimal WebM writer for one VP8/VP9 video track (no audio).
// Takes encoded chunks from WebCodecs and produces a playable .webm Blob
// with a known duration, so clips start instantly and never stall.

const te = new TextEncoder();

function idBytes(id) {
  const out = [];
  while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); }
  return Uint8Array.from(out);
}

function sizeBytes(n) {
  let len = 1;
  while (len < 8 && n > 2 ** (7 * len) - 2) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 1 << (8 - len);
  return out;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function el(id, ...children) {
  const body = concat(children.flat());
  return concat([idBytes(id), sizeBytes(body.length), body]);
}

function uint(n) {
  const out = [];
  do { out.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0);
  return Uint8Array.from(out);
}

function float64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return b;
}

function str(s) { return te.encode(s); }

// frames: [{ data: Uint8Array, ts: microseconds, key: boolean }] in order; first must be a key frame.
// Frame times are snapped to the display's 1/60 s grid. Capture timestamps wobble
// by several ms, which makes a 60 Hz screen hold frames unevenly (visible judder);
// on the grid every frame is shown for a whole number of refreshes.
export function buildWebM({ codec, width, height, frames, frameMs = 1000 / 30 }) {
  if (!frames.length) return null;
  const TICK_US = 100;                  // timecodes in 0.1 ms
  const GRID_US = 1e6 / 60;
  const t0 = frames[0].ts;
  const times = [];
  let lastStep = -1;
  for (const f of frames) {
    let step = Math.round((f.ts - t0) / GRID_US);
    if (step <= lastStep) step = lastStep + 1;
    lastStep = step;
    times.push(Math.round(step * GRID_US / TICK_US));
  }
  const last = times[times.length - 1];
  const durationTicks = last + Math.round(frameMs * 1000 / TICK_US);

  const header = el(0x1A45DFA3,
    el(0x4286, uint(1)), el(0x42F7, uint(1)), el(0x42F2, uint(4)), el(0x42F3, uint(8)),
    el(0x4282, str('webm')), el(0x4287, uint(4)), el(0x4285, uint(2)));

  const info = el(0x1549A966,
    el(0x2AD7B1, uint(TICK_US * 1000)),     // timecode scale in ns: 0.1 ms
    el(0x4489, float64(durationTicks)),
    el(0x4D80, str('Demoflow')), el(0x5741, str('Demoflow')));

  const tracks = el(0x1654AE6B, el(0xAE,
    el(0xD7, uint(1)), el(0x73C5, uint(1)), el(0x83, uint(1)), el(0x9C, uint(0)),
    el(0x86, str(codec)),
    el(0x23E383, uint(Math.round(frameMs * 1e6))),
    el(0xE0, el(0xB0, uint(width)), el(0xBA, uint(height)))));

  const clusters = [];
  let cur = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const t = times[i];
    if (!cur || (f.key && t - cur.t >= 10000) || t - cur.t > 30000) {
      if (cur) clusters.push(el(0x1F43B675, el(0xE7, uint(cur.t)), ...cur.blocks));
      cur = { t, blocks: [] };
    }
    const rel = t - cur.t;
    const head = new Uint8Array(4);
    head[0] = 0x81;                          // track 1
    head[1] = (rel >> 8) & 0xff; head[2] = rel & 0xff;
    head[3] = f.key ? 0x80 : 0x00;
    cur.blocks.push(el(0xA3, head, f.data));
  }
  if (cur) clusters.push(el(0x1F43B675, el(0xE7, uint(cur.t)), ...cur.blocks));

  const segment = el(0x18538067, info, tracks, ...clusters);
  return { blob: new Blob([header, segment], { type: 'video/webm' }), duration: durationTicks * TICK_US / 1e6 };
}

// Source of this module for use inside a Worker (built from the same functions).
export function webmSource() {
  return ['const te = new TextEncoder();', idBytes, sizeBytes, concat, el, uint, float64, str, buildWebM].map(String).join('\n');
}
