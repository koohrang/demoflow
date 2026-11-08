/*! Demoflow player — renders an interactive click-through demo.
 * Usage: TrailmarkPlayer.mount(element, demo, { trackUrl, fit: 'contain'|'width', flat, onEvent })
 * demo.steps[i].image is an image URL; voice.audio is an audio URL (optional).
 */
(function (global) {
  'use strict';

  var ICONS = {
    back: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    restart: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    full: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    sound: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    mute: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor"/><path d="M11 6l3.5 4M14.5 6L11 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    play: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="#1D2433"/></svg>',
    pause: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor"/></svg>',
    resume: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>'
  };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Tiny formatting: **bold**, line breaks.
  function rich(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }
  function safeUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return 'https://' + u;
    return '';
  }
  function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function reduced() { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function contrastInk(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    var n = parseInt(m[1], 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    var L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return L > 0.62 ? '#14231F' : '#fff';
  }

  /* ---------- Tooltip placement (shared with the editor) ---------- */
  // Positions tipEl inside a stage of size W x H, pointing at (ax, ay) in px.
  function layoutTip(tipEl, W, H, ax, ay, placement, gap) {
    gap = gap == null ? 22 : gap;
    var arrow = tipEl.querySelector('.tmp-arrow');
    var tw = tipEl.offsetWidth, th = tipEl.offsetHeight, m = 10;
    var room = { bottom: H - ay - gap - m, top: ay - gap - m, right: W - ax - gap - m, left: ax - gap - m };
    var fits = {
      bottom: room.bottom >= th, top: room.top >= th,
      right: room.right >= tw, left: room.left >= tw
    };
    var side = placement && placement !== 'auto' ? placement : null;
    if (!side) {
      var order = ['bottom', 'top', 'right', 'left'];
      for (var i = 0; i < order.length; i++) if (fits[order[i]]) { side = order[i]; break; }
      if (!side) {
        side = Object.keys(room).sort(function (a, b) {
          var ra = (a === 'left' || a === 'right') ? room[a] / tw : room[a] / th;
          var rb = (b === 'left' || b === 'right') ? room[b] / tw : room[b] / th;
          return rb - ra;
        })[0];
      }
    }
    var x, y;
    if (side === 'bottom' || side === 'top') {
      x = ax - tw / 2;
      y = side === 'bottom' ? ay + gap : ay - gap - th;
    } else {
      y = ay - th / 2;
      x = side === 'right' ? ax + gap : ax - gap - tw;
    }
    x = Math.max(m, Math.min(W - tw - m, x));
    y = Math.max(m, Math.min(H - th - m, y));
    tipEl.style.left = Math.round(x) + 'px';
    tipEl.style.top = Math.round(y) + 'px';
    tipEl.setAttribute('data-side', side);
    if (arrow) {
      arrow.style.left = arrow.style.top = arrow.style.right = arrow.style.bottom = '';
      var overlapsX = ax >= x && ax <= x + tw, overlapsY = ay >= y && ay <= y + th;
      arrow.style.display = (overlapsX && overlapsY) ? 'none' : '';
      if (side === 'bottom' || side === 'top') {
        arrow.style.left = Math.max(14, Math.min(tw - 28, ax - x - 7)) + 'px';
        arrow.style[side === 'bottom' ? 'top' : 'bottom'] = '-6px';
      } else {
        arrow.style.top = Math.max(14, Math.min(th - 28, ay - y - 7)) + 'px';
        arrow.style[side === 'right' ? 'left' : 'right'] = '-6px';
      }
    }
    return side;
  }

  /* ---------- Player ---------- */
  // Arrows, boxes and labels drawn over a screenshot. Positions are fractions.
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function annotations(list, imgW, imgH) {
    var VW = 1000, VH = Math.round(1000 * ((imgH || 800) / (imgW || 1280)));
    var wrap = el('div', 'tmp-annos');
    var svg = svgEl('svg', { viewBox: '0 0 ' + VW + ' ' + VH, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    wrap.append(svg);
    (list || []).forEach(function (a) {
      var col = a.color || '#E5484D';
      if (a.kind === 'box') {
        svg.append(svgEl('rect', { x: a.x * VW, y: a.y * VH, width: a.w * VW, height: a.h * VH, rx: 7, fill: col, 'fill-opacity': 0.08, stroke: col, 'stroke-width': 4 }));
      } else if (a.kind === 'arrow') {
        var x1 = a.x1 * VW, y1 = a.y1 * VH, x2 = a.x2 * VW, y2 = a.y2 * VH;
        var ang = Math.atan2(y2 - y1, x2 - x1), L = 24, Wd = 13;
        var bx = x2 - Math.cos(ang) * L, by = y2 - Math.sin(ang) * L;
        svg.append(svgEl('line', { x1: x1, y1: y1, x2: bx, y2: by, stroke: col, 'stroke-width': 5, 'stroke-linecap': 'round' }));
        var px = Math.sin(ang) * Wd, py = -Math.cos(ang) * Wd;
        svg.append(svgEl('polygon', { points: [x2, y2, bx + px, by + py, bx - px, by - py].join(' '), fill: col, 'stroke-linejoin': 'round', stroke: col, 'stroke-width': 2 }));
      } else if (a.kind === 'label') {
        var lb = el('div', 'tmp-label');
        lb.textContent = a.text || 'Label';
        lb.style.left = a.x * 100 + '%'; lb.style.top = a.y * 100 + '%';
        lb.style.background = col; lb.style.color = contrastInk(col);
        lb.dataset.id = a.id || '';
        wrap.append(lb);
      }
    });
    return wrap;
  }

  function Player(container, demo, opts) {
    this.c = container;
    this.demo = demo;
    this.o = opts || {};
    this.steps = demo.steps || [];
    this.idx = -1;
    this.history = [];
    this.seen = {};
    this.muted = false;
    this.sid = rid();
    this.vid = this._visitorId();
    this.voiceMode = (demo.settings && demo.settings.voice) || 'off';
    this.hasAuto = (this.steps || []).some(function (x) { return x.play === 'auto' || x.type === 'video'; });
    // A walkthrough that plays by itself waits for a Play click first.
    var firstAuto = this.steps[0] && (this.steps[0].play === 'auto' || this.steps[0].type === 'video');
    this.gate = (demo.gate && demo.gate.enabled && !this.o.noGate && !this._gatePassed()) ? demo.gate : null;
    this.started = (this.voiceMode === 'off' && !firstAuto && !demo.music && !this.gate) || !!this.o.skipStart;
    this.zoomState = { z: 1, ox: 0, oy: 0 };
    this.paused = false;
    this._build();
    this._track('view', {});
    var start = 0;
    if (this.o.startStep) {
      var si = this._indexOf(this.o.startStep);
      if (si >= 0) start = si;
    }
    if (!this.steps.length) { this._empty(); return; }
    if (this.started) this.go(start, true); else this._showStart(start);
  }

  Player.prototype._visitorId = function () {
    try {
      var k = 'tm_vid', v = global.localStorage.getItem(k);
      if (!v) { v = rid(); global.localStorage.setItem(k, v); }
      return v;
    } catch (e) { return this.sid; }
  };

  Player.prototype._gatePassed = function () {
    try { return !!global.localStorage.getItem('tm_gate_' + (this.demo.publicId || this.demo.id)); } catch (e) { return false; }
  };

  Player.prototype._build = function () {
    var d = this.demo, t = d.theme || {}, s = d.settings || {};
    var root = this.root = el('div', 'tmp-root' + (this.o.fit === 'width' ? ' tmp-fit-width' : '') + (this.o.flat ? ' tmp-flat' : ''));
    root.tabIndex = 0;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', (d.title || 'Interactive demo'));
    if (t.accent) { root.style.setProperty('--tmp-accent', t.accent); root.style.setProperty('--tmp-accent-ink', contrastInk(t.accent)); }
    if (t.hotspot) root.style.setProperty('--tmp-hot', t.hotspot);
    if (t.tooltipBg) root.style.setProperty('--tmp-tip-bg', t.tooltipBg);
    if (t.tooltipText) root.style.setProperty('--tmp-tip-ink', t.tooltipText);
    if (t.radius != null) root.style.setProperty('--tmp-radius', t.radius + 'px');
    if (t.font) root.style.setProperty('--tmp-font', t.font);

    this.frame = el('div', 'tmp-frame');
    this.stage = el('div', 'tmp-stage');
    this.imgA = el('img', 'tmp-img'); this.imgB = el('img', 'tmp-img tmp-out');
    this.imgA.alt = ''; this.imgB.alt = '';
    this.imgA.draggable = false; this.imgB.draggable = false;
    this.blurLayer = el('div', 'tmp-blurs');
    this.annoLayer = el('div', 'tmp-annos-wrap');
    this.cam = el('div', 'tmp-cam');
    this.cam.append(this.imgA, this.imgB, this.blurLayer, this.annoLayer);
    this.stage.append(this.cam);
    var brand = d.brand || {};
    if (brand.logo) {
      var lg = el('img', 'tmp-brand tmp-brand-' + (brand.position || 'tl'));
      lg.src = brand.logo; lg.alt = brand.name || '';
      this.brandEl = lg;
    }
    if (d.music && d.music.src) {
      this.music = new Audio(d.music.src);
      this.music.loop = true;
      this.music.volume = Math.max(0, Math.min(1, d.music.volume != null ? +d.music.volume : 0.25));
    }
    this.live = el('div', 'tmp-sr'); this.live.setAttribute('aria-live', 'polite');
    this.frame.append(this.stage, this.live);
    if (this.brandEl) this.frame.append(this.brandEl);

    if (s.showProgress !== false) {
      this.progress = el('div', 'tmp-progress', '<i></i>');
      this.frame.append(this.progress);
    }
    var ctr = el('div', 'tmp-controls');
    var self = this;
    if (this.voiceMode !== 'off' || this.music) {
      this.soundBtn = this._ctrl(ICONS.sound, 'Mute sound', function () { self.setMuted(!self.muted); });
      ctr.append(this.soundBtn);
    }
    if (this.hasAuto) {
      this.pauseBtn = this._ctrl(ICONS.pause, 'Pause', function () { self.setPaused(!self.paused); });
      ctr.append(this.pauseBtn);
    }
    ctr.append(this._ctrl(ICONS.restart, 'Restart demo', function () { self.restart(); }));
    if (!this.o.noFullscreen && document.fullscreenEnabled) {
      ctr.append(this._ctrl(ICONS.full, 'Full screen', function () {
        if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen && root.requestFullscreen();
      }));
    }
    this.frame.append(ctr);
    root.append(this.frame);
    this.c.innerHTML = '';
    this.c.append(root);

    this._onKey = function (e) {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); self.next(); }
      else if (e.key === ' ' && self.hasAuto && !/button|a/i.test(e.target.tagName)) { e.preventDefault(); self.setPaused(!self.paused); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); self.back(); }
    };
    (this.o.globalKeys ? document : root).addEventListener('keydown', this._onKey);
    this._ro = new ResizeObserver(function () { self._fit(); });
    this._ro.observe(this.o.fit === 'width' ? root : this.c);
    document.addEventListener('fullscreenchange', this._fs = function () { self._fit(); });
  };

  Player.prototype._ctrl = function (icon, label, fn) {
    var b = el('button', 'tmp-ctrl', icon);
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  };

  Player.prototype._aspect = function () {
    var st = this.steps[this.idx];
    var visual = function (x) { return x && (x.type === 'screen' || x.type === 'video') && x.imgW && x.imgH; };
    if (!visual(st)) {
      st = null;
      for (var i = 0; i < this.steps.length; i++) if (visual(this.steps[i])) { st = this.steps[i]; break; }
    }
    if (st) return st.imgW / st.imgH;
    return 16 / 10;
  };

  Player.prototype._fit = function () {
    var ar = this._aspect();
    var w, h;
    if (this.o.fit === 'width' && !document.fullscreenElement) {
      w = this.root.clientWidth; h = w / ar;
    } else {
      var box = document.fullscreenElement === this.root ? this.root : this.c;
      var cs = global.getComputedStyle(box);
      var cw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var ch = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (!ch) { w = cw; h = cw / ar; } else if (cw / ch > ar) { h = ch; w = ch * ar; } else { w = cw; h = cw / ar; }
    }
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    if (w === this._w && h === this._h) return;
    this._w = w; this._h = h;
    this.frame.style.width = w + 'px';
    this.frame.style.height = h + 'px';
    this.root.style.setProperty('--tmp-w', w + 'px');
    this.root.classList.toggle('tmp-docked', w < 560);
    this._layout();
  };

  // Opening and closing cards aren't counted as steps.
  Player.prototype._content = function () {
    return this.steps.filter(function (x) { return !x.role; });
  };
  Player.prototype._label = function (i) {
    var c = this._content(), n = c.indexOf(this.steps[i]);
    return n < 0 ? '' : (n + 1) + ' of ' + c.length;
  };

  Player.prototype._indexOf = function (id) {
    for (var i = 0; i < this.steps.length; i++) if (this.steps[i].id === id) return i;
    return -1;
  };

  Player.prototype._clearOverlays = function () {
    var kill = this.stage.querySelectorAll('.tmp-beacon,.tmp-spot,.tmp-area,.tmp-tip,.tmp-overlay,.tmp-video,.tmp-skip');
    for (var i = 0; i < kill.length; i++) kill[i].remove();
    this.blurLayer.innerHTML = '';
    this.annoLayer.innerHTML = '';
    this.tip = null; this.anchor = null;
  };

  Player.prototype._empty = function () {
    this._fit();
    var o = this._overlay(null);
    o.querySelector('.tmp-card').innerHTML = '<h2>This demo has no steps yet</h2>';
  };

  Player.prototype._overlay = function (bgUrl) {
    var o = el('div', 'tmp-overlay');
    var bg = el('div', 'tmp-bg');
    if (bgUrl) bg.style.backgroundImage = 'url("' + String(bgUrl).replace(/"/g, '%22') + '")';
    o.append(bg, el('div', 'tmp-veil'), el('div', 'tmp-card'));
    this.stage.append(o);
    requestAnimationFrame(function () { o.classList.add('tmp-in'); });
    return o;
  };

  Player.prototype._bgFor = function (i) {
    for (var k = i; k < this.steps.length; k++) if (this.steps[k].type !== 'chapter' && this.steps[k].image) return this.steps[k].image;
    for (k = i; k >= 0; k--) if (this.steps[k].type !== 'chapter' && this.steps[k].image) return this.steps[k].image;
    return '';
  };

  Player.prototype._showStart = function (startIdx) {
    var self = this;
    this._fit();
    var o = this._overlay(this._bgFor(startIdx));
    o.classList.add('tmp-start');
    var card = o.querySelector('.tmp-card');
    var play = el('button', 'tmp-play', ICONS.play);
    play.type = 'button'; play.setAttribute('aria-label', 'Start the demo');
    var h = el('h2'); h.textContent = this.demo.title || 'Interactive demo';
    var p = el('p'); p.textContent = this.voiceMode !== 'off' ? 'Click to start. This tour has a voiceover.' : 'Click to play this walkthrough.';
    card.append(play, h, p);
    var go = function () { self.started = true; self._unlockAudio(); self._startMusic(); o.remove(); self.go(startIdx, true); };
    if (this.gate) { card.innerHTML = ''; this._gateForm(card, go); return; }
    play.addEventListener('click', go);
    card.addEventListener('click', function (e) { if (e.target === card) go(); });
    setTimeout(function () { try { play.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 50);
  };

  Player.prototype._gateForm = function (card, go) {
    var self = this, g = this.gate;
    var h = el('h2'); h.textContent = g.title || this.demo.title || 'Interactive demo';
    card.append(h);
    if (g.text) { var p = el('p'); p.textContent = g.text; card.append(p); }
    var f = el('form', 'tmp-gate');
    f.noValidate = true;
    var fields = [];
    if (g.askName) fields.push({ k: 'name', label: 'Your name', type: 'text', ac: 'name' });
    fields.push({ k: 'email', label: 'Work email', type: 'email', ac: 'email' });
    if (g.askCompany) fields.push({ k: 'company', label: 'Company', type: 'text', ac: 'organization' });
    var inputs = {};
    fields.forEach(function (fd) {
      var lab = el('label', 'tmp-field');
      var sp = el('span'); sp.textContent = fd.label;
      var inp = el('input'); inp.type = fd.type; inp.name = fd.k; inp.autocomplete = fd.ac; inp.required = true;
      lab.append(sp, inp); f.append(lab); inputs[fd.k] = inp;
    });
    var err = el('div', 'tmp-gate-err'); err.setAttribute('role', 'alert');
    var b = el('button', 'tmp-btn', esc(g.button || 'Start the demo') + ICONS.next); b.type = 'submit';
    f.append(err, b);
    if (g.privacy) { var sm = el('small', 'tmp-gate-note'); sm.textContent = g.privacy; f.append(sm); }
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {};
      for (var k in inputs) data[k] = inputs[k].value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { err.textContent = 'Please enter a valid email address.'; inputs.email.focus(); return; }
      if (g.askName && !data.name) { err.textContent = 'Please enter your name.'; inputs.name.focus(); return; }
      data.demo = self.demo.title || ''; data.at = new Date().toISOString(); data.page = String(global.location && global.location.href || '');
      self._track('lead', { email: data.email, name: data.name || '', company: data.company || '' });
      var hook = safeUrl(g.webhook);
      if (hook) { try { fetch(hook, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(data) }); } catch (x) { /* ignore */ } }
      if (self.o.onLead) { try { self.o.onLead(data); } catch (x) { /* ignore */ } }
      try { global.localStorage.setItem('tm_gate_' + (self.demo.publicId || self.demo.id), '1'); } catch (x) { /* ignore */ }
      self.gate = null;
      go();
    });
    card.append(f);
    setTimeout(function () { try { f.querySelector('input').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 60);
  };

  Player.prototype._startMusic = function () {
    if (!this.music || this.muted) return;
    try { var p = this.music.play(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ }
  };

  /* ---------- Zoom: the camera moves in on the hotspot ---------- */
  Player.prototype._setZoom = function (z, fx, fy, ms) {
    z = Math.max(1, z || 1);
    var ox = z > 1 ? Math.max(0, Math.min(1 - 1 / z, fx - 0.5 / z)) : 0;
    var oy = z > 1 ? Math.max(0, Math.min(1 - 1 / z, fy - 0.5 / z)) : 0;
    var st = this.zoomState;
    if (st.z === z && st.ox === ox && st.oy === oy) return;
    this.zoomState = { z: z, ox: ox, oy: oy };
    var c = this.cam;
    c.style.transition = reduced() ? 'none' : 'transform ' + (ms == null ? 700 : ms) + 'ms cubic-bezier(.45,0,.2,1)';
    c.style.transform = z > 1 ? 'scale(' + z + ') translate(' + (-ox * 100) + '%,' + (-oy * 100) + '%)' : '';
    c.style.setProperty('--tmp-z', z);
  };
  Player.prototype._map = function (x, y) {
    var s = this.zoomState;
    return { x: (x - s.ox) * s.z, y: (y - s.oy) * s.z };
  };
  Player.prototype._zoomFor = function (step) {
    var zm = step.zoom;
    if (!zm || !(zm.scale > 1)) { this._setZoom(1, 0, 0, 500); return false; }
    var fx = step.hotspot ? step.hotspot.x : 0.5, fy = step.hotspot ? step.hotspot.y : 0.5;
    if (step.highlight && step.hotspot && (step.hotspot.style === 'area' || step.hotspot.style === 'spotlight')) {
      fx = step.highlight.x + step.highlight.w / 2; fy = step.highlight.y + step.highlight.h / 2;
    }
    if (zm.x != null) { fx = zm.x; fy = zm.y; }
    this._setZoom(zm.scale, fx, fy);
    return true;
  };

  Player.prototype._unlockAudio = function () {
    if (!this.audio) this.audio = new Audio();
    try { this.audio.muted = true; var p = this.audio.play(); if (p && p.catch) p.catch(function () {}); this.audio.pause(); this.audio.muted = false; } catch (e) { /* ignore */ }
  };

  Player.prototype.go = function (i, noHistory) {
    if (i < 0 || i >= this.steps.length) return;
    if (!noHistory && this.idx >= 0 && this.idx !== i) this.history.push(this.idx);
    if (noHistory === true && this.idx === -1) this.history = [];
    this.idx = i;
    clearTimeout(this._playT);
    this._pendingAdvance = null;
    this._stopVoice();
    var step = this.steps[i];
    if (!this.seen[i]) { this.seen[i] = 1; this._track('step', { step: i, stepId: step.id }); }
    if (this.progress) {
      var pct = this.steps.length > 1 ? (i / (this.steps.length - 1)) * 100 : 100;
      this.progress.firstChild.style.width = pct + '%';
    }
    this._clearOverlays();
    this._fit();
    if (!(step.type === 'screen' && step.zoom && step.zoom.scale > 1)) this._setZoom(1, 0, 0, 450);
    if (step.type === 'chapter') { this._dropMotion(); this._renderChapter(step, i); }
    else if (step.type === 'video') this._renderVideoStep(step, i);
    else this._renderScreen(step, i);
    this._preload(i);
    if (this.o.onStep) this.o.onStep(i, step);
  };

  Player.prototype._preload = function (i) {
    for (var k = i + 1; k < Math.min(this.steps.length, i + 3); k++) {
      if (this.steps[k].image) { var im = new Image(); im.src = this.steps[k].image; }
    }
  };

  Player.prototype._swapImage = function (src, done) {
    var front = this.imgA.classList.contains('tmp-out') ? this.imgB : this.imgA;
    var back = front === this.imgA ? this.imgB : this.imgA;
    if (front.getAttribute('src') === src) { done(); return; }
    var called = false;
    var fin = function () {
      if (called) return; called = true;
      back.classList.remove('tmp-out');
      front.classList.add('tmp-out');
      done();
    };
    back.onload = fin; back.onerror = fin;
    back.src = src;
    if (back.complete && back.naturalWidth) fin();
  };

  Player.prototype._renderScreen = function (step, i) {
    var self = this, token = {};
    this._token = token;
    this._swapImage(step.image || '', function () {
      if (self._token !== token) return;
      self._dropMotion();
      self._renderScreenOverlay(step, i);
    });
  };

  /* ---------- Recorded movement (plays after the hotspot is clicked) ---------- */
  // Fade the finished clip away to reveal the next screenshot underneath.
  Player.prototype._dropMotion = function () {
    var m = this.stage.querySelectorAll('.tmp-motion:not(.tmp-gone),.tmp-skip');
    for (var k = 0; k < m.length; k++) {
      var node = m[k];
      if (node.classList.contains('tmp-skip') || reduced()) { node.remove(); continue; }
      node.classList.add('tmp-gone');
      (function (n) { setTimeout(function () { n.remove(); }, 200); })(node);
    }
  };

  Player.prototype._advance = function (step) {
    var self = this, m = step.motion;
    var go = function () { self._do(step.next || { type: 'next' }, step); };
    if (!m || !m.video || m.play === false) { go(); return; }
    this._playMotion(m, go);
  };

  Player.prototype._motionVideo = function (src) {
    var v = el('video', 'tmp-motion');
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.setAttribute('aria-label', 'Recorded movement. Click to skip.');
    v.src = src;
    return v;
  };

  // Start loading the next movement clip while the viewer reads this step.
  Player.prototype._preloadMotion = function (step) {
    var m = step.motion;
    if (!m || !m.video || m.play === false) { this._pre = null; return; }
    var t0 = Math.max(0, +m.start || 0);
    if (this._pre && this._pre.getAttribute('src') === m.video && this._preAt === t0) return;
    var v = this._pre = this._motionVideo(m.video);
    this._preAt = t0;
    try { v.load(); } catch (e) { /* ignore */ }
    if (t0 > 0) v.addEventListener('loadedmetadata', function () { if (Math.abs(v.currentTime - t0) > 0.04) { try { v.currentTime = t0; } catch (e) { /* ignore */ } } }, { once: true });
  };

  Player.prototype._playMotion = function (m, done) {
    var self = this, token = {}, finished = false, timer;
    this._token = token;
    this._stopVoice();
    this._clearOverlays();
    this._dropMotion();
    this._setZoom(1, 0, 0, 350);
    var t0 = Math.max(0, +m.start || 0), t1 = m.end != null && +m.end > t0 ? +m.end : 0;
    var v = (this._pre && this._pre.getAttribute('src') === m.video && this._preAt === t0) ? this._pre : this._motionVideo(m.video);
    this._pre = null;
    var skip = el('button', 'tmp-skip', 'Skip');
    skip.type = 'button';
    var fin = function () {
      if (finished) return;
      finished = true; clearTimeout(timer); if (poll) clearInterval(poll);
      if (self._token !== token) return;
      try { v.pause(); } catch (e) { /* ignore */ }
      skip.remove();
      done(); // the next step removes the video once its screenshot is showing
    };
    // Reveal only when a frame is actually on screen: the screenshot underneath
    // stays visible until then, so there is never a blank flash.
    var shown = false;
    var reveal = function () { if (!shown) { shown = true; v.classList.add('tmp-on'); } };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(reveal);
    v.addEventListener('playing', function () { requestAnimationFrame(function () { requestAnimationFrame(reveal); }); });
    v.addEventListener('ended', fin);
    v.addEventListener('error', fin);
    v.addEventListener('click', fin);
    skip.addEventListener('click', function (e) { e.stopPropagation(); fin(); });
    // Stop at the trim point. A recording has no new frames while the screen is
    // still, so check the clock rather than waiting for the next frame.
    var poll = null;
    if (t1) {
      poll = setInterval(function () {
        if (finished || !v.isConnected && self._token !== token) { clearInterval(poll); return; }
        if (v.currentTime >= t1 - 0.03) { clearInterval(poll); fin(); }
      }, 20);
    }
    this.stage.append(v, skip);
    this._motionEl = v;
    // Play only once the video sits at its start point, so no earlier frame flashes.
    var go = function () {
      if (finished || self._token !== token || self.paused) return;
      var p = v.play(); if (p && p.catch) p.catch(function () { if (!self.paused) fin(); });
    };
    var ready = v.readyState >= 1 && !v.seeking && Math.abs(v.currentTime - t0) <= 0.04;
    if (ready || t0 <= 0) { if (t0 <= 0 && v.currentTime > 0.04) { try { v.currentTime = 0; } catch (e) { /* ignore */ } } go(); }
    else {
      v.addEventListener('seeked', function once() { if (Math.abs(v.currentTime - t0) <= 0.05) { v.removeEventListener('seeked', once); go(); } });
      var seek = function () { if (Math.abs(v.currentTime - t0) > 0.04 || !v.seeking) { try { v.currentTime = t0; } catch (e) { /* ignore */ } } };
      if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
    }
    timer = setTimeout(function check() {
      if (self.paused) { timer = setTimeout(check, 1000); return; }
      fin();
    }, (((t1 || m.dur || 8) - t0) + 4) * 1000);
    this.live.textContent = 'Playing recorded movement';
  };

  /* ---------- Video-only step: no clicks, plays by itself ---------- */
  Player.prototype._renderAutoScreen = function (step, i) {
    var self = this;
    this.anchor = null;
    var text = step.caption && step.tooltip && step.tooltip.text;
    if (text) {
      var tip = this.tip = el('div', 'tmp-tip tmp-cap tmp-cap-only');
      tip.append(el('p', 'tmp-text', rich(text)));
      this.anchor = { cap: true, x: 0.5, y: 1 };
      this.stage.append(tip);
      this._layout();
      requestAnimationFrame(function () { tip.classList.add('tmp-in'); });
      this.live.textContent = text.replace(/\*\*/g, '');
    } else this.live.textContent = 'Step ' + (i + 1);
    this._playVoice(step);
    this._scheduleAuto(step);
  };

  Player.prototype._scheduleAuto = function (step) {
    var self = this, idx = this.idx;
    clearTimeout(this._playT);
    if (this.paused || !this.started) return;
    var hasMotion = step.motion && step.motion.video && step.motion.play !== false;
    var hold = step.hold != null ? +step.hold : 0.8;
    if (!hasMotion) hold = Math.max(hold, 2.5); // nothing to play: give the screen a moment
    this._playT = setTimeout(function () {
      if (self.idx !== idx || self.atEnd || self.paused) return;
      if (self._voiceBusy) { self._pendingAdvance = step; return; } // let the narration finish
      self._advance(step);
    }, hold * 1000);
  };

  Player.prototype.setPaused = function (p) {
    this.paused = p;
    if (this.pauseBtn) {
      this.pauseBtn.innerHTML = p ? ICONS.resume : ICONS.pause;
      this.pauseBtn.setAttribute('aria-label', p ? 'Play' : 'Pause');
      this.pauseBtn.title = p ? 'Play' : 'Pause';
    }
    var m = this.stage.querySelector('.tmp-motion:not(.tmp-gone)'), vid = this.stage.querySelector('.tmp-video');
    var media = (m && this._motionEl === m) ? m : vid;
    if (p) {
      clearTimeout(this._playT);
      if (media) media.pause();
      if (this.audio) { try { this.audio.pause(); } catch (e) { /* ignore */ } }
      if (global.speechSynthesis) global.speechSynthesis.pause();
      if (this.music) this.music.pause();
    } else {
      if (this.music && !this.muted && this.started) this._startMusic();
      if (global.speechSynthesis) global.speechSynthesis.resume();
      if (this.audio && this.audio.src && !this.audio.ended && this._voiceBusy) { var a = this.audio.play(); if (a && a.catch) a.catch(function () {}); }
      if (media && !media.ended) { var q = media.play(); if (q && q.catch) q.catch(function () {}); }
      else {
        var st = this.steps[this.idx];
        if (st && st.play === 'auto' && st.type === 'screen' && !this.atEnd) this._scheduleAuto(st);
      }
    }
  };

  /* ---------- Video clip step ---------- */
  Player.prototype._renderVideoStep = function (step, i) {
    var self = this, token = {};
    this._token = token;
    this._swapImage(step.image || '', function () {
      if (self._token !== token) return;
      self._dropMotion();
      var v = el('video', 'tmp-video');
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
      if (step.image) v.poster = step.image;
      v.setAttribute('aria-label', 'Video clip. Click to pause or play.');
      v.addEventListener('click', function () { if (v.paused) v.play(); else v.pause(); });
      v.addEventListener('ended', function () {
        if (self._token !== token || self.atEnd || step.autoNext === false) return;
        setTimeout(function () { if (self._token === token && !self.atEnd) self._do(step.next || { type: 'next' }, step); }, 600);
      });
      v.src = step.video || '';
      self.stage.insertBefore(v, self.blurLayer);
      if (!self.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      var text = step.tooltip && step.tooltip.text;
      var tip = self.tip = el('div', 'tmp-tip tmp-cap');
      tip.setAttribute('role', 'dialog');
      tip.setAttribute('aria-label', 'Step ' + (i + 1));
      if (text) { tip.append(el('p', 'tmp-text', rich(text))); self.live.textContent = text.replace(/\*\*/g, ''); }
      else self.live.textContent = 'Video clip';
      if (step.buttons && step.buttons.length) tip.append(self._buttons(step));
      tip.append(self._footer(i, step));
      self.anchor = { cap: true, x: 0.5, y: 1 };
      self.stage.append(tip);
      self._layout();
      requestAnimationFrame(function () { tip.classList.add('tmp-in'); });
      self._playVoice(step);
    });
  };

  Player.prototype._renderScreenOverlay = function (step, i) {
    var self = this;
    (step.blurs || []).forEach(function (b) {
      var d = el('div', 'tmp-blur');
      d.style.left = b.x * 100 + '%'; d.style.top = b.y * 100 + '%';
      d.style.width = b.w * 100 + '%'; d.style.height = b.h * 100 + '%';
      self.blurLayer.append(d);
    });
    if (step.annotations && step.annotations.length) this.annoLayer.append(annotations(step.annotations, step.imgW, step.imgH));
    this._preloadMotion(step);
    var zoomed = this._zoomFor(step);
    if (step.play === 'auto') { this._renderAutoScreen(step, i); return; }
    var hs = step.hotspot || { x: 0.5, y: 0.5, style: 'beacon' };
    var style = hs.style || 'beacon';
    // Keep the player's buttons off a hotspot in the top-right corner.
    var hx = hs.x, hy = hs.y;
    if (step.highlight && (style === 'area' || style === 'spotlight')) { hx = step.highlight.x + step.highlight.w; hy = step.highlight.y; }
    var mz = this._map(hx, hy);
    this.root.classList.toggle('tmp-ctl-low', style !== 'none' && mz.x * this._w > this._w - 190 && mz.y * this._h < 70);
    var act = function (e) { if (e) e.stopPropagation(); self._advance(step); };
    var label = (step.tooltip && step.tooltip.text) ? step.tooltip.text.replace(/\*\*/g, '') : 'Continue';
    if ((style === 'spotlight' || style === 'area') && step.highlight) {
      var sp = el('button', style === 'area' ? 'tmp-area' : 'tmp-spot');
      sp.type = 'button';
      sp.setAttribute('aria-label', label);
      var h = step.highlight;
      sp.style.left = h.x * 100 + '%'; sp.style.top = h.y * 100 + '%';
      sp.style.width = h.w * 100 + '%'; sp.style.height = h.h * 100 + '%';
      sp.addEventListener('click', act);
      this.cam.append(sp);
      this.anchor = { x: hs.x, y: hs.y, spot: h };
    } else {
      if (style !== 'none') {
        var b = el('button', 'tmp-beacon', '<span class="tmp-ring"></span><span class="tmp-ring"></span><span class="tmp-core"></span>');
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.style.left = hs.x * 100 + '%'; b.style.top = hs.y * 100 + '%';
        b.addEventListener('click', act);
        this.cam.append(b);
      }
      this.anchor = { x: hs.x, y: hs.y };
    }
    var text = step.tooltip && step.tooltip.text;
    if (text || (step.buttons && step.buttons.length)) {
      var tip = this.tip = el('div', 'tmp-tip');
      tip.setAttribute('role', 'dialog');
      tip.setAttribute('aria-label', 'Step ' + (i + 1));
      tip.append(el('span', 'tmp-arrow'));
      if (text) { var p = el('p', 'tmp-text', rich(text)); tip.append(p); this.live.textContent = text.replace(/\*\*/g, ''); }
      if (step.buttons && step.buttons.length) tip.append(this._buttons(step));
      tip.append(this._footer(i, step));
      this.stage.append(tip);
      this._layout();
      var showTip = function () { tip.classList.add('tmp-in'); };
      if (zoomed && !reduced()) setTimeout(function () { requestAnimationFrame(showTip); }, 380); else requestAnimationFrame(showTip);
    } else {
      this.live.textContent = 'Step ' + (i + 1);
    }
    this._playVoice(step);
  };

  Player.prototype._buttons = function (step) {
    var self = this, row = el('div', 'tmp-ctas');
    step.buttons.forEach(function (bt) {
      var b = el('button', 'tmp-btn' + (bt.style === 'primary' ? '' : ' tmp-secondary'));
      b.type = 'button'; b.textContent = bt.label || 'Continue';
      b.addEventListener('click', function (e) { e.stopPropagation(); self._do(bt.action || { type: 'next' }, step, bt); });
      row.append(b);
    });
    return row;
  };

  Player.prototype._footer = function (i, step) {
    var self = this, s = this.demo.settings || {};
    var f = el('div', 'tmp-foot');
    var c = el('span', 'tmp-count');
    if (s.showStepCount !== false) c.textContent = this._label(i);
    f.append(c);
    if (s.showBack !== false && this.history.length) {
      var bk = el('button', 'tmp-btn tmp-icon', ICONS.back);
      bk.type = 'button'; bk.setAttribute('aria-label', 'Previous step'); bk.title = 'Back';
      bk.addEventListener('click', function (e) { e.stopPropagation(); self.back(); });
      f.append(bk);
    }
    var last = i === this.steps.length - 1 && (!step.next || step.next.type === 'next');
    var nx = el('button', 'tmp-btn', esc(last ? 'Finish' : 'Next') + ' ' + ICONS.next);
    nx.type = 'button';
    nx.addEventListener('click', function (e) { e.stopPropagation(); if (step.type === 'screen') self._advance(step); else self._do(step.next || { type: 'next' }, step); });
    f.append(nx);
    return f;
  };

  Player.prototype._layout = function () {
    if (!this.tip || !this.anchor) return;
    var W = this._w, H = this._h;
    if (this.anchor.cap) {
      var cw = this.tip.offsetWidth, chh = this.tip.offsetHeight;
      this.tip.style.left = Math.round(Math.max(10, (W - cw) / 2)) + 'px';
      this.tip.style.top = Math.round(Math.max(10, H - chh - 16)) + 'px';
      return;
    }
    if (this.root.classList.contains('tmp-docked')) {
      var ay = this._map(this.anchor.x, this.anchor.y).y * H;
      this.tip.style.top = ''; this.tip.style.bottom = '';
      var th = this.tip.offsetHeight;
      this.tip.style.top = (ay > H / 2 ? 10 : Math.max(10, H - th - 14)) + 'px';
      return;
    }
    var z = this.zoomState.z, mp = this._map(this.anchor.x, this.anchor.y);
    var ax = mp.x * W, ayy = mp.y * H, gap = 22;
    var step = this.steps[this.idx] || {};
    if (this.anchor.spot) {
      var s0 = this.anchor.spot, m0 = this._map(s0.x, s0.y);
      var sp = { x: m0.x, y: m0.y, w: s0.w * z, h: s0.h * z };
      // Anchor to the spotlight edge so the box isn't covered.
      var cx = (sp.x + sp.w / 2) * W, cy = (sp.y + sp.h / 2) * H;
      ax = cx; ayy = cy;
      gap = Math.max(sp.w * W, sp.h * H) / 2 + 14;
      var pl = (step.tooltip && step.tooltip.placement) || 'auto';
      if (pl === 'auto') {
        // choose vertical side by default for spotlight
        var below = H - (sp.y + sp.h) * H, above = sp.y * H;
        pl = below >= above ? 'bottom' : 'top';
        gap = (pl === 'bottom' ? (sp.h * H) / 2 : (sp.h * H) / 2) + 14;
      } else if (pl === 'left' || pl === 'right') gap = (sp.w * W) / 2 + 14; else gap = (sp.h * H) / 2 + 14;
      layoutTip(this.tip, W, H, ax, ayy, pl, gap);
      return;
    }
    if (step.hotspot && step.hotspot.style === 'none') gap = 10;
    layoutTip(this.tip, W, H, ax, ayy, (step.tooltip && step.tooltip.placement) || 'auto', gap);
  };

  Player.prototype._renderChapter = function (step, i) {
    var self = this;
    var bg = step.bgImage || this._bgFor(i);
    // Keep the stage image in sync so the frame doesn't look empty behind the blur.
    if (bg) this._swapImage(bg, function () {});
    var o = this._overlay(bg);
    if (step.role) o.classList.add('tmp-' + step.role);
    var card = o.querySelector('.tmp-card');
    if (step.role === 'opening') {
      var n = this._content().length;
      card.append(el('div', 'tmp-meta', esc(n + ' step' + (n === 1 ? '' : 's'))));
    }
    var h = el('h2'); h.textContent = step.title || '';
    card.append(h);
    if (step.text) { var p = el('p', null, rich(step.text)); card.append(p); }
    if (step.role === 'closing' && !this._completed) { this._completed = true; this._track('complete', {}); }
    var btns = (step.buttons && step.buttons.length) ? step.buttons : [{ label: 'Continue', style: 'primary', action: { type: 'next' } }];
    // A link button with no link yet stays hidden.
    btns = btns.filter(function (bt) { return !(bt.action && bt.action.type === 'url' && !safeUrl(bt.action.url)); });
    var box = el('div', 'tmp-choices');
    btns.forEach(function (bt) {
      var ic = bt.action && bt.action.type === 'restart' ? ICONS.restart : ICONS.next;
      var b = el('button', 'tmp-btn' + (bt.style === 'primary' ? '' : ' tmp-secondary'), esc(bt.label || 'Continue') + ic);
      b.type = 'button';
      b.addEventListener('click', function () { self._do(bt.action || { type: 'next' }, step, bt); });
      box.append(b);
    });
    card.append(box);
    var s = this.demo.settings || {};
    if (!step.role && (s.showStepCount !== false || (s.showBack !== false && this.history.length))) {
      var f = el('div', 'tmp-foot');
      var c = el('span', 'tmp-count');
      if (s.showStepCount !== false) c.textContent = this._label(i);
      f.append(c);
      if (s.showBack !== false && this.history.length) {
        var bk = el('button', 'tmp-btn tmp-icon', ICONS.back + ' Back');
        bk.type = 'button';
        bk.addEventListener('click', function () { self.back(); });
        f.append(bk);
      }
      card.append(f);
    }
    this.live.textContent = (step.title || '') + '. ' + (step.text || '');
    setTimeout(function () { var first = box.querySelector('button'); if (first && self.root.contains(document.activeElement)) first.focus({ preventScroll: true }); }, 60);
    this._playVoice(step);
  };

  Player.prototype._renderEnd = function () {
    var self = this, s = (this.demo.settings && this.demo.settings.endScreen) || {};
    this._stopVoice();
    clearTimeout(this._playT);
    this._clearOverlays();
    this._dropMotion();
    this._token = {};
    if (this.progress) this.progress.firstChild.style.width = '100%';
    if (!this._completed) { this._completed = true; this._track('complete', {}); }
    if (s.enabled === false) return;
    var o = this._overlay(this._bgFor(this.steps.length - 1));
    var card = o.querySelector('.tmp-card');
    var h = el('h2'); h.textContent = s.title || 'That’s the tour';
    card.append(h);
    if (s.text) { var p = el('p'); p.textContent = s.text; card.append(p); }
    var box = el('div', 'tmp-choices');
    var url = safeUrl(s.ctaUrl);
    if (url && s.ctaLabel) {
      var a = el('a', 'tmp-btn', esc(s.ctaLabel) + ICONS.next);
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      a.addEventListener('click', function () { self._track('cta', { label: s.ctaLabel, url: url, step: 'end' }); });
      box.append(a);
    }
    if (s.showRestart !== false) {
      var r = el('button', 'tmp-btn tmp-secondary', esc('Watch again') + ICONS.restart);
      r.type = 'button';
      r.addEventListener('click', function () { self.restart(); });
      box.append(r);
    }
    card.append(box);
    this.live.textContent = h.textContent;
    this.atEnd = true;
  };

  Player.prototype._do = function (action, step, button) {
    action = action || { type: 'next' };
    if (button) this._track('cta', { label: button.label, url: action.url || '', step: this.idx, stepId: step && step.id });
    this.atEnd = false;
    switch (action.type) {
      case 'step': {
        var i = this._indexOf(action.stepId);
        if (i >= 0) this.go(i); else this.next();
        break;
      }
      case 'url': {
        var u = safeUrl(action.url);
        if (u) global.open(u, '_blank', 'noopener');
        break;
      }
      case 'end': this._renderEnd(); break;
      case 'restart': this.restart(); break;
      default: this.next();
    }
  };

  Player.prototype.next = function () {
    if (this.atEnd) return;
    if (!this.started) return;
    var cur = this.steps[this.idx];
    if (cur && cur.role === 'closing') return; // the closing card is the end
    if (this.idx >= this.steps.length - 1) { this._renderEnd(); return; }
    this.go(this.idx + 1);
  };
  Player.prototype.back = function () {
    if (this.atEnd) { this.atEnd = false; this.go(this.idx, true); return; }
    if (!this.history.length) return;
    var prev = this.history.pop();
    this.go(prev, true);
  };
  Player.prototype.restart = function () {
    this.history = []; this.atEnd = false; this._completed = false;
    this.idx = -1;
    this.go(0, true);
  };

  /* ---------- Voiceover ---------- */
  Player.prototype._voiceText = function (step) {
    var v = step.voice || {};
    if (v.sameAsTooltip === false) return v.text || '';
    if (step.type === 'chapter') return [step.title, step.text].filter(Boolean).join('. ');
    return ((step.tooltip && step.tooltip.text) || '').replace(/\*\*/g, '');
  };
  Player.prototype._playVoice = function (step) {
    var self = this;
    if (!this.started || this.voiceMode === 'off' || this.muted) { this._maybeAuto(step, 0); return; }
    var v = step.voice || {};
    var auto = this.demo.settings && this.demo.settings.autoAdvance;
    var doneVoice = function () {
      self._voiceBusy = false;
      if (self._pendingAdvance === step && self.steps[self.idx] === step) { self._pendingAdvance = null; self._advance(step); return; }
      if (auto) self._autoNext(step);
    };
    if (this.voiceMode === 'audio' && v.audio) {
      if (!this.audio) this.audio = new Audio();
      this.audio.src = v.audio;
      this._voiceBusy = true;
      this.audio.onended = doneVoice;
      this.audio.onerror = doneVoice;
      var p = this.audio.play(); if (p && p.catch) p.catch(function () {});
    } else if ((this.voiceMode === 'browser' || this.voiceMode === 'audio') && global.speechSynthesis) {
      var text = this._voiceText(step);
      if (!text) { this._maybeAuto(step, 0); return; }
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      this._voiceBusy = true;
      u.onend = doneVoice;
      u.onerror = doneVoice;
      global.speechSynthesis.speak(u);
    }
  };
  Player.prototype._maybeAuto = function (step, ms) { /* no voice: never auto-advance */ };
  Player.prototype._autoNext = function (step) {
    var self = this, idx = this.idx;
    clearTimeout(this._autoT);
    this._autoT = setTimeout(function () {
      if (self.idx !== idx || self.atEnd) return;
      if (step.type === 'chapter' && step.buttons && step.buttons.length > 1) return; // a real choice: wait
      if (step.play === 'auto') return; // video-only steps advance on their own schedule
      if (step.type === 'screen') self._advance(step); else self._do(step.next || { type: 'next' }, step);
    }, 700);
  };
  Player.prototype._stopVoice = function () {
    clearTimeout(this._autoT);
    this._voiceBusy = false;
    if (this.audio) { try { this.audio.onended = null; this.audio.pause(); } catch (e) { /* ignore */ } }
    if (global.speechSynthesis) global.speechSynthesis.cancel();
  };
  Player.prototype.setMuted = function (m) {
    this.muted = m;
    if (this.soundBtn) {
      this.soundBtn.innerHTML = m ? ICONS.mute : ICONS.sound;
      this.soundBtn.setAttribute('aria-label', m ? 'Unmute sound' : 'Mute sound');
      this.soundBtn.title = m ? 'Unmute sound' : 'Mute sound';
    }
    if (this.music) { if (m) this.music.pause(); else if (this.started) this._startMusic(); }
    if (m) this._stopVoice(); else if (this.steps[this.idx]) this._playVoice(this.steps[this.idx]);
  };

  /* ---------- Analytics ---------- */
  Player.prototype._track = function (type, data) {
    var ev = { demoId: this.demo.publicId || this.demo.id, sid: this.sid, vid: this.vid, type: type, t: Date.now() };
    for (var k in data) ev[k] = data[k];
    if (this.o.onEvent) { try { this.o.onEvent(ev); } catch (e) { /* ignore */ } }
    if (this.o.trackUrl) {
      try {
        var body = JSON.stringify(ev);
        if (!(navigator.sendBeacon && navigator.sendBeacon(this.o.trackUrl, new Blob([body], { type: 'text/plain' })))) {
          fetch(this.o.trackUrl, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } });
        }
      } catch (e) { /* ignore */ }
    }
  };

  Player.prototype.destroy = function () {
    this._stopVoice();
    if (this.music) { try { this.music.pause(); this.music.src = ''; } catch (e) { /* ignore */ } }
    if (this._ro) this._ro.disconnect();
    (this.o.globalKeys ? document : this.root).removeEventListener('keydown', this._onKey);
    document.removeEventListener('fullscreenchange', this._fs);
    this.c.innerHTML = '';
  };

  global.TrailmarkPlayer = global.DemoflowPlayer = {
    mount: function (container, demo, opts) { return new Player(container, demo, opts); },
    annotations: annotations,
    layoutTip: layoutTip,
    rich: rich,
    safeUrl: safeUrl,
    contrastInk: contrastInk,
    version: '2.0.0'
  };
})(typeof window !== 'undefined' ? window : this);
