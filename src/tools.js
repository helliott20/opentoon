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
    if (allowCreate === false) {
      // Read-only intent must not create or fork.
      cel = layer.celAt(app.frame);
    } else {
      // Edit intent: ensure a cel exists, then fork if it is held across
      // multiple frames so the edit only affects this frame.
      cel = layer.drawingAt(app.frame, app.project.width, app.project.height);
      if (cel && typeof layer.forkAt === 'function') {
        const forked = layer.forkAt(app.frame);
        if (forked) cel = forked;
      }
    }
    if (!cel) return null;
    // Surface "Made unique" status once, then clear the flag so subsequent
    // strokes on the same cel don't repeat the message.
    if (cel.forked) {
      cel.forked = false;
      if (app.ui && app.ui.status) app.ui.status('Made unique: Drawing ' + cel.num);
    }
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

  // Free-transform handle math, shared between SelectTool and LassoTool.
  // The selection object `s` carries { cx, cy, sw, sh, scaleX, scaleY, rot }.
  // `selWorld` maps a local (centred-on-cx,cy) offset to world space; `selLocal`
  // inverts that; `selAnchor` returns the 8 corner/edge anchor points; and
  // `selRotHandleWorld` is the position of the rotation knob above the top edge.
  function selAnchor(idx, sw, sh) {
    const xs = [-sw / 2, 0, sw / 2, sw / 2, sw / 2, 0, -sw / 2, -sw / 2];
    const ys = [-sh / 2, -sh / 2, -sh / 2, 0, sh / 2, sh / 2, sh / 2, 0];
    return { x: xs[idx], y: ys[idx] };
  }
  function selWorld(s, ix, iy) {
    const c = Math.cos(s.rot), sn = Math.sin(s.rot);
    const x = ix * s.scaleX, y = iy * s.scaleY;
    return { x: s.cx + x * c - y * sn, y: s.cy + x * sn + y * c };
  }
  function selLocal(s, wx, wy) {
    const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
    const dx = wx - s.cx, dy = wy - s.cy;
    return { x: (dx * c - dy * sn) / s.scaleX, y: (dx * sn + dy * c) / s.scaleY };
  }
  function selRotHandleWorld(s, zoom) {
    const a = selAnchor(1, s.sw, s.sh);
    const off = 26 / zoom / Math.abs(s.scaleY || 1);
    return selWorld(s, a.x, a.y - off);
  }

  // Lazy-pointer / rope smoothing: the smoothed point `sm` trails the raw
  // cursor `pt` by a fixed maxLag distance regardless of pen speed.
  // sm only moves when the pen drags it beyond maxLag, so jitter inside the
  // radius is silently absorbed while bigger moves track 1:1. This produces
  // CONSISTENT smoothing at any speed (vs a per-frame EMA factor which gives
  // wildly different results for slow vs fast strokes).
  //   smooth = 0   -> maxLag ~2 px  (no perceptible smoothing)
  //   smooth = 0.5 -> maxLag ~13 px
  //   smooth = 1   -> maxLag ~24 px (strong shaping, ~2 frames of lag)
  function lazyAdvance(sm, pt, smooth) {
    const maxLag = 2 + (smooth || 0) * 22;
    const dx = pt.x - sm.x, dy = pt.y - sm.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxLag) return;
    const t = (dist - maxLag) / dist;
    sm.x += dx * t;
    sm.y += dy * t;
  }

  // Invert a layer's transform: convert a project-space point into the
  // layer's cel-local coords. Matches the forward chain in canvas.js
  // (`_layerXform`): translate(tr.x+px, tr.y+py); rotate(rot); scale(sx,sy);
  // translate(-px,-py).
  function layerLocal(pt, layer, frame, app) {
    if (!layer || !layer.transformAt) return { x: pt.x, y: pt.y };
    const tr = layer.transformAt(frame);
    if (!tr.x && !tr.y && !tr.rot && tr.sx === 1 && tr.sy === 1)
      return { x: pt.x, y: pt.y };
    const p = app.project, px = p.width / 2, py = p.height / 2;
    const u = pt.x - tr.x - px;
    const v = pt.y - tr.y - py;
    const r = tr.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const ux = u * c + v * s, uy = -u * s + v * c;
    return { x: ux / (tr.sx || 1) + px, y: uy / (tr.sy || 1) + py };
  }
  // Inverse layer transform applied to a delta vector (no translation).
  function layerLocalDelta(dx, dy, layer, frame) {
    if (!layer || !layer.transformAt) return { dx, dy };
    const tr = layer.transformAt(frame);
    if (!tr.rot && tr.sx === 1 && tr.sy === 1) return { dx, dy };
    const r = tr.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return { dx: (dx * c + dy * s) / (tr.sx || 1), dy: (-dx * s + dy * c) / (tr.sy || 1) };
  }
  // Apply a layer's forward transform to a canvas 2D ctx, so overlay
  // shapes drawn in cel-local coords visually align with the rendered
  // artwork on a translated/rotated/scaled layer.
  function applyLayerXform(ctx, layer, frame, app) {
    if (!layer || !layer.transformAt) return false;
    const tr = layer.transformAt(frame);
    if (!tr.x && !tr.y && !tr.rot && tr.sx === 1 && tr.sy === 1) return false;
    const p = app.project, px = p.width / 2, py = p.height / 2;
    ctx.translate(tr.x + px, tr.y + py);
    ctx.rotate(tr.rot * Math.PI / 180);
    ctx.scale(tr.sx, tr.sy);
    ctx.translate(-px, -py);
    return true;
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
      // Shift-constrain: lock the stroke to a straight line from pointer-down
      // to the current pointer. Re-read e.shiftKey on every move so the user
      // can toggle the constraint mid-stroke. startPt is the anchor.
      this.straight = !!(e && e.shiftKey);
      this.startPt = { x: pt.x, y: pt.y, p: pt.pressure };
      if (this.vec) this._vDown(pt, app); else this._rDown(pt, app);
    }
    pointerMove(pt, e, app) {
      if (!this.t) return;
      // Re-read shift on every move so it can be toggled mid-stroke.
      this.straight = !!(e && e.shiftKey);
      if (this.vec) this._vMove(pt, app); else this._rMove(pt, app);
    }
    pointerUp(pt, e, app) {
      if (!this.t) return;
      if (this.vec) this._vUp(pt, app); else this._rUp(pt, app);
      this.t = null;
    }
    // Esc mid-stroke: drop any pending RAFs, restore the cel to what it was
    // before pointerDown, and reset state without pushing history.
    cancel(app) {
      if (!this.t) return;
      if (this._compRAF) { cancelAnimationFrame(this._compRAF); this._compRAF = 0; }
      if (this._emitRAF) { cancelAnimationFrame(this._emitRAF); this._emitRAF = 0; }
      if (this._eraseRAF) { cancelAnimationFrame(this._eraseRAF); this._eraseRAF = 0; }
      this._erasePending = null;
      this._lastErasePt = null;
      if (this.t && this.t.cel) this.t.cel._liveDrawing = false;
      if (this.before) this.t.cel.restore(this.before);
      this.t = null;
      this.buf = null; this.base = null;
      this.raw = null; this.sm = null; this.last = null; this.lastStamp = null;
      this.changed = false;
      app.emit('render');
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
      if (this.straight) {
        // Lock the stamp to the cursor and rebuild the segment from startPt
        // each move so the buf only carries one straight line. Clearing buf
        // is critical -- otherwise the freehand path stamped before Shift
        // was held remains baked into the dab buffer.
        this.sm.x = pt.x; this.sm.y = pt.y;
        const bx = this.bctx;
        bx.setTransform(1, 0, 0, 1, 0, 0);
        bx.clearRect(0, 0, this.buf.width, this.buf.height);
        this._dot(this.startPt.x, this.startPt.y, this.startPt.p);
        this._seg(this.startPt.x, this.startPt.y, this.startPt.p,
                  pt.x, pt.y, pt.pressure);
        this.last = { x: pt.x, y: pt.y, p: pt.pressure };
        this._scheduleComposite();
        return;
      }
      // Lazy-pointer / rope smoothing: the smoothed point trails the cursor by
      // a fixed maxLag in project pixels. Identical smoothing strength at any
      // speed -- slow strokes get the same shaping as fast ones, which is the
      // consistency animators expect (Procreate / Animate behave this way).
      lazyAdvance(this.sm, pt, this.smooth);
      this._seg(this.last.x, this.last.y, this.last.p, this.sm.x, this.sm.y, pt.pressure);
      this.last = { x: this.sm.x, y: this.sm.y, p: pt.pressure };
      this._scheduleComposite();
    }
    _rUp(pt, app) {
      if (this._compRAF) { cancelAnimationFrame(this._compRAF); this._compRAF = 0; }
      if (this.straight) {
        // Final straight commit: rebuild the buf one last time so the
        // committed segment ends exactly under the release pointer.
        const bx = this.bctx;
        bx.setTransform(1, 0, 0, 1, 0, 0);
        bx.clearRect(0, 0, this.buf.width, this.buf.height);
        this._dot(this.startPt.x, this.startPt.y, this.startPt.p);
        this._seg(this.startPt.x, this.startPt.y, this.startPt.p,
                  pt.x, pt.y, pt.pressure);
      } else {
        // Commit lands on the smoothed cursor, not the raw pointer position, so
        // the stroke does not visibly snap forward at release (matches vector
        // and pencil tools).
        this._seg(this.last.x, this.last.y, this.last.p, this.sm.x, this.sm.y, pt.pressure);
      }
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
        this._lastErasePt = null;
        this._erase(cel, pt.x, pt.y, app);
        return;
      }
      // Paint the first dot synchronously so the artist sees their input
      // immediately. The previous code allocated an 8 MB cel-sized
      // canvas (`canvasCopy`) BEFORE the first dot landed, which made
      // the brush feel choppy on stroke start. `_vUp` now uses
      // `cel.rebuild()` instead of a pre-stroke raster, so we don't
      // need that snapshot any more.
      this.raw = [{ x: pt.x, y: pt.y, p: pt.pressure }];
      this.sm = { x: pt.x, y: pt.y };
      this.lastStamp = { x: pt.x, y: pt.y, p: pt.pressure };
      // mark this cel as actively being drawn into so compositeStage
      // falls back to reading cel.canvas (where the live stamps live)
      // rather than the not-yet-committed strokes array
      cel._liveDrawing = true;
      cel.ctx.fillStyle = this.color;
      cel.ctx.beginPath();
      cel.ctx.arc(pt.x, pt.y, this._r(pt.pressure), 0, 7);
      cel.ctx.fill();
      cel.dirty();
      app.emit('render');
    }
    _vMove(pt, app) {
      const cel = this.t.cel;
      if (this.mode === 'eraser') {
        if (this.straight) {
          // Straight-line erase: revert prior erasure on this stroke, then
          // sample along start->current at radius/0.4 spacing. This is the
          // same dab spacing the eraser already uses internally.
          cel.restore(this.before);
          this._lastErasePt = null;
          // _erase will sample from _lastErasePt (start, set just below) to
          // (pt.x, pt.y) at the right step automatically. Prime it.
          this._lastErasePt = { x: this.startPt.x, y: this.startPt.y };
          this._erase(cel, pt.x, pt.y, app);
          return;
        }
        this._erase(cel, pt.x, pt.y, app);
        return;
      }
      if (this.straight) {
        // Replace raw with exactly two points so the committed stroke is a
        // straight line. Re-stamping every move would bake every intermediate
        // segment into cel.ctx; instead clear the cel back to its committed
        // state via rebuild() and paint just the start->current dab band.
        this.sm.x = pt.x; this.sm.y = pt.y;
        this.raw = [
          { x: this.startPt.x, y: this.startPt.y, p: this.startPt.p },
          { x: pt.x, y: pt.y, p: pt.pressure }
        ];
        cel.rebuild();
        const c = cel.ctx;
        c.fillStyle = this.color;
        const a = this.startPt, b = { x: pt.x, y: pt.y, p: pt.pressure };
        c.beginPath(); c.arc(a.x, a.y, this._r(a.p), 0, 7); c.fill();
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
        return;
      }
      // Lazy-pointer rope smoothing (see _rMove). Consistent at any speed.
      lazyAdvance(this.sm, pt, this.smooth);
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
      if (this.straight) {
        // raw is already [startPt, endPt] from the last straight _vMove;
        // overwrite the end point one more time so the commit lands exactly
        // under the release pointer even if no move event arrived between.
        this.raw = [
          { x: this.startPt.x, y: this.startPt.y, p: this.startPt.p },
          { x: pt.x, y: pt.y, p: pt.pressure }
        ];
      } else {
        // Push the live-smoothed point as the final, so the committed geometry
        // ends exactly where the wet-ink preview ended -- no visible "snap"
        // forward at release. Skip the second smoothing pass: this.raw already
        // carries the EMA-smoothed coordinates from _vMove, so a second smoothPts
        // would tighten the curve away from what the user just saw.
        this.raw.push({ x: this.sm.x, y: this.sm.y, p: pt.pressure });
      }
      const tol = 0.4 + this.smooth * 0.8;
      let pts = V().simplify(this.raw, tol);
      if (pts.length < 2) pts = this.raw.slice(0, 2);
      // endpoint auto-connect
      const snap = app.settings.snapDist;
      const s0 = V().snapPoint(cel, pts[0].x, pts[0].y, snap);
      if (s0) { pts[0] = { x: s0.x, y: s0.y, p: pts[0].p }; }
      const li = pts.length - 1;
      const s1 = V().snapPoint(cel, pts[li].x, pts[li].y, snap);
      if (s1) { pts[li] = { x: s1.x, y: s1.y, p: pts[li].p }; }
      let closed = false;
      // Auto-close is opt-in. Without this guard a quick tick mark that
      // happens to start and end within ~18 px is silently turned into a
      // closed loop, which traps fill operations the artist never intended.
      const autoClose = !!(app.settings && app.settings.autoClose);
      if (autoClose && pts.length > 3 &&
          U.dist(pts[0].x, pts[0].y, pts[li].x, pts[li].y) < snap * 1.3) {
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
      }
      // Rebuild cel.canvas from every stroke (including the new one). This
      // is the same result as the old "clearRect + drawImage(base) +
      // renderStroke" path, but no pre-stroke snapshot is needed -- which
      // is what removed the lag on stroke start.
      cel.rebuild();
      cel._liveDrawing = false;
      app.history.pushCelEdit('brush', cel, this.before);
      app.emit('render'); app.emit('celchange');
    }
    _erase(cel, x, y, app) {
      const r = this.size / 2;
      // Sample the segment from the previous erase point to the current one so
      // a fast stroke does not leave gaps between widely-spaced pointer events.
      // Same stamping pattern the brush uses (~r * 0.4 spacing).
      let samples;
      const last = this._lastErasePt;
      if (last) {
        const d = U.dist(last.x, last.y, x, y);
        const step = Math.max(2, r * 0.4);
        const n = Math.max(1, Math.ceil(d / step));
        samples = [];
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          samples.push({ x: last.x + (x - last.x) * t, y: last.y + (y - last.y) * t });
        }
      } else {
        samples = [{ x: x, y: y }];
      }
      this._lastErasePt = { x: x, y: y };
      let changed = false;
      let strokes = cel.strokes;
      for (const s of samples) {
        const next = [];
        let touched = false;
        for (const st of strokes) {
          const res = V().eraseStroke(st, s.x, s.y, r);
          if (res === null) next.push(st);
          else { touched = true; for (const p of res) next.push(p); }
        }
        if (touched) { strokes = next; changed = true; }
      }
      if (!changed) return;
      cel.strokes = strokes;
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
      this._lastErasePt = null;
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
      // Shift-constrain: lock the stroke to a straight line from this.startPt.
      // Re-read e.shiftKey on every move so the user can toggle mid-stroke.
      this.straight = !!(e && e.shiftKey);
      this.startPt = { x: pt.x, y: pt.y, p: pt.pressure };
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
      this.straight = !!(e && e.shiftKey);
      if (this.straight) {
        // Lock smoothed cursor to the raw pointer and replace raw with just
        // two points so the rendered polyline is the straight start->current
        // segment. _render uses this.raw as-is, so this is enough.
        this.sm.x = pt.x; this.sm.y = pt.y;
        this.raw = [
          { x: this.startPt.x, y: this.startPt.y },
          { x: pt.x, y: pt.y }
        ];
        this._schedule(app);
        return;
      }
      // Lazy-pointer rope smoothing (see PaintTool._rMove for rationale).
      lazyAdvance(this.sm, pt, this.smooth);
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
      if (this.straight) {
        // Force raw to exactly [startPt, releasePt] so the committed polyline
        // is a single straight segment, regardless of how many move events
        // arrived between Shift-down and pointerUp.
        this.raw = [
          { x: this.startPt.x, y: this.startPt.y },
          { x: pt.x, y: pt.y }
        ];
      } else {
        // Push the smoothed final point so commit lands exactly where the live
        // preview ended (this.sm is the EMA-smoothed cursor from pointerMove).
        this.raw.push({ x: this.sm.x, y: this.sm.y });
      }
      const cel = this.t.cel;
      if (this.vec) {
        const tol = 0.4 + this.smooth * 0.8;
        let pts = V().simplify(this.raw, tol);
        if (pts.length < 2) pts = this.raw.slice(0, 2);
        const snap = app.settings.snapDist;
        const s0 = V().snapPoint(cel, pts[0].x, pts[0].y, snap);
        if (s0) pts[0] = { x: s0.x, y: s0.y };
        const li = pts.length - 1;
        const s1 = V().snapPoint(cel, pts[li].x, pts[li].y, snap);
        if (s1) pts[li] = { x: s1.x, y: s1.y };
        let closed = false;
        // Same opt-in guard as PaintTool: auto-close traps tick strokes into
        // unintended closed loops unless the user explicitly opts in.
        const autoClose = !!(app.settings && app.settings.autoClose);
        if (autoClose && pts.length > 3 &&
            U.dist(pts[0].x, pts[0].y, pts[li].x, pts[li].y) < snap * 1.3) {
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
    // Esc mid-stroke: restore the cel and drop the tool's transient state
    // without pushing history.
    cancel(app) {
      if (!this.t) return;
      if (this._rRAF) { cancelAnimationFrame(this._rRAF); this._rRAF = 0; }
      if (this.before) this.t.cel.restore(this.before);
      this.t = null;
      this.buf = null; this.base = null;
      this.raw = null; this.sm = null;
      app.emit('render');
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
      // Track which pixels were filled so we can dilate the region a couple
      // of pixels into the surrounding anti-aliased line edge afterwards.
      // Without this dilation a 1-2 px sliver of unfilled pixels is visible
      // between the fill and the line, because the AA edge fails `match`.
      //
      // IMPORTANT: do NOT overwrite the alpha channel. Anti-aliased line art
      // has fractional alpha along its edges; clobbering alpha to 255 turns a
      // soft edge into a hard one. Only update RGB and let the original alpha
      // define edge softness.
      const filled = new Uint8Array(w * h);
      // Non-contiguous flood would recolour every matching pixel anywhere on
      // the layer (including disconnected regions the artist never clicked).
      // That is almost never what the user wants, so the contiguous flood is
      // the only supported path now -- the `contig` arg is preserved for
      // call-site compatibility but ignored.
      void contig;
      const stack = [x, y];
      while (stack.length) {
        const py = stack.pop(), px = stack.pop();
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const p = py * w + px;
        if (filled[p]) continue;
        const i = p * 4;
        if (!match(i)) continue;
        filled[p] = 1;
        d[i] = f.r; d[i + 1] = f.g; d[i + 2] = f.b;
        stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
      }
      cel.ctx.putImageData(img, 0, 0);
      // Dilate the filled mask by 2 px and paint that ring under the existing
      // pixels (destination-over). The line art on top keeps its full alpha;
      // only the gap pixels behind the AA edge gain the fill colour.
      const expand = 2;
      const ring = this._ringMask(filled, w, h, expand);
      if (ring) {
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tx = tmp.getContext('2d');
        const ringImg = tx.createImageData(w, h);
        const rd = ringImg.data;
        for (let p = 0, n = w * h; p < n; p++) {
          if (!ring[p]) continue;
          const i = p * 4;
          rd[i] = f.r; rd[i + 1] = f.g; rd[i + 2] = f.b; rd[i + 3] = 255;
        }
        tx.putImageData(ringImg, 0, 0);
        const c = cel.ctx;
        c.save();
        c.globalCompositeOperation = 'destination-over';
        c.drawImage(tmp, 0, 0);
        c.restore();
      }
    }
    // Build the dilation ring: pixels NOT in `mask` but within `n` pixels of
    // one that is, using 4-connected dilation. Returns null if `n` is 0 or
    // the mask is empty.
    _ringMask(mask, w, h, n) {
      let any = false;
      for (let p = 0, len = w * h; p < len; p++) if (mask[p]) { any = true; break; }
      if (!any || n <= 0) return null;
      let cur = mask;
      for (let pass = 0; pass < n; pass++) {
        const next = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          const row = y * w;
          for (let x = 0; x < w; x++) {
            const i = row + x;
            if (cur[i]) { next[i] = 1; continue; }
            if ((x > 0 && cur[i - 1]) ||
                (x < w - 1 && cur[i + 1]) ||
                (y > 0 && cur[i - w]) ||
                (y < h - 1 && cur[i + w])) next[i] = 1;
          }
        }
        cur = next;
      }
      // ring = dilated - original
      const ring = new Uint8Array(w * h);
      for (let p = 0, len = w * h; p < len; p++) if (cur[p] && !mask[p]) ring[p] = 1;
      return ring;
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
      this._stopAnts();
      app.emit('overlayrender');
    }
    // a frame / layer change drops the selection so it can't act on a hidden cel
    flush(app) {
      this._commitRaster(app);
      this.vsel = []; this.vcel = null;
      this._stopAnts();
    }
    // marching-ants animation: emit overlayrender ~12fps while there's something
    // to animate; auto-stops when nothing is selected.
    _startAnts(app) {
      if (this._antsTimer) return;
      this._antsTimer = setInterval(() => {
        if (this.mode === 'lasso' || this.vsel.length || this.raster)
          app.emit('overlayrender');
        else this._stopAnts();
      }, 70);
    }
    _stopAnts() {
      if (this._antsTimer) { clearInterval(this._antsTimer); this._antsTimer = null; }
    }

    pointerDown(pt, e, app) {
      const layer = app.activeLayer();
      this.layerKind = layer ? layer.type : null;
      if (this.layerKind === 'vector') {
        if (this.vsel.length && this.vcel && this._inVBounds(pt, app)) {
          this.mode = 'vmove';
          this.before = this.vcel.snapshot();
          this.last = { x: pt.x, y: pt.y };
          this.moved = false;
          return;
        }
        this.vsel = [];
      } else if (this.layerKind === 'drawing') {
        if (this.raster) {
          const r = this.raster;
          const local = layerLocal(pt, r.layer, r.frame, app);
          // First drag on an unlifted selection: lift now so handles + bbox
          // are available
          if (!r.lifted) {
            // unlifted: check if click was inside the polygon bbox
            if (local.x >= r.x && local.x <= r.x + r.w &&
                local.y >= r.y && local.y <= r.y + r.h) {
              this._liftRaster(app);
            } else {
              this._commitRaster(app);   // click outside -- drop selection
            }
          }
          // After (possible) lift, check transform handles
          if (this.raster && this.raster.lifted) {
            const rl = this.raster;
            const zoom = app.stage.view.zoom;
            const thr = 9 / zoom;
            // rotation knob
            const rh = selRotHandleWorld(rl, zoom);
            if (U.dist(local.x, local.y, rh.x, rh.y) < thr) {
              this.mode = 'rrotate';
              this.startRot = rl.rot;
              this.startAng = Math.atan2(local.y - rl.cy, local.x - rl.cx);
              return;
            }
            // 8 scale handles
            for (let i = 0; i < 8; i++) {
              const a = selAnchor(i, rl.sw, rl.sh);
              const w = selWorld(rl, a.x, a.y);
              if (U.dist(local.x, local.y, w.x, w.y) < thr) {
                this.mode = 'rscale';
                this.hIdx = i;
                const opp = selAnchor((i + 4) % 8, rl.sw, rl.sh);
                this.fixed = selWorld(rl, opp.x, opp.y);
                this.oppA = opp; this.hA = a;
                return;
              }
            }
            // inside the transformed bbox -- translate
            const loc = selLocal(rl, local.x, local.y);
            if (Math.abs(loc.x) <= rl.sw / 2 && Math.abs(loc.y) <= rl.sh / 2) {
              this.mode = 'rmove';
              this.moveOff = { x: local.x - rl.cx, y: local.y - rl.cy };
              return;
            }
            // clicked outside the floating piece -- commit and start a new lasso
            this._commitRaster(app);
          }
        }
      } else {
        app.ui.status('The lasso works on drawing layers');
        this.mode = 'idle';
        return;
      }
      this.mode = 'lasso';
      this.poly = [{ x: pt.x, y: pt.y }];
      this._startAnts(app);
      app.emit('overlayrender');
    }
    pointerMove(pt, e, app) {
      if (this.mode === 'lasso') {
        const last = this.poly[this.poly.length - 1];
        // tighter screen-space threshold (was 1.6) -- captures pen samples
        // more densely so the polygon hugs the user's drawn path
        const zoom = (app.stage && app.stage.view && app.stage.view.zoom) || 1;
        const thr = 1.0 / zoom;
        if (U.dist(last.x, last.y, pt.x, pt.y) > thr) this.poly.push({ x: pt.x, y: pt.y });
        app.emit('overlayrender');
      } else if (this.mode === 'vmove') {
        const dx = pt.x - this.last.x, dy = pt.y - this.last.y;
        this.last = { x: pt.x, y: pt.y };
        if (dx || dy) this.moved = true;
        // delta is in project-space; convert to cel-local if the layer
        // has a rotation/scale transform so strokes move with the cursor
        // rather than at a confusing offset
        const layer = app.activeLayer();
        const ld = layerLocalDelta(dx, dy, layer, app.frame);
        for (const st of this.vsel) {
          if (st.type === 'fill')
            st.contour = st.contour.map(p => ({ x: p.x + ld.dx, y: p.y + ld.dy }));
          else
            st.pts = st.pts.map(p => ({ x: p.x + ld.dx, y: p.y + ld.dy, p: p.p }));
        }
        // RAF-debounce the heavy rebuild + render. Without this, a vector cel
        // with many strokes lags noticeably while dragging a selection.
        this._scheduleVMove(app);
        app.emit('overlayrender');
      } else if (this.mode === 'rmove') {
        // translate the lifted piece in cel-local space (so the layer's own
        // rotation/scale doesn't fight the cursor)
        const r = this.raster;
        const local = layerLocal(pt, r.layer, r.frame, app);
        r.cx = local.x - this.moveOff.x;
        r.cy = local.y - this.moveOff.y;
        app.emit('render'); app.emit('overlayrender');
      } else if (this.mode === 'rrotate') {
        const r = this.raster;
        const local = layerLocal(pt, r.layer, r.frame, app);
        const ang = Math.atan2(local.y - r.cy, local.x - r.cx);
        r.rot = this.startRot + (ang - this.startAng);
        if (e && e.shiftKey) r.rot = Math.round(r.rot / (Math.PI / 12)) * (Math.PI / 12);
        app.emit('render'); app.emit('overlayrender');
      } else if (this.mode === 'rscale') {
        // Drag a scale handle: keep the opposite corner fixed, derive new
        // scale factors by projecting the cursor into the selection's local
        // frame. Shift-drag = uniform scale (preserve aspect ratio).
        const r = this.raster;
        const local = layerLocal(pt, r.layer, r.frame, app);
        const dxA = this.hA.x - this.oppA.x, dyA = this.hA.y - this.oppA.y;
        const c = Math.cos(-r.rot), sn = Math.sin(-r.rot);
        const vx = (local.x - this.fixed.x) * c - (local.y - this.fixed.y) * sn;
        const vy = (local.x - this.fixed.x) * sn + (local.y - this.fixed.y) * c;
        let nsx = dxA !== 0 ? vx / dxA : r.scaleX;
        let nsy = dyA !== 0 ? vy / dyA : r.scaleY;
        if (e && e.shiftKey && dxA !== 0 && dyA !== 0) {
          const m = Math.max(Math.abs(nsx), Math.abs(nsy));
          nsx = Math.sign(nsx) * m; nsy = Math.sign(nsy) * m;
        }
        if (Math.abs(nsx) < 0.01) nsx = 0.01 * Math.sign(nsx || 1);
        if (Math.abs(nsy) < 0.01) nsy = 0.01 * Math.sign(nsy || 1);
        r.scaleX = nsx; r.scaleY = nsy;
        const rc = Math.cos(r.rot), rs = Math.sin(r.rot);
        const ox = -this.oppA.x * nsx, oy = -this.oppA.y * nsy;
        r.cx = this.fixed.x + ox * rc - oy * rs;
        r.cy = this.fixed.y + ox * rs + oy * rc;
        app.emit('render'); app.emit('overlayrender');
      }
    }
    _scheduleVMove(app) {
      if (this._vmoveRAF) return;
      this._vmoveRAF = requestAnimationFrame(() => {
        this._vmoveRAF = 0;
        if (this.vcel) { this.vcel.rebuild(); app.emit('render'); }
      });
    }
    _flushVMove(app) {
      if (this._vmoveRAF) { cancelAnimationFrame(this._vmoveRAF); this._vmoveRAF = 0; }
      if (this.vcel) { this.vcel.rebuild(); app.emit('render'); }
    }
    pointerUp(pt, e, app) {
      if (this.mode === 'lasso') {
        if (this.poly && this.poly.length >= 3) {
          if (this.layerKind === 'vector') this._lassoVector(app);
          else this._lassoRaster(app);
        }
        this.poly = null;
      } else if (this.mode === 'vmove') {
        this._flushVMove(app);
        if (this.moved) {
          app.history.pushCelEdit('Move strokes', this.vcel, this.before);
          app.emit('celchange');
        }
      }
      // rmove / rrotate / rscale leave the raster selection alive so the
      // artist can chain transformations -- they only commit on click-outside,
      // tool change, or Enter/Esc.
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
    // A stroke is inside the lasso if any of its sample points is inside the
    // polygon (a long horizontal stroke whose centroid sits outside the loop
    // but whose body crosses through it would otherwise never be picked).
    _strokeInLasso(st, poly) {
      const pts = st.type === 'fill' ? st.contour : st.pts;
      if (!pts || !pts.length) return false;
      for (const p of pts) if (pointInPoly(p.x, p.y, poly)) return true;
      return false;
    }
    _lassoVector(app) {
      const layer = app.activeLayer();
      const cel = layer.celAt(app.frame);
      if (!cel) { app.ui.status('Nothing on this frame to select'); return; }
      this.vcel = cel;
      // convert the project-space polygon into cel-local space so it lines
      // up with the strokes (whose points are stored cel-local) on a layer
      // that has a transform applied
      const localPoly = this.poly.map(p => layerLocal(p, layer, app.frame, app));
      const sel = [];
      for (const st of cel.strokes) {
        if (this._strokeInLasso(st, localPoly)) sel.push(st);
      }
      this.vsel = sel;
      if (sel.length) this._startAnts(app);
      app.ui.status(sel.length
        ? 'Lassoed ' + sel.length + ' stroke' + (sel.length === 1 ? '' : 's') + ' — drag to move'
        : 'No strokes inside the lasso');
    }
    _lassoRaster(app) {
      const layer = app.activeLayer();
      if (layer.locked) { app.ui.status('Layer is locked'); return; }
      // Lasso lifts pixels destructively, so fork held exposure runs to
      // prevent the lift from mutating every frame that shares this cel.
      const cel = (typeof layer.forkAt === 'function')
        ? layer.forkAt(app.frame)
        : layer.celAt(app.frame);
      if (!cel) { app.ui.status('Nothing on this frame'); return; }
      if (cel.forked) {
        cel.forked = false;
        app.ui.status('Made unique: Drawing ' + cel.num);
      }
      // bring the polygon into cel-local space so it matches the cel's
      // pixel grid on layers with a transform applied
      const localPoly = this.poly.map(p => layerLocal(p, layer, app.frame, app));
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const p of localPoly) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      x0 = U.clamp(Math.floor(x0), 0, cel.w); y0 = U.clamp(Math.floor(y0), 0, cel.h);
      x1 = U.clamp(Math.ceil(x1), 0, cel.w); y1 = U.clamp(Math.ceil(y1), 0, cel.h);
      const w = x1 - x0, h = y1 - y0;
      if (w < 2 || h < 2) return;
      // Do NOT lift pixels yet. The user often just wants a marquee-style
      // selection (e.g. to delete it). Lifting on close is destructive --
      // every Esc-ed selection would otherwise leave a hole on the cel.
      // Lifting is deferred to the first actual drag (see `_liftRaster`).
      this.raster = {
        canvas: null, lifted: false,
        poly: localPoly, layer: layer, frame: app.frame,
        x: x0, y: y0, w: w, h: h, cel: cel, before: null
      };
      this._startAnts(app);
      app.ui.status('Lassoed a region — drag to move it, Del to remove, Esc to deselect');
    }
    // Lift pixels off the cel into a floating canvas. Called lazily the first
    // time the user actually drags the lasso catch, so a quick lasso-and-Esc
    // (or lasso-and-Del) never modifies the cel.
    _liftRaster(app) {
      const r = this.raster;
      if (!r || r.lifted) return;
      const cel = r.cel;
      const before = cel.snapshot();
      const poly = r.poly;
      const x0 = r.x, y0 = r.y, w = r.w, h = r.h;
      const trace = ctx => {
        ctx.beginPath();
        ctx.moveTo(poly[0].x - x0, poly[0].y - y0);
        for (let i = 1; i < poly.length; i++)
          ctx.lineTo(poly[i].x - x0, poly[i].y - y0);
        ctx.closePath();
      };
      const fc = document.createElement('canvas');
      fc.width = w; fc.height = h;
      const fx = fc.getContext('2d');
      fx.save(); trace(fx); fx.clip();
      fx.drawImage(cel.canvas, -x0, -y0);
      fx.restore();
      const ctx = cel.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.clip();
      ctx.clearRect(0, 0, cel.w, cel.h);
      ctx.restore();
      cel.dirty();
      r.canvas = fc;
      r.before = before;
      r.lifted = true;
      // Initialise free-transform state on the lifted piece so the user
      // can scale / rotate / move it via handles. cx/cy is the centre,
      // sw/sh are the canvas-pixel dimensions, scaleX/scaleY and rot
      // accumulate as the user drags handles.
      r.sw = w; r.sh = h;
      r.cx = x0 + w / 2; r.cy = y0 + h / 2;
      r.scaleX = 1; r.scaleY = 1; r.rot = 0;
      app.emit('render');
    }
    _commitRaster(app) {
      const r = this.raster;
      if (!r) return;
      this.raster = null;
      // Nothing was actually lifted (user lassoed then bailed out) -- nothing
      // to commit and no history entry to push.
      if (!r.lifted || !r.canvas) return;
      const ctx = r.cel.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      // apply the accumulated transform (translate + rotate + scale) when
      // baking the floating piece back into the cel, so squash/stretch/
      // rotate edits persist
      ctx.translate(r.cx, r.cy);
      ctx.rotate(r.rot || 0);
      ctx.scale(r.scaleX || 1, r.scaleY || 1);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(r.canvas, -r.sw / 2, -r.sh / 2);
      ctx.restore();
      r.cel.dirty();
      app.history.pushCelEdit('Transform selection', r.cel, r.before);
      app.emit('render'); app.emit('celchange');
    }
    _inVBounds(pt, app) {
      if (!this.vsel.length) return false;
      // bounds are in cel-local space; pointer comes in project-space
      const local = app
        ? layerLocal(pt, app.activeLayer(), app.frame, app)
        : pt;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const st of this.vsel) {
        const b = V().strokeBounds(st);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
      }
      return local.x >= x0 && local.x <= x1 && local.y >= y0 && local.y <= y1;
    }
    _inRasterBounds(pt, app) {
      const r = this.raster;
      if (!r) return false;
      const local = app && r.layer
        ? layerLocal(pt, r.layer, r.frame, app)
        : pt;
      if (r.lifted) {
        // transformed bbox: project into the selection's local frame
        const loc = selLocal(r, local.x, local.y);
        return Math.abs(loc.x) <= r.sw / 2 && Math.abs(loc.y) <= r.sh / 2;
      }
      // unlifted: still the original polygon bbox
      return local.x >= r.x && local.x <= r.x + r.w &&
             local.y >= r.y && local.y <= r.y + r.h;
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
        const r = this.raster;
        this.raster = null;
        if (r.lifted) {
          // Region was already cleared from the cel when lifted; just commit
          // history so undo can restore it.
          r.cel.dirty();
          app.history.pushCelEdit('Delete selection', r.cel, r.before);
        } else {
          // Not yet lifted -- delete what's inside the lasso polygon now.
          const cel = r.cel;
          const before = cel.snapshot();
          const ctx = cel.ctx;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(r.poly[0].x, r.poly[0].y);
          for (let i = 1; i < r.poly.length; i++) ctx.lineTo(r.poly[i].x, r.poly[i].y);
          ctx.closePath();
          ctx.clip();
          ctx.clearRect(0, 0, cel.w, cel.h);
          ctx.restore();
          cel.dirty();
          app.history.pushCelEdit('Delete selection', cel, before);
        }
        app.emit('render'); app.emit('celchange');
        return true;
      }
      return false;
    }
    // Esc -> drop the selection, restoring lifted pixels.
    cancel(app) {
      if (this.raster) {
        // Only restore the cel if pixels were actually lifted from it. An
        // un-lifted lasso never modified anything, so Esc is purely a
        // deselect.
        if (this.raster.lifted && this.raster.before) {
          this.raster.cel.restore(this.raster.before);
          app.emit('celchange');
        }
        this.raster = null;
        app.emit('render');
      }
      this.vsel = []; this.vcel = null;
      app.emit('overlayrender');
    }
    hasSelection() { return this.vsel.length > 0 || !!this.raster; }

    // classic marching-ants outline: thick dark base + thin white dashed top
    // with an offset that animates over time. Works on any background.
    _ants(ctx, zoom, tracePath) {
      const t = performance.now() / 60;
      const dash = 6 / zoom, gap = 4 / zoom;
      // dark backing — fully visible on light artwork
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.lineWidth = 2.6 / zoom;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      tracePath();
      ctx.stroke();
      // bright dashed top — visible on dark artwork; phase-offset so it marches
      ctx.lineWidth = 1.6 / zoom;
      ctx.setLineDash([dash, gap]);
      ctx.lineDashOffset = -t;
      ctx.strokeStyle = '#fff';
      tracePath();
      ctx.stroke();
      ctx.restore();
    }
    drawOverlay(ctx, app) {
      const zoom = app.stage.view.zoom;
      if (this.mode === 'lasso' && this.poly && this.poly.length) {
        const poly = this.poly, n = poly.length;
        // Open-path trace (no closePath): matches the Photoshop lasso look,
        // where the user sees only the line they've actually drawn, with no
        // ghost line snapping back to the start point. Canvas `fill()`
        // closes the path implicitly for the translucent area, so we still
        // get a region tint without a visible closing stroke.
        const tracePath = () => {
          ctx.beginPath();
          ctx.moveTo(poly[0].x, poly[0].y);
          for (let i = 1; i < n; i++) ctx.lineTo(poly[i].x, poly[i].y);
        };
        // translucent tint inside the loop so you can see what you're enclosing
        if (n > 2) {
          ctx.save();
          tracePath();
          ctx.fillStyle = 'rgba(74,159,212,0.18)';
          ctx.fill('evenodd');
          ctx.restore();
        }
        this._ants(ctx, zoom, tracePath);
        // start-point pip — shows where the loop will close back to
        const s = poly[0], r = 4 / zoom;
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.2 / zoom;
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 7); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      if (this.vsel && this.vsel.length) {
        // bounding box around each selected stroke, with marching ants.
        // Strokes are stored in cel-local coords; apply the layer's
        // transform so the bbox visually wraps the rendered artwork.
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const st of this.vsel) {
          const b = V().strokeBounds(st);
          x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
          x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
        }
        const pad = 4 / zoom;
        const trace = () => {
          ctx.beginPath();
          ctx.rect(x0 - pad, y0 - pad, (x1 - x0) + pad * 2, (y1 - y0) + pad * 2);
        };
        ctx.save();
        applyLayerXform(ctx, app.activeLayer(), app.frame, app);
        this._ants(ctx, zoom, trace);
        ctx.restore();
      }
      if (this.raster) {
        const r = this.raster;
        // raster bounds + canvas live in cel-local space -- apply the layer
        // transform so the overlay tracks the cursor on transformed layers
        ctx.save();
        applyLayerXform(ctx, r.layer || app.activeLayer(), r.frame != null ? r.frame : app.frame, app);
        if (r.lifted && r.canvas) {
          // Draw the floating piece through the accumulated transform so
          // the user sees the squash / stretch / rotate in real time.
          ctx.save();
          ctx.globalAlpha = 0.95;
          ctx.imageSmoothingEnabled = true;
          ctx.translate(r.cx, r.cy);
          ctx.rotate(r.rot || 0);
          ctx.scale(r.scaleX || 1, r.scaleY || 1);
          ctx.drawImage(r.canvas, -r.sw / 2, -r.sh / 2);
          ctx.restore();
        }
        if (r.lifted) {
          // Transformed bbox outline + 8 scale handles + rotation knob.
          const corners = [0, 2, 4, 6].map(i => {
            const a = selAnchor(i, r.sw, r.sh);
            return selWorld(r, a.x, a.y);
          });
          const trace = () => {
            ctx.beginPath();
            ctx.moveTo(corners[0].x, corners[0].y);
            for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
            ctx.closePath();
          };
          this._ants(ctx, zoom, trace);
          // rotation knob + connecting stem
          const tc = selWorld(r, 0, -r.sh / 2);
          const rh = selRotHandleWorld(r, zoom);
          ctx.save();
          ctx.lineWidth = 1.4 / zoom;
          ctx.strokeStyle = '#4a9fd4';
          ctx.beginPath(); ctx.moveTo(tc.x, tc.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
          // 8 square handles
          const hs = 4 / zoom;
          ctx.fillStyle = '#fff';
          for (let i = 0; i < 8; i++) {
            const a = selAnchor(i, r.sw, r.sh);
            const w = selWorld(r, a.x, a.y);
            ctx.beginPath(); ctx.rect(w.x - hs, w.y - hs, hs * 2, hs * 2);
            ctx.fill(); ctx.stroke();
          }
          // rotation knob (circle)
          ctx.beginPath(); ctx.arc(rh.x, rh.y, hs, 0, 7); ctx.fill(); ctx.stroke();
          ctx.restore();
        } else if (r.poly) {
          // unlifted: still showing the lassoed polygon outline
          const trace = () => {
            ctx.beginPath();
            ctx.moveTo(r.poly[0].x, r.poly[0].y);
            for (let i = 1; i < r.poly.length; i++) ctx.lineTo(r.poly[i].x, r.poly[i].y);
            ctx.closePath();
          };
          this._ants(ctx, zoom, trace);
        }
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
