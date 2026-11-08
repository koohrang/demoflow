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
