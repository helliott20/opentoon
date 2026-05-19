/* OpenToon Studio - drawing tools + tool manager (raster + vector) */
(function (OT) {
  'use strict';
  const U = OT.util;
  const V = () => OT.Vector;

  function isDrawable(layer) {
    return layer && (layer.type === 'drawing' || layer.type === 'vector');
  }

  function drawTarget(app, allowCreate) {
    const layer = app.activeLayer();
    if (!layer) { app.ui.status('No layer selected'); return null; }
    if (!isDrawable(layer)) { app.ui.status('Not a drawing layer'); return null; }
    if (layer.locked) { app.ui.status('Layer is locked'); return null; }
    let cel;
    if (allowCreate === false) cel = layer.celAt(app.frame);
    else cel = layer.drawingAt(app.frame, app.project.width, app.project.height);
    if (!cel) return null;
    return { layer, cel };
  }

  // Map a project-space point into the active layer's cel space (inverse layer transform).
  function toCel(app, pt) {
    const layer = app.activeLayer();
    if (!layer || !layer.hasTransform()) return pt;
    const tr = layer.transformAt(app.frame);
    if (!tr.x && !tr.y && !tr.rot && tr.sx === 1 && tr.sy === 1) return pt;
    const p = app.project, px = p.width / 2, py = p.height / 2;
    const lx = pt.x - tr.x - px, ly = pt.y - tr.y - py;
    const r = -tr.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const rx = (lx * c - ly * s) / tr.sx, ry = (lx * s + ly * c) / tr.sy;
    return {
      x: rx + px, y: ry + py, pressure: pt.pressure,
      shift: pt.shift, alt: pt.alt, ctrl: pt.ctrl,
      sx: pt.sx, sy: pt.sy, button: pt.button
    };
  }

  function canvasCopy(cel) {
    const c = document.createElement('canvas');
    c.width = cel.w; c.height = cel.h;
    c.getContext('2d').drawImage(cel.canvas, 0, 0);
    return c;
  }

  // Ray-cast point-in-polygon test (polygon = array of {x,y}).
  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ============================== base ============================== */
  class Tool {
    constructor(name) { this.name = name; }
    onActivate() {} onDeactivate() {} flush() {}
    pointerDown() {} pointerMove() {} pointerUp() {}
    drawOverlay() {}
  }

  /* ============================== paint (brush / eraser) ============================== */
  class PaintTool extends Tool {
    constructor(mode) { super(mode); this.mode = mode; }
    cursorRadius(app) {
      return (this.mode === 'eraser' ? app.settings.eraserSize : app.settings.brushSize) / 2;
    }
    pointerDown(pt, e, app) {
      const t = drawTarget(app); if (!t) return;
      this.t = t;
      this.vec = t.cel.kind === 'vector';
      this.size = this.mode === 'eraser' ? app.settings.eraserSize : app.settings.brushSize;
      this.opacity = this.mode === 'eraser' ? app.settings.eraserOpacity : app.settings.brushOpacity;
      this.color = app.color;
      this.smooth = app.settings.smoothing;
      this.before = t.cel.snapshot();
      if (this.vec) this._vDown(pt, app); else this._rDown(pt, app);
    }
    pointerMove(pt, e, app) {
      if (!this.t) return;
      if (this.vec) this._vMove(pt, app); else this._rMove(pt, app);
    }
    pointerUp(pt, e, app) {
      if (!this.t) return;
      if (this.vec) this._vUp(pt, app); else this._rUp(pt, app);
      this.t = null;
    }

    /* ---- raster ---- */
    _rDown(pt) {
      const cel = this.t.cel;
      this.buf = document.createElement('canvas');
      this.buf.width = cel.w; this.buf.height = cel.h;
      this.bctx = this.buf.getContext('2d');
      this.sm = { x: pt.x, y: pt.y };
      this.last = { x: pt.x, y: pt.y, p: pt.pressure };
      this._dot(pt.x, pt.y, pt.pressure);
      this._rComposite();
    }
    _rMove(pt, app) {
      const k = 1 - this.smooth * 0.82;
      this.sm.x += (pt.x - this.sm.x) * k;
      this.sm.y += (pt.y - this.sm.y) * k;
      this._seg(this.last.x, this.last.y, this.last.p, this.sm.x, this.sm.y, pt.pressure);
      this.last = { x: this.sm.x, y: this.sm.y, p: pt.pressure };
      this._scheduleComposite();
    }
    _rUp(pt, app) {
      if (this._compRAF) { cancelAnimationFrame(this._compRAF); this._compRAF = 0; }
      this._seg(this.last.x, this.last.y, this.last.p, pt.x, pt.y, pt.pressure);
      this._rComposite();
      app.history.pushCelEdit(this.mode, this.t.cel, this.before);
      this.t.cel.dirty();
      app.emit('celchange');
    }
    // A graphics-tablet pen fires many coalesced move events per frame.
    // Compositing the whole cel and emitting a full stage render on every one
    // of them is what makes the raster brush / eraser lag. The dabs are still
    // stamped into `buf` on every event (cheap); only the heavy composite +
    // render is deferred to at most once per animation frame.
    _scheduleComposite() {
      if (this._compRAF) return;
      this._compRAF = requestAnimationFrame(() => {
        this._compRAF = 0;
        if (this.t && !this.vec) this._rComposite();
      });
    }
    // Same idea for the vector brush, whose live stamp lands on the cel
    // directly: keep stamping every event, but coalesce the render emit.
    _rafEmit(app) {
      if (this._emitRAF) return;
      this._emitRAF = requestAnimationFrame(() => {
        this._emitRAF = 0;
        if (this.t) app.emit('render');
      });
    }
    _r(p) { return Math.max(0.35, this.size / 2 * p); }
    _dot(x, y, p) {
      const c = this.bctx;
      c.beginPath(); c.arc(x, y, this._r(p), 0, 7); c.fillStyle = '#000'; c.fill();
    }
    _seg(x0, y0, p0, x1, y1, p1) {
      const d = U.dist(x0, y0, x1, y1);
      const r0 = this._r(p0), r1 = this._r(p1);
      const step = Math.max(0.5, Math.min(r0, r1) * 0.35);
      const n = Math.max(1, Math.ceil(d / step));
      const c = this.bctx;
      c.fillStyle = '#000';
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        c.beginPath();
        c.arc(U.lerp(x0, x1, t), U.lerp(y0, y1, t), U.lerp(r0, r1, t), 0, 7);
        c.fill();
      }
    }
    _colored() {
      const t = this._tint || (this._tint = document.createElement('canvas'));
      t.width = this.buf.width; t.height = this.buf.height;
      const x = t.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, t.width, t.height);
      x.globalCompositeOperation = 'source-over';
      x.drawImage(this.buf, 0, 0);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = this.color;
      x.fillRect(0, 0, t.width, t.height);
      x.globalCompositeOperation = 'source-over';
      return t;
    }
    _rComposite() {
      const cel = this.t.cel, c = cel.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      c.clearRect(0, 0, cel.w, cel.h);
      c.drawImage(this.before, 0, 0);
      c.globalAlpha = this.opacity;
      if (this.mode === 'eraser') {
        c.globalCompositeOperation = 'destination-out';
        c.drawImage(this.buf, 0, 0);
      } else {
        c.drawImage(this._colored(), 0, 0);
      }
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      cel.dirty();
      OT.app.emit('render');
    }

    /* ---- vector ---- */
    _vDown(pt, app) {
      const cel = this.t.cel;
      if (this.mode === 'eraser') {
        this.changed = false;
        this._erase(cel, pt.x, pt.y, app);
        return;
      }
      this.base = canvasCopy(cel);
      this.raw = [{ x: pt.x, y: pt.y, p: pt.pressure }];
      this.sm = { x: pt.x, y: pt.y };
      this.lastStamp = { x: pt.x, y: pt.y, p: pt.pressure };
      cel.ctx.fillStyle = this.color;
      cel.ctx.beginPath();
      cel.ctx.arc(pt.x, pt.y, this._r(pt.pressure), 0, 7);
      cel.ctx.fill();
      cel.dirty();
      app.emit('render');
    }
    _vMove(pt, app) {
      const cel = this.t.cel;
      if (this.mode === 'eraser') { this._erase(cel, pt.x, pt.y, app); return; }
      const k = 1 - this.smooth * 0.82;
      this.sm.x += (pt.x - this.sm.x) * k;
      this.sm.y += (pt.y - this.sm.y) * k;
      this.raw.push({ x: this.sm.x, y: this.sm.y, p: pt.pressure });
      // live stamp preview
      const c = cel.ctx;
      c.fillStyle = this.color;
      const a = this.lastStamp, b = { x: this.sm.x, y: this.sm.y, p: pt.pressure };
      const d = U.dist(a.x, a.y, b.x, b.y);
      const r0 = this._r(a.p), r1 = this._r(b.p);
      const n = Math.max(1, Math.ceil(d / Math.max(0.5, Math.min(r0, r1) * 0.4)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        c.beginPath();
        c.arc(U.lerp(a.x, b.x, t), U.lerp(a.y, b.y, t), U.lerp(r0, r1, t), 0, 7);
        c.fill();
      }
      this.lastStamp = b;
      cel.dirty();
      this._rafEmit(app);
    }
    _vUp(pt, app) {
      const cel = this.t.cel;
      if (this._emitRAF) { cancelAnimationFrame(this._emitRAF); this._emitRAF = 0; }
      if (this.mode === 'eraser') {
        this._flushErase();
        if (this.changed) { app.history.pushCelEdit('eraser', cel, this.before); app.emit('celchange'); }
        return;
      }
      this.raw.push({ x: pt.x, y: pt.y, p: pt.pressure });
      const tol = 0.5 + this.smooth * 2.5;
      let pts = V().simplify(V().smoothPts(this.raw, Math.round(this.smooth * 10)), tol);
      if (pts.length < 2) pts = this.raw.slice(0, 2);
      // endpoint auto-connect
      const snap = app.settings.snapDist;
      const s0 = V().snapPoint(cel, pts[0].x, pts[0].y, snap);
      if (s0) { pts[0] = { x: s0.x, y: s0.y, p: pts[0].p }; }
      const li = pts.length - 1;
      const s1 = V().snapPoint(cel, pts[li].x, pts[li].y, snap);
      if (s1) { pts[li] = { x: s1.x, y: s1.y, p: pts[li].p }; }
      let closed = false;
      if (pts.length > 3 && U.dist(pts[0].x, pts[0].y, pts[li].x, pts[li].y) < snap * 1.3) {
        pts[li] = { x: pts[0].x, y: pts[0].y, p: pts[li].p };
        closed = true;
      }
      const stroke = {
        id: U.uid(), type: 'line', pencil: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: closed
      };
      cel.strokes.push(stroke);
      if (app.symmetry && app.symmetry.on) {
        cel.strokes.push(V().mirrorStroke(stroke, app.symmetry.axis,
          app.project.width / 2, app.project.height / 2));
        cel.rebuild();
      } else {
        // fast commit: base + this stroke only
        const c = cel.ctx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cel.w, cel.h);
        c.drawImage(this.base, 0, 0);
        V().renderStroke(c, stroke);
        cel.dirty();
      }
      app.history.pushCelEdit('brush', cel, this.before);
      app.emit('render'); app.emit('celchange');
    }
    _erase(cel, x, y, app) {
      const r = this.size / 2;
      let changed = false;
      const next = [];
      for (const st of cel.strokes) {
        const res = V().eraseStroke(st, x, y, r);
        if (res === null) next.push(st);
        else { changed = true; for (const p of res) next.push(p); }
      }
      if (!changed) return;
      cel.strokes = next;
      this.changed = true;
      // rebuild() re-renders every stroke. A tablet pen fires many coalesced
      // events per frame, so calling it per event makes the eraser lag.
      // Defer the heavy rebuild + render to at most once per animation frame.
      this._erasePending = { cel: cel, app: app };
      if (!this._eraseRAF) {
        this._eraseRAF = requestAnimationFrame(() => {
          this._eraseRAF = 0;
          const p = this._erasePending;
          if (p) { p.cel.rebuild(); p.app.emit('render'); }
        });
      }
    }
    _flushErase() {
      if (this._eraseRAF) { cancelAnimationFrame(this._eraseRAF); this._eraseRAF = 0; }
      if (this._erasePending) {
        this._erasePending.cel.rebuild();
        this._erasePending.app.emit('render');
        this._erasePending = null;
      }
    }
  }

  /* ============================== pencil ============================== */
  class PencilTool extends Tool {
    constructor() { super('pencil'); }
    cursorRadius(app) { return app.settings.pencilSize / 2; }
    pointerDown(pt, e, app) {
      const t = drawTarget(app); if (!t) return;
      this.t = t;
      this.vec = t.cel.kind === 'vector';
      this.size = app.settings.pencilSize;
      this.opacity = app.settings.pencilOpacity;
      this.color = app.color;
      this.smooth = app.settings.smoothing;
      this.before = t.cel.snapshot();
      this.sm = { x: pt.x, y: pt.y };
      this.raw = [{ x: pt.x, y: pt.y }];
      if (this.vec) this.base = canvasCopy(t.cel);
      else {
        this.buf = document.createElement('canvas');
        this.buf.width = t.cel.w; this.buf.height = t.cel.h;
        this.bctx = this.buf.getContext('2d');
      }
      this._render(app);
    }
    pointerMove(pt, e, app) {
      if (!this.t) return;
      const k = 1 - this.smooth * 0.82;
      this.sm.x += (pt.x - this.sm.x) * k;
      this.sm.y += (pt.y - this.sm.y) * k;
      this.raw.push({ x: this.sm.x, y: this.sm.y });
      this._schedule(app);
    }
    // Coalesce the per-event re-render to one per frame -- a tablet pen would
    // otherwise re-stroke the whole polyline dozens of times per frame.
    _schedule(app) {
      if (this._rRAF) return;
      this._rRAF = requestAnimationFrame(() => {
        this._rRAF = 0;
        if (this.t) this._render(app);
      });
    }
    pointerUp(pt, e, app) {
      if (!this.t) return;
      if (this._rRAF) { cancelAnimationFrame(this._rRAF); this._rRAF = 0; }
      this.raw.push({ x: pt.x, y: pt.y });
      const cel = this.t.cel;
      if (this.vec) {
        const tol = 0.5 + this.smooth * 2.5;
        let pts = V().simplify(V().smoothPts(this.raw, Math.round(this.smooth * 10)), tol);
        if (pts.length < 2) pts = this.raw.slice(0, 2);
        const snap = app.settings.snapDist;
        const s0 = V().snapPoint(cel, pts[0].x, pts[0].y, snap);
        if (s0) pts[0] = { x: s0.x, y: s0.y };
        const li = pts.length - 1;
        const s1 = V().snapPoint(cel, pts[li].x, pts[li].y, snap);
        if (s1) pts[li] = { x: s1.x, y: s1.y };
        let closed = false;
        if (pts.length > 3 && U.dist(pts[0].x, pts[0].y, pts[li].x, pts[li].y) < snap * 1.3) {
          pts[li] = { x: pts[0].x, y: pts[0].y }; closed = true;
        }
        const stroke = {
          id: U.uid(), type: 'line', pencil: true,
          color: this.color, width: this.size, opacity: this.opacity,
          pts: pts, closed: closed
        };
        cel.strokes.push(stroke);
        if (app.symmetry && app.symmetry.on) {
          cel.strokes.push(V().mirrorStroke(stroke, app.symmetry.axis,
            app.project.width / 2, app.project.height / 2));
          cel.rebuild();
        } else {
          const c = cel.ctx;
          c.setTransform(1, 0, 0, 1, 0, 0);
          c.clearRect(0, 0, cel.w, cel.h);
          c.drawImage(this.base, 0, 0);
          V().renderStroke(c, stroke);
          cel.dirty();
        }
      } else {
        this._render(app);
      }
      app.history.pushCelEdit('pencil', cel, this.before);
      this.t = null;
      app.emit('render'); app.emit('celchange');
    }
    _render(app) {
      const cel = this.t.cel;
      if (this.vec) {
        const c = cel.ctx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cel.w, cel.h);
        c.drawImage(this.base, 0, 0);
        c.strokeStyle = this.color; c.fillStyle = this.color;
        c.lineWidth = this.size; c.lineJoin = 'round'; c.lineCap = 'round';
        c.globalAlpha = this.opacity;
        this._poly(c, this.raw);
        c.globalAlpha = 1;
        cel.dirty();
      } else {
        const c = this.bctx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, this.buf.width, this.buf.height);
        c.strokeStyle = '#000'; c.fillStyle = '#000';
        c.lineWidth = this.size; c.lineJoin = 'round'; c.lineCap = 'round';
        this._poly(c, this.raw);
        const cel2 = this.t.cel, x = cel2.ctx;
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.clearRect(0, 0, cel2.w, cel2.h);
        x.drawImage(this.before, 0, 0);
        x.globalAlpha = this.opacity;
        x.drawImage(this._colored(), 0, 0);
        x.globalAlpha = 1;
        cel2.dirty();
      }
      app.emit('render');
    }
    _poly(c, p) {
      if (p.length === 1) {
        c.beginPath(); c.arc(p[0].x, p[0].y, this.size / 2, 0, 7); c.fill(); return;
      }
      c.beginPath();
      c.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i].x + p[i + 1].x) / 2, my = (p[i].y + p[i + 1].y) / 2;
        c.quadraticCurveTo(p[i].x, p[i].y, mx, my);
      }
      c.lineTo(p[p.length - 1].x, p[p.length - 1].y);
      c.stroke();
    }
    _colored() {
      const t = this._tint || (this._tint = document.createElement('canvas'));
      t.width = this.buf.width; t.height = this.buf.height;
      const x = t.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, t.width, t.height);
      x.drawImage(this.buf, 0, 0);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = this.color;
      x.fillRect(0, 0, t.width, t.height);
      x.globalCompositeOperation = 'source-over';
      return t;
    }
  }

  /* ============================== fill ============================== */
  class FillTool extends Tool {
    constructor() { super('fill'); this.preview = null; }
    onDeactivate(app) { this.preview = null; }
    pointerDown(pt, e, app) {
      const t = drawTarget(app); if (!t) return;
      if (t.cel.kind === 'vector') this._vFill(t.cel, pt, app);
      else this._rFill(t.cel, pt, app);
      this.preview = null;
      app.emit('overlayrender');
    }
    pointerMove(pt, e, app) {
      // hover preview of the enclosed region (vector layers)
      const layer = app.activeLayer();
      if (!layer || layer.type !== 'vector') { this.preview = null; return; }
      const now = performance.now();
      if (now - (this._lastHover || 0) < 130) return;
      this._lastHover = now;
      const cel = layer.celAt(app.frame);
      if (!cel || !cel.strokes.length) { this.preview = null; app.emit('overlayrender'); return; }
      const res = V().computeFill(cel, pt.x, pt.y, { gap: app.settings.fillGap });
      this.preview = (res && !res.open) ? res.contour : null;
      app.emit('overlayrender');
    }
    drawOverlay(ctx, app) {
      if (!this.preview || this.preview.length < 3) return;
      ctx.save();
      ctx.fillStyle = '#4a9fd455';
      ctx.strokeStyle = '#4a9fd4';
      ctx.lineWidth = 1.5 / app.stage.view.zoom;
      ctx.beginPath();
      ctx.moveTo(this.preview[0].x, this.preview[0].y);
      for (let i = 1; i < this.preview.length; i++) ctx.lineTo(this.preview[i].x, this.preview[i].y);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    _vFill(cel, pt, app) {
      if (!cel.strokes.some(s => s.type === 'line')) {
        app.ui.status('Draw some line art first, then fill inside it');
        return;
      }
      const before = cel.snapshot();
      const gap = app.settings.fillGap;
      const res = V().computeFill(cel, pt.x, pt.y, { gap: gap });
      if (!res) { app.ui.status('Click inside an area enclosed by lines'); return; }
      if (res.open) {
        app.ui.status('Region is not closed - increase Gap Closing or connect the line ends');
        return;
      }
      cel.strokes.push({
        id: U.uid(), type: 'fill', color: app.color, opacity: 1,
        contour: res.contour, grow: gap
      });
      cel.rebuild();
      app.history.pushCelEdit('fill', cel, before);
      app.emit('render'); app.emit('celchange');
      app.ui.status('Filled enclosed region');
    }
    _rFill(cel, pt, app) {
      const x = Math.floor(pt.x), y = Math.floor(pt.y);
      if (x < 0 || y < 0 || x >= cel.w || y >= cel.h) return;
      const before = cel.snapshot();
      this._flood(cel, x, y, app.color, app.settings.fillTolerance, app.settings.fillContiguous);
      app.history.pushCelEdit('fill', cel, before);
      cel.dirty();
      app.emit('render'); app.emit('celchange');
    }
    _flood(cel, x, y, hex, tol, contig) {
      const w = cel.w, h = cel.h;
      const img = cel.ctx.getImageData(0, 0, w, h);
      const d = img.data;
      const f = U.hexToRgb(hex);
      const idx = (y * w + x) * 4;
      const tr = d[idx], tg = d[idx + 1], tb = d[idx + 2], ta = d[idx + 3];
      if (tr === f.r && tg === f.g && tb === f.b && ta === 255) return;
      const thr = tol * tol * 4;
      const match = i => {
        const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb, da = d[i + 3] - ta;
        return dr * dr + dg * dg + db * db + da * da <= thr;
      };
      if (contig) {
        const seen = new Uint8Array(w * h);
        const stack = [x, y];
        while (stack.length) {
          const py = stack.pop(), px = stack.pop();
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const p = py * w + px;
          if (seen[p]) continue;
          const i = p * 4;
          if (!match(i)) continue;
          seen[p] = 1;
          d[i] = f.r; d[i + 1] = f.g; d[i + 2] = f.b; d[i + 3] = 255;
          stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
        }
      } else {
        for (let p = 0, n = w * h; p < n; p++) {
          const i = p * 4;
          if (match(i)) { d[i] = f.r; d[i + 1] = f.g; d[i + 2] = f.b; d[i + 3] = 255; }
        }
      }
      cel.ctx.putImageData(img, 0, 0);
    }
  }

  /* ============================== eyedropper ============================== */
  class EyedropperTool extends Tool {
    constructor() { super('eyedropper'); }
    pointerDown(pt, e, app) {
      const c = app.stage.sampleColor(pt.x, pt.y);
      if (c) { app.setColor(c); app.ui.status('Picked ' + c); }
    }
  }

  /* ============================== shapes ============================== */
  class ShapeTool extends Tool {
    constructor(kind) { super(kind); this.kind = kind; }
    pointerDown(pt) { this.start = { x: pt.x, y: pt.y }; this.cur = { x: pt.x, y: pt.y }; }
    pointerMove(pt, e, app) {
      if (!this.start) return;
      this.cur = { x: pt.x, y: pt.y, shift: pt.shift };
      app.emit('overlayrender');
    }
    pointerUp(pt, e, app) {
      if (!this.start) return;
      this.cur = { x: pt.x, y: pt.y, shift: pt.shift };
      const t = drawTarget(app);
      if (t) {
        if (t.cel.kind === 'vector') this._vCommit(t.cel, app);
        else this._rCommit(t.cel, app);
      }
      this.start = null;
    }
    drawOverlay(ctx, app) { if (this.start) this._path(ctx, app); }
    _geom() {
      let x0 = this.start.x, y0 = this.start.y, x1 = this.cur.x, y1 = this.cur.y;
      if (this.cur.shift) {
        if (this.kind === 'line') {
          const a = Math.atan2(y1 - y0, x1 - x0);
          const len = U.dist(x0, y0, x1, y1);
          const s = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
          x1 = x0 + Math.cos(s) * len; y1 = y0 + Math.sin(s) * len;
        } else {
          const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
          x1 = x0 + Math.sign(x1 - x0 || 1) * s;
          y1 = y0 + Math.sign(y1 - y0 || 1) * s;
        }
      }
      return { x0, y0, x1, y1 };
    }
    _points() {
      const g = this._geom();
      if (this.kind === 'line') return { pts: [{ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }], closed: false };
      if (this.kind === 'rect') {
        const x = Math.min(g.x0, g.x1), y = Math.min(g.y0, g.y1);
        const w = Math.abs(g.x1 - g.x0), h = Math.abs(g.y1 - g.y0);
        return { pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true };
      }
      const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2;
      const rx = Math.abs(g.x1 - g.x0) / 2, ry = Math.abs(g.y1 - g.y0) / 2;
      const pts = [];
      for (let i = 0; i < 40; i++) {
        const a = i / 40 * Math.PI * 2;
        pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
      }
      return { pts, closed: true };
    }
    _path(ctx, app) {
      const s = app.settings;
      const geo = this._points();
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = s.shapeStrokeWidth;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = app.color; ctx.fillStyle = app.color;
      ctx.beginPath();
      ctx.moveTo(geo.pts[0].x, geo.pts[0].y);
      for (let i = 1; i < geo.pts.length; i++) ctx.lineTo(geo.pts[i].x, geo.pts[i].y);
      if (geo.closed) ctx.closePath();
      if (geo.closed && s.shapeFill) ctx.fill();
      if (!geo.closed || s.shapeStroke) ctx.stroke();
      ctx.restore();
    }
    _rCommit(cel, app) {
      const before = cel.snapshot();
      const ctx = cel.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._path(ctx, app);
      app.history.pushCelEdit(this.kind, cel, before);
      cel.dirty();
      app.emit('render'); app.emit('celchange');
    }
    _vCommit(cel, app) {
      const s = app.settings;
      const before = cel.snapshot();
      const geo = this._points();
      const added = [];
      if (geo.closed && s.shapeFill) {
        const f = {
          id: U.uid(), type: 'fill', color: app.color, opacity: 1,
          contour: geo.pts.map(p => ({ x: p.x, y: p.y })), grow: 0
        };
        cel.strokes.push(f); added.push(f);
      }
      if (!geo.closed || s.shapeStroke) {
        const ln = {
          id: U.uid(), type: 'line', pencil: true, sharp: true,
          color: app.color, width: s.shapeStrokeWidth, opacity: 1,
          pts: geo.pts.map(p => ({ x: p.x, y: p.y })), closed: geo.closed
        };
        cel.strokes.push(ln); added.push(ln);
      }
      if (app.symmetry && app.symmetry.on) {
        for (const st of added)
          cel.strokes.push(V().mirrorStroke(st, app.symmetry.axis,
            app.project.width / 2, app.project.height / 2));
      }
      cel.rebuild();
      app.history.pushCelEdit(this.kind, cel, before);
      app.emit('render'); app.emit('celchange');
    }
  }

  /* ============================== hand / zoom ============================== */
  class HandTool extends Tool {
    constructor() { super('hand'); }
    pointerDown(pt) { this.last = { x: pt.sx, y: pt.sy }; }
    pointerMove(pt, e, app) {
      if (!this.last) return;
      app.stage.panBy(pt.sx - this.last.x, pt.sy - this.last.y);
      this.last = { x: pt.sx, y: pt.sy };
    }
    pointerUp() { this.last = null; }
  }
  class ZoomTool extends Tool {
    constructor() { super('zoom'); }
    pointerDown(pt, e, app) {
      app.stage.zoomAt(pt.sx, pt.sy, pt.alt ? 1 / 1.4 : 1.4);
    }
  }

  /* ============================== select ============================== */
  class SelectTool extends Tool {
    constructor() { super('select'); this.sel = null; this.mode = 'idle'; this.vsel = []; }
    onDeactivate(app) { this.commit(app); this.vsel = []; }
    flush(app) { this.commit(app); }

    pointerDown(pt, e, app) {
      const layer = app.activeLayer();
      this.layerKind = layer ? layer.type : null;
      if (this.layerKind === 'vector') this._vDown(pt, app);
      else this._rDown(pt, e, app);
    }
    pointerMove(pt, e, app) {
      if (this.layerKind === 'vector') this._vMove(pt, app);
      else this._rMove(pt, e, app);
    }
    pointerUp(pt, e, app) {
      if (this.layerKind === 'vector') this._vUp(pt, app);
      else this._rUp(pt, e, app);
    }
    drawOverlay(ctx, app) {
      if (this.layerKind === 'vector') this._vOverlay(ctx, app);
      else this._rOverlay(ctx, app);
    }

    /* ---- vector stroke selection ---- */
    _vDown(pt, app) {
      const cel = app.activeLayer().celAt(app.frame);
      if (!cel) { this.vmode = 'none'; return; }
      this.vcel = cel;
      const zoom = app.stage.view.zoom;
      let hit = null;
      for (let i = cel.strokes.length - 1; i >= 0; i--) {
        if (V().strokeHit(cel.strokes[i], pt.x, pt.y, 5 / zoom)) { hit = cel.strokes[i]; break; }
      }
      if (hit) {
        if (this.vsel.indexOf(hit) < 0) {
          if (!pt.shift) this.vsel = [];
          this.vsel.push(hit);
        }
        this.vmode = 'move';
        this.vbefore = cel.snapshot();
        this.vstart = { x: pt.x, y: pt.y };
        this.vmoved = false;
      } else {
        if (!pt.shift) this.vsel = [];
        this.vmode = 'marquee';
        this.marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      }
      app.emit('overlayrender');
    }
    _vMove(pt, app) {
      if (this.vmode === 'marquee') {
        this.marquee.x1 = pt.x; this.marquee.y1 = pt.y;
        app.emit('overlayrender');
      } else if (this.vmode === 'move') {
        const dx = pt.x - this.vstart.x, dy = pt.y - this.vstart.y;
        this.vstart = { x: pt.x, y: pt.y };
        if (dx || dy) this.vmoved = true;
        for (const st of this.vsel) {
          if (st.type === 'fill')
            st.contour = st.contour.map(p => ({ x: p.x + dx, y: p.y + dy }));
          else
            st.pts = st.pts.map(p => ({ x: p.x + dx, y: p.y + dy, p: p.p }));
        }
        this.vcel.rebuild();
        app.emit('render'); app.emit('overlayrender');
      }
    }
    _vUp(pt, app) {
      if (this.vmode === 'marquee' && this.marquee) {
        const m = this.marquee;
        const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
        const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
        if (w > 2 || h > 2) {
          for (const st of this.vcel.strokes) {
            const b = V().strokeBounds(st);
            if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y)
              if (this.vsel.indexOf(st) < 0) this.vsel.push(st);
          }
        }
        this.marquee = null;
      } else if (this.vmode === 'move' && this.vmoved) {
        app.history.pushCelEdit('move strokes', this.vcel, this.vbefore);
        app.emit('celchange');
      }
      this.vmode = 'idle';
      app.emit('render'); app.emit('overlayrender');
    }
    _vOverlay(ctx, app) {
      const zoom = app.stage.view.zoom;
      if (this.vmode === 'marquee' && this.marquee) {
        const m = this.marquee;
        ctx.save();
        ctx.lineWidth = 1 / zoom; ctx.setLineDash([5 / zoom, 4 / zoom]);
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1),
          Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
        ctx.restore();
      }
      if (this.vsel.length) {
        ctx.save();
        ctx.strokeStyle = '#4a9fd4';
        ctx.lineWidth = 1.4 / zoom;
        ctx.setLineDash([4 / zoom, 3 / zoom]);
        for (const st of this.vsel) {
          const b = V().strokeBounds(st);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
        }
        ctx.restore();
      }
    }
    deleteVSel(app) {
      if (!this.vsel.length || !this.vcel) return false;
      const before = this.vcel.snapshot();
      this.vcel.strokes = this.vcel.strokes.filter(s => this.vsel.indexOf(s) < 0);
      this.vsel = [];
      this.vcel.rebuild();
      app.history.pushCelEdit('delete strokes', this.vcel, before);
      app.emit('render'); app.emit('celchange');
      return true;
    }

    /* ---- raster pixel selection (marquee + free transform) ---- */
    _anchor(idx, sw, sh) {
      const xs = [-sw / 2, 0, sw / 2, sw / 2, sw / 2, 0, -sw / 2, -sw / 2];
      const ys = [-sh / 2, -sh / 2, -sh / 2, 0, sh / 2, sh / 2, sh / 2, 0];
      return { x: xs[idx], y: ys[idx] };
    }
    _world(s, ix, iy) {
      const c = Math.cos(s.rot), sn = Math.sin(s.rot);
      const x = ix * s.scaleX, y = iy * s.scaleY;
      return { x: s.cx + x * c - y * sn, y: s.cy + x * sn + y * c };
    }
    _local(s, wx, wy) {
      const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
      const dx = wx - s.cx, dy = wy - s.cy;
      return { x: (dx * c - dy * sn) / s.scaleX, y: (dx * sn + dy * c) / s.scaleY };
    }
    _rDown(pt, e, app) {
      const s = this.sel;
      if (s) {
        const zoom = app.stage.view.zoom, thr = 9 / zoom;
        const rh = this._rotHandleWorld(s);
        if (U.dist(pt.x, pt.y, rh.x, rh.y) < thr) {
          this.mode = 'rotate'; this.startRot = s.rot;
          this.startAng = Math.atan2(pt.y - s.cy, pt.x - s.cx); return;
        }
        for (let i = 0; i < 8; i++) {
          const a = this._anchor(i, s.sw, s.sh);
          const w = this._world(s, a.x, a.y);
          if (U.dist(pt.x, pt.y, w.x, w.y) < thr) {
            this.mode = 'scale'; this.hIdx = i;
            const opp = this._anchor((i + 4) % 8, s.sw, s.sh);
            this.fixed = this._world(s, opp.x, opp.y);
            this.oppA = opp; this.hA = a; return;
          }
        }
        const loc = this._local(s, pt.x, pt.y);
        if (Math.abs(loc.x) <= s.sw / 2 && Math.abs(loc.y) <= s.sh / 2) {
          this.mode = 'move';
          this.moveOff = { x: pt.x - s.cx, y: pt.y - s.cy }; return;
        }
        this.commit(app);
      }
      this.mode = 'marquee';
      this.marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      app.emit('overlayrender');
    }
    _rMove(pt, e, app) {
      const s = this.sel;
      if (this.mode === 'marquee') {
        this.marquee.x1 = pt.x; this.marquee.y1 = pt.y;
        app.emit('overlayrender');
      } else if (this.mode === 'move') {
        s.cx = pt.x - this.moveOff.x; s.cy = pt.y - this.moveOff.y;
        app.emit('render');
      } else if (this.mode === 'rotate') {
        const ang = Math.atan2(pt.y - s.cy, pt.x - s.cx);
        s.rot = this.startRot + (ang - this.startAng);
        if (pt.shift) s.rot = Math.round(s.rot / (Math.PI / 12)) * (Math.PI / 12);
        app.emit('render');
      } else if (this.mode === 'scale') {
        const dxA = this.hA.x - this.oppA.x, dyA = this.hA.y - this.oppA.y;
        const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
        const vx = (pt.x - this.fixed.x) * c - (pt.y - this.fixed.y) * sn;
        const vy = (pt.x - this.fixed.x) * sn + (pt.y - this.fixed.y) * c;
        let nsx = dxA !== 0 ? vx / dxA : s.scaleX;
        let nsy = dyA !== 0 ? vy / dyA : s.scaleY;
        if (pt.shift && dxA !== 0 && dyA !== 0) {
          const m = Math.max(Math.abs(nsx), Math.abs(nsy));
          nsx = Math.sign(nsx) * m; nsy = Math.sign(nsy) * m;
        }
        if (Math.abs(nsx) < 0.01) nsx = 0.01 * Math.sign(nsx || 1);
        if (Math.abs(nsy) < 0.01) nsy = 0.01 * Math.sign(nsy || 1);
        s.scaleX = nsx; s.scaleY = nsy;
        const rc = Math.cos(s.rot), rs = Math.sin(s.rot);
        const ox = -this.oppA.x * nsx, oy = -this.oppA.y * nsy;
        s.cx = this.fixed.x + ox * rc - oy * rs;
        s.cy = this.fixed.y + ox * rs + oy * rc;
        app.emit('render');
      }
    }
    _rUp(pt, e, app) {
      if (this.mode === 'marquee') {
        const m = this.marquee;
        const x = Math.round(Math.min(m.x0, m.x1)), y = Math.round(Math.min(m.y0, m.y1));
        const w = Math.round(Math.abs(m.x1 - m.x0)), h = Math.round(Math.abs(m.y1 - m.y0));
        this.marquee = null;
        if (w > 2 && h > 2) this._lift(app, x, y, w, h);
      }
      this.mode = 'idle';
      app.emit('render');
    }
    _lift(app, x, y, w, h) {
      const layer = app.activeLayer();
      if (!isDrawable(layer) || layer.locked) { app.ui.status('Cannot select here'); return; }
      const cel = layer.celAt(app.frame);
      if (!cel) { app.ui.status('Nothing on this frame'); return; }
      const cx0 = U.clamp(x, 0, cel.w), cy0 = U.clamp(y, 0, cel.h);
      const cx1 = U.clamp(x + w, 0, cel.w), cy1 = U.clamp(y + h, 0, cel.h);
      w = cx1 - cx0; h = cy1 - cy0;
      if (w < 1 || h < 1) return;
      const before = cel.snapshot();
      const sc = document.createElement('canvas');
      sc.width = w; sc.height = h;
      sc.getContext('2d').drawImage(cel.canvas, cx0, cy0, w, h, 0, 0, w, h);
      cel.ctx.clearRect(cx0, cy0, w, h);
      if (cel.kind === 'vector') {
        // selection on a vector layer flattens what was lifted
        cel.strokes = cel.strokes;
      }
      cel.dirty();
      this.sel = {
        canvas: sc, sw: w, sh: h,
        cx: cx0 + w / 2, cy: cy0 + h / 2,
        scaleX: 1, scaleY: 1, rot: 0,
        cel, layer, before
      };
      app.ui.status('Selection lifted - drag to move, handles to transform, click outside to commit');
    }
    _rotHandleWorld(s) {
      const a = this._anchor(1, s.sw, s.sh);
      const off = 26 / OT.app.stage.view.zoom / Math.abs(s.scaleY || 1);
      return this._world(s, a.x, a.y - off);
    }
    deleteSel(app) {
      const s = this.sel; if (!s) return;
      app.history.pushCelEdit('delete selection', s.cel, s.before);
      s.cel.dirty(); this.sel = null;
      app.emit('render'); app.emit('celchange');
    }
    cancel(app) {
      const s = this.sel; if (!s) return;
      s.cel.restore(s.before);
      this.sel = null;
      app.emit('render'); app.emit('celchange');
    }
    commit(app) {
      const s = this.sel; if (!s) return;
      this.sel = null;
      const ctx = s.cel.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.translate(s.cx, s.cy);
      ctx.rotate(s.rot);
      ctx.scale(s.scaleX, s.scaleY);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(s.canvas, -s.sw / 2, -s.sh / 2);
      ctx.restore();
      app.history.pushCelEdit('transform selection', s.cel, s.before);
      s.cel.dirty();
      app.emit('render'); app.emit('celchange');
    }
    _rOverlay(ctx, app) {
      const zoom = app.stage.view.zoom;
      if (this.mode === 'marquee' && this.marquee) {
        const m = this.marquee;
        ctx.save();
        ctx.lineWidth = 1 / zoom;
        ctx.setLineDash([5 / zoom, 4 / zoom]);
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1),
          Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
        ctx.restore();
      }
      const s = this.sel;
      if (!s) return;
      ctx.save();
      ctx.translate(s.cx, s.cy);
      ctx.rotate(s.rot);
      ctx.scale(s.scaleX, s.scaleY);
      ctx.globalAlpha = 0.55;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(s.canvas, -s.sw / 2, -s.sh / 2);
      ctx.restore();
      ctx.save();
      ctx.lineWidth = 1.4 / zoom;
      ctx.strokeStyle = '#4a9fd4';
      const corners = [0, 2, 4, 6].map(i => {
        const a = this._anchor(i, s.sw, s.sh); return this._world(s, a.x, a.y);
      });
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.stroke();
      const tc = this._world(s, 0, -s.sh / 2);
      const rh = this._rotHandleWorld(s);
      ctx.beginPath(); ctx.moveTo(tc.x, tc.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
      const hs = 4 / zoom;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4a9fd4';
      for (let i = 0; i < 8; i++) {
        const a = this._anchor(i, s.sw, s.sh);
        const w = this._world(s, a.x, a.y);
        ctx.beginPath(); ctx.rect(w.x - hs, w.y - hs, hs * 2, hs * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(rh.x, rh.y, hs, 0, 7); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  /* ============================== lasso (freeform select) ============================== */
  // Draw a freeform loop to grab strokes (vector layers) or a pixel region
  // (bitmap layers), then drag the catch to move it.
  class LassoTool extends Tool {
    constructor() {
      super('lasso');
      this.mode = 'idle';
      this.poly = null;        // the loop being drawn
      this.vsel = [];          // selected vector strokes
      this.vcel = null;
      this.raster = null;      // a lifted floating pixel piece
    }
    onDeactivate(app) {
      this._commitRaster(app);
      this.vsel = []; this.vcel = null; this.poly = null; this.mode = 'idle';
      app.emit('overlayrender');
    }
    // a frame / layer change drops the selection so it can't act on a hidden cel
    flush(app) {
      this._commitRaster(app);
      this.vsel = []; this.vcel = null;
    }

    pointerDown(pt, e, app) {
      const layer = app.activeLayer();
      this.layerKind = layer ? layer.type : null;
      if (this.layerKind === 'vector') {
        if (this.vsel.length && this.vcel && this._inVBounds(pt)) {
          this.mode = 'vmove';
          this.before = this.vcel.snapshot();
          this.last = { x: pt.x, y: pt.y };
          this.moved = false;
          return;
        }
        this.vsel = [];
      } else if (this.layerKind === 'drawing') {
        if (this.raster && this._inRasterBounds(pt)) {
          this.mode = 'rmove';
          this.off = { x: pt.x - this.raster.x, y: pt.y - this.raster.y };
          return;
        }
        this._commitRaster(app);   // a new loop drops any floating piece
      } else {
        app.ui.status('The lasso works on drawing layers');
        this.mode = 'idle';
        return;
      }
      this.mode = 'lasso';
      this.poly = [{ x: pt.x, y: pt.y }];
      app.emit('overlayrender');
    }
    pointerMove(pt, e, app) {
      if (this.mode === 'lasso') {
        const last = this.poly[this.poly.length - 1];
        if (U.dist(last.x, last.y, pt.x, pt.y) > 1.6) this.poly.push({ x: pt.x, y: pt.y });
        app.emit('overlayrender');
      } else if (this.mode === 'vmove') {
        const dx = pt.x - this.last.x, dy = pt.y - this.last.y;
        this.last = { x: pt.x, y: pt.y };
        if (dx || dy) this.moved = true;
        for (const st of this.vsel) {
          if (st.type === 'fill')
            st.contour = st.contour.map(p => ({ x: p.x + dx, y: p.y + dy }));
          else
            st.pts = st.pts.map(p => ({ x: p.x + dx, y: p.y + dy, p: p.p }));
        }
        this.vcel.rebuild();
        app.emit('render'); app.emit('overlayrender');
      } else if (this.mode === 'rmove') {
        this.raster.x = pt.x - this.off.x;
        this.raster.y = pt.y - this.off.y;
        app.emit('render'); app.emit('overlayrender');
      }
    }
    pointerUp(pt, e, app) {
      if (this.mode === 'lasso') {
        if (this.poly && this.poly.length >= 3) {
          if (this.layerKind === 'vector') this._lassoVector(app);
          else this._lassoRaster(app);
        }
        this.poly = null;
      } else if (this.mode === 'vmove') {
        if (this.moved) {
          app.history.pushCelEdit('Move strokes', this.vcel, this.before);
          app.emit('celchange');
        }
      }
      this.mode = 'idle';
      app.emit('render'); app.emit('overlayrender');
    }

    _strokeCentroid(st) {
      const pts = st.type === 'fill' ? st.contour : st.pts;
      if (!pts || !pts.length) return null;
      let x = 0, y = 0;
      for (const p of pts) { x += p.x; y += p.y; }
      return { x: x / pts.length, y: y / pts.length };
    }
    _lassoVector(app) {
      const cel = app.activeLayer().celAt(app.frame);
      if (!cel) { app.ui.status('Nothing on this frame to select'); return; }
      this.vcel = cel;
      const sel = [];
      for (const st of cel.strokes) {
        const c = this._strokeCentroid(st);
        if (c && pointInPoly(c.x, c.y, this.poly)) sel.push(st);
      }
      this.vsel = sel;
      app.ui.status(sel.length
        ? 'Lassoed ' + sel.length + ' stroke' + (sel.length === 1 ? '' : 's') + ' — drag to move'
        : 'No strokes inside the lasso');
    }
    _lassoRaster(app) {
      const layer = app.activeLayer();
      if (layer.locked) { app.ui.status('Layer is locked'); return; }
      const cel = layer.celAt(app.frame);
      if (!cel) { app.ui.status('Nothing on this frame'); return; }
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const p of this.poly) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      x0 = U.clamp(Math.floor(x0), 0, cel.w); y0 = U.clamp(Math.floor(y0), 0, cel.h);
      x1 = U.clamp(Math.ceil(x1), 0, cel.w); y1 = U.clamp(Math.ceil(y1), 0, cel.h);
      const w = x1 - x0, h = y1 - y0;
      if (w < 2 || h < 2) return;
      const before = cel.snapshot();
      const trace = ctx => {
        ctx.beginPath();
        ctx.moveTo(this.poly[0].x - x0, this.poly[0].y - y0);
        for (let i = 1; i < this.poly.length; i++)
          ctx.lineTo(this.poly[i].x - x0, this.poly[i].y - y0);
        ctx.closePath();
      };
      // copy the lassoed pixels into a floating canvas
      const fc = document.createElement('canvas');
      fc.width = w; fc.height = h;
      const fx = fc.getContext('2d');
      fx.save(); trace(fx); fx.clip();
      fx.drawImage(cel.canvas, -x0, -y0);
      fx.restore();
      // erase the lassoed region from the cel
      const ctx = cel.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(this.poly[0].x, this.poly[0].y);
      for (let i = 1; i < this.poly.length; i++) ctx.lineTo(this.poly[i].x, this.poly[i].y);
      ctx.closePath();
      ctx.clip();
      ctx.clearRect(0, 0, cel.w, cel.h);
      ctx.restore();
      cel.dirty();
      this.raster = { canvas: fc, x: x0, y: y0, w: w, h: h, cel: cel, before: before };
      app.ui.status('Lassoed a region — drag to move it, lasso again to drop it');
    }
    _commitRaster(app) {
      const r = this.raster;
      if (!r) return;
      this.raster = null;
      r.cel.ctx.drawImage(r.canvas, r.x, r.y);
      r.cel.dirty();
      app.history.pushCelEdit('Move selection', r.cel, r.before);
      app.emit('render'); app.emit('celchange');
    }
    _inVBounds(pt) {
      if (!this.vsel.length) return false;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const st of this.vsel) {
        const b = V().strokeBounds(st);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
      }
      return pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1;
    }
    _inRasterBounds(pt) {
      const r = this.raster;
      return !!r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
    }
    // Del key -> remove the lasso catch.
    deleteLasso(app) {
      if (this.vsel.length && this.vcel) {
        const before = this.vcel.snapshot();
        this.vcel.strokes = this.vcel.strokes.filter(s => this.vsel.indexOf(s) < 0);
        this.vsel = [];
        this.vcel.rebuild();
        app.history.pushCelEdit('Delete strokes', this.vcel, before);
        app.emit('render'); app.emit('celchange');
        return true;
      }
      if (this.raster) {
        const r = this.raster;     // region is already cleared from the cel
        this.raster = null;
        r.cel.dirty();
        app.history.pushCelEdit('Delete selection', r.cel, r.before);
        app.emit('render'); app.emit('celchange');
        return true;
      }
      return false;
    }
    // Esc -> drop the selection, restoring lifted pixels.
    cancel(app) {
      if (this.raster) {
        this.raster.cel.restore(this.raster.before);
        this.raster = null;
        app.emit('render'); app.emit('celchange');
      }
      this.vsel = []; this.vcel = null;
      app.emit('overlayrender');
    }
    hasSelection() { return this.vsel.length > 0 || !!this.raster; }

    drawOverlay(ctx, app) {
      const zoom = app.stage.view.zoom;
      if (this.mode === 'lasso' && this.poly && this.poly.length) {
        ctx.save();
        ctx.lineWidth = 1.4 / zoom;
        ctx.setLineDash([5 / zoom, 4 / zoom]);
        ctx.strokeStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(this.poly[0].x, this.poly[0].y);
        for (let i = 1; i < this.poly.length; i++) ctx.lineTo(this.poly[i].x, this.poly[i].y);
        if (this.poly.length > 2) ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
      if (this.vsel && this.vsel.length) {
        ctx.save();
        ctx.strokeStyle = '#4a9fd4';
        ctx.lineWidth = 1.4 / zoom;
        ctx.setLineDash([4 / zoom, 3 / zoom]);
        for (const st of this.vsel) {
          const b = V().strokeBounds(st);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
        }
        ctx.restore();
      }
      if (this.raster) {
        const r = this.raster;
        ctx.save();
        ctx.globalAlpha = 0.95;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(r.canvas, r.x, r.y);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#4a9fd4';
        ctx.lineWidth = 1.4 / zoom;
        ctx.setLineDash([4 / zoom, 3 / zoom]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
      }
    }
  }

  /* ============================== transform (cut-out / peg) ============================== */
  class TransformTool extends Tool {
    constructor() { super('transform'); }
    _box(app) {
      const layer = app.activeLayer(), p = app.project;
      const tr = layer.transformAt(app.frame);
      const px = p.width / 2, py = p.height / 2;
      const fwd = (cx, cy) => {
        const lx = (cx - px) * tr.sx, ly = (cy - py) * tr.sy;
        const r = tr.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        return { x: lx * c - ly * s + px + tr.x, y: lx * s + ly * c + py + tr.y };
      };
      return {
        layer, p, tr, px, py, fwd,
        corners: [fwd(0, 0), fwd(p.width, 0), fwd(p.width, p.height), fwd(0, p.height)],
        center: { x: px + tr.x, y: py + tr.y },
        rotH: fwd(px, -Math.max(p.width, p.height) * 0.12)
      };
    }
    pointerDown(pt, e, app) {
      const layer = app.activeLayer();
      if (!isDrawable(layer)) { app.ui.status('Select a drawing layer'); return; }
      this.layer = layer;
      this.before = app._structSnapshot();
      let kf = layer.transform.keyframes.find(k => k.frame === app.frame);
      if (!kf) {
        const c = layer.transformAt(app.frame);
        kf = { frame: app.frame, x: c.x, y: c.y, sx: c.sx, sy: c.sy, rot: c.rot };
        layer.transform.keyframes.push(kf);
      }
      this.kf = kf;
      const b = this._box(app);
      const thr = 11 / app.stage.view.zoom;
      if (U.dist(pt.x, pt.y, b.rotH.x, b.rotH.y) < thr) {
        this.mode = 'rotate';
        this.startAng = Math.atan2(pt.y - b.center.y, pt.x - b.center.x);
        this.startRot = kf.rot;
        return;
      }
      for (let i = 0; i < 4; i++) {
        if (U.dist(pt.x, pt.y, b.corners[i].x, b.corners[i].y) < thr) {
          this.mode = 'scale'; this.hCorner = i; return;
        }
      }
      this.mode = 'move';
      this.startX = kf.x; this.startY = kf.y;
      this.startPt = { x: pt.x, y: pt.y };
    }
    pointerMove(pt, e, app) {
      if (!this.kf) return;
      const b = this._box(app);
      if (this.mode === 'move') {
        this.kf.x = this.startX + (pt.x - this.startPt.x);
        this.kf.y = this.startY + (pt.y - this.startPt.y);
      } else if (this.mode === 'rotate') {
        const ang = Math.atan2(pt.y - b.center.y, pt.x - b.center.x);
        let deg = this.startRot + (ang - this.startAng) * 180 / Math.PI;
        if (pt.shift) deg = Math.round(deg / 15) * 15;
        this.kf.rot = deg;
      } else if (this.mode === 'scale') {
        const cc = [[0, 0], [b.p.width, 0], [b.p.width, b.p.height], [0, b.p.height]][this.hCorner];
        const vx = cc[0] - b.px, vy = cc[1] - b.py;
        const lx = pt.x - this.kf.x - b.px, ly = pt.y - this.kf.y - b.py;
        const r = -this.kf.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        let nsx = vx ? (lx * c - ly * s) / vx : this.kf.sx;
        let nsy = vy ? (lx * s + ly * c) / vy : this.kf.sy;
        if (pt.shift) {
          const m = Math.max(Math.abs(nsx), Math.abs(nsy));
          nsx = Math.sign(nsx || 1) * m; nsy = Math.sign(nsy || 1) * m;
        }
        this.kf.sx = Math.abs(nsx) < 0.02 ? 0.02 * Math.sign(nsx || 1) : nsx;
        this.kf.sy = Math.abs(nsy) < 0.02 ? 0.02 * Math.sign(nsy || 1) : nsy;
      }
      app.emit('render'); app.emit('overlayrender');
    }
    pointerUp(pt, e, app) {
      if (!this.kf) return;
      app._commitStruct('Layer transform keyframe', this.before);
      this.kf = null; this.mode = null;
    }
    drawOverlay(ctx, app) {
      const layer = app.activeLayer();
      if (!isDrawable(layer)) return;
      const b = this._box(app);
      const zoom = app.stage.view.zoom;
      ctx.save();
      ctx.lineWidth = 1.6 / zoom;
      ctx.strokeStyle = '#e8a23a';
      ctx.beginPath();
      ctx.moveTo(b.corners[0].x, b.corners[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(b.corners[i].x, b.corners[i].y);
      ctx.closePath(); ctx.stroke();
      const tc = b.fwd(b.px, 0);
      ctx.beginPath(); ctx.moveTo(tc.x, tc.y); ctx.lineTo(b.rotH.x, b.rotH.y); ctx.stroke();
      const hs = 4.5 / zoom;
      ctx.fillStyle = '#fff';
      for (const cn of b.corners) {
        ctx.beginPath(); ctx.rect(cn.x - hs, cn.y - hs, hs * 2, hs * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(b.rotH.x, b.rotH.y, hs, 0, 7); ctx.fill(); ctx.stroke();
      const cr = 7 / zoom;
      ctx.beginPath();
      ctx.moveTo(b.center.x - cr, b.center.y); ctx.lineTo(b.center.x + cr, b.center.y);
      ctx.moveTo(b.center.x, b.center.y - cr); ctx.lineTo(b.center.x, b.center.y + cr);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ============================== manager ============================== */
  const PAINTY = { brush: 1, pencil: 1, fill: 1 };
  // tools that a flipped-over pen eraser should override
  const PEN_ERASE = { brush: 1, pencil: 1 };
  const CEL_TOOLS = { brush: 1, pencil: 1, eraser: 1, fill: 1, rect: 1, ellipse: 1, line: 1, select: 1, lasso: 1 };
  class ToolManager {
    constructor(app) {
      this.app = app;
      this.dragging = false;
      const list = [
        new SelectTool(),
        new LassoTool(),
        new TransformTool(),
        new PaintTool('brush'),
        new PencilTool(),
        new PaintTool('eraser'),
        new FillTool(),
        new EyedropperTool(),
        new ShapeTool('rect'),
        new ShapeTool('ellipse'),
        new ShapeTool('line'),
        new HandTool(),
        new ZoomTool()
      ];
      this.tools = {};
      for (const t of list) this.tools[t.name] = t;
      this.active = this.tools.brush;
    }
    select(name) {
      const t = this.tools[name];
      if (!t || t === this.active) return;
      if (this.active.onDeactivate) this.active.onDeactivate(this.app);
      this.active = t;
      if (t.onActivate) t.onActivate(this.app);
      this.app.emit('toolchange', name);
      this.app.emit('overlayrender');
    }
    flush() { if (this.active.flush) this.active.flush(this.app); }
    _map(pt, tool) {
      return CEL_TOOLS[tool.name] ? toCel(this.app, pt) : pt;
    }
    pointerDown(pt, e) {
      if (pt.alt && PAINTY[this.active.name]) {
        const c = this.app.stage.sampleColor(pt.x, pt.y);
        if (c) this.app.setColor(c);
        return;
      }
      this.dragging = true;
      // a stylus flipped to its eraser end erases, whatever brush is selected
      this._strokeTool = (pt.penEraser && PEN_ERASE[this.active.name])
        ? this.tools.eraser : this.active;
      if (this._strokeTool !== this.active) this.app.ui.status('Pen eraser');
      this._strokeTool.pointerDown(this._map(pt, this._strokeTool), e, this.app);
    }
    pointerMove(pt, e) {
      const t = this._strokeTool || this.active;
      t.pointerMove(this._map(pt, t), e, this.app);
    }
    pointerUp(pt, e) {
      this.dragging = false;
      const t = this._strokeTool || this.active;
      t.pointerUp(this._map(pt, t), e, this.app);
      this._strokeTool = null;
    }
    drawOverlay(ctx) { if (this.active.drawOverlay) this.active.drawOverlay(ctx, this.app); }
  }

  OT.ToolManager = ToolManager;
})(window.OT);
