// The one-time Click Helper setup, shown in Settings and in the Record dialog.
import { h, icon, toast } from './ui.js';
import { helperZip } from './helper.js';

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function helperSetupSteps() {
  const isFile = location.protocol === 'file:';
  const copy = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText('chrome://extensions'); toast('Copied. Paste it into a new Chrome tab’s address bar.', { kind: 'ok' }); }
    catch { toast('Type chrome://extensions into a new tab’s address bar.'); }
  } }, icon('copy', 14), 'Copy');
  return h('ol', { class: 'setup-steps' },
    h('li', null, h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => downloadBlob(await helperZip(), 'demoflow-click-helper.zip') }, icon('download', 15), 'Download the Click Helper'),
      ' then double-click the downloaded zip to unzip it. You get a folder called ', h('code', null, 'demoflow-click-helper'), '.'),
    h('li', null, 'Open a new Chrome tab and go to ', h('code', null, 'chrome://extensions'), ' ', copy),
    h('li', null, 'Switch on ', h('strong', null, 'Developer mode'), ' (top right of that page).'),
    h('li', null, 'Click ', h('strong', null, 'Load unpacked'), ' (top left) and choose the ', h('code', null, 'demoflow-click-helper'), ' folder.'),
    isFile ? h('li', null, 'Click ', h('strong', null, 'Details'), ' on Demoflow Click Helper and turn on ', h('strong', null, 'Allow access to file URLs'), ' (needed because you opened Demoflow as a file).') : null,
    h('li', null, 'Come back here. Demoflow finds the helper by itself within a few seconds. It’s a one-time setup.'));
}
