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
    brush: '<path d="M4 21c3.2 0 5-1.8 5-5l-3-3c-3.2 0-5 1.8-5 5z"/><path d="M8 13L19 2.2a2 2 0 0 1 3 3L11 16z"/>',
    pencil: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 6l3 3"/>',
    eraser: '<path d="M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M21 21H7"/><path d="M5 11l9 9"/>',
    fill:   '<path d="M11 3l8 8-7.5 7.5L4 11z"/><path d="M9 5l-5 6"/><path d="M20 13c0 0 2.4 3 2.4 4.8a2.4 2.4 0 1 1-4.8 0c0-1.8 2.4-4.8 2.4-4.8z"/>'
  };
  const TOOL_NAME = {
    select: 'Select', brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser', fill: 'Paint Bucket'
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
        tool: { name: 'brush', color: '#222222', toolSize: 6, toolOpacity: 1, pencil: false, brushFrac: 0.02, toolRadius: 0, activeLayerKind: null, sel: {}, transform: {} },
        wetStroke: null
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
    // Lasso transform toolbar — visible when the main side has a transform
    // armed. Buttons fire one-shot commands; the toolbar's mode toggles
    // are driven by meta.transform on each frame.
    _buildLassoTb() {
      const tb = document.getElementById('penLassoTb');
      if (!tb) return;
      this.lassoTb = tb;
      const mk = (label, mode, extraClass) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.mode = mode;
        if (extraClass) b.className = extraClass;
        b.addEventListener('click', () => {
          if (b.classList.contains('disabled')) return;
          this._cmd({ type: 'lasso-mode', mode: mode });
          b.blur();
        });
        tb.appendChild(b);
        return b;
      };
      const sep = () => {
        const s = document.createElement('span');
        s.className = 'pen-lasso-sep';
        tb.appendChild(s);
      };
      this.lassoBtns = {};
      this.lassoBtns.uniform  = mk('Uniform',  'uniform');
      this.lassoBtns.freeform = mk('Freeform', 'freeform');
      this.lassoBtns.distort  = mk('Distort',  'distort');
      this.lassoBtns.warp     = mk('Warp',     'warp');
      sep();
      this.lassoBtns.reset    = mk('Reset',    'reset');
      sep();
      this.lassoBtns.commit   = mk('✓',   'commit', 'pen-lasso-commit');
      this.lassoBtns.cancel   = mk('✕',   'cancel', 'pen-lasso-cancel');
      this.lassoBtns.commit.title = 'Commit transform (Enter)';
      this.lassoBtns.cancel.title = 'Cancel transform (Esc)';
    }
    _applyTransform(xf) {
      const tb = this.lassoTb;
      if (!tb) return;
      if (!xf || !xf.armed) { tb.classList.add('hidden'); return; }
      tb.classList.remove('hidden');
      const modeBtns = ['uniform', 'freeform', 'distort', 'warp'];
      for (const m of modeBtns) {
        const b = this.lassoBtns[m];
        if (!b) continue;
        b.classList.toggle('active', m === xf.mode);
        // Distort + warp are vector-only — grey them for raster lassos.
        if (xf.isRaster && (m === 'distort' || m === 'warp')) {
          b.classList.add('disabled');
        } else {
          b.classList.remove('disabled');
        }
      }
      // Reset only makes sense for vector free-transform-tool sessions;
      // hide it here as the main side does (the lasso path doesn't use it).
      if (this.lassoBtns.reset) {
        this.lassoBtns.reset.style.display = xf.isRaster ? 'none' : '';
      }
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
      }
      // raster cels: D1 keeps the placeholder; D2 wires bmp data
      layer.exposure[frame] = num;
    }

    _applyOp(op) {
      if (!op || !op.op) return;
      const s = this.state;
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
          break;
        }
        case 'frame-change': {
          if (typeof op.frame === 'number') s.frame = op.frame;
          // Drop any in-flight wet stroke — its cel context just changed
          // and rendering it on the new frame's cel would be wrong.
          if (s.wetStroke) this._clearWetStroke();
          break;
        }
        case 'active-layer': {
          if (op.layerId != null) s.activeLayerId = op.layerId;
          // Active layer just changed; wet stroke (if any) was targeting
          // the previous active layer's cel.
          if (s.wetStroke) this._clearWetStroke();
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
      if (meta.sel) t.sel = meta.sel;
      if (meta.transform) t.transform = meta.transform;
      if (typeof meta.activeLayerKind === 'string') t.activeLayerKind = meta.activeLayerKind;
      // toolbar visuals
      for (const n in this.toolBtns)
        this.toolBtns[n].classList.toggle('active', n === t.name);
      if (t.color && /^#[0-9a-fA-F]{6}$/.test(t.color))
        this.colorInput.value = t.color;
      if (this.colorWrap) this.colorWrap.style.background = t.color || '#222222';
      const f = (this.state.frame || 0) + 1;
      const total = this.state.project.frameCount || 1;
      if (this.frameLabel) this.frameLabel.textContent = f + ' / ' + total;
      this._refreshActions(t.sel || {}, t.transform);
      this._applyTransform(t.transform);
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
      // Hide when there's nothing to act on. (Main window also hides when
      // a raw lasso poly is being drawn — we don't have that signal here
      // but the visual cost is minimal: an extra still chip.)
      if (!sel || !sel.count) {
        el.classList.add('hidden');
        el.classList.remove('is-active');
        el.innerHTML = '';
        el.onclick = null;
        return;
      }
      const armed = !!(transform && transform.armed);
      el.classList.remove('hidden');
      el.classList.toggle('is-active', armed);
      el.innerHTML = '';
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
      return t.activeLayerKind === 'vector'
        && (t.name === 'brush' || t.name === 'pencil');
    }
    _seedWetStroke(id, projPt) {
      const t = this.state.tool;
      // No `predicted` field: D1 drops predicted touches entirely. They
      // caused leading-edge shimmer because their extrapolation flickered
      // frame-to-frame, and the `pts.concat(predicted)` produced a fresh
      // array each render -- defeating OT.Vector.samplesOf's cache.
      this.state.wetStroke = {
        id: id, type: 'line',
        pencil: t.name === 'pencil',
        color: t.color || '#222222',
        width: t.toolSize || 6,
        opacity: t.toolOpacity == null ? 1 : t.toolOpacity,
        closed: false,
        pts: [projPt]
      };
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
    // predictedPts is accepted but ignored for forward compatibility -- D1
    // does not render predicted touches (see _seedWetStroke comment).
    _extendWetStroke(actualPts, predictedPts) {
      const ws = this.state.wetStroke;
      if (!ws) return;
      for (const p of actualPts) ws.pts.push(p);
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
      if (this.state.wetStroke) {
        // D1 diagnostic — temporary, remove once symptom B is confirmed fixed
        console.log('[pen] clearWet from:', new Error().stack.split('\n').slice(2, 5).join(' | '));
      }
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
        // Pass the wet stroke straight through. Its `pts` array reference
        // is stable across renders (mutated by push only) which keeps
        // OT.Vector.samplesOf's WeakMap cache hot. No predicted touches
        // are appended — see _seedWetStroke for the rationale.
        OT.compositeStage(s.project, s.frame, c, {
          bg: true,
          wetStroke: s.wetStroke || null,
          wetLayerId: s.activeLayerId,
          includeVideo: false          // D1: pen has no <video> element
          // includeLassoHidden defaults to false (skip transform-drag
          // rasterised originals); same as the main canvas.
        }, {
          layerAncestors: layer => this._layerAncestors(layer)
        });
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
        // Arm the 2-second defensive cleanup so the wet eventually goes
        // away even if the commit message never arrives. (D1 no longer
        // tracks predicted touches, so there's nothing to clear here.)
        const id = this.state.wetStroke ? this.state.wetStroke.id : null;
        if (this.state.wetStroke) {
          this._armWetTimer();
          this._scheduleComposite();
        }
        const r = rect();
        const n = norm(e.clientX, e.clientY, r);
        const pressure = e.pointerType === 'pen' ? e.pressure : 1;
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
