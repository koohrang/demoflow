// Demoflow Click Helper: relays clicks from the tab you record to the Demoflow
// tab, only while Demoflow says a recording is running. Nothing leaves the browser.
let state = null;
async function load() {
  if (state) return state;
  const s = await chrome.storage.session.get('df');
  state = s.df || { bridges: [], rec: false };
  return state;
}
function save() { return chrome.storage.session.set({ df: state }); }

chrome.runtime.onMessage.addListener((m, sender) => {
  (async () => {
    await load();
    const tab = sender.tab && sender.tab.id;
    if (m.t === 'bridge') {
      if (tab != null && !state.bridges.includes(tab)) { state.bridges.push(tab); await save(); }
    } else if (m.t === 'recording') {
      state.rec = !!m.on; await save();
    } else if ((m.t === 'click' || m.t === 'type') && state.rec) {
      for (const b of state.bridges.slice()) {
        if (b === tab) continue;
        chrome.tabs.sendMessage(b, { t: 'event', ev: { ...m.ev, kind: m.t } }).catch(async () => {
          state.bridges = state.bridges.filter((x) => x !== b); await save();
        });
      }
    }
  })();
});

chrome.tabs.onRemoved.addListener(async (id) => {
  await load();
  if (state.bridges.includes(id)) { state.bridges = state.bridges.filter((x) => x !== id); if (!state.bridges.length) state.rec = false; await save(); }
});

// Right after installing (or updating), add the helper to tabs that are already
// open, so Demoflow sees it at once without reloading anything.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || !/^(https?|file):/.test(t.url || '')) continue;
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['helper.js'] }).catch(() => {});
    }
  } catch (e) { /* nothing to do */ }
});
