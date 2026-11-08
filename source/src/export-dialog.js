import { h, icon, modal, toast, downloadBlob, slug } from './ui.js';
import { buildTimeline, exportVideo, exportGif, videoFormat } from './exporter.js';
import { standaloneHtml, voiceIsFresh, motionPlays, siteFiles } from './pack.js';
import { db } from './db.js';
import { makeZip } from './zip.js';
import { loadSettings, saveSettings } from './store.js';

// Netlify: create the site the first time, then redeploy to the same link.
async function netlifyDeploy(token, zip, siteId) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' };
  const url = siteId ? `https://api.netlify.com/api/v1/sites/${siteId}/deploys` : 'https://api.netlify.com/api/v1/sites';
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: zip }); }
  catch { throw new Error('Netlify couldn’t be reached from this file. Use “Download website” below and drop the zip on app.netlify.com/drop instead.'); }
  if (res.status === 401) throw new Error('Netlify didn’t accept the token. Check it in Settings → Publishing.');
  if (res.status === 404 && siteId) return netlifyDeploy(token, zip, null); // site was deleted: make a new one
  if (!res.ok) throw new Error(`Netlify answered ${res.status}. ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const id = siteId || j.id;
  const link = j.ssl_url || j.url || (j.subdomain ? `https://${j.subdomain}.netlify.app` : '');
  return { siteId: id, url: siteId ? (j.ssl_url || j.deploy_ssl_url || j.url || '').replace(/\/\/[0-9a-f]+--/, '//') : link };
}

function estimate(demo) {
  let t = 0;
  for (const s of demo.steps) {
    const words = String(s.type === 'chapter' ? `${s.title} ${s.text}` : s.tooltip.text).split(/\s+/).filter(Boolean).length;
    if (s.type === 'video') t += (s.dur || 3) + 0.6;
    else if (s.type === 'screen') t += (s.play === 'auto' ? Math.max(+s.hold || 0.8, motionPlays(s) ? 0 : 2.5) : 1.1 + Math.min(7.5, Math.max(2.4, 1.4 + words * 0.3))) + (motionPlays(s) ? Math.max(0.4, s.motion.dur - (s.motion.start || 0)) : 0);
    else t += Math.max(3.4, 1.6 + words * 0.3);
  }
  if (demo.settings.endScreen && demo.settings.endScreen.enabled !== false) t += 3;
  return Math.round(t);
}
function fmtSize(b) { return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`; }

export function openExportDialog({ demo }) {
  let kind = 'html';
  let quality = 1080, gifW = 800, cursor = true, subtitles = false;
  let running = null;
  const body = h('div');
  const fmt = videoFormat();
  const dlg = modal({ title: 'Export and share', body, wide: true, onClose: () => { if (running) running.abort(); } });

  function opt(key, ic, title, sub) {
    return h('button', { class: 'opt', type: 'button', 'aria-pressed': String(kind === key), onclick: () => { if (running) return; kind = key; draw(); } }, icon(ic, 22), h('strong', null, title), h('small', null, sub));
  }
  function segc(options, val, set, label) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(v === val), onclick: () => { set(v); draw(); } }, l)));
  }

  function draw() {
    body.replaceChildren();
    const secs = estimate(demo);
    const audioSteps = demo.settings.voice === 'audio' ? demo.steps.filter(voiceIsFresh).length : 0;
    const hasVideo = demo.steps.some((s) => s.type === 'video' || motionPlays(s));
    body.append(h('div', { class: 'opt-grid' },
      opt('html', 'html', 'Interactive HTML', 'The clickable demo in one file. Upload it to your website or Netlify Drop, or send it to anyone.'),
      opt('video', 'film', fmt && fmt.ext === 'mp4' ? 'MP4 video' : 'Video', 'A narrated walkthrough for YouTube, social posts or slides.'),
      opt('gif', 'gif', 'Animated GIF', 'Loops silently. Good for docs, emails and changelogs.'),
      opt('web', 'globe', 'Publish online', 'Get a link to share and an embed code. Free with Netlify.')));
    if (kind === 'video') {
      body.append(
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Resolution'), segc([[720, '720p'], [1080, '1080p'], [1440, '1440p']], quality, (v) => { quality = v; }, 'Resolution')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cursor, onchange: (e) => { cursor = e.target.checked; } }), h('span', null, 'Animate a cursor moving to each hotspot')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: subtitles, onchange: (e) => { subtitles = e.target.checked; } }), h('span', null, 'Add subtitles for narration that isn’t already on screen')),
        h('div', { class: 'notice', style: { marginTop: '10px' } }, icon('film'), h('span', null,
          `Recording plays in real time, so it takes about ${secs} seconds. Keep this tab in front while it runs. `,
          audioSteps ? `Includes generated voiceover for ${audioSteps} step${audioSteps === 1 ? '' : 's'}.` : demo.settings.voice === 'browser' ? 'Browser voice can’t be recorded; switch to generated voiceover to include narration.' : '', demo.music && demo.music.audioId ? ' Background music is included.' : '',
          fmt && fmt.ext === 'webm' ? ' This browser saves WebM; most editors and players open it.' : '')));
    } else if (kind === 'gif') {
      body.append(
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Width'), segc([[640, '640 px'], [800, '800 px'], [960, '960 px']], gifW, (v) => { gifW = v; }, 'GIF width')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cursor, onchange: (e) => { cursor = e.target.checked; } }), h('span', null, 'Animate a cursor moving to each hotspot')),
        h('div', { class: 'notice', style: { marginTop: '10px' } }, icon('gif'), h('span', null, `About ${secs} seconds long at 12 frames per second. GIFs have no sound${hasVideo ? ', and recorded movement and video clips are left out (video clips show their first frame). Use MP4 or HTML to include them' : ''}.`)));
    } else if (kind === 'web') {
      const site = (pubSettings && pubSettings.publish.sites[demo.id]) || null;
      const hasToken = !!(pubSettings && pubSettings.publish.netlifyToken);
      body.append(
        site ? h('div', { class: 'pub-live' }, icon('globe'), h('div', null, h('strong', null, 'Live at '), h('a', { href: site.url, target: '_blank', rel: 'noopener' }, site.url), h('small', null, 'Publishing again updates this same link.'))) : null,
        h('div', { class: 'notice' }, icon('rocket'), h('span', null, hasToken
          ? 'Demoflow uploads the demo to your Netlify account and gives you a link. Blurred areas are baked into the images.'
          : h('span', null, 'Add a free Netlify token in ', h('a', { href: '#/settings/publish', onclick: () => dlg.close() }, 'Settings → Publishing'), ' for one-click publishing. Or download the website and drag it onto ', h('a', { href: 'https://app.netlify.com/drop', target: '_blank', rel: 'noopener' }, 'Netlify Drop'), '.'))),
        embedBox(site));
    } else {
      body.append(h('div', { class: 'notice' }, icon('html'), h('span', null, 'This is how you share the interactive demo: put the file on any website (or drag it onto app.netlify.com/drop for a free link), embed it in an iframe, or attach it to an email. It keeps hotspots, branching, buttons and voiceover, and works offline. Blurred areas are baked into the images.')));
    }
    const status = h('div', { class: 'export-status' });
    if (kind === 'web') {
      const hasToken = !!(pubSettings && pubSettings.publish.netlifyToken);
      const zipBtn = h('button', { class: 'btn ' + (hasToken ? 'btn-outline' : 'btn-primary'), type: 'button', onclick: () => start(status, zipBtn, 'zip') }, icon('download', 17), 'Download website (.zip)');
      const pubBtn = hasToken ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => start(status, pubBtn, 'netlify') }, icon('rocket', 17), pubSettings.publish.sites[demo.id] ? 'Publish update' : 'Publish to Netlify') : null;
      body.append(status, h('div', { class: 'modal-foot', style: { padding: '14px 0 20px' } },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dlg.close() }, 'Close'), zipBtn, pubBtn));
      return;
    }
    const startBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => start(status, startBtn) }, icon('download', 17), kind === 'video' ? 'Record video' : kind === 'gif' ? 'Create GIF' : 'Download HTML');
    body.append(status, h('div', { class: 'modal-foot', style: { padding: '14px 0 20px' } },
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dlg.close() }, 'Close'), startBtn));
  }

  function embedBox(site) {
    if (!site) return null;
    const code = `<iframe src="${site.url}" title="${(demo.title || 'Interactive demo').replace(/"/g, '&quot;')}" style="width:100%;aspect-ratio:16/10;border:0;border-radius:12px" allow="fullscreen" loading="lazy"></iframe>`;
    const ta = h('textarea', { class: 'textarea code', rows: 3, readonly: true }, code);
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Embed code'), ta,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(code); toast('Embed code copied', { kind: 'ok' }); } catch { ta.select(); } } }, icon('copy', 15), 'Copy embed code'),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(site.url); toast('Link copied', { kind: 'ok' }); } catch { /* ignore */ } } }, icon('link', 15), 'Copy link')));
  }

  async function start(status, btn, how) {
    const ac = new AbortController();
    running = ac;
    btn.disabled = true;
    const bar = h('i');
    const label = h('span', { class: 'status-line' }, h('span', { class: 'spin' }), 'Preparing screenshots…');
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => ac.abort() }, 'Cancel');
    status.replaceChildren(h('div', { class: 'progress' }, bar), h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, label, cancel));
    const setP = (p, txt) => { bar.style.width = Math.round(p * 100) + '%'; if (txt) label.lastChild.textContent = txt; };
    const name = slug(demo.title);
    try {
      if (kind === 'web') {
        const files = await siteFiles(demo, { onProgress: (p) => setP(p * 0.6, 'Packing the website…') });
        const zip = await makeZip(files, { onProgress: (p) => setP(0.6 + p * 0.2, 'Packing the website…') });
        if (how === 'zip') {
          downloadBlob(zip, `${name}-website.zip`);
          done(`${name}-website.zip`, zip.size);
          status.append(h('p', { class: 'hint' }, 'Drag the zip onto app.netlify.com/drop (or upload its contents to any web host) to get a link.'));
        } else {
          setP(0.85, 'Uploading to Netlify…');
          const prev = pubSettings.publish.sites[demo.id];
          const r = await netlifyDeploy(pubSettings.publish.netlifyToken, zip, prev && prev.siteId);
          const url = r.url || (prev && prev.url) || '';
          pubSettings.publish.sites[demo.id] = { siteId: r.siteId, url, at: Date.now() };
          await saveSettings(pubSettings);
          demo.published = { url, siteId: r.siteId, at: Date.now() };
          demo.exports = (demo.exports || 0) + 1;
          await db.putDemo(demo);
          setP(1, 'Published');
          draw();
          toast('Published. The link is live in a few seconds.', { kind: 'ok', timeout: 6000 });
        }
      } else if (kind === 'html') {
        const html = await standaloneHtml(demo, { onProgress: (p) => setP(p, 'Packing images…') });
        const blob = new Blob([html], { type: 'text/html' });
        downloadBlob(blob, `${name}.html`);
        done(`${name}.html`, blob.size);
      } else {
        // Video height follows the chosen resolution; width follows the screenshots.
        const first = demo.steps.find((s) => s.type === 'screen');
        const ar = first ? first.imgW / first.imgH : 16 / 10;
        const width = kind === 'video' ? Math.round((quality * ar) / 2) * 2 : gifW;
        const tl = await buildTimeline(demo, { width, cursor, subtitles: kind === 'video' && subtitles, withAudio: kind === 'video', withVideo: kind === 'video', onProgress: (p) => setP(p * 0.15, 'Preparing screenshots…') });
        if (kind === 'video') {
          const res = await exportVideo(tl, { signal: ac.signal, onProgress: (p) => setP(0.15 + p * 0.85, `Recording… ${Math.round(p * tl.total)} of ${Math.round(tl.total)} s`) });
          downloadBlob(res.blob, `${name}.${res.ext}`);
          done(`${name}.${res.ext}`, res.blob.size);
        } else {
          const blob = await exportGif(tl, { signal: ac.signal, onProgress: (p) => setP(0.15 + p * 0.85, `Rendering frames… ${Math.round(p * 100)}%`) });
          downloadBlob(blob, `${name}.gif`);
          done(`${name}.gif`, blob.size);
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') { status.replaceChildren(h('p', { class: 'modal-text' }, 'Export cancelled.')); }
      else { console.error(e); status.replaceChildren(h('div', { class: 'notice warn' }, icon('close'), h('span', null, e.message || String(e)))); }
    } finally {
      running = null;
      btn.disabled = false;
    }
    function done(file, size) {
      demo.exports = (demo.exports || 0) + 1;
      db.putDemo(demo).catch(() => {});
      status.replaceChildren(h('div', { class: 'notice' }, icon('check'), h('span', null, `Downloaded ${file} (${fmtSize(size)}).`)));
      toast('Export finished', { kind: 'ok' });
    }
  }

  let pubSettings = null;
  loadSettings().then((s) => { pubSettings = s; if (kind === 'web') draw(); });
  draw();
}
