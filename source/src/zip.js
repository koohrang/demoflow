// Minimal ZIP (stored, no compression) writer and reader. Images and videos are
// already compressed, so storing them is fast and loses nothing.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0xFFFFFFFF) {
  for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return crc;
}

async function crcOf(blob) {
  let crc = 0xFFFFFFFF;
  const CH = 8 * 1024 * 1024;
  for (let o = 0; o < blob.size; o += CH) crc = crc32(new Uint8Array(await blob.slice(o, o + CH).arrayBuffer()), crc);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ name, data: Blob | string | Uint8Array }]
export async function makeZip(files, { onProgress } = {}) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const blob = f.data instanceof Blob ? f.data : new Blob([typeof f.data === 'string' ? enc.encode(f.data) : f.data]);
    const name = enc.encode(f.name);
    const crc = await crcOf(blob);
    const size = blob.size;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
    if (onProgress) onProgress((i + 1) / files.length);
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// Returns { names, get(name) -> Blob, text(name) -> string }. Stored entries only.
export async function readZip(blob) {
  const tailLen = Math.min(blob.size, 66000);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This isn’t a Demoflow backup (no zip directory found).');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('The backup file is damaged.');
    const method = cd.getUint16(p + 10, true);
    const size = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  async function get(name, type = '') {
    const e = entries.get(name);
    if (!e) return null;
    if (e.method !== 0) throw new Error('Compressed backups aren’t supported. Use a backup made by Demoflow.');
    const lh = new DataView(await blob.slice(e.local, e.local + 30).arrayBuffer());
    const start = e.local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    return blob.slice(start, start + e.size, type);
  }
  return { names: [...entries.keys()], get, text: async (n) => { const b = await get(n); return b ? b.text() : null; } };
}
