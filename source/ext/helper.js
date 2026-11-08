// Runs in every tab. In the Demoflow tab it acts as a bridge; in other tabs it
// reports clicks (position, the clicked element's name and box) to the bridge.
(function () {
  // The newest copy wins: after an update (or when added to an open tab twice),
  // older copies in this page go quiet.
  const gen = window.__demoflowHelperGen = (window.__demoflowHelperGen || 0) + 1;
  const alive = () => { if (window.__demoflowHelperGen !== gen) return false; try { return !!chrome.runtime.id; } catch (e) { return false; } };
  const VERSION = '1.1.0';
  const send = (msg) => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* extension reloaded */ } };
  const isApp = () => document.documentElement && document.documentElement.hasAttribute('data-demoflow');

  function bridge() {
    const hello = () => window.postMessage({ source: 'demoflow-helper', type: 'hello', version: VERSION }, '*');
    send({ t: 'bridge' });
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.source !== 'demoflow-app' || !alive()) return;
      if (e.data.type === 'recording') send({ t: 'recording', on: !!e.data.on });
      else if (e.data.type === 'ping') { send({ t: 'bridge' }); hello(); }
    });
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.t === 'event' && alive()) window.postMessage({ source: 'demoflow-helper', type: 'event', ev: m.ev }, '*');
    });
    hello();
  }

  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[onclick],[tabindex]';
  function describe(el) {
    const t = el.closest(INTERACTIVE) || el;
    const tag = t.tagName.toLowerCase();
    const role = t.getAttribute('role') || '';
    const type = (t.getAttribute('type') || '').toLowerCase();
    let label = t.getAttribute('aria-label') || t.getAttribute('title') || t.getAttribute('placeholder') || t.getAttribute('alt') || '';
    if (!label && t.labels && t.labels[0]) label = t.labels[0].innerText;
    if (!label && tag !== 'input' && tag !== 'textarea') label = t.innerText || t.textContent || '';
    if (!label && type === 'submit') label = t.value || 'Submit';
    label = String(label).replace(/\s+/g, ' ').trim().slice(0, 80);
    let kind = 'button';
    if (tag === 'a' || role === 'link') kind = 'link';
    else if (type === 'checkbox' || role === 'checkbox' || role === 'switch') kind = 'checkbox';
    else if (role === 'tab') kind = 'tab';
    else if (role === 'menuitem' || role === 'option' || tag === 'option') kind = 'menuitem';
    else if (tag === 'input' || tag === 'textarea' || tag === 'select') kind = 'input';
    const r = t.getBoundingClientRect();
    const W = innerWidth, H = innerHeight;
    return {
      label, kind, tag, password: type === 'password',
      box: { x: r.left / W, y: r.top / H, w: r.width / W, h: r.height / H },
    };
  }

  function reporter() {
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.isTrusted || !alive()) return;
      const d = describe(e.target);
      send({ t: 'click', ev: {
        t: Date.now(), x: e.clientX / innerWidth, y: e.clientY / innerHeight, vw: innerWidth, vh: innerHeight,
        label: d.label, el: d.kind, tag: d.tag, box: d.box, url: location.href, title: document.title,
      } });
    }, true);
    window.addEventListener('change', (e) => {
      const el = e.target;
      if (!alive()) return;
      if (!el || !/^(input|textarea)$/i.test(el.tagName)) return;
      const type = (el.type || '').toLowerCase();
      if (/password|hidden|checkbox|radio|file/.test(type)) return;
      const d = describe(el);
      send({ t: 'type', ev: { t: Date.now(), value: String(el.value || '').slice(0, 60), label: d.label, box: d.box, vw: innerWidth, vh: innerHeight, url: location.href } });
    }, true);
  }

  if (isApp()) bridge(); else reporter();
})();
