// Turns a stored demo into the public shape the player reads, with blur
// baked into the screenshots so hidden pixels never leave the device.
import { db } from './db.js';
import { stepVoiceText } from './model.js';
import { bakeImage, blobToDataURL } from './media.js';

export function voiceIsFresh(step) {
  const v = step.voice || {};
  return !!(v.audioId && v.audioText === stepVoiceText(step));
}

// mode: 'dataurl' (single-file export) | 'files' (server upload) | 'blob' (local preview)
export function motionPlays(step) {
  return !!(step.type === 'screen' && step.motion && step.motion.videoId && step.motion.play !== false && !(step.blurs && step.blurs.length));
}

export async function packDemo(demo, { mode = 'dataurl', maxW = 1920, onProgress } = {}) {
  const files = [];
  const steps = [];
  const total = demo.steps.length;
  const shared = new Map(); // videoId -> url, so one recording used by many steps is packed once
  for (let i = 0; i < total; i++) {
    const s = demo.steps[i];
    const out = {
      id: s.id, type: s.type,
      buttons: (s.buttons || []).map((b) => ({ id: b.id, label: b.label, style: b.style, action: b.action })),
      voice: { text: s.voice ? s.voice.text : '', sameAsTooltip: s.voice ? s.voice.sameAsTooltip !== false : true },
    };
    if (s.type === 'screen') {
      Object.assign(out, {
        imgW: s.imgW, imgH: s.imgH,
        hotspot: s.hotspot, highlight: s.highlight, tooltip: s.tooltip, next: s.next, blurs: [],
        play: s.play === 'auto' ? 'auto' : 'click', hold: s.hold != null ? s.hold : 0.8, caption: !!s.caption,
        annotations: s.annotations || [], zoom: s.zoom && s.zoom.scale > 1 ? s.zoom : null,
      });
      const blob = s.imageId ? await db.getBlob(s.imageId) : null;
      if (blob) {
        if (mode === 'blob') {
          out.image = URL.createObjectURL(blob);
          out.blurs = s.blurs || [];
        } else {
          const baked = await bakeImage(blob, s.blurs, { maxW, type: 'image/webp', quality: 0.86 });
          if (mode === 'files') { const name = `${s.id}.webp`; files.push({ name, blob: baked }); out.image = name; }
          else out.image = await blobToDataURL(baked);
        }
      }
      // Video can't be blurred, so a step with blurred areas never ships its movement clip.
      if (motionPlays(s)) {
        const mv = await db.getBlob(s.motion.videoId);
        if (mv) {
          if (!shared.has(s.motion.videoId)) shared.set(s.motion.videoId, await asUrl(mv, mode, s.motion.shared ? 'recording' : `${s.id}-motion`, files));
          out.motion = { video: shared.get(s.motion.videoId), dur: s.motion.dur, start: s.motion.start || 0, end: s.motion.end || null };
        }
      }
    } else if (s.type === 'video') {
      Object.assign(out, { imgW: s.imgW, imgH: s.imgH, dur: s.dur, autoNext: s.autoNext !== false, tooltip: s.tooltip, next: s.next });
      const poster = s.imageId ? await db.getBlob(s.imageId) : null;
      if (poster) out.image = mode === 'blob' ? URL.createObjectURL(poster) : await blobToDataURL(await bakeImage(poster, [], { maxW, type: 'image/webp', quality: 0.82 }));
      const vid = s.videoId ? await db.getBlob(s.videoId) : null;
      if (vid) out.video = await asUrl(vid, mode, s.id, files);
    } else {
      Object.assign(out, { title: s.title, text: s.text, role: s.role || undefined });
    }
    if (demo.settings.voice === 'audio' && voiceIsFresh(s)) {
      const audio = await db.getBlob(s.voice.audioId);
      if (audio) {
        if (mode === 'blob') out.voice.audio = URL.createObjectURL(audio);
        else if (mode === 'files') { const name = `${s.id}.mp3`; files.push({ name, blob: audio }); out.voice.audio = name; }
        else out.voice.audio = await blobToDataURL(audio);
      }
    }
    steps.push(out);
    if (onProgress) onProgress((i + 1) / total);
  }
  const data = {
    id: demo.id,
    title: demo.title,
    theme: demo.theme,
    settings: demo.settings,
    steps,
  };
  const brand = demo.brand || {};
  if (brand.logoId) {
    const lb = await db.getBlob(brand.logoId);
    if (lb) data.brand = { logo: await asUrl(lb, mode, 'logo', files, 'img'), position: brand.position || 'tl', name: brand.name || '' };
  }
  if (demo.music && demo.music.audioId) {
    const mb = await db.getBlob(demo.music.audioId);
    if (mb) data.music = { src: await asUrl(mb, mode, 'music', files, 'audio'), volume: demo.music.volume != null ? demo.music.volume : 0.25 };
  }
  if (demo.gate && demo.gate.enabled) data.gate = { ...demo.gate };
  return { data, files };
}

// The player's own source is embedded in this file so exports can reuse it.
async function asUrl(blob, mode, name, files, kind = 'video') {
  if (mode === 'blob') return URL.createObjectURL(blob);
  if (mode === 'files') {
    const sub = (blob.type.split('/')[1] || '').split(/[;+]/)[0];
    const ext = kind === 'video' ? (/mp4/.test(blob.type) ? 'mp4' : 'webm') : ({ mpeg: 'mp3', 'svg': 'svg', jpeg: 'jpg' }[sub] || sub || 'bin');
    files.push({ name: `${name}.${ext}`, blob });
    return `${name}.${ext}`;
  }
  return blobToDataURL(blob);
}

export async function playerSource() {
  return {
    js: document.getElementById('tm-player-src').textContent,
    css: document.getElementById('tm-player-css').textContent,
  };
}

function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export async function standaloneHtml(demo, { trackUrl = '', onProgress } = {}) {
  const { data } = await packDemo(demo, { mode: 'dataurl', onProgress });
  const { js, css } = await playerSource();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(demo.title || 'Interactive demo')}</title>
<style>
${css}
html,body{margin:0;height:100%;background:#EEF1F0}
#tm{position:fixed;inset:0;padding:clamp(0px,3vw,32px)}
@media (max-width:600px){#tm{padding:0}}
</style>
</head>
<body>
<div id="tm"></div>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
<script>
TrailmarkPlayer.mount(document.getElementById('tm'), ${jsonForScript(data)}, { fit: 'contain', globalKeys: true${trackUrl ? `, trackUrl: ${JSON.stringify(trackUrl)}` : ''} });
</script>
</body>
</html>`;
}

// A small website: index.html plus media files next to it (lighter than one big file).
export async function siteFiles(demo, { onProgress } = {}) {
  const { data, files } = await packDemo(demo, { mode: 'files', onProgress });
  const { js, css } = await playerSource();
  const title = escHtml(demo.title || 'Interactive demo');
  const index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}">
<style>
${css}
html,body{margin:0;height:100%;background:#EEF1F0}
#tm{position:fixed;inset:0;padding:clamp(0px,3vw,32px)}
@media (max-width:600px){#tm{padding:0}}
body.embed #tm{padding:0}
</style>
</head>
<body>
<div id="tm"></div>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
<script>
if (window.self !== window.top) document.body.classList.add('embed');
DemoflowPlayer.mount(document.getElementById('tm'), ${jsonForScript(data)}, { fit: 'contain', globalKeys: true, flat: window.self !== window.top });
</script>
</body>
</html>`;
  return [{ name: 'index.html', data: index }, ...files.map((f) => ({ name: f.name, data: f.blob }))];
}
