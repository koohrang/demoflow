import { h, icon, toast, debounce } from './ui.js';
import { loadSettings, saveSettings } from './store.js';
import { testAI, synthesize } from './ai.js';
import { db, collectGarbage } from './db.js';
import { exportBackup, importBackup } from './backup.js';
import { topnav } from './nav.js';
import { APP_VERSION, checkForUpdate, storedUpdate, removeStoredUpdate, installFromFile, restartApp, feedUrl, cmpVersion } from './update.js';
import { detectHelper, helperZip, helperVersion } from './helper.js';
import { downloadBlob } from './ui.js';

export async function renderSettings(root, section) {
  const s = await loadSettings();
  const saved = h('span', { class: 'status-line' });
  const persist = debounce(async () => { await saveSettings(s); saved.replaceChildren(icon('check', 14), 'Changes saved'); saved.className = 'status-line ok'; }, 300);
  const changed = () => { saved.textContent = 'Saving…'; saved.className = 'status-line'; persist(); };

  const field = (label, input, help) => h('div', { class: 'field' }, h('label', null, label, input), help ? h('p', { class: 'help' }, help) : null);
  const text = (obj, key, attrs = {}) => h('input', { class: 'input', value: obj[key] || '', ...attrs, oninput: (e) => { obj[key] = e.target.value.trim(); changed(); } });
  const secret = (obj, key, placeholder) => {
    const inp = h('input', { class: 'input grow', type: 'password', value: obj[key] || '', placeholder, autocomplete: 'off', spellcheck: 'false', oninput: (e) => { obj[key] = e.target.value.trim(); changed(); } });
    const tog = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; tog.textContent = inp.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    return h('div', { class: 'row' }, inp, tog);
  };
  const segc = (options, val, set, label) => {
    const g = h('div', { class: 'seg', role: 'group', 'aria-label': label, style: { maxWidth: '460px' } });
    const paint = (v) => g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    options.forEach(([v, l]) => g.append(h('button', { type: 'button', dataset: { v }, 'aria-pressed': String(v === val), onclick: () => { set(v); paint(v); } }, l)));
    return g;
  };
  // fix label nesting: inputs are siblings, not children, for proper layout
  const fieldRow = (labelText, control, help) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, labelText), control, help ? h('p', { class: 'help' }, help) : null);

  /* AI */
  const aiFields = h('div');
  const aiStatus = h('span', { class: 'status-line' });
  function drawAI() {
    aiFields.replaceChildren();
    if (s.ai.provider === 'anthropic') {
      aiFields.append(h('div', { class: 'two' },
        fieldRow('Anthropic API key', secret(s.ai, 'anthropicKey', 'sk-ant-…'), h('span', null, 'Create one at console.anthropic.com.')),
        fieldRow('Model', text(s.ai, 'anthropicModel', { placeholder: 'claude-haiku-5-5' }), 'Haiku is fast and inexpensive; Sonnet writes a little better.')));
    } else if (s.ai.provider === 'openai') {
      aiFields.append(h('div', { class: 'two' },
        fieldRow('OpenAI API key', secret(s.ai, 'openaiKey', 'sk-…')),
        fieldRow('Model', text(s.ai, 'openaiModel', { placeholder: 'gpt-5-mini' }), 'Must accept images.')),
      fieldRow('API base URL', text(s.ai, 'openaiBase', { placeholder: 'https://api.openai.com/v1' }), 'Change this to use any OpenAI-compatible service, such as OpenRouter or a local model server.'));
    }
    if (s.ai.provider !== 'none') {
      aiFields.append(h('div', { class: 'two' },
        fieldRow('Tone', h('select', { class: 'select', onchange: (e) => { s.ai.tone = e.target.value; changed(); } },
          [['friendly', 'Friendly'], ['concise', 'Concise'], ['formal', 'Formal']].map(([v, l]) => h('option', { value: v, selected: s.ai.tone === v }, l)))),
        fieldRow('Language', text(s.ai, 'language', { placeholder: 'English' }), 'Tooltips are written in this language.')));
    }
  }
  drawAI();
  const aiPanel = h('section', { class: 'panel', id: 'ai' },
    h('h2', null, 'AI writing'),
    h('p', null, 'Demoflow sends a step’s screenshot (with your blurs applied) and the clicked label to your provider to draft tooltip text. Keys stay in this browser and requests go straight from here to the provider.'),
    fieldRow('Provider', segc([['none', 'Off'], ['anthropic', 'Anthropic'], ['openai', 'OpenAI or compatible']], s.ai.provider, (v) => { s.ai.provider = v; changed(); drawAI(); }, 'AI provider')),
    aiFields,
    h('div', { class: 'panel-foot' },
      h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true; aiStatus.className = 'status-line'; aiStatus.replaceChildren(h('span', { class: 'spin' }), 'Testing…');
        try { await persist.flush(); await testAI(s); aiStatus.className = 'status-line ok'; aiStatus.replaceChildren(icon('check', 14), 'Connected'); }
        catch (err) { aiStatus.className = 'status-line bad'; aiStatus.textContent = err.message; }
        finally { b.disabled = false; }
      } }, 'Test connection'), aiStatus));

  /* Voice */
  const vFields = h('div');
  const vStatus = h('span', { class: 'status-line' });
  function drawVoice() {
    vFields.replaceChildren();
    if (s.tts.provider === 'openai') {
      vFields.append(
        fieldRow('OpenAI API key', secret(s.tts, 'openaiKey', s.ai.openaiKey ? 'Uses your AI writing key if left empty' : 'sk-…')),
        h('div', { class: 'two' },
          fieldRow('Voice', h('select', { class: 'select', onchange: (e) => { s.tts.openaiVoice = e.target.value; changed(); } },
            ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((v) => h('option', { value: v, selected: s.tts.openaiVoice === v }, v[0].toUpperCase() + v.slice(1))))),
          fieldRow('Model', text(s.tts, 'openaiModel', { placeholder: 'gpt-4o-mini-tts' }))));
    } else if (s.tts.provider === 'elevenlabs') {
      vFields.append(
        fieldRow('ElevenLabs API key', secret(s.tts, 'elevenKey', 'xi-…')),
        h('div', { class: 'two' },
          fieldRow('Voice ID', text(s.tts, 'elevenVoice', { placeholder: '21m00Tcm4TlvDq8ikWAM' }), 'Copy it from the Voices page in ElevenLabs.'),
          fieldRow('Model', text(s.tts, 'elevenModel', { placeholder: 'eleven_multilingual_v2' }))));
    }
  }
  drawVoice();
  const voicePanel = h('section', { class: 'panel', id: 'voice' },
    h('h2', null, 'Voiceover'),
    h('p', null, 'Generated voiceovers are saved with each step, played in shared demos and mixed into video exports. Without a provider, demos can still use the viewer’s browser voice.'),
    fieldRow('Provider', segc([['none', 'Off'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs']], s.tts.provider, (v) => { s.tts.provider = v; changed(); drawVoice(); }, 'Voice provider')),
    vFields,
    h('div', { class: 'panel-foot' },
      h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true; vStatus.className = 'status-line'; vStatus.replaceChildren(h('span', { class: 'spin' }), 'Generating sample…');
        try {
          await persist.flush();
          const blob = await synthesize(s, 'Here’s how your product tours will sound. Click the highlighted button to continue.');
          new Audio(URL.createObjectURL(blob)).play();
          vStatus.className = 'status-line ok'; vStatus.replaceChildren(icon('check', 14), 'Playing sample');
        } catch (err) { vStatus.className = 'status-line bad'; vStatus.textContent = err.message; }
        finally { b.disabled = false; }
      } }, icon('play', 14), 'Play a sample'), vStatus));

  /* Storage */
  const restoreIn = h('input', { type: 'file', accept: '.demoflow,.zip', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const t = toast('Restoring…', { timeout: 600000 });
    try { const r2 = await importBackup(f); t.remove(); toast(`Restored: ${r2.added} added, ${r2.updated} updated, ${r2.skipped} already here`, { kind: 'ok', timeout: 7000 }); drawUsage(); }
    catch (err) { t.remove(); toast(err.message, { kind: 'error', timeout: 8000 }); }
  } });
  const usage = h('p');
  const storagePanel = h('section', { class: 'panel', id: 'storage' },
    h('h2', null, 'Storage and backup'),
    h('p', null, 'Demos, screenshots and voiceovers are saved in this browser, on this computer. A backup file holds everything, so you can keep a safe copy or move your demos to another computer.'),
    usage,
    h('div', { class: 'panel-foot row wrap' },
      h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => {
        const t = toast('Packing your demos…', { timeout: 600000 });
        try { const { blob, count } = await exportBackup(); downloadBlob(blob, `demoflow-backup-${new Date().toISOString().slice(0, 10)}.demoflow`); try { localStorage.setItem('df.lastBackup', String(Date.now())); } catch { /* ignore */ } t.remove(); toast(`Backed up ${count} demo${count === 1 ? '' : 's'}`, { kind: 'ok' }); }
        catch (e) { t.remove(); toast(e.message, { kind: 'error' }); }
      } }, icon('download', 15), 'Back up all demos'),
      h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => restoreIn.click() }, icon('upload', 15), 'Restore from a backup'), restoreIn,
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: async () => { await collectGarbage(); await drawUsage(); toast('Unused files removed', { kind: 'ok' }); } }, 'Remove unused files')));
  async function drawUsage() {
    const demos = await db.listDemos();
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const mb = est ? (est.usage / 1e6).toFixed(1) : '?';
    const steps = demos.reduce((n, d) => n + d.steps.length, 0);
    usage.textContent = `${demos.length} demo${demos.length === 1 ? '' : 's'}, ${steps} step${steps === 1 ? '' : 's'}, about ${mb} MB used.`;
    usage.style.margin = '0 0 14px';
  }
  drawUsage();

  /* Updates */
  const upBody = h('div');
  const upStatus = h('div', { class: 'up-status' });
  const upFile = h('input', { type: 'file', accept: '.html,text/html', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { const v = await installFromFile(f); toast(`Demoflow ${v} is ready`, { kind: 'ok', timeout: 12000, action: { label: 'Restart now', run: restartApp } }); drawUpdates(); }
    catch (err) { toast(err.message, { kind: 'error', timeout: 8000 }); }
  } });
  const notesList = (notes) => notes && notes.length ? h('ul', { class: 'up-notes' }, notes.map((n) => h('li', null, n))) : null;
  async function drawUpdates(result) {
    const st = await storedUpdate();
    const waiting = st && cmpVersion(st.version, APP_VERSION) > 0;
    const feed = await feedUrl();
    upStatus.replaceChildren();
    if (result && result.status === 'error') upStatus.append(h('p', { class: 'up-msg err' }, result.error));
    else if (result && result.status === 'latest') upStatus.append(h('p', { class: 'up-msg ok' }, icon('check', 15), `You have the latest version (${APP_VERSION}).`));
    else if (result && result.status === 'reload') upStatus.append(h('div', { class: 'up-card' }, h('strong', null, `Demoflow ${result.version} is available`), notesList(result.notes), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: restartApp }, 'Reload to update')));
    else if (result && result.status === 'none') upStatus.append(h('p', { class: 'up-msg' }, 'No update address is set yet. Add one below, or install a newer file by hand.'));
    if (waiting) upStatus.append(h('div', { class: 'up-card' }, h('strong', null, `Demoflow ${st.version} is ready`), notesList(st.notes),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: restartApp }, 'Restart to update'))));
    const running = (window.__dfFrom || '') === 'stored';
    upBody.replaceChildren(
      h('div', { class: 'up-head' },
        h('img', { src: window.TM_LOGO, alt: '', width: 40, height: 40 }),
        h('div', null, h('strong', null, `Demoflow ${APP_VERSION}`), h('span', null, running ? 'Running the update kept in this browser.' : 'Running the copy inside this file.'))),
      upStatus,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; b.replaceChildren(h('span', { class: 'spin' }), 'Checking…');
          const r = await checkForUpdate(); b.disabled = false; b.replaceChildren(icon('refresh', 15), 'Check for updates');
          drawUpdates(r);
        } }, icon('refresh', 15), 'Check for updates'),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => upFile.click() }, icon('upload', 15), 'Install from a file'),
        upFile),
      h('label', { class: 'check', style: { marginTop: '14px' } }, h('input', { type: 'checkbox', checked: s.updates.auto, onchange: (e) => { s.updates.auto = e.target.checked; changed(); } }), h('span', null, 'Check for updates automatically (once a day)')),
      fieldRow('Update address', h('input', { class: 'input', type: 'url', value: s.updates.feed || '', placeholder: feed || 'https://raw.githubusercontent.com/you/demoflow/main/release/version.json', oninput: (e) => { s.updates.feed = e.target.value.trim(); changed(); } }),
        'Where new versions are published: the version.json file in your GitHub repository (or any web address). Leave empty to use the built-in address.'),
      running || (st && !waiting) ? h('button', { class: 'link-btn', type: 'button', onclick: async () => { await removeStoredUpdate(); toast('Back to the copy inside this file after a restart.', { action: { label: 'Restart now', run: restartApp } }); drawUpdates(); } }, 'Go back to the built-in version') : null);
  }
  const updatesPanel = h('section', { class: 'panel', id: 'updates' },
    h('h2', null, 'Updates'),
    h('p', null, 'New versions install themselves: Demoflow downloads the update once and uses it from the next start. You keep the same file, and your demos stay where they are.'),
    upBody);
  drawUpdates();

  /* Click Helper */
  const helperState = h('div', { class: 'helper-line' }, h('span', { class: 'spin' }), 'Looking for the Click Helper…');
  detectHelper(800).then((on) => {
    helperState.classList.toggle('on', on);
    helperState.replaceChildren(icon(on ? 'check' : 'puzzle', 16), on ? h('span', null, h('strong', null, 'Installed and working. '), `Version ${helperVersion()}. Recordings get exact hotspots.`) : h('span', null, h('strong', null, 'Not installed in this browser yet.')));
  });
  const helperPanel = h('section', { class: 'panel', id: 'helper' },
    h('h2', null, 'Click Helper'),
    h('p', null, 'A tiny optional Chrome extension. While you record, it tells Demoflow exactly where you clicked and what you clicked on, so hotspots land in the right place and tooltips name the button. It does nothing when you aren’t recording and sends nothing off your computer.'),
    helperState,
    h('ol', { class: 'setup-steps' },
      h('li', null, h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => downloadBlob(await helperZip(), 'demoflow-click-helper.zip') }, icon('download', 15), 'Download the Click Helper'), ' and unzip it.'),
      h('li', null, 'Open ', h('code', null, 'chrome://extensions'), ' and switch on ', h('strong', null, 'Developer mode'), ' (top right).'),
      h('li', null, 'Click ', h('strong', null, 'Load unpacked'), ' and pick the ', h('code', null, 'demoflow-click-helper'), ' folder.'),
      h('li', null, 'Click ', h('strong', null, 'Details'), ' on the Click Helper and turn on ', h('strong', null, 'Allow access to file URLs'), ', so it can talk to this file.'),
      h('li', null, 'Reload this page. The line above turns green.')),
    h('p', { class: 'help' }, 'Works when you share a browser tab (not a whole window or screen).'));

  /* Publishing */
  const publishPanel = h('section', { class: 'panel', id: 'publish' },
    h('h2', null, 'Publishing'),
    h('p', null, 'Publish a demo to the web in one click with a free Netlify account. You get a link to share and an embed code.'),
    fieldRow('Netlify personal access token', secret(s.publish, 'netlifyToken', 'nfp_…'),
      h('span', null, 'Create one at app.netlify.com → User settings → Applications → Personal access tokens. It stays in this browser.')));

  const aboutPanel = h('section', { class: 'panel', id: 'about' },
    h('h2', null, 'Keyboard shortcuts'),
    h('dl', { class: 'kv', style: { gridTemplateColumns: '170px 1fr', fontSize: '13.5px' } },
      h('dt', null, '↑ ↓'), h('dd', null, 'Previous or next step in the editor'),
      h('dt', null, 'B'), h('dd', null, 'Draw blur areas on the current step (B again or Done to finish)'),
      h('dt', null, 'Double-click'), h('dd', null, 'Move the hotspot to that spot on the screenshot'),
      h('dt', null, 'Ctrl/⌘ + Z'), h('dd', null, 'Undo (add Shift to redo)'),
      h('dt', null, 'Ctrl/⌘ + D'), h('dd', null, 'Duplicate the current step'),
      h('dt', null, '← →'), h('dd', null, 'Move through a demo while viewing it')));

  const page = h('main', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'), h('p', null, 'Optional: connect AI writing and voiceover with your own keys.')), saved),
    h('div', { class: 'settings' },
      h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
        h('a', { href: '#/settings/updates' }, 'Updates'), h('a', { href: '#/settings/helper' }, 'Click Helper'),
        h('a', { href: '#/settings/ai' }, 'AI writing'), h('a', { href: '#/settings/voice' }, 'Voiceover'),
        h('a', { href: '#/settings/publish' }, 'Publishing'),
        h('a', { href: '#/settings/storage' }, 'Storage and backup'), h('a', { href: '#/settings/about' }, 'Shortcuts')),
      h('div', null, updatesPanel, helperPanel, aiPanel, voicePanel, publishPanel, storagePanel, aboutPanel)));
  root.append(h('div', { class: 'shell' }, topnav('settings'), page));
  if (section) { const el = document.getElementById(section); if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 30); }
  return () => persist.flush();
}
