/* OpenToon Studio - pen-display window (D1 slave renderer).

   The pen window holds a real mirror of the project (OT.Layer / OT.Cel
   from core.js) and runs OT.compositeStage itself. The artist's wet
   stroke is drawn locally from pointer events; the committed stroke
   arrives via vector-cel-replace and is matched by UUID. */
(function () {
  'use strict';
  const PEN = window.OpenToonPen || null;
  const OT = window.OT;

  const TOOL_ICON = {
    select: '<path d="M5 3l15 8-7 1.6L11 20z"/>',
    lasso: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><circle cx="5" cy="16" r="2"/>',
    brush: '<path d="M4 21c3.2 0 5-1.8 5-5l-3-3c-3.2 0-5 1.8-5 5z"/><path d="M8 13L19 2.2a2 2 0 0 1 3 3L11 16z"/>',
    pencil: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 6l3 3"/>',
    eraser: '<path d="M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M21 21H7"/><path d="M5 11l9 9"/>',
    fill:   '<path d="M11 3l8 8-7.5 7.5L4 11z"/><path d="M9 5l-5 6"/><path d="M20 13c0 0 2.4 3 2.4 4.8a2.4 2.4 0 1 1-4.8 0c0-1.8 2.4-4.8 2.4-4.8z"/>'
  };
  const TOOL_NAME = {
    select: 'Select Pixels', lasso: 'Lasso Select',
    brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser', fill: 'Paint Bucket'
  };
  function svg(p) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  // Tiny UUID-ish generator if crypto.randomUUID isn't available. Doesn't
  // need to be cryptographically strong -- it just needs to not collide
  // with U.uid()'s output on the main side.
  function makeStrokeId() {
    if (window.crypto && crypto.randomUUID) return 'pen-' + crypto.randomUUID();
    return 'pen-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  class PenWindow {
    constructor() {
      this.canvas = document.getElementById('screen');
      this.ctx = this.canvas.getContext('2d');
      this.bar = document.getElementById('bar');
      this.hint = document.getElementById('hint');
      this.actions = null;
      this.state = {
        seq: 0,
        project: { width: 1920, height: 1080, bg: '#ffffff', fps: 24, frameCount: 1, layers: [] },
        // 'layers' is a duplicate inside project to satisfy compositeStage()
        layers: [],
        layersById: new Map(),
        palette: [],
        activeLayerId: null,
        frame: 0,
        tool: { name: 'brush', color: '#222222', toolSize: 6, toolOpacity: 1, pencil: false, brushFrac: 0.02, toolRadius: 0, tol: 0.4, snapDist: 0, inkDynamics: false, autoClose: false, smoothing: 0, snapShape: null, activeLayerKind: null, sel: {}, transform: {}, overlay: null },
        wetStroke: null,
        // Live eraser destination-out punches (from main mid-drag); cleared
        // by frame/active-layer change or by the vector-cel-replace that
        // pointerUp eventually publishes. Shape: { layerId, samples:[{x,y,r}] }.
        eraserOverlay: null
      };
      this.fit = { x: 0, y: 0, w: 0, h: 0 };
      this.view = { scale: 1, x: 0, y: 0 };
      this.stroking = false;
      this.toolBtns = {};
      this._lastHover = 0;
      this._wetTimer = null;
      // Cursor position in pen-canvas CSS-px (screen space, before DPR
      // scaling). Updated on pointermove/hover, cleared on pointerleave.
      // Used by _compositeStage to draw the cursor circle indicator.
      this._cursorCss = null;
      // Project-sized cache of the static layer composite. Rebuilt only
      // when the project / selection meaningfully changes; blitted every
      // frame during a transform so we don't iterate layers ~30 times/sec
      // when nothing's actually changing under the lasso box.
      this._baseCache = null;
      this._baseCacheDirty = true;

      this._buildBar();
      this._buildLassoTb();
      this._resize();
      this._installInput();
      this._installKeys();
      window.addEventListener('resize', () => { this._resize(); this.draw(); });

      if (PEN) {
        if (PEN.onState) PEN.onState(msg => this._onState(msg));
        PEN.ready();
        this._reportSize();
      }
    }

    _cmd(msg) { if (PEN) PEN.sendCommand(msg); }

    /* ---------------- toolbar (lifted from Phase 2 verbatim) ---------------- */
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

      ['select', 'lasso', 'brush', 'pencil', 'eraser', 'fill'].forEach(name => {
        const btn = mkBtn(svg(TOOL_ICON[name]), TOOL_NAME[name],
          () => this._cmd({ type: 'tool', tool: name }));
        this.toolBtns[name] = btn;
        this._installLongPress(btn, name);
      });
      sep();
      this._buildSizeChip();

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

      // Selection chip — exact mirror of the main window's .ca-chip. Sits
      // inside #bar; popover descends below on hover/tap. Refreshes as
      // meta.sel / meta.transform arrive from the main window.
      this.actions = document.createElement('div');
      this.actions.className = 'ca-chip hidden';
      this.actions.tabIndex = 0;
      this.actions.setAttribute('role', 'button');
      // Tablet: tap toggles the popover (hover doesn't fire reliably for
      // pen/touch). Bound once at build time so we don't pile up listeners
      // every refresh.
      this.actions.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'touch' || ev.pointerType === 'pen') {
          if (ev.target && ev.target.closest && ev.target.closest('.ca-btn')) return;
          this.actions.classList.toggle('open');
        }
      });
      bar.appendChild(this.actions);
    }

    /* ---------------- inline size chip + tool-settings popover ----------------
       Drag the chip horizontally to resize live (px-per-px feel). Tap (no
       drag) opens a popover with size + opacity + smoothing sliders. The
       same popover opens via tap-and-hold on a tool button. */
    _buildSizeChip() {
      const chip = document.createElement('div');
      chip.className = 'psize';
      chip.title = 'Drag to resize · Tap for options';
      const dot = document.createElement('span');
      dot.className = 'pdot';
      const num = document.createElement('span');
      num.className = 'pnum';
      chip.appendChild(dot); chip.appendChild(num);
      this.bar.appendChild(chip);
      this.sizeChip = chip;
      this.sizeChipDot = dot;
      this.sizeChipNum = num;
      this._refreshSizeChip();

      // pointer-driven drag: small horizontal movement = absolute resize.
      // A drag delta > 4 px counts as a drag; smaller releases re-open the
      // popover (tap-to-open) so the artist can use sliders directly.
      let dragging = null;
      const SIZE_MIN = 1, SIZE_MAX = 300, DRAG_THRESH = 4;
      chip.addEventListener('pointerdown', ev => {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        try { chip.setPointerCapture(ev.pointerId); } catch (_) {}
        dragging = {
          startX: ev.clientX,
          startSize: Math.max(1, this.state.tool.toolSize || 6),
          moved: false
        };
        ev.preventDefault();
      });
      chip.addEventListener('pointermove', ev => {
        if (!dragging) return;
        const dx = ev.clientX - dragging.startX;
        if (!dragging.moved && Math.abs(dx) >= DRAG_THRESH) {
          dragging.moved = true;
          chip.classList.add('dragging');
        }
        if (!dragging.moved) return;
        // ~0.6 px-per-px feel: a 200px drag covers roughly 1->120 by
        // exponential mapping so small sizes have fine control.
        const factor = Math.pow(1.012, dx);
        const next = Math.max(SIZE_MIN, Math.min(SIZE_MAX,
          Math.round(dragging.startSize * factor)));
        this.state.tool.toolSize = next;
        this._refreshSizeChip();
        this._cmd({ type: 'brush-size', absolute: next });
      });
      const endDrag = ev => {
        if (!dragging) return;
        const wasDrag = dragging.moved;
        chip.classList.remove('dragging');
        try { chip.releasePointerCapture(ev.pointerId); } catch (_) {}
        dragging = null;
        if (!wasDrag) this._openToolPopover(this.state.tool.name || 'brush', chip);
      };
      chip.addEventListener('pointerup', endDrag);
      chip.addEventListener('pointercancel', endDrag);
    }
    _refreshSizeChip() {
      if (!this.sizeChip) return;
      const sz = Math.max(1, Math.round(this.state.tool.toolSize || 6));
      if (this._sizeChipSz === sz) return;     // no change — skip DOM writes
      this._sizeChipSz = sz;
      const visDot = Math.min(20, Math.max(4, sz / 3));
      this.sizeChipDot.style.width = visDot + 'px';
      this.sizeChipDot.style.height = visDot + 'px';
      this.sizeChipNum.textContent = sz;
    }
    _installLongPress(btn, toolName) {
      // 380ms hold opens the popover. Movement > 6 px cancels (so a normal
      // tap-then-pan doesn't trigger). Pointer leave also cancels.
      const HOLD_MS = 380, MOVE_CANCEL = 6;
      let state = null;
      const start = ev => {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        state = {
          startX: ev.clientX, startY: ev.clientY,
          fired: false,
          timer: setTimeout(() => {
            if (!state) return;
            state.fired = true;
            btn.classList.remove('holding');
            this._openToolPopover(toolName, btn);
          }, HOLD_MS)
        };
        btn.classList.add('holding');
      };
      const move = ev => {
        if (!state) return;
        const dx = ev.clientX - state.startX, dy = ev.clientY - state.startY;
        if (Math.hypot(dx, dy) > MOVE_CANCEL) cancel();
      };
      const cancel = () => {
        if (!state) return;
        clearTimeout(state.timer);
        btn.classList.remove('holding');
        state = null;
      };
      const up = ev => {
        if (!state) return;
        if (state.fired) {
          // Long press already opened the popover — swallow the click so
          // the artist doesn't also switch tools.
          ev.stopPropagation();
          ev.preventDefault();
          cancel();
          return;
        }
        cancel();
      };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointermove', move);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', cancel);
      btn.addEventListener('pointerleave', cancel);
    }
    _openToolPopover(toolName, anchor) {
      // Close any existing popover first.
      this._closeToolPopover();
      // Skip tools that don't have meaningful settings.
      if (toolName === 'select' || toolName === 'lasso' || toolName === 'fill') {
        if (toolName === 'fill') {
          // Fill: just open the color picker.
          if (this.colorInput) this.colorInput.click();
        }
        return;
      }
      const pop = document.createElement('div');
      pop.className = 'ptpop';
      const t = this.state.tool;
      const mkSlider = (label, min, max, step, value, onInput) => {
        const row = document.createElement('div');
        row.className = 'prow';
        const lbl = document.createElement('div');
        lbl.className = 'plabel';
        lbl.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = String(min); inp.max = String(max); inp.step = String(step);
        inp.value = String(value);
        const val = document.createElement('div');
        val.className = 'pval';
        val.textContent = String(value);
        inp.addEventListener('input', () => {
          const v = Number(inp.value);
          val.textContent = (step >= 1) ? String(Math.round(v)) : v.toFixed(2);
          onInput(v);
        });
        row.appendChild(lbl); row.appendChild(inp); row.appendChild(val);
        pop.appendChild(row);
        return inp;
      };
      // Size: 1..300 integer
      mkSlider('Size', 1, 300, 1, Math.round(t.toolSize || 6), v => {
        this.state.tool.toolSize = v;
        this._refreshSizeChip();
        this._cmd({ type: 'brush-size', absolute: v });
      });
      // Eraser has no meaningful opacity/smoothing (it's a hard mask).
      if (toolName !== 'eraser') {
        mkSlider('Opacity', 0.05, 1, 0.01,
          t.toolOpacity == null ? 1 : t.toolOpacity, v => {
            this.state.tool.toolOpacity = v;
            this._cmd({ type: 'brush-opacity', value: v });
          });
        mkSlider('Smoothing', 0, 1, 0.01, t.smoothing || 0, v => {
          this.state.tool.smoothing = v;
          this._cmd({ type: 'brush-smoothing', value: v });
        });
      }
      // Position the popover under the anchor.
      this.bar.parentElement.appendChild(pop);
      const a = anchor.getBoundingClientRect();
      const barH = this.bar.offsetHeight || 48;
      const leftMax = window.innerWidth - 260;
      pop.style.left = Math.max(8, Math.min(leftMax, a.left)) + 'px';
      pop.style.top = (barH + 4) + 'px';
      // Animate in.
      requestAnimationFrame(() => pop.classList.add('open'));
      this._toolPopover = pop;

      // Click outside closes. Bind once and remove on close so we don't
      // leak listeners.
      this._toolPopOutside = ev => {
        if (!this._toolPopover) return;
        if (pop.contains(ev.target)) return;
        if (anchor.contains(ev.target)) return;
        this._closeToolPopover();
      };
      // Defer so the opening pointerup doesn't immediately close.
      setTimeout(() => {
        if (this._toolPopover) {
          document.addEventListener('pointerdown', this._toolPopOutside, true);
        }
      }, 0);
    }
    _closeToolPopover() {
      const pop = this._toolPopover;
      if (!pop) return;
      this._toolPopover = null;
      if (this._toolPopOutside) {
        document.removeEventListener('pointerdown', this._toolPopOutside, true);
        this._toolPopOutside = null;
      }
      pop.classList.remove('open');
      setTimeout(() => { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 200);
    }

    // Lasso transform toolbar — uses #lasso-toolbar from pen.html, which
    // has identical markup to index.html and is styled by the shared
    // styles/lasso-tb.css. We just delegate clicks back to main as
    // lasso-mode commands; the active-mode pill is driven by meta.transform.
    _buildLassoTb() {
      const tb = document.getElementById('lasso-toolbar');
      if (!tb) return;
      this.lassoTb = tb;
      tb.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.style.opacity === '0.45') return;   // greyed out
        const mode = btn.dataset.mode;
        if (!mode) return;
        this._cmd({ type: 'lasso-mode', mode });
        btn.blur();
      });
      this.lassoBtns = {};
      for (const btn of tb.querySelectorAll('button')) {
        if (btn.dataset.mode) this.lassoBtns[btn.dataset.mode] = btn;
      }
    }
    _applyTransform(xf) {
      const tb = this.lassoTb;
      if (!tb) return;
      if (!xf || !xf.armed) {
        if (this._xfButtonsSig !== 'off') {
          tb.classList.add('hidden');
          this._xfButtonsSig = 'off';
        }
        this._stopAntsTick();
        return;
      }
      // Button-state signature — mode + raster flag is all the toolbar
      // buttons depend on. Avoid re-toggling classList every meta.
      const btnSig = (xf.mode || 'uniform') + '|' + (!!xf.isRaster);
      if (btnSig !== this._xfButtonsSig) {
        this._xfButtonsSig = btnSig;
        tb.classList.remove('hidden');
        const modeBtns = ['uniform', 'freeform', 'distort', 'warp'];
        for (const m of modeBtns) {
          const b = this.lassoBtns[m];
          if (!b) continue;
          b.classList.toggle('active', m === xf.mode);
          if (xf.isRaster && (m === 'distort' || m === 'warp')) {
            b.style.opacity = '0.45';
          } else {
            b.style.opacity = '';
          }
        }
        if (this.lassoBtns.reset) {
          this.lassoBtns.reset.style.display = 'none';
        }
      }
      this._positionLassoToolbar(xf);
      this._startAntsTick();
    }

    // Anchor the lasso toolbar's bottom-mid to the top-mid of the current
    // selection in pen-canvas CSS px. Mode-aware: uses the actual top edge
    // of distort/warp meshes so the toolbar follows the artwork as it
    // bends, same as main's _positionToolbar.
    _positionLassoToolbar(xf) {
      const tb = this.lassoTb;
      if (!tb || this.fit.w <= 0) return;
      const mode = xf.mode || 'uniform';
      const topMid = OT.LassoOverlay.topMidOf(xf, mode);
      // project px -> canvas CSS px (matches _compositeStage transforms).
      const projScale = this.fit.w / Math.max(1, this.state.project.width);
      const cssX = this.view.x + this.view.scale * (this.fit.x + projScale * topMid.x);
      const cssY = this.view.y + this.view.scale * (this.fit.y + projScale * topMid.y);
      // Affine modes have a rotate knob ~26 + 7 CSS px above the bbox top —
      // push the chip up past it so it doesn't cover the knob. Distort and
      // warp don't draw a rotate knob, so the tighter gap is fine there.
      const gap = (mode === 'distort' || mode === 'warp') ? 22 : 44;
      // Cache the toolbar width — offsetWidth forces synchronous layout,
      // which at 30 Hz costs ~1 ms each. Width only changes when the
      // toolbar visually changes (Reset hidden / shown), which we re-key
      // off of _xfButtonsSig above. Re-measure when the sig flips.
      if (this._tbWidth == null || this._tbSig !== this._xfButtonsSig) {
        this._tbWidth = tb.offsetWidth || 360;
        this._tbSig = this._xfButtonsSig;
      }
      const tbW = this._tbWidth;
      const stage = tb.parentElement;
      const stageW = stage ? stage.clientWidth : window.innerWidth;
      const x = Math.max(tbW / 2 + 8, Math.min(stageW - tbW / 2 - 8, cssX));
      const y = Math.max(36, cssY - gap);
      // Skip writes when neither coordinate moved enough to matter — a 1 px
      // round-trip per frame still costs a style recalc downstream.
      if (this._tbLastX === x && this._tbLastY === y) return;
      this._tbLastX = x; this._tbLastY = y;
      tb.style.left = x + 'px';
      tb.style.top = y + 'px';
      tb.style.transform = 'translate(-50%,-100%)';
    }
    _startAntsTick() {
      if (this._antsTimer) return;
      this._antsTimer = setInterval(() => {
        const tool = this.state.tool;
        const xf = tool && tool.transform;
        const armed = xf && xf.armed;
        const overlay = tool && tool.overlay;
        // Animate while ANY overlay needs ants: armed transform, lasso
        // loop being drawn, marquee drag, lifted raster selection, …
        if (!armed && !overlay) { this._stopAntsTick(); return; }
        this._scheduleComposite();
      }, 75);
    }
    _stopAntsTick() {
      if (this._antsTimer) { clearInterval(this._antsTimer); this._antsTimer = null; }
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
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.cssW = w; this.cssH = h;
      const c = this.canvas;
      c.style.width = w + 'px'; c.style.height = h + 'px';
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      this._computeFit();
      this._reportSize();
    }
    _reportSize() {
      if (!PEN) return;
      const k = this.cssW + 'x' + this.cssH + '@' + this.dpr;
      if (k === this._lastSizeKey) return;
      this._lastSizeKey = k;
      this._cmd({ type: 'pen-size', cssW: this.cssW, cssH: this.cssH, dpr: this.dpr });
    }
    _computeFit() {
      const pw = this.state.project.width || 1920;
      const ph = this.state.project.height || 1080;
      const s = Math.min(this.cssW / pw, this.cssH / ph);
      const w = pw * s, h = ph * s;
      this.fit = { x: (this.cssW - w) / 2, y: (this.cssH - h) / 2, w: w, h: h };
    }

    /* ---------------- incoming state ---------------- */
    _onState(msg) {
      if (!msg || !Array.isArray(msg.ops)) return;
      for (const op of msg.ops) {
        try { this._applyOp(op); }
        catch (e) { console.error('pen: bad op', op, e); }
      }
      if (typeof msg.seq === 'number') {
        this.state.seq = msg.seq;
        if (PEN && PEN.sendStateAck) {
          try { PEN.sendStateAck(msg.seq); } catch (_) {}
        }
      }
      // After applying ops, see if our wet stroke has been committed.
      this._checkWetCommit();
      this._scheduleComposite();
    }

    // Construct an OT.Layer from a snapshot and put it in state.layers.
    _hydrateLayer(snap) {
      const L = new OT.Layer(snap.name, snap.type);
      L.id = snap.id;
      L.visible = !!snap.visible;
      L.opacity = snap.opacity == null ? 1 : snap.opacity;
      L.color = snap.color || '';
      L.parentId = snap.parentId || null;
      L._collapsed = !!snap._collapsed;
      L.shadeOf = snap.shadeOf || null;
      L.transform = { keyframes: (snap.transform && snap.transform.keyframes) ? snap.transform.keyframes.slice() : [] };
      L.exposure = (snap.exposure || []).slice();
      L.cels = {};
      L.nextNum = 1;
      return L;
    }
    _hydrateCel(layer, frame, celSnap) {
      if (!celSnap) return;
      const num = celSnap.celNum || 1;
      let cel = layer.cels[num];
      if (!cel) {
        cel = new OT.Cel(num, celSnap.w, celSnap.h, celSnap.kind);
        layer.cels[num] = cel;
        if (num >= layer.nextNum) layer.nextNum = num + 1;
      }
      if (celSnap.kind === 'vector') {
        cel.strokes = Array.isArray(celSnap.strokes) ? celSnap.strokes.slice() : [];
        // Non-destructive eraser marks (see core.js Cel). Mirror them so
        // the pen's compositeStage punches the same destination-out
        // circles main does. Without this the pen would render strokes
        // intact after commit -- the erased view would disappear.
        cel.eraserMarks = Array.isArray(celSnap.eraserMarks)
          ? celSnap.eraserMarks.map(m => ({ x: m.x, y: m.y, r: m.r }))
          : [];
        // Populate cel.canvas so onion / thumbnails / any drawImage path
        // sees rendered pixels — compositeStage for vector cels re-renders
        // from cel.strokes directly so it never needed cel.canvas, but
        // onion-tint needs a real bitmap to recolour through source-in.
        cel.rebuild();
      }
      // raster cels: D1 keeps the placeholder; D2 wires bmp data
      layer.exposure[frame] = num;
    }

    _applyOp(op) {
      if (!op || !op.op) return;
      const s = this.state;
      // Any structural change to project/layers/cels/eraser/selection
      // invalidates the base-composite cache used during a transform
      // drag. Cheap setter; the actual rebuild is deferred until the
      // next composite that needs the cache.
      switch (op.op) {
        case 'init':
        case 'snapshot':
        case 'layers-replace':
        case 'vector-cel-replace':
        case 'erase-overlay':
        case 'frame-change':
        case 'active-layer':
        case 'project-meta':
        case 'lasso-orig':
          this._baseCacheDirty = true;
          break;
      }
      switch (op.op) {
        case 'init': {
          if (op.project) {
            Object.assign(s.project, op.project);
            this._computeFit();
          }
          if (Array.isArray(op.palette)) s.palette = op.palette.slice();
          if (Array.isArray(op.layers)) {
            s.layers = op.layers.map(snap => this._hydrateLayer(snap));
            s.layersById = new Map();
            for (const L of s.layers) s.layersById.set(L.id, L);
          }
          s.project.layers = s.layers;
          if (op.activeLayerId != null) s.activeLayerId = op.activeLayerId;
          if (typeof op.frame === 'number') s.frame = op.frame;
          if (op.cels && typeof op.cels === 'object') {
            for (const layerId in op.cels) {
              const layer = s.layersById.get(layerId);
              if (layer) this._hydrateCel(layer, s.frame, op.cels[layerId]);
            }
          }
          if (op.toolMeta) this._applyToolMeta(op.toolMeta);
          if (this.hint) this.hint.style.display = 'none';
          // Initial open: Electron sometimes withholds requestAnimationFrame
          // until the window gets focus, which left the canvas blank until
          // the user clicked something. Paint synchronously so the project
          // appears the moment init arrives.
          if (this._compositeRAF) {
            cancelAnimationFrame(this._compositeRAF);
            this._compositeRAF = 0;
          }
          try { this._compositeStage(); } catch (e) { console.error(e); }
          break;
        }
        case 'layers-replace': {
          if (!Array.isArray(op.layers)) break;
          // Preserve already-hydrated cels by id so a layer reorder/
          // visibility flip doesn't drop strokes.
          const oldById = s.layersById;
          s.layers = op.layers.map(snap => {
            const fresh = this._hydrateLayer(snap);
            const old = oldById.get(snap.id);
            if (old) {
              fresh.cels = old.cels;
              fresh.nextNum = old.nextNum;
            }
            return fresh;
          });
          s.layersById = new Map();
          for (const L of s.layers) s.layersById.set(L.id, L);
          s.project.layers = s.layers;
          if (op.activeLayerId != null) s.activeLayerId = op.activeLayerId;
          break;
        }
        case 'vector-cel-replace': {
          const layer = s.layersById.get(op.layerId);
          if (!layer || !op.cel) break;
          this._hydrateCel(layer, op.frame, op.cel);
          // A commit lands -- if it's on the same layer the eraser overlay
          // was targeting, the overlay is now redundant (committed cuts
          // ARE the eraser holes). Clear it.
          if (s.eraserOverlay && s.eraserOverlay.layerId === op.layerId
              && op.frame === s.frame) {
            s.eraserOverlay = null;
          }
          break;
        }
        case 'erase-overlay': {
          // Live destination-out punches from the active eraser drag on
          // main. Accumulate samples; _compositeStage paints them on top
          // of the rendered active layer (via temp canvas in composite.js)
          // so the user sees strokes get eaten in real time without us
          // republishing cut-stroke vectors that would change shape.
          if (!Array.isArray(op.samples) || !op.samples.length) break;
          if (!s.eraserOverlay || s.eraserOverlay.layerId !== op.layerId) {
            s.eraserOverlay = { layerId: op.layerId, samples: [] };
          }
          for (const p of op.samples) s.eraserOverlay.samples.push(p);
          break;
        }
        case 'frame-change': {
          if (typeof op.frame === 'number') s.frame = op.frame;
          // Drop any in-flight wet stroke — its cel context just changed
          // and rendering it on the new frame's cel would be wrong.
          if (s.wetStroke) this._clearWetStroke();
          // Same for the eraser overlay -- it was targeting the old frame's
          // cel content.
          if (s.eraserOverlay) s.eraserOverlay = null;
          break;
        }
        case 'active-layer': {
          if (op.layerId != null) s.activeLayerId = op.layerId;
          // Active layer just changed; wet stroke (if any) was targeting
          // the previous active layer's cel.
          if (s.wetStroke) this._clearWetStroke();
          if (s.eraserOverlay) s.eraserOverlay = null;
          break;
        }
        case 'project-meta': {
          if (op.patch) {
            Object.assign(s.project, op.patch);
            this._computeFit();
          }
          break;
        }
        case 'palette': {
          if (Array.isArray(op.colors)) s.palette = op.colors.slice();
          break;
        }
        case 'tool-meta': {
          if (op.meta) this._applyToolMeta(op.meta);
          break;
        }
        case 'lasso-orig': {
          // Fresh v.orig snapshot from main — published on session arm
          // and every mode switch (rebaseline). Includes the strokeIds
          // and layerId (formerly on every tool-meta — moved here so
          // the 30 Hz tool-meta payload stays small).
          this._lassoOrig = op.origPts || null;
          this._lassoOrigSig = op.sig || null;
          this._lassoLayerId = op.layerId || null;
          if (this._lassoSession) {
            this._lassoSession.preview = null;
            this._lassoSession.origMap = this._lassoOrig;
          }
          break;
        }
        default: break;     // forward-compatible: unknown ops are ignored
      }
    }

    _applyToolMeta(meta) {
      if (!meta) return;
      const t = this.state.tool;
      if (meta.tool || meta.name) t.name = meta.name || meta.tool;
      if (meta.color) t.color = meta.color;
      if (typeof meta.brushFrac === 'number') t.brushFrac = meta.brushFrac;
      // toolRadius is the cursor radius in *project px* (before main-side
      // viewport zoom). Preferred over brushFrac for drawing the cursor
      // circle on the pen, since brushFrac is normalised against the main
      // canvas's CSS width and is awkward to invert here. Both fields
      // coexist; older builds may only ship brushFrac.
      if (typeof meta.toolRadius === 'number') t.toolRadius = meta.toolRadius;
      if (typeof meta.toolSize === 'number') t.toolSize = meta.toolSize;
      if (typeof meta.toolOpacity === 'number') t.toolOpacity = meta.toolOpacity;
      if (typeof meta.pencil === 'boolean') t.pencil = meta.pencil;
      // Finalize params (Task 4): pen-side wet stroke uses these to call
      // OT.StrokeFinalize.finalize() with the same inputs main uses.
      // `smoothing` drives the One Euro filter the pen applies BEFORE
      // finalize, so pen's raw matches main's (One-Euro-smoothed) raw.
      if (typeof meta.tol === 'number') t.tol = meta.tol;
      if (typeof meta.snapDist === 'number') t.snapDist = meta.snapDist;
      if (typeof meta.inkDynamics === 'boolean') t.inkDynamics = meta.inkDynamics;
      if (typeof meta.autoClose === 'boolean') t.autoClose = meta.autoClose;
      if (typeof meta.smoothing === 'number') t.smoothing = meta.smoothing;
      // Shape-snap (QuickShape) live preview. `null` clears, an object
      // {pts, closed, pencil} causes _compositeStage to render the snapped
      // shape in place of the artist's freehand wet stroke. Updated by
      // main on every overlayrender pump (~30 Hz) so the morph animation
      // is visible on the pen during the drag instead of only on commit.
      if ('snapShape' in meta) t.snapShape = meta.snapShape;
      if (meta.sel) t.sel = meta.sel;
      if (meta.transform) t.transform = meta.transform;
      // Onion-skin settings mirrored from main. _compositeStage draws the
      // adjacent-frame cels under the live composite using these values
      // and the pen's own hydrated layer cache. A change to the settings
      // means the base cache (which has onion baked in) needs rebuilding.
      if ('onion' in meta) {
        const prev = this.state.onion;
        const next = meta.onion;
        const sig = o => o ? (o.on + '|' + o.prev + '|' + o.next + '|'
          + o.prevColor + '|' + o.nextColor + '|'
          + o.maxAlpha + '|' + o.minAlpha) : 'off';
        if (sig(prev) !== sig(next)) this._baseCacheDirty = true;
        this.state.onion = next;
      }
      // Generic tool-overlay channel — see pencast.js: pen-window parity
      // contract. `null` clears, an object describes overlay state for
      // the pen to render via _drawToolOverlay.
      if ('toolOverlay' in meta) {
        t.overlay = meta.toolOverlay;
        // Animation tick must run while there's an unrolled lasso loop /
        // active marquee / lifted region — same cadence as armed transform.
        if (t.overlay) this._startAntsTick();
      }
      if (typeof meta.activeLayerKind === 'string') t.activeLayerKind = meta.activeLayerKind;
      // Tool button active-class — only update when the active tool
      // actually changes. classList.toggle in a 5-item loop at 30 Hz is
      // ~150 style invalidations / sec for no reason.
      if (this._toolBtnsName !== t.name) {
        this._toolBtnsName = t.name;
        for (const n in this.toolBtns)
          this.toolBtns[n].classList.toggle('active', n === t.name);
      }
      // Colour chip — also dedupe.
      if (t.color !== this._lastColor) {
        this._lastColor = t.color;
        if (t.color && /^#[0-9a-fA-F]{6}$/.test(t.color))
          this.colorInput.value = t.color;
        if (this.colorWrap) this.colorWrap.style.background = t.color || '#222222';
      }
      this._refreshSizeChip();
      const f = (this.state.frame || 0) + 1;
      const total = this.state.project.frameCount || 1;
      const frameTxt = f + ' / ' + total;
      if (this.frameLabel && this._lastFrameTxt !== frameTxt) {
        this._lastFrameTxt = frameTxt;
        this.frameLabel.textContent = frameTxt;
      }
      this._refreshActions(t.sel || {}, t.transform);
      // Select Pixels uses the same floating chip as the lasso transform —
      // synthesise an armed-transform-shaped object from the overlay so
      // _applyTransform doesn't have to know about the select tool.
      let xfForChip = t.transform;
      if (t.overlay && t.overlay.kind === 'select-lifted' && t.overlay.s) {
        xfForChip = Object.assign({}, t.overlay.s, {
          armed: true, mode: 'uniform', isRaster: true
        });
      }
      this._applyTransform(xfForChip);
      // If the tool/layer is no longer wet-stroke-eligible, drop any wet
      if (this.state.wetStroke
          && (t.activeLayerKind !== 'vector'
              || (t.name !== 'brush' && t.name !== 'pencil'))) {
        this._clearWetStroke();
      }
    }

    _refreshActions(sel, transform) {
      const el = this.actions;
      if (!el) return;
      // Skip the entire DOM rebuild when nothing visible to the chip has
      // changed. Tool-meta arrives at 30 Hz — without this signature
      // check we'd churn createElement / innerHTML / appendChild every
      // 33 ms, which dominates the pen's main-thread time during a
      // transform.
      const armed = !!(transform && transform.armed);
      const sig = !sel || !sel.count
        ? 'empty'
        : (sel.count + '|' + (sel.color || '') + '|'
            + ((sel.colors || []).join(',')) + '|'
            + (!!sel.group) + '|' + (!!sel.hasXform) + '|' + armed);
      if (sig === this._actionsSig) return;
      this._actionsSig = sig;
      if (!sel || !sel.count) {
        el.classList.add('hidden');
        el.classList.remove('is-active');
        el.innerHTML = '';
        el.onclick = null;
        return;
      }
      el.classList.remove('hidden');
      el.classList.toggle('is-active', armed);
      el.innerHTML = '';   // rebuild — sig-gated above so this isn't per-frame
      el.onclick = (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('.ca-popover')) return;
        if (armed) {
          // Click commits, same as the main chip.
          this._cmd({ type: 'lasso-mode', mode: 'commit' });
          return;
        }
        this._cmd({ type: 'free-transform' });
      };
      // ---- dot(s): single dot or stacked-3 for multi-select ----
      if (sel.count === 1) {
        const dot = document.createElement('span');
        dot.className = 'ca-dot' + (sel.group ? ' ca-dot-group' : '');
        dot.style.background = sel.color || '#3d9be0';
        el.appendChild(dot);
      } else if (sel.count > 1) {
        const stack = document.createElement('span');
        stack.className = 'ca-dot-stack';
        const colors = (sel.colors && sel.colors.length) ? sel.colors : [sel.color];
        for (let i = 0; i < Math.min(3, sel.count); i++) {
          const d = document.createElement('span');
          d.className = 'ca-dot';
          d.style.background = colors[i] || colors[0] || '#3d9be0';
          stack.appendChild(d);
        }
        el.appendChild(stack);
      }
      // ---- CTA: icon + Transform/Transforming + kbd ----
      const cta = document.createElement('div');
      cta.className = 'ca-cta';
      const icon = document.createElement('span');
      icon.className = 'ca-cta-icon';
      icon.innerHTML = svg('<path d="M4 4l4 4M16 4l-4 4M4 20l4-4M16 20l-4-4M3 12h6M15 12h6M12 3v6M12 15v6"/>');
      cta.appendChild(icon);
      const txt = document.createElement('span');
      txt.className = 'ca-cta-text';
      txt.textContent = armed ? 'Transforming' : 'Transform';
      cta.appendChild(txt);
      const kbd = document.createElement('kbd');
      kbd.className = 'ca-kbd';
      kbd.textContent = armed ? '✓' : 'T';
      cta.appendChild(kbd);
      el.appendChild(cta);
      el.title = armed
        ? 'Free Transform armed — click to commit, Esc to cancel'
        : 'Free Transform';
      // ---- popover (Reset, when targets already carry a transform) ----
      if (sel.hasXform) {
        const pop = document.createElement('div');
        pop.className = 'ca-popover';
        const rs = document.createElement('button');
        rs.className = 'ca-btn ca-reset';
        rs.title = 'Reset transform';
        rs.innerHTML = svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>') + '<span>Reset</span>';
        rs.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._cmd({ type: 'reset-transform' });
          el.classList.remove('open');
        });
        pop.appendChild(rs);
        el.appendChild(pop);
      }
    }

    /* ---------------- wet stroke lifecycle ---------------- */
    _wetEligible() {
      const t = this.state.tool;
      if (t.name !== 'brush' && t.name !== 'pencil') return false;
      // activeLayerKind is null at startup before any tool-meta has been
      // processed. If the user's first pointerdown beats the init op's
      // toolMeta (a timing race on initial pen-window open), seeding
      // would be incorrectly skipped and they'd see no wet preview
      // until the second stroke. Treat null as "unknown, assume vector"
      // -- _applyToolMeta clears any stale wet stroke if a later
      // tool-meta arrives with a non-vector activeLayerKind.
      return t.activeLayerKind === 'vector' || t.activeLayerKind == null;
    }
    _seedWetStroke(id, projPt) {
      const t = this.state.tool;
      // wet.rawPts is the append-only One-Euro-smoothed input -- the same
      // shape main's tools accumulate via _vMove. wet.pts is the finalize
      // output that the renderer sees. Both start with the single seed
      // point because finalize on a 1-pt array returns that 1-pt array.
      //
      // The One Euro filter state lives ON the wetStroke (not the
      // PenWindow) so it dies with the stroke automatically and a new
      // stroke gets a fresh filter set.
      const wet = {
        id: id, type: 'line',
        pencil: t.name === 'pencil',
        color: t.color || '#222222',
        width: t.toolSize || 6,
        opacity: t.toolOpacity == null ? 1 : t.toolOpacity,
        closed: false,
        rawPts: null,            // set after filter init below
        pts: null,
        smooth: t.smoothing || 0  // drives One Euro params; updated per-extend
      };
      // Initialize the 3-axis One Euro filter with the seed point so the
      // first applyOneEuro call has prior state.
      OT.StrokeFinalize.initOneEuro(wet, {
        x: projPt.x, y: projPt.y, pressure: projPt.p
      });
      const seedSmoothed = { x: projPt.x, y: projPt.y, p: projPt.p, t: performance.now() };
      wet.rawPts = [seedSmoothed];
      wet.pts = wet.rawPts;
      this.state.wetStroke = wet;
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
    // predictedPts is accepted but ignored for forward compatibility -- D1
    // does not render predicted touches (see _seedWetStroke comment).
    //
    // We MUST replace pts with a fresh array reference (not push in place):
    // OT.Vector.samplesOf caches smoothed samples in a WeakMap keyed by the
    // pts array reference. Mutating the array in place leaves the cache
    // pointing at stale samples (e.g. the just-seeded one-point stroke),
    // and the renderer draws only those samples no matter how many new
    // points we add. Building a new array on every extend invalidates the
    // cache; smoothPath is O(N) and N stays small for in-progress strokes.
    _extendWetStroke(actualPts, predictedPts) {
      const ws = this.state.wetStroke;
      if (!ws || !actualPts || !actualPts.length) return;
      const t = this.state.tool;
      // Keep ws.smooth current so the slider taking effect mid-stroke
      // re-tunes the One Euro filter on the next applyOneEuro call.
      ws.smooth = t.smoothing || 0;
      // One Euro filter every incoming raw cursor sample BEFORE pushing
      // to rawPts -- this matches what main's _vMove does on its end.
      // Without this, pen's rawPts is raw cursor and main's is smoothed,
      // and finalize on either side produces a different stroke shape.
      const smoothed = [];
      const now = performance.now();
      for (const p of actualPts) {
        const sm = OT.StrokeFinalize.applyOneEuro(ws, {
          x: p.x, y: p.y, pressure: p.p
        });
        smoothed.push({ x: sm.x, y: sm.y, p: sm.p, t: now });
      }
      // Fresh array reference -- invalidates OT.Vector.samplesOf cache;
      // finalize then produces a fresh output array too.
      ws.rawPts = ws.rawPts.concat(smoothed);
      const layer = this.state.layersById.get(this.state.activeLayerId);
      const cel = layer ? layer.celAt(this.state.frame) : null;
      const fin = OT.StrokeFinalize.finalize(ws.rawPts, {
        tol: typeof t.tol === 'number' ? t.tol : 0.4,
        snapDist: typeof t.snapDist === 'number' ? t.snapDist : 0,
        inkDynamics: !!t.inkDynamics,
        autoClose: !!t.autoClose,
        cel: cel && cel.kind === 'vector' ? cel : null
      });
      ws.pts = fin.pts;
      ws.closed = fin.closed;
    }
    // Called on pointerup, before the wet timer is armed. Mirrors what
    // main's PaintTool._vUp does immediately before its own finalize call:
    //
    //   this.raw.push({ x: pt.x, y: pt.y, p: pt.pressure, t: tNow });
    //
    // The raw release pt is NOT One-Euro-filtered on main, so we must
    // skip the filter here too — applying One Euro at release would shift
    // the endpoint INTO the smoothed trail and put the pen's finalize
    // input out of sync with main's. The result was a visible ~1 px snap
    // when the committed stroke replaced the wet preview.
    _appendReleaseAndRefinalize(projPt) {
      const ws = this.state.wetStroke;
      if (!ws) return;
      const t = this.state.tool;
      ws.rawPts = ws.rawPts.concat([{
        x: projPt.x, y: projPt.y, p: projPt.p, t: performance.now()
      }]);
      const layer = this.state.layersById.get(this.state.activeLayerId);
      const cel = layer ? layer.celAt(this.state.frame) : null;
      const fin = OT.StrokeFinalize.finalize(ws.rawPts, {
        tol: typeof t.tol === 'number' ? t.tol : 0.4,
        snapDist: typeof t.snapDist === 'number' ? t.snapDist : 0,
        inkDynamics: !!t.inkDynamics,
        autoClose: !!t.autoClose,
        cel: cel && cel.kind === 'vector' ? cel : null
      });
      ws.pts = fin.pts;
      ws.closed = fin.closed;
    }
    // Defensive timer: started on pointerup, NOT on seed. While the artist
    // is still dragging, the wet stroke must stay alive arbitrarily long.
    // Once the artist lifts, main has 2 seconds to commit (via celchange)
    // or we drop the wet stroke to avoid a phantom that never clears.
    _armWetTimer() {
      if (this._wetTimer) clearTimeout(this._wetTimer);
      this._wetTimer = setTimeout(() => this._clearWetStroke(), 2000);
    }
    _clearWetStroke() {
      this.state.wetStroke = null;
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
    // After applying any state batch, see if our wet stroke has been
    // committed -- if a cel now contains a stroke with our wet id, drop.
    _checkWetCommit() {
      const ws = this.state.wetStroke;
      if (!ws) return;
      const layer = this.state.layersById.get(this.state.activeLayerId);
      if (!layer) return;
      const cel = layer.celAt(this.state.frame);
      if (!cel || cel.kind !== 'vector' || !Array.isArray(cel.strokes)) return;
      for (const st of cel.strokes) {
        if (st.id === ws.id) {
          this._clearWetStroke();
          return;
        }
      }
    }

    /* ---------------- draw ---------------- */
    draw() { this._compositeStage(); }
    _scheduleComposite() {
      if (this._compositeRAF) return;
      this._compositeRAF = requestAnimationFrame(() => {
        this._compositeRAF = 0;
        this._compositeStage();
      });
    }
    _layerAncestors(layer) {
      const out = [];
      let cur = layer;
      while (cur && cur.parentId) {
        const next = this.state.layersById.get(cur.parentId);
        if (!next || next === layer || out.includes(next)) break;
        out.push(next);
        cur = next;
      }
      return out;
    }
    // Render the full layer composite into a project-sized offscreen canvas
    // with selected strokes already excluded (their _lassoHidden flag is
    // honoured by renderCel). Called only when the cache is dirty.
    _renderBaseCache() {
      const s = this.state;
      const w = Math.max(1, s.project.width), h = Math.max(1, s.project.height);
      if (!this._baseCache) this._baseCache = document.createElement('canvas');
      if (this._baseCache.width !== w || this._baseCache.height !== h) {
        this._baseCache.width = w;
        this._baseCache.height = h;
      }
      const bctx = this._baseCache.getContext('2d');
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, w, h);
      // Paint bg + onion ourselves so onion sits between background and
      // the layer composite (matches main window's canvas.js render order).
      bctx.fillStyle = s.project.bg || '#ffffff';
      bctx.fillRect(0, 0, w, h);
      this._drawOnion(bctx);
      OT.compositeStage(s.project, s.frame, bctx, {
        bg: false,
        includeVideo: false,
        eraserOverlay: s.eraserOverlay
      }, {
        layerAncestors: layer => this._layerAncestors(layer)
      });
      this._baseCacheDirty = false;
    }
    // Onion skin: tint each adjacent-frame cel of the active layer, fade
    // by distance, blit them under the live composite. Pen mirrors the
    // settings + cels via tool-meta + vector-cel-replace from pencast.
    _drawOnion(ctx) {
      const s = this.state;
      const o = s.onion;
      if (!o || !o.on) return;
      const layer = s.layersById.get(s.activeLayerId);
      if (!layer || !layer.celAt) return;
      const f = s.frame;
      const fc = s.project.frameCount || 1;
      const tmp = this._onionTmp || (this._onionTmp = document.createElement('canvas'));
      const drawSet = (count, dir, color) => {
        for (let i = 1; i <= (count | 0); i++) {
          const fr = f + dir * i;
          if (fr < 0 || fr >= fc) break;
          const cel = layer.celAt(fr);
          if (!cel || !cel.canvas) continue;
          // Tint cel into a temp canvas: source-over the cel, then source-in
          // the onion colour to recolour every opaque pixel uniformly.
          if (tmp.width !== cel.w) tmp.width = cel.w;
          if (tmp.height !== cel.h) tmp.height = cel.h;
          const tx = tmp.getContext('2d');
          tx.setTransform(1, 0, 0, 1, 0, 0);
          tx.clearRect(0, 0, cel.w, cel.h);
          tx.globalCompositeOperation = 'source-over';
          tx.drawImage(cel.canvas, 0, 0);
          tx.globalCompositeOperation = 'source-in';
          tx.fillStyle = color;
          tx.fillRect(0, 0, cel.w, cel.h);
          tx.globalCompositeOperation = 'source-over';
          const a = (count <= 1) ? o.maxAlpha
            : (o.maxAlpha + (o.minAlpha - o.maxAlpha) * ((i - 1) / (count - 1)));
          ctx.save();
          ctx.globalAlpha = a;
          // Layer transform: same world xform that the active layer uses
          // when compositing — keeps onion aligned with the live composite.
          if (OT.applyWorldXform)
            OT.applyWorldXform(ctx, layer, fr, s.project,
              l => this._layerAncestors(l));
          ctx.drawImage(tmp, 0, 0, s.project.width, s.project.height);
          ctx.restore();
        }
      };
      drawSet(o.prev, -1, o.prevColor);
      drawSet(o.next, 1, o.nextColor);
      ctx.globalAlpha = 1;
    }
    // Mark the base cache stale so the next composite rebuilds it. Call
    // from every op that could change the rendered output of any layer.
    _invalidateBaseCache() { this._baseCacheDirty = true; }
    _compositeStage() {
      const s = this.state;
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cssW, this.cssH);
      c.fillStyle = '#0c0d10';
      c.fillRect(0, 0, this.cssW, this.cssH);
      // local view (zoom/pan on pen, doesn't touch main)
      c.save();
      c.translate(this.view.x, this.view.y);
      c.scale(this.view.scale, this.view.scale);
      // map the project rect into the fit rectangle
      if (this.fit.w > 0) {
        const projScale = this.fit.w / Math.max(1, s.project.width);
        c.translate(this.fit.x, this.fit.y);
        c.scale(projScale, projScale);
        // Pass the wet stroke straight through. Its `pts` is the finalize
        // output rebuilt on every _extendWetStroke -- a fresh array each
        // time, so OT.Vector.samplesOf's WeakMap key changes and the
        // sample cache stays correct. No predicted touches are appended —
        // see _seedWetStroke for the rationale.
        //
        // If shape-snap (QuickShape) is active on main, the snapped pts
        // arrive via tool-meta as state.tool.snapShape. Override the wet
        // stroke's pts with the snapped pts (and force sharp+no-taper so
        // it renders as a clean primitive) so the artist sees the morph
        // live during the drag instead of only after release.
        let wetForRender = s.wetStroke;
        if (wetForRender && s.tool.snapShape && s.tool.snapShape.pts) {
          const ss = s.tool.snapShape;
          wetForRender = Object.assign({}, s.wetStroke, {
            pts: ss.pts,
            closed: !!ss.closed,
            sharp: true,
            taper: false,
            pencil: !!ss.pencil
          });
        }
        // Live transform: the selected strokes are flagged _lassoHidden
        // once per session (in _ensureLassoSession) so the cel cache
        // doesn't render them at their original position.
        const lassoSession = this._ensureLassoSession();
        // Base-composite cache: when no wet stroke is in flight, the layer
        // composite is invariant between frames. Build it once, blit per
        // overlay tick — one drawImage instead of iterating every layer's
        // strokes through compositeStage every ~33ms. This is what kept
        // the pen's FPS pinned to main's during ants animation; without
        // it, marching ants triggered full re-composite at 13fps minimum.
        // The cache is invalidated by ANY state change (cel/layer/frame/
        // project/erase-overlay/lasso-orig — see the op switch above).
        if (!wetForRender) {
          if (this._baseCacheDirty || !this._baseCache) this._renderBaseCache();
          c.drawImage(this._baseCache, 0, 0);
        } else {
          // Wet-stroke path: paint bg + onion + layers ourselves so onion
          // sits below the live composite (matches main's render order).
          c.fillStyle = s.project.bg || '#ffffff';
          c.fillRect(0, 0, s.project.width, s.project.height);
          this._drawOnion(c);
          OT.compositeStage(s.project, s.frame, c, {
            bg: false,
            wetStroke: wetForRender || null,
            wetLayerId: s.activeLayerId,
            includeVideo: false,         // D1: pen has no <video> element
            eraserOverlay: s.eraserOverlay
          }, {
            layerAncestors: layer => this._layerAncestors(layer)
          });
        }
        this._drawLassoLivePreview(c, lassoSession);
        // Transform HUD: bounding box + handles, drawn in project px (we're
        // still inside the project transform). The handle line-widths /
        // sizes account for the combined pen-view scale so they look the
        // same regardless of how the artist has zoomed locally.
        this._drawTransformHud(c, projScale * this.view.scale);
        // Tool-overlay parity channel — see _drawToolOverlay header.
        this._drawToolOverlay(c, projScale * this.view.scale);
      }
      c.restore();   // local view
      // Cursor circle — drawn in screen-space (after restore), so the
      // 1px stroke stays crisp regardless of the local view zoom. We're
      // currently in DPR-scaled coords (setTransform above), and
      // _cursorCss is in CSS-px, so the existing transform handles DPR.
      this._drawCursor(c);
    }

    _drawCursor(c) {
      const cur = this._cursorCss;
      if (!cur) return;
      const t = this.state.tool;
      if (!t) return;
      const name = t.name;
      if (name !== 'brush' && name !== 'pencil' && name !== 'eraser') return;
      // Prefer the project-space radius shipped in tool-meta. Fall back to
      // brushFrac * fit.w (an approximation) if an older main hasn't
      // published toolRadius yet.
      let radiusCss = 0;
      if (t.toolRadius && this.state.project.width > 0 && this.fit.w > 0) {
        const radiusProj = t.toolRadius;
        radiusCss = radiusProj * (this.fit.w / this.state.project.width) * this.view.scale;
      } else if (t.brushFrac && this.fit.w > 0) {
        radiusCss = t.brushFrac * this.fit.w * this.view.scale;
      }
      if (!(radiusCss > 0.5)) return;
      c.save();
      c.lineWidth = 1;
      c.beginPath();
      c.arc(cur.x, cur.y, radiusCss, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(0,0,0,0.85)';
      c.stroke();
      c.beginPath();
      c.arc(cur.x, cur.y, radiusCss + 1, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.stroke();
      c.restore();
    }

    // Lasso live-preview helpers — main hides the selected strokes from its
    // cel cache during a transform drag and draws a pre-rasterised snippet
    // through the matrix. The pen mirrors that with a per-session flag set
    // (this._lassoSession) so cel.rebuild only runs once on arm and once
    // on disarm — not twice per frame. During the session each composite
    // is: compositeStage (cheap, cel.canvas is already correct) + a single
    // pass over the flagged strokes through the live transform.
    _ensureLassoSession() {
      const xf = this.state.tool && this.state.tool.transform;
      // strokeIds now live on the lasso-orig op (not in meta.transform)
      // so a session is "wanted" iff meta says armed AND we have a
      // matching orig snapshot. First armed frame before lasso-orig
      // arrives is one composite without a session — harmless.
      const ids = this._lassoOrig ? Object.keys(this._lassoOrig) : null;
      const wantSession = !!(xf && xf.armed && ids && ids.length);
      const cur = this._lassoSession;
      if (!wantSession && !cur) return null;
      if (!wantSession && cur) {
        // Disarmed — restore cel state.
        for (const st of cur.flagged) st._lassoHidden = false;
        if (cur.cel && cur.cel.rebuild) cur.cel.rebuild();
        this._lassoSession = null;
        // Drop the cached orig snapshot; next arm gets a fresh one.
        this._lassoOrig = null;
        this._lassoOrigSig = null;
        this._lassoLayerId = null;
        // cel.canvas now contains the formerly-hidden strokes again, so
        // the composite cache needs a refresh too.
        this._baseCacheDirty = true;
        return null;
      }
      const lid = this._lassoLayerId || xf.layerId;
      const layer = lid
        ? this.state.layersById.get(lid)
        : this.state.layersById.get(this.state.activeLayerId);
      if (!layer) return null;
      const cel = layer.celAt(this.state.frame);
      if (!cel || cel.kind !== 'vector' || !Array.isArray(cel.strokes)) return null;
      const idsKey = this._lassoOrigSig || (ids.join('|') + '@' + (layer.id || '') + '#' + this.state.frame);
      if (cur && cur.idsKey === idsKey) {
        cur.xf = xf;
        if (!cur.preview) cur.preview = this._buildLassoSnippet(cur);
        return cur;
      }
      // New session (or selection changed) — flip flags + rebuild ONCE.
      if (cur) {
        for (const st of cur.flagged) st._lassoHidden = false;
        if (cur.cel && cur.cel !== cel && cur.cel.rebuild) cur.cel.rebuild();
      }
      const idSet = new Set(ids);
      const flagged = [];
      for (const st of cel.strokes) {
        if (st && st.id && idSet.has(st.id)) {
          st._lassoHidden = true;
          flagged.push(st);
        }
      }
      if (!flagged.length) {
        this._lassoSession = null;
        return null;
      }
      if (cel.rebuild) cel.rebuild();
      const sess = {
        xf, cel, flagged, idsKey,
        origMap: this._lassoOrig,   // null until first lasso-orig op
        preview: null
      };
      sess.preview = this._buildLassoSnippet(sess);
      this._lassoSession = sess;
      // New session means cel.canvas just got rebuilt with strokes hidden;
      // the base composite cache built from the old cel.canvas is stale.
      this._baseCacheDirty = true;
      return sess;
    }
    // Pre-rasterise the selected strokes into a project-sized offscreen
    // canvas at their orig positions. During affine drag we blit this
    // through one ctx.transform — O(1) per frame regardless of stroke
    // count. Mirrors LassoTool._buildPreviewSnippet exactly. Returns null
    // if we don't yet have an orig snapshot (fall back to per-stroke render).
    _buildLassoSnippet(sess) {
      const origMap = sess.origMap;
      if (!origMap) return null;
      const w = Math.max(1, this.state.project.width);
      const h = Math.max(1, this.state.project.height);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const renderClone = (st, orig) => {
        // Build a transient stroke object so renderStroke uses the orig pts
        // (which are the post-rebaseline snapshot, not the live mutated pts).
        if (orig.contour) {
          OT.Vector.renderStroke(ctx, Object.assign({}, st, { contour: orig.contour, _lassoHidden: false }));
        } else if (orig.pts) {
          OT.Vector.renderStroke(ctx, Object.assign({}, st, { pts: orig.pts, _lassoHidden: false }));
        }
      };
      for (const st of sess.flagged) {
        const orig = origMap[st.id];
        if (orig && st.type === 'fill') renderClone(st, orig);
      }
      for (const st of sess.flagged) {
        const orig = origMap[st.id];
        if (orig && st.type !== 'fill') renderClone(st, orig);
      }
      return c;
    }
    _drawLassoLivePreview(c, sess) {
      if (!sess) return;
      const xf = sess.xf;
      const mode = xf.mode || 'uniform';
      const isAffine = (mode === 'uniform' || mode === 'freeform');
      // Fast path: snippet canvas + one drawImage through the affine
      // matrix. Same pattern main uses, so the per-frame cost is constant
      // regardless of how many strokes are in the selection.
      if (isAffine && sess.preview) {
        c.save();
        c.translate(xf.cx, xf.cy);
        c.rotate(xf.rot || 0);
        c.scale(xf.scaleX || 1, xf.scaleY || 1);
        c.drawImage(sess.preview, -xf.origCx, -xf.origCy);
        c.restore();
        return;
      }
      // Slow paths follow — used when we don't yet have an orig snapshot
      // (snippet not built) or when the mesh forward map needs per-pt
      // application. Briefly clear _lassoHidden so renderStroke paints.
      for (const st of sess.flagged) st._lassoHidden = false;
      // Prefer orig pts from the lasso-orig snapshot over the (possibly
      // stale) cel.strokes pts. For the very first frame after arm,
      // before the snapshot has arrived, fall back to cel.strokes.
      const origMap = sess.origMap;
      const origPtsFor = (st) => {
        const o = origMap && origMap[st.id];
        if (o) return st.type === 'fill' ? o.contour : o.pts;
        return st.type === 'fill' ? st.contour : st.pts;
      };
      if (isAffine) {
        c.save();
        c.translate(xf.cx, xf.cy);
        c.rotate(xf.rot || 0);
        c.scale(xf.scaleX || 1, xf.scaleY || 1);
        c.translate(-xf.origCx, -xf.origCy);
        const renderAt = (st, pts) => {
          const clone = st.type === 'fill'
            ? Object.assign({}, st, { contour: pts })
            : Object.assign({}, st, { pts });
          OT.Vector.renderStroke(c, clone);
        };
        for (const st of sess.flagged) if (st.type === 'fill') renderAt(st, origPtsFor(st));
        for (const st of sess.flagged) if (st.type !== 'fill') renderAt(st, origPtsFor(st));
        c.restore();
      } else {
        const fwd = OT.MeshWarp.makeForward(mode, xf);
        const mapPts = (pts) => {
          const out = new Array(pts.length);
          for (let i = 0; i < pts.length; i++) {
            const r = fwd(pts[i].x, pts[i].y);
            out[i] = { x: r.x, y: r.y, p: pts[i].p };
          }
          return out;
        };
        const renderTransformed = (st) => {
          const orig = origPtsFor(st);
          if (st.type === 'fill') {
            OT.Vector.renderStroke(c, Object.assign({}, st, { contour: mapPts(orig) }));
          } else {
            OT.Vector.renderStroke(c, Object.assign({}, st, { pts: mapPts(orig) }));
          }
        };
        for (const st of sess.flagged) if (st.type === 'fill') renderTransformed(st);
        for (const st of sess.flagged) if (st.type !== 'fill') renderTransformed(st);
      }
      for (const st of sess.flagged) st._lassoHidden = true;
    }

    // Render the transform bounding box + handles when the main side has a
    // lasso transform armed. Anchors arrive in project px via tool-meta;
    // the projScale arg lets us keep stroke widths / handle sizes visually
    // consistent across the artist's local zoom.
    _drawTransformHud(c, viewScale) {
      const xf = this.state.tool && this.state.tool.transform;
      if (!xf || !xf.armed) return;
      // xf already carries every field OT.LassoOverlay expects (cx, cy,
      // sw, sh, scaleX, scaleY, rot, distortC, warpC, warpM) — same
      // surface main passes its `vt` through. One call paints ants +
      // handles identically to the main canvas.
      OT.LassoOverlay.drawOverlay(c, xf, xf.mode || 'uniform', viewScale);
    }

    // Render the generic per-tool overlay (the lasso loop being drawn, a
    // marquee drag, a lifted raster selection, …). Tools describe their
    // state via Tool.penMeta(); pencast ships it; we dispatch on `kind`.
    // Add a new overlay → add a `case` here + a `kind` in penMeta(). One
    // canonical render path for both windows via OT.LassoOverlay.
    _drawToolOverlay(c, viewScale) {
      const o = this.state.tool && this.state.tool.overlay;
      if (!o) return;
      switch (o.kind) {
        case 'lasso-loop': {
          const poly = o.poly;
          if (!poly || poly.length < 1) break;
          const trace = (ctx) => {
            ctx.beginPath();
            ctx.moveTo(poly[0].x, poly[0].y);
            for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
          };
          OT.LassoOverlay.ants(c, viewScale, trace);
          // start-point pip so the artist sees where the loop will close
          const s = poly[0], r = 4 / Math.max(0.001, viewScale);
          c.save();
          c.fillStyle = '#fff'; c.strokeStyle = '#000';
          c.lineWidth = 1.2 / Math.max(0.001, viewScale);
          c.beginPath(); c.arc(s.x, s.y, r, 0, Math.PI * 2);
          c.fill(); c.stroke();
          c.restore();
          break;
        }
        case 'select-marquee': {
          const r = o.rect;
          if (!r) break;
          OT.LassoOverlay.ants(c, viewScale, (ctx) => {
            ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h);
          });
          break;
        }
        case 'select-lifted': {
          if (!o.s) break;
          OT.LassoOverlay.drawOverlay(c, o.s, 'uniform', viewScale);
          break;
        }
        case 'select-vsel': {
          const r = o.rect;
          if (!r) break;
          OT.LassoOverlay.ants(c, viewScale, (ctx) => {
            ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h);
          });
          break;
        }
      }
    }

    /* ---------------- pointer input ---------------- */
    _installInput() {
      const cv = this.canvas;
      const rect = () => cv.getBoundingClientRect();
      // Map a window-CSS-px coord back through the local view to a 0..1
      // fraction over the project rect, so input always lands on the
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
      // Convert a 0..1 fraction to a project-space pt the wet stroke can
      // render at (matches the main side's _ptFromNorm math).
      const toProjPt = (n, pressure) => ({
        x: n.nx * this.state.project.width,
        y: n.ny * this.state.project.height,
        p: pressure == null ? 1 : pressure
      });
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
        if (PEN) PEN.sendInput({ type: 'cancel' });
        // The wet stroke is local; if a gesture takes over, drop it so
        // we don't leave a phantom line on screen.
        this._clearWetStroke();
        this._scheduleComposite();
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
        // Need a project rect computed to map input into normalised coords.
        if (!this.fit.w) return;
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
        const pressure = e.pointerType === 'pen' ? e.pressure : 1;
        this.stroking = true;
        // A new gesture invalidates any leftover eraser overlay. Main only
        // emits celchange on eraser pointerUp if `this.changed` is true
        // (i.e. some stroke was actually intersected) -- so a quick eraser
        // tap that didn't cross a line leaves the overlay set on pen, and
        // the NEXT brush stroke's wet preview would render through that
        // stale clip. Clearing on pointerdown is the simplest fix.
        if (this.state.eraserOverlay) this.state.eraserOverlay = null;
        // Client-generated UUID flows to the main side as the stroke id;
        // the main side's brush/pencil tool honours pendingStrokeId so the
        // committed stroke matches the wet one we render locally.
        const strokeId = makeStrokeId();
        if (PEN) PEN.sendInput(Object.assign({
          type: 'down', id: strokeId, nx: n.nx, ny: n.ny, pressure
        }, mods(e)));
        if (this._wetEligible()) {
          this._seedWetStroke(strokeId, toProjPt(n, pressure));
          this._scheduleComposite();
        }
      });

      cv.addEventListener('pointermove', e => {
        if (!this.fit.w) return;
        const r = rect();
        if (this.pointers.has(e.pointerId)) {
          const p = this.pointers.get(e.pointerId);
          p.x = e.clientX - r.left; p.y = e.clientY - r.top;
        }
        // Track the cursor in CSS-px for the local cursor-circle indicator.
        // Updated for both drawing and hover (so the artist sees the circle
        // even before they put the pen down).
        this._cursorCss = { x: e.clientX - r.left, y: e.clientY - r.top };
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
          // actual coalesced points (everything since last move event)
          let coalesced = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
          if (!coalesced.length) coalesced = [e];
          const actualPts = [];
          const wirePts = [];
          for (const ce of coalesced) {
            const n = norm(ce.clientX, ce.clientY, r);
            const pr = ce.pointerType === 'pen' ? ce.pressure : 1;
            actualPts.push(toProjPt(n, pr));
            wirePts.push({ nx: n.nx, ny: n.ny, pressure: pr });
          }
          // D1: predicted touches deliberately disabled. They caused
          // leading-edge shimmer (re-extrapolated every frame) and broke
          // OT.Vector.samplesOf's cache. May be re-added later with proper
          // opacity/limiting if perceived latency demands it.
          if (this.state.wetStroke) {
            this._extendWetStroke(actualPts);
            this._scheduleComposite();
          } else {
            // Still schedule a composite so the cursor circle tracks the pen.
            this._scheduleComposite();
          }
          if (PEN) PEN.sendInput(Object.assign({ type: 'move', pts: wirePts }, mods(e)));
        } else {
          // Hover: schedule a redraw so the cursor circle follows the pen
          // before any pointerdown. Throttle wire chatter, not the redraw.
          this._scheduleComposite();
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
        const r = rect();
        const n = norm(e.clientX, e.clientY, r);
        const pressure = e.pointerType === 'pen' ? e.pressure : 1;
        // Arm the 2-second defensive cleanup so the wet eventually goes
        // away even if the commit message never arrives. Before arming,
        // push the raw release pt into rawPts and re-finalize so the wet
        // preview's pts exactly match what main's _vUp will push to
        // cel.strokes — without this, the simplify step picks slightly
        // different control points near the end and the line visibly
        // snaps when the commit replaces the wet preview.
        const id = this.state.wetStroke ? this.state.wetStroke.id : null;
        if (this.state.wetStroke) {
          this._appendReleaseAndRefinalize({
            x: n.nx * this.state.project.width,
            y: n.ny * this.state.project.height,
            p: pressure
          });
          this._armWetTimer();
          this._scheduleComposite();
        }
        if (PEN) PEN.sendInput(Object.assign({
          type: 'up', id, nx: n.nx, ny: n.ny, pressure
        }, mods(e)));
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', e => {
        if (this.pointers.has(e.pointerId)) this.pointers.delete(e.pointerId);
        if (this._pendingTouch.has(e.pointerId)) {
          const pt = this._pendingTouch.get(e.pointerId);
          if (pt.timer) clearTimeout(pt.timer);
          this._pendingTouch.delete(e.pointerId);
        }
        if (this.gesture && this.pointers.size < 2) {
          this.gesture = null;
          this.panning = null;
        }
        if (this.stroking) {
          this.stroking = false;
          this._clearWetStroke();
          if (PEN) PEN.sendInput({ type: 'cancel' });
        }
        this._cursorCss = null;
        this._scheduleComposite();
      });
      cv.addEventListener('pointerleave', e => {
        if (this.pointers.has(e.pointerId)) this.pointers.delete(e.pointerId);
        // Cursor left the canvas — drop the indicator so it doesn't ghost
        // against the bezel. Repainted by the next pointermove / hover.
        this._cursorCss = null;
        this._scheduleComposite();
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
        else if (k === 'enter' && this.state.tool.transform && this.state.tool.transform.armed) {
          ev.preventDefault();
          this._cmd({ type: 'lasso-mode', mode: 'commit' });
        }
        else if (k === 'escape' && this.state.tool.transform && this.state.tool.transform.armed) {
          ev.preventDefault();
          this._cmd({ type: 'lasso-mode', mode: 'cancel' });
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
