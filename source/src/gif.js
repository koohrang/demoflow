// Minimal animated GIF encoder: median-cut global palette, LZW,
// identical-frame merging and changed-region cropping.

export function buildPalette(samples, maxColors = 256) {
  // samples: array of Uint8ClampedArray RGBA buffers
  const hist = new Uint32Array(32768);
  for (const buf of samples) {
    for (let i = 0; i < buf.length; i += 4) {
      hist[((buf[i] >> 3) << 10) | ((buf[i + 1] >> 3) << 5) | (buf[i + 2] >> 3)]++;
    }
  }
  const bins = [];
  for (let i = 0; i < 32768; i++) if (hist[i]) bins.push(i);
  const R = (b) => b >> 10, G = (b) => (b >> 5) & 31, B = (b) => b & 31;
  const makeBox = (list) => {
    let r0 = 31, r1 = 0, g0 = 31, g1 = 0, b0 = 31, b1 = 0, n = 0;
    for (const b of list) {
      const r = R(b), g = G(b), bb = B(b);
      if (r < r0) r0 = r; if (r > r1) r1 = r; if (g < g0) g0 = g; if (g > g1) g1 = g; if (bb < b0) b0 = bb; if (bb > b1) b1 = bb;
      n += hist[b];
    }
    return { list, n, rr: r1 - r0, gr: g1 - g0, br: b1 - b0 };
  };
  let boxes = [makeBox(bins)];
  while (boxes.length < maxColors) {
    let best = -1, score = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.list.length < 2) continue;
      const s = Math.max(bx.rr, bx.gr, bx.br) * Math.sqrt(bx.n);
      if (s > score) { score = s; best = i; }
    }
    if (best < 0) break;
    const bx = boxes[best];
    const key = bx.rr >= bx.gr && bx.rr >= bx.br ? R : bx.gr >= bx.br ? G : B;
    bx.list.sort((a, b) => key(a) - key(b));
    let half = bx.n / 2, acc = 0, cut = 1;
    for (let i = 0; i < bx.list.length - 1; i++) { acc += hist[bx.list[i]]; if (acc >= half) { cut = i + 1; break; } cut = i + 1; }
    boxes.splice(best, 1, makeBox(bx.list.slice(0, cut)), makeBox(bx.list.slice(cut)));
  }
  const pal = new Uint8Array(maxColors * 3);
  boxes.forEach((bx, i) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const bin of bx.list) { const c = hist[bin]; r += R(bin) * c; g += G(bin) * c; b += B(bin) * c; n += c; }
    n = n || 1;
    pal[i * 3] = Math.round((r / n) * 8.2258); pal[i * 3 + 1] = Math.round((g / n) * 8.2258); pal[i * 3 + 2] = Math.round((b / n) * 8.2258);
  });
  return { palette: pal, size: Math.max(2, boxes.length) };
}

export function makeMapper({ palette, size }) {
  const cache = new Int16Array(32768).fill(-1);
  return function map(rgba, out) {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
      let idx = cache[key];
      if (idx < 0) {
        const r = (key >> 10) * 8.2258, g = ((key >> 5) & 31) * 8.2258, b = (key & 31) * 8.2258;
        let best = 0, bd = Infinity;
        for (let k = 0; k < size; k++) {
          const dr = palette[k * 3] - r, dg = palette[k * 3 + 1] - g, db = palette[k * 3 + 2] - b;
          const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
          if (d < bd) { bd = d; best = k; }
        }
        idx = cache[key] = best;
      }
      out[j] = idx;
    }
    return out;
  };
}

class ByteOut {
  constructor() { this.chunks = []; this.buf = new Uint8Array(1 << 16); this.pos = 0; }
  byte(b) { if (this.pos === this.buf.length) this.flush(); this.buf[this.pos++] = b; }
  word(w) { this.byte(w & 255); this.byte((w >> 8) & 255); }
  bytes(arr) { for (let i = 0; i < arr.length; i++) this.byte(arr[i]); }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  flush() { this.chunks.push(this.buf.slice(0, this.pos)); this.pos = 0; }
  done() { this.flush(); return new Blob(this.chunks, { type: 'image/gif' }); }
}

function lzwEncode(out, pixels, initCodeSize) {
  const BITS = 12, HSIZE = 5003, MAXMAX = 1 << BITS;
  const masks = [0, 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535];
  const htab = new Int32Array(HSIZE), codetab = new Int32Array(HSIZE);
  const accum = new Uint8Array(256);
  let a_count = 0, cur_accum = 0, cur_bits = 0;
  const g_init_bits = initCodeSize + 1;
  let n_bits = g_init_bits, maxcode = (1 << n_bits) - 1;
  const ClearCode = 1 << initCodeSize, EOFCode = ClearCode + 1;
  let free_ent = ClearCode + 2, clear_flg = false;

  out.byte(initCodeSize);
  const flushChar = () => { if (a_count > 0) { out.byte(a_count); for (let i = 0; i < a_count; i++) out.byte(accum[i]); a_count = 0; } };
  const charOut = (c) => { accum[a_count++] = c; if (a_count >= 254) flushChar(); };
  const output = (code) => {
    cur_accum &= masks[cur_bits];
    if (cur_bits > 0) cur_accum |= code << cur_bits; else cur_accum = code;
    cur_bits += n_bits;
    while (cur_bits >= 8) { charOut(cur_accum & 255); cur_accum >>= 8; cur_bits -= 8; }
    if (free_ent > maxcode || clear_flg) {
      if (clear_flg) { n_bits = g_init_bits; maxcode = (1 << n_bits) - 1; clear_flg = false; }
      else { ++n_bits; maxcode = n_bits === BITS ? MAXMAX : (1 << n_bits) - 1; }
    }
    if (code === EOFCode) {
      while (cur_bits > 0) { charOut(cur_accum & 255); cur_accum >>= 8; cur_bits -= 8; }
      flushChar();
    }
  };

  let hshift = 0;
  for (let fcode = HSIZE; fcode < 65536; fcode *= 2) ++hshift;
  hshift = 8 - hshift;
  htab.fill(-1);
  output(ClearCode);
  let ent = pixels[0];
  outer: for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i];
    const fcode = (c << BITS) + ent;
    let h = (c << hshift) ^ ent;
    if (htab[h] === fcode) { ent = codetab[h]; continue; }
    if (htab[h] >= 0) {
      let disp = HSIZE - h; if (h === 0) disp = 1;
      do {
        if ((h -= disp) < 0) h += HSIZE;
        if (htab[h] === fcode) { ent = codetab[h]; continue outer; }
      } while (htab[h] >= 0);
    }
    output(ent);
    ent = c;
    if (free_ent < MAXMAX) { codetab[h] = free_ent++; htab[h] = fcode; }
    else { htab.fill(-1); free_ent = ClearCode + 2; clear_flg = true; output(ClearCode); }
  }
  output(ent);
  output(EOFCode);
  out.byte(0);
}

export class GifWriter {
  constructor(width, height, pal) {
    this.w = width; this.h = height; this.pal = pal;
    this.out = new ByteOut();
    this.prev = null;        // last written full frame (indices)
    this.pending = null;     // frame waiting for its final delay
    const o = this.out;
    o.str('GIF89a'); o.word(width); o.word(height);
    o.byte(0xF7); o.byte(0); o.byte(0);
    const table = new Uint8Array(768); table.set(pal.palette.subarray(0, 768));
    o.bytes(table);
    o.byte(0x21); o.byte(0xFF); o.byte(11); o.str('NETSCAPE2.0'); o.byte(3); o.byte(1); o.word(0); o.byte(0);
  }
  add(indices, delayCs) {
    if (this.pending && equal(this.pending.idx, indices)) { this.pending.delay += delayCs; return; }
    if (this.pending) this._write(this.pending);
    this.pending = { idx: indices.slice(), delay: delayCs };
  }
  _write(f) {
    const { w, h } = this;
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    if (this.prev) {
      x0 = w; y0 = h; x1 = -1; y1 = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (f.idx[row + x] !== this.prev[row + x]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
    }
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
    let px = f.idx;
    if (rw !== w || rh !== h) {
      px = new Uint8Array(rw * rh);
      for (let y = 0; y < rh; y++) px.set(f.idx.subarray((y + y0) * w + x0, (y + y0) * w + x0 + rw), y * rw);
    }
    const o = this.out;
    o.byte(0x21); o.byte(0xF9); o.byte(4); o.byte(1 << 2); o.word(Math.max(2, Math.round(f.delay))); o.byte(0); o.byte(0);
    o.byte(0x2C); o.word(x0); o.word(y0); o.word(rw); o.word(rh); o.byte(0);
    lzwEncode(o, px, 8);
    this.prev = f.idx;
  }
  finish() {
    if (this.pending) this._write(this.pending);
    this.pending = null;
    this.out.byte(0x3B);
    return this.out.done();
  }
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
