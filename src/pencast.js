/* OpenToon Studio - PenCast: drive the canvas from a second "pen display"
   window.

   D1 architecture (slave-renderer): the pen window holds a real mirror of
   the project (OT.Layer / OT.Cel instances) and runs OT.compositeStage
   itself. We publish small JSON ops over `opentoon:pen-state`; no bitmap
   channel exists. */
(function (OT) {
  'use strict';
  const U = OT.util;

  function serializeStroke(st) {
    const out = { id: st.id, type: st.type };
    if (st.pts) out.pts = st.pts.slice();
    if (st.contour) out.contour = st.contour.slice();
    if (st.color != null) out.color = st.color;
    if (st.width != null) out.width = st.width;
    if (st.opacity != null) out.opacity = st.opacity;
    if (st.pencil) out.pencil = true;
    if (st.sharp) out.sharp = true;
    if (st.closed) out.closed = true;
    if (st.taper != null) out.taper = st.taper;
    if (st.grow != null) out.grow = st.grow;
    return out;
  }
  OT._serializeStroke = serializeStroke;

  function snapshotLayer(l) {
    return {
      id: l.id, name: l.name, type: l.type,
      visible: !!l.visible,
      opacity: l.opacity == null ? 1 : l.opacity,
      color: l.color || '',
      parentId: l.parentId || null,
      transform: {
        keyframes: (l.transform && l.transform.keyframes)
          ? l.transform.keyframes.slice() : []
      },
      shadeOf: l.shadeOf || null,
      _collapsed: !!l._collapsed,
      // exposure: needed so pen's Layer.celAt(frame) works
      exposure: (l.exposure || []).slice()
    };
  }

  function snapshotCelForLayer(layer, frame) {
    const cel = layer.celAt ? layer.celAt(frame) : null;
    if (!cel) return null;
    if (cel.kind === 'vector') {
      return {
        celNum: layer.celNumAt(frame),
        kind: 'vector',
        w: cel.w, h: cel.h,
        strokes: (cel.strokes || []).map(serializeStroke)
      };
    }
    // raster cels are placeholder in D1 (D2 sends pixel data)
    return { celNum: layer.celNumAt(frame), kind: 'raster', w: cel.w, h: cel.h };
  }

  class PenCast {
    constructor(app) {
      this.app = app;
      this.active = false;
      this.bridge = window.OpenToonDesktop || null;
      this._stateSeq = 0;
      this._pendingOps = [];
      this._lastAckSeq = 0;
      this._raf = 0;
      this._overlayLastPump = 0;
      if (!this.bridge || !this.bridge.sendPenState) return;
      this.bridge.onPenAttach(() => this._attach());
      this.bridge.onPenDetach(() => this._detach());
      this.bridge.onPenInput(msg => { try { this._onInput(msg); } catch (e) { console.error(e); } });
      this.bridge.onPenCommand(msg => { try { this._onCommand(msg); } catch (e) { console.error(e); } });
      if (this.bridge.onPenStateAck)
        this.bridge.onPenStateAck(seq => { this._lastAckSeq = seq | 0; });

      app.on('render', () => {
        // no-op in D1: there is no bitmap to re-encode; the pen pulls
        // changes via cel/layer/transform events below.
      });
      app.on('overlayrender', () => {
        if (!this.active) return;
        const now = performance.now();
        if (now - this._overlayLastPump < 33) return;
        this._overlayLastPump = now;
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
      app.on('framechange', () => {
        if (!this.active) return;
        this._publish({ op: 'frame-change', frame: app.frame });
        this._publishCelsForFrame();
        this._schedule();
      });
      app.on('layerselect', () => {
        if (!this.active) return;
        const al = app.activeLayer && app.activeLayer();
        this._publish({ op: 'active-layer', layerId: al ? al.id : null });
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
      app.on('layerschange', () => {
        if (!this.active) return;
        // Phase D1 simplification: ship the full layers snapshot. The pen
        // diffs locally. Layer count is small (typically <20); this is
        // cheaper than maintaining a diff cache here.
        this._publish({
          op: 'layers-replace',
          layers: (app.project.layers || []).map(snapshotLayer),
          activeLayerId: app.activeLayer && app.activeLayer() ? app.activeLayer().id : null
        });
        this._publishCelsForFrame();
        this._schedule();
      });
      app.on('celchange', () => {
        if (!this.active) return;
        // active layer cel changed -- publish the new cel content
        const al = app.activeLayer && app.activeLayer();
        if (!al) return;
        const cel = snapshotCelForLayer(al, app.frame);
        this._publish({
          op: 'vector-cel-replace',
          layerId: al.id,
          frame: app.frame,
          cel: cel
        });
        this._schedule();
      });
      app.on('projectchange', () => {
        if (!this.active) return;
        const p = app.project;
        this._publish({
          op: 'project-meta',
          patch: { width: p.width, height: p.height, bg: p.bg, fps: p.fps, frameCount: p.frameCount }
        });
        this._schedule();
      });
      app.on('palettechange', () => {
        if (!this.active) return;
        this._publish({ op: 'palette', colors: this._paletteColors() });
        this._schedule();
      });
      app.on('colorchange', () => {
        if (!this.active) return;
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
      app.on('toolchange', () => {
        if (!this.active) return;
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
    }

    available() { return !!(this.bridge && this.bridge.openPenWindow); }
    open() {
      if (!this.available()) {
        this.app.ui.status('The pen drawing window is a desktop-app feature');
        return;
      }
      this.bridge.openPenWindow();
      this.app.ui.status('Opening the drawing window…');
    }

    _attach() {
      this.active = true;
      this.app.ui.status('Drawing window connected — draw on your pen display');
      this._stateSeq = 0;
      this._pendingOps = [];
      this._publishInit();
    }
    _detach() {
      this.active = false;
      // If the pen disconnected mid-stroke, clear the carrier on the
      // active tool so the next mouse-drawn stroke on the main canvas
      // doesn't inherit a stale pen UUID.
      if (this.app.tools && this.app.tools.active)
        this.app.tools.active.pendingStrokeId = null;
      this.app.ui.status('Drawing window closed');
    }

    _paletteColors() {
      const p = this.app.palette;
      if (!p) return [];
      if (Array.isArray(p.colors)) return p.colors.slice();
      if (p.swatches) return p.swatches.map(s => s.color);
      return [];
    }

    _publish(op) {
      if (!this.active || !this.bridge || !this.bridge.sendPenState) return;
      this._pendingOps.push(op);
    }
    _schedule() {
      if (!this.active) return;
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._flushStateBatch('patch');
      });
    }
    _flushStateBatch(kind) {
      if (!this.bridge || !this.bridge.sendPenState) {
        this._pendingOps.length = 0;
        return;
      }
      if (!this._pendingOps.length) return;
      const ops = this._pendingOps.splice(0);
      const seq = ++this._stateSeq;
      try {
        this.bridge.sendPenState({ seq, kind: kind || 'patch', ops });
      } catch (e) { console.error('pen-state send failed', e); }
    }

    _publishInit() {
      const a = this.app, p = a.project;
      if (!p) return;
      const layers = (p.layers || []).map(snapshotLayer);
      const activeLayer = a.activeLayer && a.activeLayer();
      const cels = {};
      for (const layer of (p.layers || [])) {
        const snap = snapshotCelForLayer(layer, a.frame);
        if (snap) cels[layer.id] = snap;
      }
      this._pendingOps.unshift({
        op: 'init',
        project: { width: p.width, height: p.height, bg: p.bg, fps: p.fps, frameCount: p.frameCount },
        palette: this._paletteColors(),
        layers,
        activeLayerId: activeLayer ? activeLayer.id : null,
        frame: a.frame,
        cels,
        toolMeta: this._meta()
      });
      this._flushStateBatch('snapshot');
    }

    _publishCelsForFrame() {
      const a = this.app, p = a.project;
      if (!p) return;
      for (const layer of (p.layers || [])) {
        const cel = snapshotCelForLayer(layer, a.frame);
        if (cel) this._publish({
          op: 'vector-cel-replace', layerId: layer.id, frame: a.frame, cel
        });
      }
    }

    _meta() {
      const a = this.app, st = a.stage, t = a.tools.active;
      // radProj: cursor radius in *project px* (no viewport zoom). The pen
      // window scales this into pen-fit space itself; it's simpler than
      // inverting brushFrac (which is normalised against the main canvas's
      // CSS width, which the pen doesn't know about).
      const radProj = (t && t.cursorRadius) ? (t.cursorRadius(a) || 0) : 0;
      const rad = radProj * st.view.zoom;
      // selection HUD + transform-armed flags
      let selName = '', selCount = 0, selIsGroup = false, selHasXform = false, selColor = '';
      const sel = a.selectedLayers;
      const setIds = sel && sel.size ? new Set(Array.from(sel).map(l => l.id)) : new Set();
      let targets = [];
      if (sel && sel.size > 1) {
        targets = a.project.layers.filter(l => sel.has(l) && !setIds.has(l.parentId));
      } else if (a.activeLayer && a.activeLayer()) {
        targets = [a.activeLayer()];
      }
      if (targets.length === 1) {
        selName = targets[0].name || '';
        selIsGroup = targets[0].type === 'group';
        selColor = targets[0].color || '';
      } else if (targets.length > 1) selColor = targets[0].color || '';
      const selColors = targets.slice(0, 3).map(t => t.color || '#3d9be0');
      selCount = targets.length;
      selHasXform = targets.some(t => t.transform && t.transform.keyframes && t.transform.keyframes.length);
      const lasso = a.tools && a.tools.tools && a.tools.tools.lasso;
      let xfArmed = false, xfMode = '', xfIsRaster = false;
      if (lasso) {
        if (lasso.vt) { xfArmed = true; xfIsRaster = false; xfMode = lasso.transformMode || 'uniform'; }
        else if (lasso.raster) { xfArmed = true; xfIsRaster = true; xfMode = lasso.transformMode || 'uniform'; }
      }
      // active-layer kind: vector / drawing(raster) / group / video
      const al = a.activeLayer && a.activeLayer();
      const activeLayerKind = al ? al.type : null;
      return {
        tool: t ? t.name : 'brush',
        color: a.color,
        toolSize: t && t.size != null ? t.size : (a.settings.brushSize || 6),
        toolOpacity: t && t.opacity != null ? t.opacity : 1,
        pencil: t ? t.name === 'pencil' : false,
        brushFrac: st.cw ? rad / st.cw : 0.02,
        toolRadius: radProj,
        // ^ project-px radius — pen window prefers this for the local cursor
        // indicator (brushFrac is awkward to invert without main's st.cw).
        frame: a.frame + 1,
        frameCount: a.project.frameCount,
        zoom: Math.round(st.view.zoom * 100),
        activeLayerKind,
        sel: { name: selName, count: selCount, group: selIsGroup, hasXform: selHasXform, color: selColor, colors: selColors },
        transform: { armed: xfArmed, mode: xfMode, isRaster: xfIsRaster }
      };
    }

    /* ----- pen -> main : pointer input ----- */
    // The pen ships normalized 0..1 fractions over the *project rect*.
    // (Pen knows the project size via its mirror, computes nx/ny from
    // local fit + view; same math regardless of pen-window zoom.)
    _ptFromNorm(nx, ny, pressure, msg) {
      const a = this.app, st = a.stage, p = a.project;
      const pt = { x: nx * p.width, y: ny * p.height };
      pt.pressure = msg && msg.isPen
        ? a.mapPressure(pressure == null ? 0.5 : pressure) : 1;
      pt.shift = !!(msg && msg.shift);
      pt.alt = !!(msg && msg.alt);
      pt.ctrl = false;
      const r = st.canvas.getBoundingClientRect();
      const sc = st.projectToScreen(pt.x, pt.y);
      pt.sx = r.left + sc.x;
      pt.sy = r.top + sc.y;
      pt.button = (msg && msg.button) || 0;
      pt.penEraser = !!(msg && msg.penEraser);
      return pt;
    }
    _fakeEvt(msg) {
      return {
        pointerType: (msg && msg.isPen) ? 'pen' : 'mouse',
        shiftKey: !!(msg && msg.shift), altKey: !!(msg && msg.alt), ctrlKey: false,
        button: (msg && msg.button) || 0, buttons: (msg && msg.buttons) || 0,
        preventDefault() {}, stopPropagation() {}
      };
    }
    _onInput(msg) {
      if (!msg || !this.app.tools) return;
      const tools = this.app.tools, st = this.app.stage;
      if (msg.type === 'down') {
        // Stash the pen-supplied UUID on the active tool so the brush /
        // pencil stroke commit picks it up instead of generating its own.
        // The tool itself is the carrier of record — see tools.js for the
        // read site.
        if (tools.active) tools.active.pendingStrokeId = msg.id || null;
        const pt = this._ptFromNorm(msg.nx, msg.ny, msg.pressure, msg);
        st.cursorPt = pt;
        tools.pointerDown(pt, this._fakeEvt(msg));
      } else if (msg.type === 'move') {
        const list = (msg.pts && msg.pts.length) ? msg.pts : [msg];
        let pt = null;
        for (const p of list) {
          pt = this._ptFromNorm(p.nx, p.ny, p.pressure, msg);
          tools.pointerMove(pt, this._fakeEvt(msg));
        }
        if (pt) st.cursorPt = pt;
        if (!tools.dragging) st.renderOverlay();
        if (pt) this.app.ui.setCoord(pt);
      } else if (msg.type === 'up') {
        const pt = this._ptFromNorm(msg.nx, msg.ny, msg.pressure, msg);
        tools.pointerUp(pt, this._fakeEvt(msg));
        // pointerUp may have committed a stroke -- celchange already fired.
        // Clear the pending id so the NEXT stroke from a non-pen source
        // doesn't accidentally inherit it.
        if (tools.active) tools.active.pendingStrokeId = null;
      } else if (msg.type === 'cancel') {
        if (tools.active && tools.active.cancel) tools.active.cancel(this.app);
        if (tools.active) tools.active.pendingStrokeId = null;
      } else if (msg.type === 'hover') {
        st.cursorPt = this._ptFromNorm(msg.nx, msg.ny, 1, msg);
        st.renderOverlay();
      } else if (msg.type === 'leave') {
        st.cursorPt = null;
        st.renderOverlay();
      }
    }

    /* ----- pen -> main : toolbar commands ----- */
    _onCommand(msg) {
      if (!msg) return;
      const a = this.app, U = OT.util;
      switch (msg.type) {
        case 'tool':       if (a.tools.tools[msg.tool]) a.tools.select(msg.tool); break;
        case 'color':      if (msg.color) a.setColor(msg.color); break;
        case 'undo':       a.undo(); break;
        case 'redo':       a.redo(); break;
        case 'newdraw':    a.newDrawing(); break;
        case 'frame':      a.playback.step(msg.dir > 0 ? 1 : -1); break;
        case 'fit':        a.stage.fitToCamera(); break;
        case 'brush-size': {
          const t = a.tools.active.name;
          const sel = t === 'eraser' ? 'eraserSize'
            : t === 'pencil' ? 'pencilSize' : 'brushSize';
          const cur = a.settings[sel];
          a.settings[sel] = U.clamp(cur + (msg.delta || 0) * Math.max(1, cur * 0.14), 1, 300);
          a.ui._buildToolOpts();
          a.emit('overlayrender');
          break;
        }
        case 'zoom': {
          const st = a.stage, r = st.canvas.getBoundingClientRect();
          if (msg.absolute && msg.absolute > 0) {
            const sx = r.left + st.cw / 2, sy = r.top + st.ch / 2;
            const factor = msg.absolute / (st.view.zoom || 1);
            st.zoomAt(sx, sy, factor);
          } else {
            st.zoomAt(r.left + (msg.nx || 0.5) * st.cw,
              r.top + (msg.ny || 0.5) * st.ch, msg.factor || 1);
          }
          break;
        }
        case 'pan': { const st = a.stage; st.panBy((msg.dnx || 0) * st.cw, (msg.dny || 0) * st.ch); break; }
        case 'flip':              a.toggleFlipH(); break;
        case 'free-transform':    if (typeof a.freeTransform === 'function') a.freeTransform(); break;
        case 'reset-transform': {
          const sel = a.selectedLayers;
          const setIds = sel && sel.size ? new Set(Array.from(sel).map(l => l.id)) : new Set();
          let targets = [];
          if (sel && sel.size > 1) {
            targets = a.project.layers.filter(l => sel.has(l) && !setIds.has(l.parentId));
          } else if (a.activeLayer && a.activeLayer()) {
            targets = [a.activeLayer()];
          }
          const dirty = targets.filter(t => t.transform && t.transform.keyframes && t.transform.keyframes.length);
          if (!dirty.length) { a.ui.status('No transform to reset'); break; }
          a.doStruct(dirty.length > 1 ? 'Reset transforms' : 'Reset transform', () => {
            for (const t of dirty) t.transform.keyframes = [];
          });
          a.emit('layerschange'); a.emit('render');
          break;
        }
        case 'lasso-mode':
          if (a.tools && a.tools.tools && a.tools.tools.lasso
              && a.tools.tools.lasso.handleToolbarMode) {
            a.tools.tools.lasso.handleToolbarMode(msg.mode, a);
          }
          break;
        case 'pen-size':
          // D1 doesn't ship pixels to the pen, but we record the value in
          // case D2's raster transport wants it.
          this.penSize = {
            cssW: Math.max(1, msg.cssW | 0),
            cssH: Math.max(1, msg.cssH | 0),
            dpr: Math.max(1, Math.min(3, msg.dpr || 1))
          };
          break;
      }
    }
  }

  OT.PenCast = PenCast;
})(window.OT);
