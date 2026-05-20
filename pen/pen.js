/* OpenToon Studio - drawing-window (pen display) logic.

   This window owns no project. It shows a WebP frame streamed from the main
   window and forwards pen / mouse input back. A lightweight local "wet ink"
   preview is drawn while a stroke is in progress so the artist gets instant
   feedback before the authoritative frame catches up. */
(function () {
  'use strict';
  const PEN = window.OpenToonPen || null;

  const TOOL_ICON = {
    select: '<path d="M5 3l15 8-7 1.6L11 20z"/>',
    brush: '<path d="M4 21c3.2 0 5-1.8 5-5l-3-3c-3.2 0-5 1.8-5 5z"/><path d="M8 13L19 2.2a2 2 0 0 1 3 3L11 16z"/>',
    pencil: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 6l3 3"/>',
    eraser: '<path d="M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M21 21H7"/><path d="M5 11l9 9"/>',
    fill: '<path d="M11 3l8 8-7.5 7.5L4 11z"/><path d="M9 5l-5 6"/><path d="M20 13c0 0 2.4 3 2.4 4.8a2.4 2.4 0 1 1-4.8 0c0-1.8 2.4-4.8 2.4-4.8z"/>'
  };
  const TOOL_NAME = {
    select: 'Select', brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser', fill: 'Paint Bucket'
  };
  function svg(p) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  class PenWindow {
    constructor() {
      this.canvas = document.getElementById('screen');
      this.ctx = this.canvas.getContext('2d');
      this.bar = document.getElementById('bar');
      this.hint = document.getElementById('hint');
      this.bmp = null;
      this.meta = { tool: 'brush', color: '#222222', brushFrac: 0.02, frame: 1, frameCount: 1, zoom: 100 };
      this.fit = { x: 0, y: 0, w: 0, h: 0 };
      // local pen-window view -- magnifies / pans the streamed bitmap WITHOUT
      // touching the main window's camera. Lets the artist zoom into a detail
      // on the pen display while the producer / director still sees the
      // full scene on the main monitor.
      this.view = { scale: 1, x: 0, y: 0 };
      this.wet = [];                 // current stroke, in CSS canvas px
      this.stroking = false;
      this.awaitingCommit = false;   // a stroke ended; clear wet on next frame
      this.toolBtns = {};
      this._lastHover = 0;

      this._buildBar();
      this._resize();
      this._installInput();
      this._installKeys();
      window.addEventListener('resize', () => { this._resize(); this.draw(); });

      if (PEN) {
        PEN.onFrame((buf, meta) => this._onFrame(buf, meta));
        PEN.ready();
        // initial size report so the very first frame is encoded at the
        // correct resolution rather than the legacy 1680 px fallback
        this._reportSize();
      }
    }

    _cmd(msg) { if (PEN) PEN.sendCommand(msg); }

    /* ---------------- toolbar ---------------- */
    _buildBar() {
      const bar = this.bar;
      const mkBtn = (html, title, fn) => {
        const b = document.createElement('button');
        b.className = 'pbtn';
        b.innerHTML = html; b.title = title;
        b.addEventListener('click', () => { fn(); b.blur(); });
        bar.appendChild(b);
        return b;
      };
      const sep = () => {
        const s = document.createElement('div');
        s.className = 'psep'; bar.appendChild(s);
      };

      ['select', 'brush', 'pencil', 'eraser', 'fill'].forEach(name => {
        this.toolBtns[name] = mkBtn(svg(TOOL_ICON[name]), TOOL_NAME[name],
          () => this._cmd({ type: 'tool', tool: name }));
      });
      sep();
      mkBtn('<span class="glyph">−</span>', 'Smaller brush  ([)',
        () => this._cmd({ type: 'brush-size', delta: -1 }));
      mkBtn('<span class="glyph">+</span>', 'Bigger brush  (])',
        () => this._cmd({ type: 'brush-size', delta: 1 }));

      // colour chip with a hidden native colour picker behind it
      const wrap = document.createElement('label');
      wrap.className = 'pcolor'; wrap.title = 'Drawing colour';
      this.colorInput = document.createElement('input');
      this.colorInput.type = 'color';
      this.colorInput.value = '#222222';
      this.colorInput.addEventListener('input',
        () => this._cmd({ type: 'color', color: this.colorInput.value }));
      wrap.appendChild(this.colorInput);
      bar.appendChild(wrap);
      this.colorWrap = wrap;

      sep();
      mkBtn('<span class="glyph">↶</span>', 'Undo  (Ctrl+Z)', () => this._cmd({ type: 'undo' }));
      mkBtn('<span class="glyph">↷</span>', 'Redo  (Ctrl+Y)', () => this._cmd({ type: 'redo' }));
      sep();
      mkBtn('<span class="glyph">◀</span>', 'Previous frame', () => this._cmd({ type: 'frame', dir: -1 }));
      this.frameLabel = document.createElement('div');
      this.frameLabel.className = 'pframe';
      this.frameLabel.textContent = '1 / 1';
      bar.appendChild(this.frameLabel);
      mkBtn('<span class="glyph">▶</span>', 'Next frame', () => this._cmd({ type: 'frame', dir: 1 }));
      sep();
      mkBtn(svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/><path d="M8 11h6"/>'),
        'Zoom out  (−)', () => this._zoomLocal(1 / 1.18));
      this.zoomBtn = mkBtn('100%', 'Reset pen-window zoom  (0)',
        () => this._resetView());
      this.zoomBtn.classList.add('pzoom');
      mkBtn(svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/><path d="M8 11h6"/><path d="M11 8v6"/>'),
        'Zoom in  (+)', () => this._zoomLocal(1.18));
      mkBtn('<span class="glyph">⤢</span>', 'Fit to camera (main window)  (F)',
        () => this._cmd({ type: 'fit' }));

      const spacer = document.createElement('div');
      spacer.className = 'pspacer'; bar.appendChild(spacer);
      // pan mode toggle -- handy on a pen tablet that has no middle mouse
      this.panBtn = mkBtn(svg('<path d="M12 3v18"/><path d="M3 12h18"/><path d="M7 8l-4 4 4 4"/><path d="M17 8l4 4-4 4"/><path d="M8 7l4-4 4 4"/><path d="M8 17l4 4 4-4"/>'),
        'Pan (hold space, or tap to toggle)', () => this._togglePan());
    }
    // Local zoom -- adjusts this.view only, never sends to the main app.
    _zoomLocal(factor, cx, cy) {
      if (cx == null) cx = this.cssW / 2;
      if (cy == null) cy = this.cssH / 2;
      const v = this.view;
      const ns = Math.max(0.05, Math.min(32, v.scale * factor));
      if (ns === v.scale) return;
      const s = ns / v.scale;
      v.x = cx * (1 - s) + v.x * s;
      v.y = cy * (1 - s) + v.y * s;
      v.scale = ns;
      this._updateZoomLabel();
      this.draw();
    }
    _panLocal(dx, dy) {
      this.view.x += dx; this.view.y += dy;
      this.draw();
    }
    _resetView() {
      this.view = { scale: 1, x: 0, y: 0 };
      this._updateZoomLabel();
      this.draw();
    }
    _updateZoomLabel() {
      if (this.zoomBtn) this.zoomBtn.textContent = Math.round(this.view.scale * 100) + '%';
    }
    _togglePan() {
      this.panLock = !this.panLock;
      this.panBtn.classList.toggle('active', this.panLock);
      this.canvas.style.cursor = this.panLock ? 'grab' : '';
    }

    /* ---------------- sizing ---------------- */
    _resize() {
      const barH = this.bar.offsetHeight || 48;
      const w = window.innerWidth;
      const h = Math.max(1, window.innerHeight - barH);
      // Cap DPR at 3 (was 2) so Cintiq Pro / iPad-class pen displays get
      // a properly high-resolution backing store.
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.cssW = w; this.cssH = h;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this._computeFit();
      // Let the main window know what resolution to encode for, so the
      // streamed bitmap arrives at 1:1 with no upscaling = no pixelation.
      this._reportSize();
    }
    _reportSize() {
      if (!PEN) return;
      // throttle: only resend if size meaningfully changed
      const k = this.cssW + 'x' + this.cssH + '@' + this.dpr;
      if (k === this._lastSizeKey) return;
      this._lastSizeKey = k;
      this._cmd({ type: 'pen-size', cssW: this.cssW, cssH: this.cssH, dpr: this.dpr });
    }
    _computeFit() {
      if (!this.bmp) { this.fit = { x: 0, y: 0, w: 0, h: 0 }; return; }
      const s = Math.min(this.cssW / this.bmp.width, this.cssH / this.bmp.height);
      const w = this.bmp.width * s, h = this.bmp.height * s;
      this.fit = { x: (this.cssW - w) / 2, y: (this.cssH - h) / 2, w: w, h: h };
    }

    /* ---------------- incoming frame ---------------- */
    _onFrame(buf, meta) {
      if (meta) this._applyMeta(meta);
      let blob;
      try { blob = new Blob([buf], { type: 'image/webp' }); }
      catch (e) { return; }
      createImageBitmap(blob).then(bmp => {
        if (this.bmp && this.bmp.close) this.bmp.close();
        this.bmp = bmp;
        this._computeFit();
        if (this.awaitingCommit && !this.stroking) {
          this.wet = []; this.awaitingCommit = false;
        }
        if (this.hint) this.hint.style.display = 'none';
        this.draw();
      }).catch(() => {});
    }
    _applyMeta(meta) {
      this.meta = meta;
      for (const n in this.toolBtns)
        this.toolBtns[n].classList.toggle('active', n === meta.tool);
      if (meta.color && /^#[0-9a-fA-F]{6}$/.test(meta.color))
        this.colorInput.value = meta.color;
      this.colorWrap.style.background = meta.color || '#222222';
      this.frameLabel.textContent = (meta.frame || 1) + ' / ' + (meta.frameCount || 1);
      // zoomBtn now shows the pen window's *local* view percent -- main
      // window's camera zoom is irrelevant to the pen display, so we ignore
      // meta.zoom here. _updateZoomLabel keeps it in sync with this.view.
    }

    /* ---------------- draw ---------------- */
    draw() {
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cssW, this.cssH);
      c.fillStyle = '#0c0d10';
      c.fillRect(0, 0, this.cssW, this.cssH);
      if (this.bmp) {
        const v = this.view;
        c.save();
        // local view: translate then scale, on top of the fit-to-window rect
        c.translate(v.x, v.y); c.scale(v.scale, v.scale);
        c.imageSmoothingEnabled = v.scale < 3;
        c.imageSmoothingQuality = 'high';
        c.drawImage(this.bmp, this.fit.x, this.fit.y, this.fit.w, this.fit.h);
        c.restore();
      }
      this._drawWet();
    }
    // Local in-progress stroke preview -- instant feedback while the
    // authoritative render streams back from the main window.
    _drawWet() {
      if (this.wet.length < 1 || !this.fit.w) return;
      const tool = this.meta.tool;
      if (tool !== 'brush' && tool !== 'pencil' && tool !== 'eraser') return;
      const c = this.ctx;
      // brush radius scales with the local view so the wet-ink preview
      // matches the diameter the artist will actually see after commit
      const dia = Math.max(1.5,
        (this.meta.brushFrac || 0.02) * this.fit.w * 2 * (this.view.scale || 1));
      c.save();
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.lineWidth = dia;
      c.strokeStyle = tool === 'eraser' ? 'rgb(202,208,216)' : (this.meta.color || '#222222');
      c.globalAlpha = tool === 'eraser' ? 0.5 : 0.9;
      c.beginPath();
      c.moveTo(this.wet[0].x, this.wet[0].y);
      for (let i = 1; i < this.wet.length; i++) c.lineTo(this.wet[i].x, this.wet[i].y);
      if (this.wet.length === 1) c.lineTo(this.wet[0].x + 0.1, this.wet[0].y + 0.1);
      c.stroke();
      c.restore();
    }

    /* ---------------- pointer input ---------------- */
    _installInput() {
      const cv = this.canvas;
      const rect = () => cv.getBoundingClientRect();
      // Map a window-CSS-px coord back through the local view to a 0..1
      // fraction over the streamed bitmap, so input always lands on the
      // correct project pixel regardless of how the artist has zoomed.
      const norm = (clientX, clientY, r) => {
        const v = this.view;
        const ox = (clientX - r.left - v.x) / v.scale;
        const oy = (clientY - r.top - v.y) / v.scale;
        return {
          nx: (ox - this.fit.x) / (this.fit.w || 1),
          ny: (oy - this.fit.y) / (this.fit.h || 1)
        };
      };
      const isPenEraser = e =>
        e.pointerType === 'pen' && (((e.buttons & 32) !== 0) || e.button === 5);
      const mods = e => ({
        isPen: e.pointerType === 'pen',
        shift: e.shiftKey, alt: e.altKey,
        button: e.button, buttons: e.buttons,
        penEraser: isPenEraser(e)
      });
      // Track every live pointer by id, so we can switch into a 2-finger
      // pinch + pan gesture when a second touch arrives -- a must on a
      // Cintiq-class tablet that has no mouse wheel.
      this.pointers = new Map();
      this.gesture = null;        // { dist, midX, midY }
      // Palm rejection: any touch is held in limbo for 80ms; if a pen
      // pointerdown lands during the wait, we discard the touch instead of
      // letting it pan. Keyed by pointerId -> { x, y, t, timer, clientX, clientY }.
      this._pendingTouch = new Map();
      const PALM_DELAY = 80;

      const clearPendingTouches = () => {
        // Pen has arrived -- abandon every tentative touch. Release captures
        // so the OS stops feeding move events to a phantom gesture.
        for (const [pid, pt] of this._pendingTouch) {
          if (pt.timer) clearTimeout(pt.timer);
          this.pointers.delete(pid);
          try { cv.releasePointerCapture(pid); } catch (_) {}
        }
        this._pendingTouch.clear();
      };

      const cancelStroke = () => {
        if (!this.stroking) return;
        this.stroking = false;
        this.awaitingCommit = false;
        this.wet = [];
        if (PEN) PEN.sendInput({ type: 'cancel' });
        this.draw();
      };
      const beginGesture = () => {
        cancelStroke();
        const list = Array.from(this.pointers.values());
        const [a, b] = list;
        this.gesture = {
          dist: Math.hypot(b.x - a.x, b.y - a.y),
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2
        };
      };
      const updateGesture = e => {
        if (!this.gesture || this.pointers.size < 2) return;
        const list = Array.from(this.pointers.values());
        const [a, b] = list;
        const nd = Math.hypot(b.x - a.x, b.y - a.y);
        const nmx = (a.x + b.x) / 2, nmy = (a.y + b.y) / 2;
        const g = this.gesture;
        if (g.dist > 1 && nd > 1) {
          const factor = nd / g.dist;
          if (Math.abs(factor - 1) > 0.005) this._zoomLocal(factor, nmx, nmy);
        }
        const dx = nmx - g.midX, dy = nmy - g.midY;
        if (dx || dy) this._panLocal(dx, dy);
        g.dist = nd; g.midX = nmx; g.midY = nmy;
      };

      cv.addEventListener('pointerdown', e => {
        if (!this.bmp) return;
        // Palm rejection: an active pen stroke vetos any touch entirely --
        // a resting palm must not interrupt the line being drawn.
        if (e.pointerType === 'touch' && this.stroking) return;
        // Pen arriving cancels any pending touch (resting palm) and any
        // tentative single-touch pan it may have promoted before we got here.
        if (e.pointerType === 'pen') {
          clearPendingTouches();
          // If we were panning from a single touch (not a confirmed
          // 2-finger gesture), drop it -- artist clearly wants to draw.
          if (this.panning && !this.gesture) {
            this.panning = null;
            this.canvas.style.cursor = this.panLock ? 'grab' : '';
          }
        }
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        const r = rect();
        // remember every pointer so multi-touch gestures can react
        this.pointers.set(e.pointerId, {
          x: e.clientX - r.left, y: e.clientY - r.top, type: e.pointerType
        });
        // A second touch arriving while the first is still pending promotes
        // both immediately -- this is a deliberate two-finger gesture, not
        // a stray palm. Clear timers but keep the pointers tracked.
        if (e.pointerType === 'touch' && this._pendingTouch.size > 0) {
          for (const [, pt] of this._pendingTouch) {
            if (pt.timer) clearTimeout(pt.timer);
          }
          this._pendingTouch.clear();
        }
        if (this.pointers.size >= 2) { beginGesture(); return; }
        // middle / right button pans the canvas (mouse / pen barrel button)
        if (e.button === 1 || e.button === 2 || this.panLock) {
          this.panning = { x: e.clientX, y: e.clientY };
          this.canvas.style.cursor = 'grabbing';
          return;
        }
        // Single-touch (finger) by itself is held in limbo for 80ms.
        // If a pen lands during that window we discard it (palm rejection);
        // otherwise we promote it to a pan.
        if (e.pointerType === 'touch') {
          const pid = e.pointerId;
          const startX = e.clientX, startY = e.clientY;
          const pend = { x: startX, y: startY, t: performance.now(), timer: null };
          pend.timer = setTimeout(() => {
            // Only promote if the touch is still down and no pen took over.
            if (!this._pendingTouch.has(pid)) return;
            this._pendingTouch.delete(pid);
            if (this.stroking) return;
            if (!this.pointers.has(pid)) return;
            this.panning = { x: startX, y: startY };
          }, PALM_DELAY);
          this._pendingTouch.set(pid, pend);
          return;
        }
        const n = norm(e.clientX, e.clientY, r);
        this.stroking = true;
        this.awaitingCommit = false;
        this.wet = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
        if (PEN) PEN.sendInput(Object.assign({
          type: 'down', nx: n.nx, ny: n.ny,
          pressure: e.pointerType === 'pen' ? e.pressure : 1
        }, mods(e)));
        this.draw();
      });

      cv.addEventListener('pointermove', e => {
        if (!this.bmp) return;
        const r = rect();
        if (this.pointers.has(e.pointerId)) {
          const p = this.pointers.get(e.pointerId);
          p.x = e.clientX - r.left; p.y = e.clientY - r.top;
        }
        // A touch that is still in its palm-rejection grace window must not
        // pan, draw, or emit hover events -- it's quarantined until promoted.
        if (this._pendingTouch.has(e.pointerId)) return;
        if (this.gesture && this.pointers.size >= 2) {
          updateGesture(e);
          return;
        }
        if (this.panning) {
          this._panLocal(e.clientX - this.panning.x, e.clientY - this.panning.y);
          this.panning = { x: e.clientX, y: e.clientY };
          return;
        }
        if (this.stroking) {
          let batch = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
          if (!batch.length) batch = [e];
          const pts = [];
          for (const ce of batch) {
            const n = norm(ce.clientX, ce.clientY, r);
            pts.push({
              nx: n.nx, ny: n.ny,
              pressure: ce.pointerType === 'pen' ? ce.pressure : 1
            });
            this.wet.push({ x: ce.clientX - r.left, y: ce.clientY - r.top });
          }
          if (PEN) PEN.sendInput(Object.assign({ type: 'move', pts: pts }, mods(e)));
          this.draw();
        } else {
          const now = performance.now();
          if (now - this._lastHover < 55) return;
          this._lastHover = now;
          const n = norm(e.clientX, e.clientY, r);
          if (PEN) PEN.sendInput(Object.assign({ type: 'hover', nx: n.nx, ny: n.ny }, mods(e)));
        }
      });

      const end = e => {
        if (this.pointers.has(e.pointerId)) this.pointers.delete(e.pointerId);
        // Touch released before its 80ms grace window elapsed: just cancel
        // the timer, no pan was ever started.
        if (this._pendingTouch.has(e.pointerId)) {
          const pt = this._pendingTouch.get(e.pointerId);
          if (pt.timer) clearTimeout(pt.timer);
          this._pendingTouch.delete(e.pointerId);
          return;
        }
        if (this.gesture) {
          // dropping a second finger ends the pinch / pan immediately so the
          // remaining finger doesn't suddenly pan from far away
          if (this.pointers.size < 2) {
            this.gesture = null;
            this.panning = null;
            return;
          }
        }
        if (this.panning) {
          this.panning = null;
          this.canvas.style.cursor = this.panLock ? 'grab' : '';
          return;
        }
        if (!this.stroking) return;
        this.stroking = false;
        this.awaitingCommit = true;
        const n = norm(e.clientX, e.clientY, rect());
        if (PEN) PEN.sendInput(Object.assign({
          type: 'up', nx: n.nx, ny: n.ny,
          pressure: e.pointerType === 'pen' ? e.pressure : 1
        }, mods(e)));
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', e => {
        if (this.pointers.has(e.pointerId)) this.pointers.delete(e.pointerId);
        if (this.stroking) return;
        if (PEN) PEN.sendInput({ type: 'leave' });
      });
      cv.addEventListener('contextmenu', e => e.preventDefault());
      // wheel zoom: Ctrl gives a precision step, plain wheel is coarser. Both
      // are centred on the cursor, so the artist can dial in without losing
      // their place. Track-pad pinch reaches us as Ctrl+wheel automatically.
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const r = rect();
        const fine = e.ctrlKey || e.metaKey;
        const step = fine ? 1.05 : 1.15;
        const factor = e.deltaY < 0 ? step : 1 / step;
        this._zoomLocal(factor, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
    }

    // A few keyboard shortcuts so the artist need not reach for the toolbar.
    _installKeys() {
      const TOOLKEY = { v: 'select', b: 'brush', n: 'pencil', e: 'eraser', g: 'fill' };
      window.addEventListener('keydown', ev => {
        const k = ev.key.toLowerCase();
        if (ev.ctrlKey || ev.metaKey) {
          if (k === 'z') { ev.preventDefault(); this._cmd({ type: ev.shiftKey ? 'redo' : 'undo' }); }
          else if (k === 'y') { ev.preventDefault(); this._cmd({ type: 'redo' }); }
          return;
        }
        if (TOOLKEY[k]) { this._cmd({ type: 'tool', tool: TOOLKEY[k] }); return; }
        if (k === '[') this._cmd({ type: 'brush-size', delta: -1 });
        else if (k === ']') this._cmd({ type: 'brush-size', delta: 1 });
        else if (k === 'f') this._cmd({ type: 'fit' });
        else if (k === ',') this._cmd({ type: 'frame', dir: -1 });
        else if (k === '.') this._cmd({ type: 'frame', dir: 1 });
        else if (k === '+' || k === '=') this._zoomLocal(1.18);
        else if (k === '-' || k === '_') this._zoomLocal(1 / 1.18);
        else if (k === '0') this._resetView();
        else if (k === ' ') {
          // hold space for ad-hoc pan -- standard across drawing apps
          if (!this._spaceHeld) { this._spaceHeld = true; this._togglePan(); }
          ev.preventDefault();
        }
      });
      window.addEventListener('keyup', ev => {
        if (ev.key === ' ' && this._spaceHeld) {
          this._spaceHeld = false; this._togglePan();
        }
      });
    }
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => new PenWindow());
  else new PenWindow();
})();
