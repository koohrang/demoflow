// Image helpers: blur baking, compression, AI previews.

export async function bitmap(blob) { return createImageBitmap(blob); }

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

export function toBlob(c, type = 'image/webp', quality = 0.86) {
  return new Promise((resolve) => c.toBlob((b) => resolve(b), type, quality));
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Pixelate + blur the rectangles so the original pixels can't be recovered.
export function applyBlurs(ctx, W, H, blurs) {
  for (const b of blurs || []) {
    const x = Math.max(0, Math.floor(b.x * W)), y = Math.max(0, Math.floor(b.y * H));
    const w = Math.min(W - x, Math.ceil(b.w * W)), hh = Math.min(H - y, Math.ceil(b.h * H));
    if (w < 2 || hh < 2) continue;
    const cell = Math.max(6, Math.round(Math.min(W, H) / 90));
    const tw = Math.max(1, Math.round(w / cell)), th = Math.max(1, Math.round(hh / cell));
    const small = canvas(tw, th);
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(ctx.canvas, x, y, w, hh, 0, 0, tw, th);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.filter = `blur(${Math.max(4, cell * 0.9)}px)`;
    ctx.drawImage(small, 0, 0, tw, th, x - cell, y - cell, w + cell * 2, hh + cell * 2);
    ctx.filter = 'none';
    ctx.restore();
  }
}

// Draw a step's screenshot at a target width with blurs baked in.
export async function bakedCanvas(blob, blurs, maxW = 1920) {
  const bmp = await bitmap(blob);
  const scale = Math.min(1, maxW / bmp.width);
  const c = canvas(bmp.width * scale, bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  applyBlurs(ctx, c.width, c.height, blurs);
  return c;
}

export async function bakeImage(blob, blurs, { maxW = 1920, type = 'image/webp', quality = 0.86 } = {}) {
  const c = await bakedCanvas(blob, blurs, maxW);
  return toBlob(c, type, quality);
}

// Screenshot with the click point marked, for the AI writer.
export async function annotatedForAI(blob, step, maxW = 1280) {
  const c = await bakedCanvas(blob, step.blurs, maxW);
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  if (step.highlight) {
    const r = step.highlight;
    ctx.strokeStyle = '#FF2D55'; ctx.lineWidth = Math.max(2, W / 400);
    ctx.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
  }
  const hs = step.hotspot || { x: 0.5, y: 0.5 };
  ctx.beginPath();
  ctx.arc(hs.x * W, hs.y * H, Math.max(10, W / 80), 0, Math.PI * 2);
  ctx.lineWidth = Math.max(3, W / 300); ctx.strokeStyle = '#FF2D55'; ctx.stroke();
  const out = await toBlob(c, 'image/jpeg', 0.82);
  const url = await blobToDataURL(out);
  return url.split(',')[1];
}

export async function fileToStepImage(file) {
  const bmp = await bitmap(file);
  const w = bmp.width, h = bmp.height;
  // Normalise to JPEG/PNG kept as-is if already reasonable
  let blob = file;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    const c = canvas(w, h); c.getContext('2d').drawImage(bmp, 0, 0);
    blob = await toBlob(c, 'image/png');
  }
  bmp.close();
  return { blob, w, h };
}

export async function thumbnail(blob, w = 360) {
  const bmp = await bitmap(blob);
  const scale = w / bmp.width;
  const c = canvas(w, bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return toBlob(c, 'image/jpeg', 0.8);
}

// Logos: keep SVG as is, scale big bitmaps down so exports stay small.
export async function shrinkImage(file, maxW = 480) {
  if (/svg/.test(file.type)) return file.slice(0, file.size, 'image/svg+xml');
  const bmp = await createImageBitmap(file);
  if (bmp.width <= maxW && file.size < 150 * 1024) { bmp.close && bmp.close(); return file.slice(0, file.size, file.type); }
  const k = Math.min(1, maxW / bmp.width);
  const c = canvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return toBlob(c, 'image/png');
}
