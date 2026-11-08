// Renders a demo as a linear video (MP4 where the browser supports it,
// otherwise WebM) or an animated GIF. Both draw the same timeline:
// cursor glides to each hotspot, clicks, and the tooltip appears.
import { db } from './db.js';
import { stepVoiceText } from './model.js';
import { bakedCanvas, canvas } from './media.js';
import { voiceIsFresh, motionPlays } from './pack.js';
import { buildPalette, makeMapper, GifWriter } from './gif.js';

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function words(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

const videoUrls = new WeakMap();
// at: seek there before the segment starts, so a section of a long recording plays at once.
function loadVideo(blob, at = 0) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(v.readyState >= 1 ? v : null); };
    v.addEventListener('loadeddata', () => {
      if (at > 0.05) { v.addEventListener('seeked', done, { once: true }); try { v.currentTime = at; } catch { done(); } } else done();
    }, { once: true });
    v.addEventListener('error', () => resolve(null), { once: true });
    setTimeout(done, 6000);
    if (!videoUrls.has(blob)) videoUrls.set(blob, URL.createObjectURL(blob));
    v.src = videoUrls.get(blob);
  });
}

// withVideo: play recorded movement and video clips (real-time video export).
// Without it (GIF), video clips show their first frame and movement is skipped.
export async function buildTimeline(demo, { width = 1280, cursor = true, withAudio = true, withVideo = false, includeEnd = true, subtitles = false, onProgress } = {}) {
  const first = demo.steps.find((s) => s.type !== 'chapter' && s.imgW);
  const aspect = first ? first.imgW / first.imgH : 16 / 10;
  const W = Math.round(width / 2) * 2;
  const H = Math.round(W / aspect / 2) * 2;
  const images = new Map();
  const blurred = new Map();
  const blobCache = new Map();
  let actx = null;
  const segs = [];
  let t = 0;
  let prevPt = { x: 0.5, y: 0.92 };
  let prevImg = null;

  for (let i = 0; i < demo.steps.length; i++) {
    const s = demo.steps[i];
    let audio = null;
    if (withAudio && demo.settings.voice === 'audio' && voiceIsFresh(s)) {
      const blob = await db.getBlob(s.voice.audioId);
      if (blob) {
        actx = actx || new OfflineAudioContext(2, 48000, 48000);
        try { audio = await actx.decodeAudioData(await blob.arrayBuffer()); } catch { audio = null; }
      }
    }
    const aDur = audio ? audio.duration : 0;
    if (s.type === 'screen') {
      const blob = s.imageId ? await db.getBlob(s.imageId) : null;
      let img = null;
      if (blob) { img = await bakedCanvas(blob, s.blurs, W); images.set(s.id, img); }
      if (s.play === 'auto') {
        // Video-only: no cursor or tooltip, just the screen, then its movement.
        const willMove = withVideo && motionPlays(s);
        let dur = Math.max(s.hold != null ? +s.hold : 0.8, willMove ? 0.05 : 2.5, aDur + 0.3);
        segs.push({ kind: 'screen', auto: true, i, step: s, start: t, dur, img, prevImg, audio, audioAt: t });
        t += dur;
        prevImg = img;
      } else {
      const pt = { x: s.hotspot.x, y: s.hotspot.y };
      const moveT = cursor ? 0.8 : 0;
      const tipAt = moveT + (cursor ? 0.3 : 0.2);
      const text = (s.tooltip && s.tooltip.text) || '';
      const hold = Math.max(Math.min(7.5, Math.max(2.4, 1.4 + words(text) * 0.3)), aDur + 0.5);
      segs.push({ kind: 'screen', i, step: s, start: t, dur: tipAt + hold, moveT, tipAt, prevPt, pt, img, prevImg, audio, audioAt: t + tipAt });
      t += tipAt + hold;
      prevPt = pt;
      prevImg = img;
      }
      if (withVideo && motionPlays(s)) {
        const vb = blobCache.get(s.motion.videoId) || await db.getBlob(s.motion.videoId);
        if (vb) blobCache.set(s.motion.videoId, vb);
        const video = vb ? await loadVideo(vb, s.motion.start || 0) : null;
        if (video) {
          const endAt = s.motion.end != null && +s.motion.end > (s.motion.start || 0) ? +s.motion.end : (s.motion.dur || 1);
          const dur = Math.max(0.2, endAt - (s.motion.start || 0));
          segs.push({ kind: 'motion', i, step: s, start: t, dur, video, offset: s.motion.start || 0, img });
          t += dur;
          prevImg = null; // the clip ends on the next screen, so no cross-fade
        }
      }
    } else if (s.type === 'video') {
      const pb = s.imageId ? await db.getBlob(s.imageId) : null;
      const img = pb ? await bakedCanvas(pb, [], W) : null;
      images.set(s.id, img);
      const vb = withVideo && s.videoId ? await db.getBlob(s.videoId) : null;
      const video = vb ? await loadVideo(vb) : null;
      const dur = video ? Math.max(1, s.dur || 3) + 0.6 : Math.max(3, 1.6 + words(s.tooltip && s.tooltip.text) * 0.3);
      segs.push({ kind: 'clip', i, step: s, start: t, dur: Math.max(dur, aDur + 0.5), video, offset: 0, img, audio, audioAt: t + 0.2 });
      t += Math.max(dur, aDur + 0.5);
      prevImg = img;
    } else {
      const visual = (x) => x.type !== 'chapter' && x.imageId;
      const next = demo.steps.slice(i + 1).find(visual) || [...demo.steps.slice(0, i)].reverse().find(visual);
      let bg = null;
      if (next) {
        if (!blurred.has(next.id)) {
          const blob = next.imageId ? await db.getBlob(next.imageId) : null;
          if (blob) blurred.set(next.id, blurCopy(await bakedCanvas(blob, next.blurs || [], W)));
        }
        bg = blurred.get(next.id);
      }
      const n = words(s.title) + words(s.text);
      const dur = Math.max(3.4, 1.6 + n * 0.3, aDur + 0.9);
      segs.push({ kind: 'chapter', i, step: s, start: t, dur, bg, audio, audioAt: t + 0.35 });
      t += dur;
    }
    if (onProgress) onProgress((i + 1) / demo.steps.length);
  }
  const end = demo.settings.endScreen || {};
  if (includeEnd && end.enabled !== false) {
    const last = [...demo.steps].reverse().find((x) => x.type !== 'chapter' && images.get(x.id));
    let bg = null;
    if (last && images.get(last.id)) bg = blurCopy(images.get(last.id));
    segs.push({ kind: 'end', i: demo.steps.length, start: t, dur: 3, bg, end });
    t += 3;
  }
  const content = demo.steps.filter((x) => !x.role);
  const label = (i) => { const n = content.indexOf(demo.steps[i]); return n < 0 ? '' : `${n + 1} of ${content.length}`; };
  let music = null;
  if (withAudio && demo.music && demo.music.audioId) {
    const mb = await db.getBlob(demo.music.audioId);
    if (mb) {
      actx = actx || new OfflineAudioContext(2, 48000, 48000);
      try { music = { buffer: await actx.decodeAudioData(await mb.arrayBuffer()), volume: demo.music.volume != null ? +demo.music.volume : 0.25 }; } catch { music = null; }
    }
  }
  const brand = { img: null, pos: (demo.brand && demo.brand.position) || 'tl' };
  if (demo.brand && demo.brand.logoId) {
    const lb = await db.getBlob(demo.brand.logoId);
    if (lb) { try { brand.img = await loadImage(lb); } catch { brand.img = null; } }
  }
  return { W, H, segs, total: t, demo, count: demo.steps.length, label, music, subtitles, brand };
}

function blurCopy(src) {
  const c = canvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${Math.round(src.width / 70)}px)`;
  ctx.drawImage(src, -20, -20, src.width + 40, src.height + 40);
  ctx.filter = 'none';
  return c;
}

/* ---------- drawing ---------- */
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function tokens(text) {
  const out = [];
  String(text || '').split(/(\*\*.+?\*\*)/g).forEach((part) => {
    if (!part) return;
    const bold = /^\*\*.+\*\*$/.test(part);
    const t = bold ? part.slice(2, -2) : part;
    t.split(/(\s+)/).forEach((w) => { if (w) out.push({ w, bold }); });
  });
  return out;
}

function wrap(ctx, text, maxW, size, weight = 400) {
  const lines = [[]];
  let lw = 0;
  for (const tk of tokens(text)) {
    ctx.font = `${tk.bold ? 650 : weight} ${size}px ${FONT}`;
    const ww = ctx.measureText(tk.w).width;
    if (/^\s+$/.test(tk.w)) { if (lines[lines.length - 1].length) { lines[lines.length - 1].push({ ...tk, ww }); lw += ww; } continue; }
    if (lw + ww > maxW && lines[lines.length - 1].length) {
      const cur = lines[lines.length - 1];
      while (cur.length && /^\s+$/.test(cur[cur.length - 1].w)) cur.pop();
      lines.push([]); lw = 0;
    }
    lines[lines.length - 1].push({ ...tk, ww }); lw += ww;
  }
  return lines;
}

function drawLines(ctx, lines, x, y, size, lh, color, weight = 400) {
  ctx.fillStyle = color; ctx.textBaseline = 'top';
  lines.forEach((line, li) => {
    let cx = x;
    for (const tk of line) {
      ctx.font = `${tk.bold ? 650 : weight} ${size}px ${FONT}`;
      ctx.fillText(tk.w, cx, y + li * lh);
      cx += tk.ww;
    }
  });
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

function ink(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff';
  const n = parseInt(m[1], 16); const L = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
  return L > 0.62 ? '#14231F' : '#fff';
}

function drawCursor(ctx, x, y, k, press) {
  const s = k * 1.35 * (press ? 0.88 : 1);
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.4, 13); ctx.lineTo(7.4, 19.6); ctx.lineTo(10.2, 18.4); ctx.lineTo(7.3, 11.9); ctx.lineTo(12.8, 11.9); ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#111'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.4; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.restore();
}

function drawTooltip(ctx, tl, seg, alpha, k) {
  const { W, H, demo } = tl;
  const th = demo.theme || {};
  const text = (seg.step.tooltip && seg.step.tooltip.text) || '';
  if (!text) return;
  const pad = 16 * k, size = 15.5 * k, lh = size * 1.48;
  const tw = Math.min(340 * k, W - 24 * k);
  ctx.save();
  const lines = wrap(ctx, text, tw - pad * 2, size);
  const footH = 30 * k;
  const thh = pad + lines.length * lh + 10 * k + footH + pad * 0.7;
  let ax = seg.pt.x * W, ay = seg.pt.y * H, gap = 24 * k;
  const m = 12 * k;
  let side = (seg.step.tooltip && seg.step.tooltip.placement) || 'auto';
  const box = (seg.step.hotspot.style === 'area' || seg.step.hotspot.style === 'spotlight') && seg.step.highlight;
  if (box) {
    // Sit beside the highlighted region rather than on top of it.
    if (side === 'auto') side = (H - (box.y + box.h) * H) >= thh + 30 * k ? 'bottom' : 'top';
    ax = (box.x + box.w / 2) * W;
    if (side === 'bottom') ay = (box.y + box.h) * H; else if (side === 'top') ay = box.y * H;
    else { ay = (box.y + box.h / 2) * H; ax = side === 'right' ? (box.x + box.w) * W : box.x * W; }
    gap = 14 * k;
  }
  if (side === 'auto') {
    if (H - ay - gap - m >= thh) side = 'bottom';
    else if (ay - gap - m >= thh) side = 'top';
    else if (W - ax - gap - m >= tw) side = 'right';
    else side = 'left';
  }
  let x, y;
  if (side === 'bottom' || side === 'top') { x = ax - tw / 2; y = side === 'bottom' ? ay + gap : ay - gap - thh; }
  else { y = ay - thh / 2; x = side === 'right' ? ax + gap : ax - gap - tw; }
  x = Math.max(m, Math.min(W - tw - m, x)); y = Math.max(m, Math.min(H - thh - m, y));
  const lift = (1 - alpha) * 6 * k;
  y += lift;
  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(10,20,18,.28)'; ctx.shadowBlur = 30 * k; ctx.shadowOffsetY = 10 * k;
  const bg = th.tooltipBg || '#fff';
  ctx.fillStyle = bg;
  rr(ctx, x, y, tw, thh, (th.radius != null ? th.radius : 12) * k); ctx.fill();
  ctx.shadowColor = 'transparent';
  // arrow
  ctx.beginPath();
  const as = 7 * k;
  if (side === 'bottom') { const cx = Math.max(x + 18 * k, Math.min(x + tw - 18 * k, ax)); ctx.moveTo(cx - as, y); ctx.lineTo(cx, y - as); ctx.lineTo(cx + as, y); }
  else if (side === 'top') { const cx = Math.max(x + 18 * k, Math.min(x + tw - 18 * k, ax)); ctx.moveTo(cx - as, y + thh); ctx.lineTo(cx, y + thh + as); ctx.lineTo(cx + as, y + thh); }
  else if (side === 'right') { const cy = Math.max(y + 18 * k, Math.min(y + thh - 18 * k, ay)); ctx.moveTo(x, cy - as); ctx.lineTo(x - as, cy); ctx.lineTo(x, cy + as); }
  else { const cy = Math.max(y + 18 * k, Math.min(y + thh - 18 * k, ay)); ctx.moveTo(x + tw, cy - as); ctx.lineTo(x + tw + as, cy); ctx.lineTo(x + tw, cy + as); }
  ctx.fill();
  const inkc = th.tooltipText || '#17211E';
  drawLines(ctx, lines, x + pad, y + pad, size, lh, inkc);
  // footer
  const fy = y + pad + lines.length * lh + 10 * k;
  ctx.font = `400 ${12.5 * k}px ${FONT}`; ctx.fillStyle = hexA(inkc.length === 7 ? inkc : '#17211E', 0.55); ctx.textBaseline = 'middle';
  if (demo.settings.showStepCount !== false) ctx.fillText(tl.label(seg.i), x + pad, fy + footH / 2);
  const label = seg.i === tl.count - 1 ? 'Finish' : 'Next';
  ctx.font = `600 ${13.5 * k}px ${FONT}`;
  const bw = ctx.measureText(label).width + 30 * k;
  ctx.fillStyle = th.accent || '#1F5E52';
  rr(ctx, x + tw - pad - bw, fy, bw, footH, 8 * k); ctx.fill();
  ctx.fillStyle = ink(th.accent || '#1F5E52');
  ctx.fillText(label, x + tw - pad - bw + 13 * k, fy + footH / 2);
  ctx.restore();
}

function drawCard(ctx, tl, { title, text, buttons, alpha, k, accent, foot }) {
  const { W, H, demo } = tl;
  const th = demo.theme || {};
  ctx.save();
  ctx.globalAlpha = alpha;
  const cw = Math.min(520 * k, W - 48 * k), pad = 28 * k;
  const tsize = 27 * k, bsize = 16.5 * k;
  const tl1 = wrap(ctx, title || '', cw - pad * 2, tsize, 700);
  const bl = text ? wrap(ctx, text, cw - pad * 2, bsize) : [];
  const btnH = 44 * k, gap = 9 * k;
  const ch = pad + tl1.length * tsize * 1.2 + (bl.length ? 10 * k + bl.length * bsize * 1.5 : 0) + (buttons.length ? 20 * k + buttons.length * (btnH + gap) - gap : 0) + (foot ? 34 * k : 0) + pad * 0.85;
  const x = (W - cw) / 2, y = (H - ch) / 2 + (1 - alpha) * 10 * k;
  ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 50 * k; ctx.shadowOffsetY = 18 * k;
  ctx.fillStyle = th.tooltipBg || '#fff';
  rr(ctx, x, y, cw, ch, ((th.radius != null ? th.radius : 12) * 1.33) * k); ctx.fill();
  ctx.shadowColor = 'transparent';
  let cy = y + pad;
  drawLines(ctx, tl1, x + pad, cy, tsize, tsize * 1.2, th.tooltipText || '#17211E', 700);
  cy += tl1.length * tsize * 1.2;
  if (bl.length) { cy += 10 * k; drawLines(ctx, bl, x + pad, cy, bsize, bsize * 1.5, hexA(th.tooltipText || '#17211E', 0.75)); cy += bl.length * bsize * 1.5; }
  if (buttons.length) {
    cy += 20 * k;
    buttons.forEach((b, i) => {
      const primary = b.style === 'primary';
      ctx.fillStyle = primary ? accent : hexA(accent, 0.11);
      rr(ctx, x + pad, cy, cw - pad * 2, btnH, 9 * k); ctx.fill();
      ctx.fillStyle = primary ? ink(accent) : accent;
      ctx.font = `600 ${15 * k}px ${FONT}`; ctx.textBaseline = 'middle';
      ctx.fillText(b.label || 'Continue', x + pad + 16 * k, cy + btnH / 2);
      cy += btnH + gap;
      if (i === buttons.length - 1) cy -= gap;
    });
  }
  if (foot) {
    ctx.font = `400 ${12.5 * k}px ${FONT}`; ctx.fillStyle = hexA(th.tooltipText || '#17211E', 0.55); ctx.textBaseline = 'middle';
    ctx.fillText(foot, x + pad, cy + 22 * k);
  }
  ctx.restore();
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im); im.onerror = reject;
    im.src = URL.createObjectURL(blob);
  });
}

// Arrows, boxes and labels, matching the player's drawing (sizes relative to width).
function drawAnnos(ctx, list, W, H) {
  const u = W / 1000;
  for (const a of list || []) {
    const col = a.color || '#E5484D';
    ctx.save();
    if (a.kind === 'box') {
      ctx.fillStyle = hexA(col, 0.08); rr(ctx, a.x * W, a.y * H, a.w * W, a.h * H, 7 * u); ctx.fill();
      ctx.lineWidth = 4 * u; ctx.strokeStyle = col; rr(ctx, a.x * W, a.y * H, a.w * W, a.h * H, 7 * u); ctx.stroke();
    } else if (a.kind === 'arrow') {
      const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H;
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 24 * u, Wd = 13 * u;
      const bx = x2 - Math.cos(ang) * L, by = y2 - Math.sin(ang) * L;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineWidth = 5 * u; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(bx, by); ctx.stroke();
      const px = Math.sin(ang) * Wd, py = -Math.cos(ang) * Wd;
      ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(bx + px, by + py); ctx.lineTo(bx - px, by - py); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (a.kind === 'label') {
      const size = 15.5 * u, text = a.text || 'Label';
      ctx.font = `600 ${size}px Inter, ui-sans-serif, system-ui, sans-serif`;
      const tw = ctx.measureText(text).width, ph = size * 0.35, pw = size * 0.75;
      const bw = tw + pw * 2, bh = size * 1.25 + ph * 2;
      ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 10 * u; ctx.shadowOffsetY = 2 * u;
      ctx.fillStyle = col; rr(ctx, a.x * W - bw / 2, a.y * H - bh / 2, bw, bh, bh / 2); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = ink(col); ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(text, a.x * W, a.y * H + size * 0.04);
    }
    ctx.restore();
  }
}

// Zoom amount for a screen segment at time u: glides in, holds, glides out.
function zoomAt(seg, u) {
  const zm = seg.step && seg.step.zoom;
  if (!zm || !(zm.scale > 1)) return { z: 1, ox: 0, oy: 0 };
  const s = seg.step;
  let fx = s.hotspot ? s.hotspot.x : 0.5, fy = s.hotspot ? s.hotspot.y : 0.5;
  if (s.highlight && s.hotspot && (s.hotspot.style === 'area' || s.hotspot.style === 'spotlight')) { fx = s.highlight.x + s.highlight.w / 2; fy = s.highlight.y + s.highlight.h / 2; }
  const pIn = ease(clamp01((u - 0.15) / 0.75));
  const pOut = ease(clamp01((seg.dur - u) / 0.45));
  const p = Math.min(pIn, pOut);
  const tz = zm.scale, z = 1 + (tz - 1) * p;
  // The view's centre glides from the middle to the target view's centre.
  const cxT = Math.max(0, Math.min(1 - 1 / tz, fx - 0.5 / tz)) + 0.5 / tz;
  const cyT = Math.max(0, Math.min(1 - 1 / tz, fy - 0.5 / tz)) + 0.5 / tz;
  const cx = 0.5 + (cxT - 0.5) * p, cy = 0.5 + (cyT - 0.5) * p;
  return { z, ox: Math.max(0, Math.min(1 - 1 / z, cx - 0.5 / z)), oy: Math.max(0, Math.min(1 - 1 / z, cy - 0.5 / z)) };
}

function subtitleText(seg) {
  const s = seg.step;
  if (!s || seg.kind === 'motion' || seg.kind === 'chapter' || seg.kind === 'end') return '';
  const own = s.voice && s.voice.sameAsTooltip === false;
  const v = stepVoiceText(s).replace(/\*\*/g, '');
  if (seg.kind === 'screen' && !seg.auto) return own ? v : '';
  if (seg.kind === 'screen' && seg.auto) return s.caption ? (own ? v : '') : (v || '');
  if (seg.kind === 'clip') return own ? v : '';
  return '';
}

function drawSubtitle(ctx, tl, text, k) {
  if (!text) return;
  const { W, H } = tl;
  const size = 19 * k, lh = size * 1.35, pad = 10 * k;
  const lines = wrap(ctx, text, Math.min(W * 0.8, 900 * k), size, 500).slice(0, 3);
  const widths = lines.map((ln) => ln.reduce((n, t) => n + t.ww, 0));
  const bw = Math.max(...widths) + pad * 3, bh = lines.length * lh + pad * 1.6;
  const x = (W - bw) / 2, y = H - bh - 26 * k;
  ctx.save();
  ctx.fillStyle = 'rgba(10,14,26,.78)'; rr(ctx, x, y, bw, bh, 8 * k); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  lines.forEach((ln, i) => {
    let cx = (W - widths[i]) / 2;
    for (const t of ln) { ctx.font = `${t.bold ? 700 : 500} ${size}px Inter, ui-sans-serif, system-ui, sans-serif`; ctx.fillText(t.w, cx, y + pad * 0.8 + i * lh); cx += t.ww; }
  });
  ctx.restore();
}

function drawBrand(ctx, tl, k) {
  const im = tl.brand && tl.brand.img;
  if (!im || !im.naturalWidth) return;
  const { W, H } = tl;
  const h = 30 * k, w = Math.min(140 * k, (im.naturalWidth / im.naturalHeight) * h);
  const hh = w / (im.naturalWidth / im.naturalHeight);
  const pos = tl.brand.pos;
  const x = pos === 'br' ? W - w - 14 * k : 14 * k;
  const y = pos === 'tl' ? 12 * k : H - hh - 16 * k;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 3 * k; ctx.drawImage(im, x, y, w, hh); ctx.restore();
}

function drawContain(ctx, src, W, H) {
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawCaption(ctx, tl, seg, k) {
  const text = (seg.step.tooltip && seg.step.tooltip.text) || '';
  if (!text) return;
  const { W, H, demo } = tl;
  const th = demo.theme || {};
  const pad = 16 * k, size = 15.5 * k, lh = size * 1.48;
  const tw = Math.min(460 * k, W - 24 * k);
  const lines = wrap(ctx, text, tw - pad * 2, size);
  const bh = pad * 2 + lines.length * lh;
  const x = (W - tw) / 2, y = H - bh - 18 * k;
  ctx.save();
  ctx.shadowColor = 'rgba(20,28,52,.28)'; ctx.shadowBlur = 30 * k; ctx.shadowOffsetY = 10 * k;
  ctx.fillStyle = th.tooltipBg || '#fff';
  rr(ctx, x, y, tw, bh, (th.radius != null ? th.radius : 12) * k); ctx.fill();
  ctx.restore();
  drawLines(ctx, lines, x + pad, y + pad, size, lh, th.tooltipText || '#1D2433');
}

export function drawFrame(ctx, tl, t) {
  const { W, H, segs, demo } = tl;
  let k = W / 1280 * 1.1;
  const th = demo.theme || {};
  const accent = th.accent || '#4F46E5';
  const hot = th.hotspot || '#FFB21A';
  let si = segs.findIndex((s) => t < s.start + s.dur);
  if (si < 0) si = segs.length - 1;
  const seg = segs[si];
  const u = Math.max(0, t - seg.start);
  ctx.fillStyle = '#ECEEF5'; ctx.fillRect(0, 0, W, H);

  if (seg.kind === 'screen') {
    const fade = 0.4;
    const Z = zoomAt(seg, u);
    const map = (x, y) => ({ x: (x - Z.ox) * Z.z, y: (y - Z.oy) * Z.z });
    ctx.save();
    if (Z.z > 1) { ctx.scale(Z.z, Z.z); ctx.translate(-Z.ox * W, -Z.oy * H); }
    if (seg.prevImg && seg.prevImg !== seg.img && u < fade) {
      ctx.drawImage(seg.prevImg, 0, 0, W, H);
      ctx.globalAlpha = ease(u / fade);
    }
    if (seg.img) ctx.drawImage(seg.img, 0, 0, W, H);
    if (seg.step.annotations && seg.step.annotations.length) drawAnnos(ctx, seg.step.annotations, W, H);
    ctx.globalAlpha = 1;
    if (seg.auto) {
      ctx.restore();
      if (seg.step.caption) drawCaption(ctx, tl, seg, k);
    } else {
    const kz = k;
    k = k / Z.z; // hotspot marks keep their size while zoomed
    const style = seg.step.hotspot.style || 'beacon';
    const px = seg.pt.x * W, py = seg.pt.y * H;
    const tipA = clamp01((u - seg.tipAt) / 0.28);
    if (style === 'area' && seg.step.highlight && u >= seg.moveT) {
      const r = seg.step.highlight;
      const pulse = ((u - seg.moveT) % 1.8) / 1.8;
      const bx = r.x * W, by = r.y * H, bw = r.w * W, bh = r.h * H, rad = 10 * k;
      ctx.save();
      ctx.fillStyle = hexA(hot, 0.12); rr(ctx, bx, by, bw, bh, rad); ctx.fill();
      const grow = 14 * k * pulse;
      ctx.lineWidth = 3 * k; ctx.strokeStyle = hexA(hot, 0.55 * (1 - pulse)); rr(ctx, bx - grow, by - grow, bw + grow * 2, bh + grow * 2, rad + grow); ctx.stroke();
      ctx.lineWidth = 2.5 * k; ctx.strokeStyle = hot; rr(ctx, bx, by, bw, bh, rad); ctx.stroke();
      ctx.restore();
    }
    if (style === 'spotlight' && seg.step.highlight && tipA > 0) {
      const r = seg.step.highlight;
      ctx.save();
      ctx.fillStyle = `rgba(12,22,20,${0.52 * tipA})`;
      ctx.beginPath(); ctx.rect(0, 0, W, H);
      rr(ctx, r.x * W, r.y * H, r.w * W, r.h * H, 8 * k);
      ctx.fill('evenodd');
      ctx.lineWidth = 2 * k; ctx.strokeStyle = hexA(hot, tipA); rr(ctx, r.x * W, r.y * H, r.w * W, r.h * H, 8 * k); ctx.stroke();
      ctx.restore();
    }
    const clickU = u - seg.moveT;
    if (clickU >= 0) {
      // ripple
      if (clickU < 0.6) {
        const p = clickU / 0.6;
        ctx.beginPath(); ctx.arc(px, py, (10 + 34 * ease(p)) * k, 0, Math.PI * 2);
        ctx.lineWidth = 3 * k; ctx.strokeStyle = hexA(hot, 1 - p); ctx.stroke();
      }
      if (style === 'beacon') {
        const pulse = ((u - seg.moveT) % 1.6) / 1.6;
        ctx.beginPath(); ctx.arc(px, py, (8 + 18 * pulse) * k, 0, Math.PI * 2);
        ctx.lineWidth = 2 * k; ctx.strokeStyle = hexA(hot, 0.8 * (1 - pulse)); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, 8 * k, 0, Math.PI * 2);
        ctx.fillStyle = hot; ctx.fill(); ctx.lineWidth = 3 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
    }
    ctx.restore();
    k = kz;
    if (tipA > 0) {
      const hl = seg.step.highlight;
      const mpt = map(seg.pt.x, seg.pt.y);
      const mh = hl ? (() => { const a = map(hl.x, hl.y); return { x: a.x, y: a.y, w: hl.w * Z.z, h: hl.h * Z.z }; })() : hl;
      drawTooltip(ctx, tl, { ...seg, pt: mpt, step: { ...seg.step, highlight: mh } }, tipA, k);
    }
    if (seg.moveT > 0) {
      const mp = ease(clamp01(u / seg.moveT));
      const c = map(seg.prevPt.x + (seg.pt.x - seg.prevPt.x) * mp, seg.prevPt.y + (seg.pt.y - seg.prevPt.y) * mp);
      const cx = c.x * W, cy = c.y * H;
      const press = clickU >= 0 && clickU < 0.18;
      drawCursor(ctx, cx + (clickU >= 0 ? 6 * k : 0), cy + (clickU >= 0 ? 6 * k : 0), k, press);
    }
    }
  } else if (seg.kind === 'motion' || seg.kind === 'clip') {
    const v = seg.video;
    if (v) {
      if (!seg.begun) {
        seg.begun = true;
        try { if (seg.offset > 0.05) v.currentTime = seg.offset; } catch { /* not seekable */ }
        const p = v.play(); if (p && p.catch) p.catch(() => {});
      }
      if (v.readyState >= 2 && v.videoWidth) drawContain(ctx, v, W, H);
      else if (seg.img) ctx.drawImage(seg.img, 0, 0, W, H);
    } else if (seg.img) ctx.drawImage(seg.img, 0, 0, W, H);
    if (seg.kind === 'clip') drawCaption(ctx, tl, seg, k);
  } else {
    if (seg.bg) ctx.drawImage(seg.bg, 0, 0, W, H);
    ctx.fillStyle = hexA(accent, 0.6); ctx.fillRect(0, 0, W, H);
    const a = clamp01(u / 0.35);
    if (seg.kind === 'chapter') {
      const s = seg.step;
      const buttons = ((s.buttons && s.buttons.length) ? s.buttons : [{ label: 'Continue', style: 'primary' }])
        .filter((b) => !(b.action && b.action.type === 'url' && !String(b.action.url || '').trim()));
      drawCard(ctx, tl, { title: s.title, text: s.text, buttons, alpha: a, k, accent, foot: demo.settings.showStepCount !== false ? tl.label(seg.i) : '' });
    } else {
      const e = seg.end;
      const buttons = [];
      if (e.ctaLabel) buttons.push({ label: e.ctaLabel, style: 'primary' });
      drawCard(ctx, tl, { title: e.title || 'That’s the tour', text: e.text, buttons, alpha: a, k, accent });
    }
  }
  if (seg.kind !== 'chapter' && seg.kind !== 'end') drawBrand(ctx, tl, k);
  if (tl.subtitles) drawSubtitle(ctx, tl, subtitleText(seg), k);
  if (demo.settings.showProgress !== false) {
    const p = Math.min(1, (si + Math.min(1, u / seg.dur)) / segs.length);
    ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(0, H - 4 * k, W, 4 * k);
    ctx.fillStyle = accent; ctx.fillRect(0, H - 4 * k, W * p, 4 * k);
  }
}

/* ---------- Video ---------- */
export function videoFormat() {
  const prefs = [
    ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [m, ext] of prefs) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return { mime: m, ext };
  return null;
}

async function mixAudio(tl) {
  const withAudio = tl.segs.filter((s) => s.audio);
  if (!withAudio.length && !tl.music) return null;
  const rate = 48000;
  const off = new OfflineAudioContext(2, Math.ceil((tl.total + 0.5) * rate), rate);
  if (tl.music) {
    const src = off.createBufferSource();
    src.buffer = tl.music.buffer; src.loop = true;
    const g = off.createGain();
    const v = tl.music.volume * (withAudio.length ? 0.6 : 1); // a little quieter under narration
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(v, 1);
    g.gain.setValueAtTime(v, Math.max(1, tl.total - 1.6));
    g.gain.linearRampToValueAtTime(0, tl.total + 0.4);
    src.connect(g).connect(off.destination); src.start(0);
  }
  for (const s of withAudio) {
    const src = off.createBufferSource();
    src.buffer = s.audio; src.connect(off.destination); src.start(s.audioAt);
  }
  return off.startRendering();
}

export async function exportVideo(tl, { fps = 30, onProgress, signal } = {}) {
  const fmt = videoFormat();
  if (!fmt) throw new Error('This browser can’t record video. Update Chrome and try again.');
  const c = canvas(tl.W, tl.H);
  const ctx = c.getContext('2d', { alpha: false });
  drawFrame(ctx, tl, 0);
  const stream = c.captureStream(fps);
  const mixed = await mixAudio(tl);
  let ac = null, src = null;
  if (mixed) {
    ac = new AudioContext({ sampleRate: 48000 });
    const dest = ac.createMediaStreamDestination();
    src = ac.createBufferSource(); src.buffer = mixed; src.connect(dest);
    dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  }
  const mime = mixed ? fmt.mime : fmt.mime.replace(/,mp4a\.40\.2|,opus/, '');
  const rec = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported(mime) ? mime : fmt.mime,
    videoBitsPerSecond: Math.round(Math.min(16e6, tl.W * tl.H * fps * 0.11)),
    audioBitsPerSecond: 160000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(500);
  if (ac) { await ac.resume(); src.start(); }
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (signal && signal.aborted) { reject(new DOMException('Export cancelled', 'AbortError')); return; }
      const t = (performance.now() - t0) / 1000;
      drawFrame(ctx, tl, Math.min(t, tl.total));
      if (onProgress) onProgress(Math.min(1, t / tl.total));
      if (t >= tl.total + 0.25) { resolve(); return; }
      setTimeout(tick, 1000 / fps / 2);
    };
    tick();
  }).finally(() => {
    try { rec.state !== 'inactive' && rec.stop(); } catch { /* ignore */ }
    try { src && src.stop(); ac && ac.close(); } catch { /* ignore */ }
    stream.getTracks().forEach((tr) => tr.stop());
  });
  await done;
  return { blob: new Blob(chunks, { type: rec.mimeType.split(';')[0] }), ext: fmt.ext, hasAudio: !!mixed };
}

/* ---------- GIF ---------- */
export async function exportGif(tl, { fps = 12, onProgress, signal } = {}) {
  const c = canvas(tl.W, tl.H);
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  // Palette from representative frames (each segment fully revealed).
  const samples = [];
  for (const s of tl.segs) {
    drawFrame(ctx, tl, s.start + s.dur * 0.85);
    const d = ctx.getImageData(0, 0, tl.W, tl.H).data;
    const sub = new Uint8ClampedArray(Math.ceil(d.length / 16) * 4);
    for (let i = 0, j = 0; i < d.length; i += 16, j += 4) { sub[j] = d[i]; sub[j + 1] = d[i + 1]; sub[j + 2] = d[i + 2]; sub[j + 3] = 255; }
    samples.push(sub);
  }
  const pal = buildPalette(samples, 256);
  const map = makeMapper(pal);
  const gw = new GifWriter(tl.W, tl.H, pal);
  const frames = Math.ceil(tl.total * fps);
  const idx = new Uint8Array(tl.W * tl.H);
  const delay = 100 / fps;
  for (let f = 0; f <= frames; f++) {
    if (signal && signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    drawFrame(ctx, tl, Math.min(tl.total, f / fps));
    map(ctx.getImageData(0, 0, tl.W, tl.H).data, idx);
    gw.add(idx, delay);
    if (f % 4 === 0) {
      if (onProgress) onProgress(f / frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(1);
  return gw.finish();
}
