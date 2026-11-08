#!/usr/bin/env python3
"""Bundle the Trailmark single-file app: every module, style, font and icon
inlined into dist/Trailmark.html. No dependencies."""
import base64, re, os, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
ASSETS = os.path.join(HERE, 'assets')
OUT = os.path.join(HERE, 'dist', 'Trailmark.html')

def read(p): return open(p, encoding='utf8').read()
def b64(p): return base64.b64encode(open(p, 'rb').read()).decode()

IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'\./([\w-]+)\.js';\s*$", re.M)
EXPORT_RE = re.compile(r"^export\s+(async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)", re.M)

def transform(name, code):
    deps = []
    def imp(m):
        names = []
        for part in m.group(1).split(','):
            part = part.strip()
            if not part: continue
            if ' as ' in part:
                a, b = [x.strip() for x in part.split(' as ')]
                names.append(f'{a}: {b}')
            else:
                names.append(part)
        deps.append(m.group(2))
        return f"const {{ {', '.join(names)} }} = __req('{m.group(2)}');"
    code = IMPORT_RE.sub(imp, code)
    exports = [m.group(2) for m in EXPORT_RE.finditer(code)]
    code = EXPORT_RE.sub(lambda m: f"{m.group(1)} {m.group(2)}", code)
    if re.search(r"^\s*(import|export)\b", code, re.M):
        sys.exit(f'Unhandled import/export in {name}')
    body = f"__def('{name}', function (__req) {{\n'use strict';\n{code}\nreturn {{ {', '.join(exports)} }};\n}});\n"
    return body, deps

modules = {}
for f in sorted(os.listdir(SRC)):
    if f.endswith('.js') and f != 'player.js':
        modules[f[:-3]] = transform(f[:-3], read(os.path.join(SRC, f)))

loader = """(function () {
  var defs = {}, cache = {};
  window.__def = function (n, f) { defs[n] = f; };
  window.__req = function (n) {
    if (cache[n]) return cache[n];
    if (!defs[n]) throw new Error('Trailmark: missing module ' + n);
    cache[n] = {};
    var out = defs[n](window.__req);
    cache[n] = out;
    return out;
  };
})();
"""
bundle = loader + ''.join(m[0] for m in modules.values()) + "__req('app');\n"
# Literal "</script" only occurs inside strings (the HTML export template); "<\/" is the same string.
bundle = re.sub(r'</(script)', r'<\\/\1', bundle, flags=re.I)

fonts = read(os.path.join(SRC, 'fonts.css'))
fonts = re.sub(r'url\("\.\./fonts/([\w-]+\.woff)"\)',
               lambda m: f'url("data:font/woff;base64,{b64(os.path.join(ASSETS, m.group(1)))}")', fonts)
player_js = read(os.path.join(SRC, 'player.js'))
player_css = read(os.path.join(SRC, 'player.css'))
for chunk in (player_js, player_css, bundle):
    assert '</script' not in chunk.lower(), 'script terminator inside inline code'


CONFIG = json.load(open(os.path.join(HERE, 'release.json'))) if os.path.exists(os.path.join(HERE, 'release.json')) else {}
VERSION = CONFIG.get('version', '1.0.0')
FEED = CONFIG.get('feed', '')
NOTES = CONFIG.get('notes', [])

logo48 = 'data:image/png;base64,' + b64(os.path.join(ASSETS, 'logo48.png'))
logo32 = 'data:image/png;base64,' + b64(os.path.join(ASSETS, 'logo32.png'))

EXT = os.path.join(HERE, 'ext')
ext_files = {}
for f in sorted(os.listdir(EXT)):
    ext_files[f] = b64(os.path.join(EXT, f)) if f.endswith('.png') else read(os.path.join(EXT, f))
ext_json = json.dumps(ext_files).replace('</', '<\\/')

# Runs first. If this browser holds a newer Demoflow (downloaded by the updater),
# start that one instead. A copy that fails to start is skipped next time.
boot = """(function () {
  window.DF_VERSION = %(v)s;
  window.DF_FEED = %(feed)s;
  document.documentElement.setAttribute('data-demoflow', '1');
  function cmp(a, b) {
    a = String(a).split('.'); b = String(b).split('.');
    for (var i = 0; i < Math.max(a.length, b.length); i++) { var d = (+a[i] || 0) - (+b[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  }
  window.__dfBoot = new Promise(function (go) {
    if (/[?&#]safe\\b/.test(location.href) || window.__dfNested) return go();
    var ls = {};
    try { ls = window.localStorage; } catch (e) { return go(); }
    var q;
    try { q = indexedDB.open('demoflow-app', 1); } catch (e) { return go(); }
    q.onupgradeneeded = function () { q.result.createObjectStore('app'); };
    q.onerror = function () { go(); };
    q.onsuccess = function () {
      var db = q.result, r;
      try { r = db.transaction('app', 'readonly').objectStore('app').get('current'); } catch (e) { db.close(); return go(); }
      r.onerror = function () { db.close(); go(); };
      r.onsuccess = function () {
        var rec = r.result; db.close();
        if (!rec || cmp(rec.version, window.DF_VERSION) <= 0 || ls.getItem('df.bad') === rec.version) return go();
        if (ls.getItem('df.bootPending') === rec.version) { ls.setItem('df.bad', rec.version); ls.removeItem('df.bootPending'); return go(); }
        ls.setItem('df.bootPending', rec.version);
        var html = rec.html.replace('<head>', '<head><script>window.__dfNested=1;window.__dfFrom="stored";<\\/script>');
        // If that copy hasn't started within 12 s, reload: it is then skipped.
        setTimeout(function () { if (ls.getItem('df.bootPending') === rec.version) location.reload(); }, 12000);
        document.open(); document.write(html); document.close();
      };
    };
  });
})();
""" % {'v': json.dumps(VERSION), 'feed': json.dumps(FEED)}

html = f"""<!doctype html>
<html lang="en" data-demoflow-app="{VERSION}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demoflow</title>
<link rel="icon" href="{logo32}">
<link rel="manifest" href="manifest.webmanifest" id="df-manifest">
<meta name="theme-color" content="#1E2A4A">
<script>
{boot}
</script>
<style>
{fonts}
{player_css}
{read(os.path.join(SRC, 'app.css'))}
</style>
<script type="text/plain" id="tm-player-src">{player_js}</script>
<script type="text/plain" id="tm-player-css">{player_css}</script>
<script>
{player_js}
</script>
</head>
<body>
<div id="app"></div>
<noscript>Demoflow needs JavaScript. Open this file in Chrome or Edge.</noscript>
<script>
window.TM_LOGO = {json.dumps(logo48)};
window.DF_EXT = {ext_json};
if (location.protocol === 'file:') {{ var m = document.getElementById('df-manifest'); if (m) m.remove(); }}
else if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {{}});
window.__dfBoot.then(function () {{
{bundle}
}});
</script>
</body>
</html>
"""
assert '</script' not in boot.lower().replace('<\\\\/script', '')
OUT = os.path.join(HERE, 'dist', 'Demoflow.html')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf8').write(html)

# Release folder: what goes into the GitHub repository (or any web host).
import hashlib, shutil
REL = os.path.join(HERE, 'release')
readme = read(os.path.join(REL, 'README.md')) if os.path.exists(os.path.join(REL, 'README.md')) else None
shutil.rmtree(REL, ignore_errors=True)
os.makedirs(REL)
if readme: open(os.path.join(REL, 'README.md'), 'w').write(readme)
data = html.encode('utf8')
open(os.path.join(REL, 'Demoflow.html'), 'wb').write(data)
open(os.path.join(REL, 'index.html'), 'wb').write(data)
json.dump({'version': VERSION, 'url': 'Demoflow.html', 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'notes': NOTES,
           'released': CONFIG.get('released', '')}, open(os.path.join(REL, 'version.json'), 'w'), indent=2)
json.dump({'name': 'Demoflow', 'short_name': 'Demoflow', 'start_url': './', 'display': 'standalone', 'background_color': '#F6F7FB', 'theme_color': '#1E2A4A',
           'icons': [{'src': 'icon-256.png', 'sizes': '256x256', 'type': 'image/png'}, {'src': 'icon-128.png', 'sizes': '128x128', 'type': 'image/png'}]},
          open(os.path.join(REL, 'manifest.webmanifest'), 'w'), indent=2)
shutil.copy(os.path.join(ASSETS, 'logo256.png'), os.path.join(REL, 'icon-256.png'))
shutil.copy(os.path.join(ASSETS, 'logo128.png'), os.path.join(REL, 'icon-128.png'))
shutil.copy(os.path.join(ASSETS, 'logo.svg'), os.path.join(REL, 'logo.svg'))
open(os.path.join(REL, 'sw.js'), 'w').write("""// Demoflow offline cache: network first, so a new release shows up on the next load.
const CACHE = 'demoflow-v1';
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
""")
print(f'Wrote {OUT} ({len(data) / 1024:.0f} KB), version {VERSION}, modules: {", ".join(modules)}')
