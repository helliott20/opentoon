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
      mkBtn('<span class="glyph">⤢</span>', 'Fit to camera', () => this._cmd({ type: 'fit' }));

      const spacer = document.createElement('div');
      spacer.className = 'pspacer'; bar.appendChild(spacer);
      this.zoomLabel = document.createElement('div');
      this.zoomLabel.className = 'pframe';
      this.zoomLabel.textContent = '100%';
      bar.appendChild(this.zoomLabel);
    }

    /* ---------------- sizing ---------------- */
    _resize() {
      const barH = this.bar.offsetHeight || 48;
      const w = window.innerWidth;
      const h = Math.max(1, window.innerHeight - barH);
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.cssW = w; this.cssH = h;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this._computeFit();
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
      this.zoomLabel.textContent = (meta.zoom || 100) + '%';
    }

    /* ---------------- draw ---------------- */
    draw() {
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cssW, this.cssH);
      c.fillStyle = '#0c0d10';
      c.fillRect(0, 0, this.cssW, this.cssH);
      if (this.bmp) {
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(this.bmp, this.fit.x, this.fit.y, this.fit.w, this.fit.h);
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
      const dia = Math.max(1.5, (this.meta.brushFrac || 0.02) * this.fit.w * 2);
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
      const norm = (clientX, clientY, r) => ({
        nx: (clientX - r.left - this.fit.x) / (this.fit.w || 1),
        ny: (clientY - r.top - this.fit.y) / (this.fit.h || 1)
      });
      const isPenEraser = e =>
        e.pointerType === 'pen' && (((e.buttons & 32) !== 0) || e.button === 5);
      const mods = e => ({
        isPen: e.pointerType === 'pen',
        shift: e.shiftKey, alt: e.altKey,
        button: e.button, buttons: e.buttons,
        penEraser: isPenEraser(e)
      });

      cv.addEventListener('pointerdown', e => {
        if (!this.bmp) return;
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        const r = rect();
        // middle / right button pans the canvas, just like the main window
        if (e.button === 1 || e.button === 2) {
          this.panning = { x: e.clientX, y: e.clientY };
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
        if (this.panning) {
          this._cmd({
            type: 'pan',
            dnx: (e.clientX - this.panning.x) / (this.fit.w || 1),
            dny: (e.clientY - this.panning.y) / (this.fit.h || 1)
          });
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
        if (this.panning) { this.panning = null; return; }
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
      cv.addEventListener('pointerleave', () => {
        if (this.stroking) return;
        if (PEN) PEN.sendInput({ type: 'leave' });
      });
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const n = norm(e.clientX, e.clientY, rect());
        this._cmd({
          type: 'zoom', nx: n.nx, ny: n.ny,
          factor: e.deltaY < 0 ? 1.12 : 1 / 1.12
        });
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
      });
    }
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => new PenWindow());
  else new PenWindow();
})();
