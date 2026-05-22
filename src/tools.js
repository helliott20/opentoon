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

  // One Euro filter (Casiez / Roussel / Vogel, CHI 2012) -- the modern
  // industry default for low-latency stylus smoothing. Unlike the older
  // lazy-pointer rope (fixed-radius lag), the cutoff frequency is adaptive:
  // at low speeds the cutoff drops, killing tablet jitter; at high speeds
  // the cutoff rises so the filter barely lags the cursor at all. Result:
  // shaky-line strokes stay clean AND fast confident strokes stay snappy.
  //
  //   alpha(cutoff, dt) = 1 / (1 + 1/(2*pi*cutoff*dt))
  //   lowpass(x, alpha, prev) = alpha*x + (1-alpha)*prev
  //   cutoff = mincutoff + beta * |speed_smoothed|
  //
  // One instance per axis (x, y, pressure) since each tracks its own
  // history. The filter is parameterised at construction or via setParams.
  class OneEuroFilter {
    constructor(mincutoff, beta, dcutoff) {
      this.mincutoff = mincutoff != null ? mincutoff : 1.0;
      this.beta = beta != null ? beta : 0.0;
      this.dcutoff = dcutoff != null ? dcutoff : 1.0;
      this.xPrev = null; this.dxPrev = 0; this.tPrev = null;
    }
    setParams(mincutoff, beta, dcutoff) {
      this.mincutoff = mincutoff;
      this.beta = beta;
      if (dcutoff != null) this.dcutoff = dcutoff;
    }
    reset(x, t) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = t;
    }
    _alpha(cutoff, dt) {
      const tau = 1.0 / (2 * Math.PI * cutoff);
      return 1.0 / (1.0 + tau / dt);
    }
    filter(x, t) {
      if (this.xPrev == null || this.tPrev == null) {
        this.xPrev = x; this.tPrev = t; this.dxPrev = 0;
        return x;
      }
      // Clamp dt to a sane minimum so a duplicate-timestamp event (dt = 0)
      // doesn't blow up the alpha calculation. 0.5 ms is below any real
      // tablet rate, so this only affects pathological cases.
      let dt = t - this.tPrev;
      if (!(dt > 0)) dt = 0.016;
      if (dt < 0.0005) dt = 0.0005;
      const dxRaw = (x - this.xPrev) / dt;
      const aD = this._alpha(this.dcutoff, dt);
      const dxSmoothed = aD * dxRaw + (1 - aD) * this.dxPrev;
      const cutoff = this.mincutoff + this.beta * Math.abs(dxSmoothed);
      const aX = this._alpha(cutoff, dt);
      const xSmoothed = aX * x + (1 - aX) * this.xPrev;
      this.xPrev = xSmoothed;
      this.dxPrev = dxSmoothed;
      this.tPrev = t;
      return xSmoothed;
    }
  }

  // Map [0..1] smoothing slider to One Euro params.
  //   mincutoff (Hz) -- lower = more smoothing at rest
  //   beta           -- higher = less lag on fast moves
  function oneEuroParams(smooth) {
    const s = smooth || 0;
    const mincutoff = U.lerp(2.0, 0.3, s);
    const beta = U.lerp(0.05, 0.005, s);
    return { mincutoff: mincutoff, beta: beta, dcutoff: 1.0 };
  }
  // Expose for testing.
  OT.OneEuroFilter = OneEuroFilter;
  OT.oneEuroParams = oneEuroParams;

  // Shared lifecycle helpers for tools that smooth (x, y, pressure) through
  // a One Euro filter per axis. The tool owns _oneEuroX / _oneEuroY /
  // _oneEuroP fields and a `smooth` number in [0, 1].
  function initOneEuro(tool, pt) {
    const t = performance.now() / 1000;
    const params = oneEuroParams(tool.smooth);
    tool._oneEuroX = new OneEuroFilter(params.mincutoff, params.beta, params.dcutoff);
    tool._oneEuroY = new OneEuroFilter(params.mincutoff, params.beta, params.dcutoff);
    tool._oneEuroP = new OneEuroFilter(params.mincutoff, params.beta, params.dcutoff);
    tool._oneEuroX.reset(pt.x, t);
    tool._oneEuroY.reset(pt.y, t);
    tool._oneEuroP.reset(pt.pressure != null ? pt.pressure : 1, t);
  }
  // Apply current smoothing params to all three axis filters. Called every
  // move so a slider tweak mid-stroke takes effect immediately.
  function applyOneEuro(tool, pt) {
    const t = performance.now() / 1000;
    const params = oneEuroParams(tool.smooth);
    tool._oneEuroX.setParams(params.mincutoff, params.beta, params.dcutoff);
    tool._oneEuroY.setParams(params.mincutoff, params.beta, params.dcutoff);
    tool._oneEuroP.setParams(params.mincutoff, params.beta, params.dcutoff);
    const sx = tool._oneEuroX.filter(pt.x, t);
    const sy = tool._oneEuroY.filter(pt.y, t);
    const sp = tool._oneEuroP.filter(pt.pressure != null ? pt.pressure : 1, t);
    return { x: sx, y: sy, p: sp };
  }

  // (Ink-pen velocity dynamics now lives in OT.StrokeFinalize.applyInkDynamics
  // — see src/stroke-finalize.js. Pen window and main both call it via
  // OT.StrokeFinalize.finalize() so wet preview matches commit.)

  // Detect a Procreate-style "hold at end" gesture. Walks back from the last
  // sample looking for the earliest point that's still within `holdPx` of the
  // final position; if that point is at least `holdMs` older than `now`, we
  // treat the trailing run as a hold and return its starting index. Passing
  // an explicit `now` lets a fallback timer detect holds even when no new
  // pointer events have fired (a stopped mouse stops firing events entirely;
  // the dwell needs to count wallclock time, not raw[n-1].t which is frozen).
  // Returns -1 when no hold is detected (insufficient dwell or no timestamps).
  function detectHold(raw, holdMs, holdPx, now) {
    const n = raw ? raw.length : 0;
    if (n < 3) return -1;
    const end = raw[n - 1];
    if (end.t == null) return -1;
    // Walk back to the earliest point that is still within holdPx of the
    // current position. This forms the "cluster" at the end of the stroke.
    let i = n - 1;
    while (i > 0) {
      const p = raw[i - 1];
      if (p.t == null) break;
      if (Math.hypot(p.x - end.x, p.y - end.y) > holdPx) break;
      i--;
    }
    if (i <= 1) return -1;   // whole stroke clustered — probably a dot, ignore
    // Find when the cursor really STOPPED. The naive "first sample in the
    // cluster" timestamp includes the deceleration phase — the user perceives
    // they only started holding once their pen stopped, but the cluster has
    // already swallowed several hundred milliseconds of slow-down. Walk
    // forward through the cluster looking for the first sample where the
    // velocity to its predecessor drops below ~80 project-px/second. From
    // that sample onwards, the cursor is genuinely held.
    const STOP_SPEED = 0.08;  // project px per ms (= 80 px/s)
    let stopT = raw[i].t;
    for (let k = i + 1; k < n; k++) {
      const a = raw[k - 1], b = raw[k];
      const dt = Math.max(1, b.t - a.t);
      const sp = Math.hypot(b.x - a.x, b.y - a.y) / dt;
      if (sp < STOP_SPEED) { stopT = b.t; break; }
    }
    // Dwell is measured against wallclock NOW (a stopped mouse stops firing
    // events entirely, so end.t freezes; we still need the dwell to grow).
    const endTime = (now != null && now > end.t) ? now : end.t;
    const dwell = endTime - stopT;
    if (dwell < holdMs) return -1;
    return i;
  }
  OT.detectHold = detectHold;

  // Resample a polyline to exactly N points evenly along its arc length.
  // For `closed`, the closing segment is included and the N samples cover
  // [0, L) (no duplicate at end). For open, samples cover [0, L] inclusive
  // so the first and last points sit on the original endpoints.
  function resampleByArcLength(pts, N, closed) {
    const m = pts.length;
    if (m === 0) return Array.from({ length: N }, () => ({ x: 0, y: 0 }));
    if (m === 1) {
      const p = pts[0];
      return Array.from({ length: N }, () => ({ x: p.x, y: p.y }));
    }
    const path = closed ? pts.concat([pts[0]]) : pts;
    const cum = [0];
    let L = 0;
    for (let i = 1; i < path.length; i++) {
      L += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      cum.push(L);
    }
    if (L === 0) {
      return Array.from({ length: N }, () => ({ x: path[0].x, y: path[0].y }));
    }
    const out = new Array(N);
    for (let k = 0; k < N; k++) {
      const s = closed ? (k / N) * L : (k / (N - 1)) * L;
      // Find the segment containing arc length s
      let j = 0;
      while (j < cum.length - 1 && cum[j + 1] < s) j++;
      const segL = cum[j + 1] - cum[j];
      const t = segL > 0 ? (s - cum[j]) / segL : 0;
      out[k] = {
        x: path[j].x + (path[j + 1].x - path[j].x) * t,
        y: path[j].y + (path[j + 1].y - path[j].y) * t
      };
    }
    return out;
  }
  OT.resampleByArcLength = resampleByArcLength;

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
      this._liveTip = null;
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
      if (this._stopSnapLoop) this._stopSnapLoop();
      this._oneEuroX = this._oneEuroY = this._oneEuroP = null;
      this.changed = false;
      app.emit('render');
    }

    // Predicted pointer samples (from PointerEvent.getPredictedEvents).
    // These are transient -- they live only in the overlay so the live
    // preview reaches AHEAD of the real cursor, hiding ~16 ms of display
    // latency. Predicted points must NEVER be added to this.raw because
    // they can diverge from the real path. ToolManager.setPredicted maps
    // the points into cel-local space before forwarding to us.
    setPredicted(pts) {
      if (!this.t || !this.vec) { this._predictedPts = null; return; }
      this._predictedPts = (pts && pts.length) ? pts : null;
    }

    /* ---- raster ---- */
    _rDown(pt) {
      const cel = this.t.cel;
      this.buf = document.createElement('canvas');
      this.buf.width = cel.w; this.buf.height = cel.h;
      this.bctx = this.buf.getContext('2d');
      this.sm = { x: pt.x, y: pt.y };
      this.last = { x: pt.x, y: pt.y, p: pt.pressure };
      this._initOneEuro(pt);
      this._predictedPts = null;
      this._dot(pt.x, pt.y, pt.pressure);
      this._rComposite();
    }
    // Allocate the per-stroke One Euro filters (one per axis: x, y, pressure)
    // and prime them with the pointer-down sample so the first smoothed point
    // is exactly the touch-down point rather than 0.
    _initOneEuro(pt) { initOneEuro(this, pt); }
    _applyOneEuro(pt) { return applyOneEuro(this, pt); }
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
      // One Euro filter: adaptive cutoff smooths jitter at low speeds but
      // tracks fast moves with minimal lag (vs. the old fixed-radius rope,
      // which lagged the cursor the same amount no matter how fast). Slider
      // controls mincutoff / beta -- see oneEuroParams.
      const sm = this._applyOneEuro(pt);
      this.sm.x = sm.x; this.sm.y = sm.y;
      this._seg(this.last.x, this.last.y, this.last.p, this.sm.x, this.sm.y, sm.p);
      this.last = { x: this.sm.x, y: this.sm.y, p: sm.p };
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
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
      if (this._stopSnapLoop) this._stopSnapLoop();
      this._oneEuroX = this._oneEuroY = this._oneEuroP = null;
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
        if (!this.t) return;
        // Shape-snap detection lives in _startSnapLoop's RAF, not here, so
        // detection runs even when the mouse is fully stopped.
        if (this.vec) {
          this._computePreview(app);
          app.emit('overlayrender');
        }
        else app.emit('render');
      });
    }
    // Compute the would-commit pts from this.raw via OT.StrokeFinalize.
    // Cached as this._previewPts; drawOverlay renders this instead of
    // this.raw. Called per rAF from _rafEmit and once more at _vUp so
    // the committed pts equals the last preview pts.
    _computePreview(app) {
      if (!this.raw || !this.raw.length || !this.t) {
        this._previewPts = null;
        this._previewClosed = false;
        return;
      }
      // Skip while shape-snap animation is running -- the snap preview
      // owns drawOverlay during the morph, see drawOverlay for the snap
      // branch.
      if (this._snapAnim || this._snapPreview) return;
      // Append _liveTip so finalize sees the same input shape _vUp will:
      // _vUp pushes the actual release point onto this.raw BEFORE
      // finalizing (tools.js: this.raw.push({x:pt.x, y:pt.y, ...})).
      // Without this here, wet preview only sees the One-Euro-smoothed
      // rope (~13 px behind cursor) while commit sees an extra point at
      // the cursor -- producing the visible "shift on release" the user
      // experienced. Concatenating _liveTip both makes the wet preview
      // reach the cursor AND eliminates the geometric diff on commit.
      let raw = this.raw;
      if (this._liveTip && !this.straight) {
        const tail = raw[raw.length - 1];
        if (tail.x !== this._liveTip.x || tail.y !== this._liveTip.y) {
          raw = raw.concat([{
            x: this._liveTip.x, y: this._liveTip.y,
            p: this._liveTip.p, t: performance.now()
          }]);
        }
      }
      const tol = 0.4 + (this.smooth || 0) * 0.8;
      const fin = OT.StrokeFinalize.finalize(raw, {
        tol,
        snapDist: app.settings.snapDist || 0,
        inkDynamics: !!app.settings.inkDynamics,
        autoClose: !!(app.settings && app.settings.autoClose),
        cel: this.t.cel
      });
      this._previewPts = fin.pts;
      this._previewClosed = fin.closed;
    }
    // Live preview of the in-progress vector brush stroke, rendered on the
    // overlay so it stays crisp at any zoom (the alternative — stamping
    // into cel.canvas and using the cache fallback — pixelated the entire
    // cel whenever the user zoomed in).
    drawOverlay(ctx, app) {
      if (!this.t || !this.vec || this.mode === 'eraser') return;
      if (!this.raw || this.raw.length < 1) return;
      ctx.save();
      applyLayerXform(ctx, this.t.layer, app.frame, app);
      // Snap-in-progress: interpolate from the freehand resampled path to
      // the snapped resampled path with smoothstep easing, so the rough
      // drawing morphs smoothly into the clean shape (Procreate-style
      // QuickShape transition).
      if (this._snapAnim) {
        const now = performance.now();
        const t = Math.min(1, (now - this._snapAnim.start) / this._snapAnim.duration);
        const eased = t * t * (3 - 2 * t);
        const from = this._snapAnim.fromPts, to = this._snapAnim.toPts;
        const pts = new Array(from.length);
        for (let i = 0; i < from.length; i++) {
          pts[i] = {
            x: from[i].x + (to[i].x - from[i].x) * eased,
            y: from[i].y + (to[i].y - from[i].y) * eased
          };
        }
        const snapStroke = {
          type: 'line', pencil: false, sharp: true, taper: false,
          color: this.color, width: this.size, opacity: this.opacity,
          pts: pts, closed: this._snapAnim.closed
        };
        V().renderStroke(ctx, snapStroke);
        ctx.restore();
        if (t >= 1) this._snapAnim = null;
        return;
      }
      // Animation finished — render the final snapped geometry directly.
      if (this._snapPreview) {
        const snapStroke = {
          type: 'line', pencil: false, sharp: true, taper: false,
          color: this.color, width: this.size, opacity: this.opacity,
          pts: this._snapPreview.pts, closed: this._snapPreview.closed
        };
        V().renderStroke(ctx, snapStroke);
        ctx.restore();
        return;
      }
      // Render the FINALIZE output (= the would-commit pts), not this.raw.
      // The finalize pipeline runs per rAF in _computePreview, so what the
      // artist sees is exactly what _vUp will push to cel.strokes. The
      // _liveTip workaround is no longer needed -- finalize-per-frame
      // keeps the preview within ~one frame of the cursor.
      const pts = this._previewPts;
      if (!pts || pts.length === 0) { ctx.restore(); return; }
      const stroke = {
        type: 'line', pencil: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: this._previewClosed
      };
      V().renderStroke(ctx, stroke);
      ctx.restore();
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
      const t0 = performance.now();
      this.raw = [{ x: pt.x, y: pt.y, p: pt.pressure, t: t0 }];
      // _previewPts is the finalize output for the current in-progress
      // stroke, recomputed per rAF in _vMove. drawOverlay renders this
      // (NOT this.raw) so the wet line equals what will commit.
      this._previewPts = null;
      this._previewClosed = false;
      this.sm = { x: pt.x, y: pt.y };
      this.lastStamp = { x: pt.x, y: pt.y, p: pt.pressure };
      this._initOneEuro(pt);
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
      this._startSnapLoop(app);
      // Live preview is rendered via the overlay (vector path = crisp at any
      // zoom). The cel cache stays untouched until commit, so committed
      // strokes also stay crisp via compositeStage's direct-from-strokes
      // path. Stamping into cel.canvas previously made everything pixelate
      // at zoom > 1 because the cache had to be upscaled.
      app.emit('overlayrender');
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
        // straight line. The overlay renders this two-point line as a
        // vector path each frame — no cel.canvas stamping, no rebuilds.
        this.sm.x = pt.x; this.sm.y = pt.y;
        this.raw = [
          { x: this.startPt.x, y: this.startPt.y, p: this.startPt.p },
          { x: pt.x, y: pt.y, p: pt.pressure }
        ];
        this.lastStamp = { x: pt.x, y: pt.y, p: pt.pressure };
        this._rafEmit(app);
        return;
      }
      // One Euro filter smoothing (see _rMove). Adaptive cutoff: low at rest
      // for jitter rejection, high during fast moves for low lag.
      const sm = this._applyOneEuro(pt);
      this.sm.x = sm.x; this.sm.y = sm.y;
      this.raw.push({ x: this.sm.x, y: this.sm.y, p: sm.p, t: performance.now() });
      this.lastStamp = { x: this.sm.x, y: this.sm.y, p: sm.p };
      // Track the true cursor for the line-snap drag-to-refine path
      // (see _startSnapLoop): once a line snaps, pts[1] tracks _liveTip
      // so the snapped line follows the cursor instead of running snap
      // detection again. (drawOverlay no longer needs _liveTip now that
      // finalize runs per rAF and the preview reaches the cursor on its
      // own.)
      this._liveTip = { x: pt.x, y: pt.y, p: pt.pressure };
      // No cel.canvas stamping — drawOverlay renders the live stroke as a
      // proper vector path on the overlay each frame, which stays crisp at
      // any zoom. RAF-coalesce the overlay refresh + the Procreate-style
      // hold-to-snap shape detection so the work happens once per frame
      // regardless of pointer event rate.
      this._rafEmit(app);
    }
    _vUp(pt, app) {
      const cel = this.t.cel;
      if (this._emitRAF) { cancelAnimationFrame(this._emitRAF); this._emitRAF = 0; }
      // Freeze the snap state at release. The detection loop runs at ~60 Hz
      // and is still firing while pointerUp executes; if we don't stop it,
      // pushing the release point below shifts the cluster and the loop's
      // next tick could clear _snapPreview just before we read it.
      this._stopSnapLoop();
      const snapAtRelease = this._snapPreview;
      if (this.mode === 'eraser') {
        this._flushErase();
        if (this.changed) { app.history.pushCelEdit('eraser', cel, this.before); app.emit('celchange'); }
        return;
      }
      const tNow = performance.now();
      if (this.straight) {
        // raw is already [startPt, endPt] from the last straight _vMove;
        // overwrite the end point one more time so the commit lands exactly
        // under the release pointer even if no move event arrived between.
        const t0 = this.raw && this.raw[0] && this.raw[0].t != null ? this.raw[0].t : tNow;
        this.raw = [
          { x: this.startPt.x, y: this.startPt.y, p: this.startPt.p, t: t0 },
          { x: pt.x, y: pt.y, p: pt.pressure, t: tNow }
        ];
      } else {
        // End at the actual release position, not the trailing smoothed
        // point. With the lazy-pointer rope, sm can sit up to maxLag pixels
        // behind the cursor at release — committing there left the stroke
        // ending visibly short of where the artist meant to stop. Pushing
        // pt makes the final point exactly meet the cursor; the lag radius
        // is small enough in screen pixels (≈13 px at smooth 0.5) that the
        // catch-up isn't perceived as a jump.
        this.raw.push({ x: pt.x, y: pt.y, p: pt.pressure, t: tNow });
      }
      // Procreate-style hold-to-snap: prefer the snap result that was live
      // at the moment of release. Pushing pt above invalidates the trailing
      // cluster (the new end is the release position, with t=now → dwell 0)
      // so re-running detection here would miss snaps that the loop had
      // already locked in.
      const snapped = snapAtRelease || this._maybeSnapShape(app);
      let pts, closed;
      if (snapped) {
        // Shape-snap path is unaffected: it produced a clean primitive
        // shape and bypasses the inkDynamics/snap/autoClose stack on
        // purpose. (See applyInkDynamics docs: clean shapes look wrong
        // with velocity-thinned tips.)
        pts = snapped.pts;
        closed = snapped.closed;
      } else {
        const fin = OT.StrokeFinalize.finalize(this.raw, {
          tol: 0.4 + this.smooth * 0.8,
          snapDist: app.settings.snapDist || 0,
          inkDynamics: !!app.settings.inkDynamics,
          autoClose: !!(app.settings && app.settings.autoClose),
          cel: cel
        });
        pts = fin.pts;
        closed = fin.closed;
      }
      // pendingStrokeId comes from a pen-window 'down' message; honour it
      // so the committed stroke matches the wet stroke the pen is showing.
      const stroke = snapped ? {
        id: this.pendingStrokeId || U.uid(), type: 'line', pencil: false, sharp: true, taper: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: closed
      } : {
        id: this.pendingStrokeId || U.uid(), type: 'line', pencil: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: closed
      };
      this.pendingStrokeId = null;
      cel.strokes.push(stroke);
      if (app.symmetry && app.symmetry.on) {
        cel.strokes.push(V().mirrorStroke(stroke, app.symmetry.axis,
          app.project.width / 2, app.project.height / 2));
      }
      // Rebuild cel.canvas so the raster cache (used by thumbnails / onion
      // skin / exports) matches the new stroke.
      cel.rebuild();
      // Drop the in-progress raw[] so drawOverlay stops drawing a ghost on
      // top of the now-committed stroke.
      this.raw = null;
      this._previewPts = null;
      this._previewClosed = false;
      this._liveTip = null;
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
      if (this._stopSnapLoop) this._stopSnapLoop();
      this._oneEuroX = this._oneEuroY = this._oneEuroP = null;
      app.history.pushCelEdit('brush', cel, this.before);
      app.emit('render'); app.emit('overlayrender'); app.emit('celchange');
    }
    // Detect a "hold at end" gesture and try to snap the freehand stroke
    // to a primitive shape. Returns { pts, closed, kind } when snapping
    // fired, null otherwise.
    _maybeSnapShape(app) {
      if (!app.settings.shapeSnap) return null;
      if (this.straight) return null;
      if (!this.raw || this.raw.length < 8) return null;
      const holdMs = app.settings.shapeSnapHoldMs || 1300;
      const holdPx = app.settings.shapeSnapHoldPx || 14;
      const holdIdx = detectHold(this.raw, holdMs, holdPx, performance.now());
      if (holdIdx < 0) return null;
      const candidate = this.raw.slice(0, holdIdx + 1);
      const shape = V().detectShape(candidate, { locked: !!this._snapPreview });
      if (!shape) return null;
      // Lock the kind once acquired: if detection now picks a different
      // primitive (circle ↔ ellipse ↔ rect cycling at the residual edges),
      // keep the original geometry instead of swapping shapes mid-hold.
      const lockedKind = this._snapPreview && this._snapPreview.kind;
      if (lockedKind && lockedKind !== shape.kind) return this._snapPreview;
      const geom = V().shapeToPts(shape);
      geom.kind = shape.kind;
      // Normalise pressure to 1 so the snapped shape renders with uniform
      // weight (variable pressure on a clean geometric shape looks broken).
      for (const p of geom.pts) p.p = 1;
      return geom;
    }
    // ~60 Hz detection loop active for the duration of a vector brush stroke.
    // Uses setTimeout rather than requestAnimationFrame so it keeps firing
    // when the page is in the background (RAF is throttled to 1 Hz in that
    // case). Without this, a stopped mouse fires no pointermove events and
    // the snap detection never re-runs after the user pauses — the snap only
    // fires if the artist wiggles slightly. The loop also drives the morph
    // animation.
    _startSnapLoop(app) {
      if (this._snapLoopId) return;
      const tick = () => {
        if (!this.t || !this.vec) { this._snapLoopId = 0; return; }
        // Drag-to-refine: after a line snap has finished its morph
        // animation, the snap stays locked and follows the cursor instead
        // of re-running detection. pts[0] is the path-start anchor (stays
        // fixed); pts[1] is the held-end (tracks the cursor). This matches
        // Procreate's QuickShape post-snap refinement. _liveTip is in
        // cel-local space (ToolManager._map maps incoming points before
        // they reach _vMove), which is the same space as _snapPreview.pts.
        if (this._snapPreview && this._snapPreview.kind === 'line'
            && !this._snapAnim && this._liveTip) {
          this._snapPreview.pts[1] = { x: this._liveTip.x, y: this._liveTip.y, p: 1 };
          app.emit('overlayrender');
          this._snapLoopId = setTimeout(tick, 16);
          return;
        }
        const prev = this._snapPreview;
        const next = this._maybeSnapShape(app);
        if (next && !prev) this._beginSnapAnim(next);
        else if (!next && this._snapAnim) this._snapAnim = null;
        this._snapPreview = next;
        if (next || this._snapAnim) app.emit('overlayrender');
        this._snapLoopId = setTimeout(tick, 16);
      };
      this._snapLoopId = setTimeout(tick, 16);
    }
    _stopSnapLoop() {
      if (this._snapLoopId) {
        clearTimeout(this._snapLoopId);
        this._snapLoopId = 0;
      }
    }
    // Capture a snapshot of the current freehand path + the target snap path
    // resampled to the same point count, so drawOverlay can interpolate
    // between them over a short ease-out window.
    _beginSnapAnim(snap) {
      const N = 48;
      const fromPts = resampleByArcLength(this.raw, N, false);
      let toPts = resampleByArcLength(snap.pts, N, snap.closed);
      // Align direction + rotation so paired points sit on matching parts
      // of each path — otherwise the lerp pulls opposite-side points
      // through the centre and the morph looks like a flip.
      toPts = snap.closed
        ? V().alignClosedPath(fromPts, toPts)
        : V().alignOpenPath(fromPts, toPts);
      this._snapAnim = {
        start: performance.now(),
        duration: 180,
        fromPts: fromPts,
        toPts: toPts,
        closed: snap.closed
      };
    }
    _erase(cel, x, y, app) {
      const r = this.size / 2;
      // Per-event: buffer interpolated samples between the previous
      // erase point and this one. Same step the brush uses (r * 0.4)
      // so a fast tablet flick doesn't leave un-erased gaps. The heavy
      // stroke-intersection work is deferred to one RAF tick so a pen
      // firing 200 events/sec only does the erase pass ~60 times/sec.
      const last = this._lastErasePt;
      if (!this._erasePending) {
        this._erasePending = { cel: cel, app: app, samples: [] };
        // First sample of a fresh drag: pre-rasterise cel.canvas once
        // and switch the composite to the cached path. Every later
        // frame just blits cel.canvas with the destructive-punch holes
        // already in it — O(1) per frame instead of O(strokes ×
        // segments) re-rendering every stamp every tick.
        cel.rebuild();
        cel._liveDrawing = true;
      }
      const buf = this._erasePending.samples;
      if (last) {
        const d = U.dist(last.x, last.y, x, y);
        const step = Math.max(2, r * 0.4);
        const n = Math.max(1, Math.ceil(d / step));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          buf.push({ x: last.x + (x - last.x) * t, y: last.y + (y - last.y) * t });
        }
      } else {
        buf.push({ x: x, y: y });
      }
      this._lastErasePt = { x: x, y: y };
      if (!this._eraseRAF) {
        this._eraseRAF = requestAnimationFrame(() => {
          this._eraseRAF = 0;
          this._processErase();
        });
      }
    }
    // Drain the sample buffer. Two passes per tick:
    //   1) Punch the eraser dabs directly on cel.canvas via
    //      destination-out — this is what the user sees, and the cost
    //      is O(samples) regardless of how many strokes are on the
    //      cel. The stage composite blits cel.canvas via one
    //      drawImage so the live view stays at 60 fps.
    //   2) Run the vector-level eraseStroke pass to keep cel.strokes
    //      consistent (so save / undo / export get the real surviving
    //      stroke fragments). The bbox cull in eraseStroke skips
    //      strokes nowhere near the eraser tip, so this scales with
    //      "strokes actually under the eraser path", not "all strokes
    //      on the cel".
    // cel.canvas isn't full-rebuilt during the drag — that one heavy
    // pass is deferred to _flushErase on pointerUp.
    _processErase() {
      const pending = this._erasePending;
      if (!pending || !pending.samples.length) return;
      const r = this.size / 2;
      const samples = pending.samples;
      pending.samples = [];
      // Pass 1: destructive punch on cel.canvas — instant visual
      // feedback regardless of stroke count.
      const ctx = pending.cel.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      for (const s of samples) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      pending.cel.dirty();
      // Pass 2: vector-level erase pass to keep cel.strokes in sync.
      let strokes = pending.cel.strokes;
      let changed = false;
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
      if (changed) {
        pending.cel.strokes = strokes;
        this.changed = true;
      }
      pending.app.emit('render');
    }
    _flushErase() {
      if (this._eraseRAF) { cancelAnimationFrame(this._eraseRAF); this._eraseRAF = 0; }
      // Process any pending samples that didn't get a RAF tick.
      this._processErase();
      if (this._erasePending) {
        const cel = this._erasePending.cel;
        const app = this._erasePending.app;
        // Drop the cached-path override and re-render cel.canvas from
        // the now-final cel.strokes. This reconciles the destructive
        // punch (which removed pixels regardless of stroke ownership)
        // with the real surviving stroke fragments, so thumbs / onion
        // / export pick up the clean vector state.
        cel._liveDrawing = false;
        cel.rebuild();
        app.emit('render');
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
      // Timestamps on every point enable the Procreate-style hold-to-snap
      // gesture in shape recognition (see _maybeSnapShape).
      this.raw = [{ x: pt.x, y: pt.y, t: performance.now() }];
      // _previewPts is the finalize output for the current in-progress
      // stroke, recomputed per rAF in _schedule. drawOverlay renders this
      // (NOT this.raw) so the wet line equals what will commit.
      this._previewPts = null;
      this._previewClosed = false;
      // Shift-constrain: lock the stroke to a straight line from this.startPt.
      // Re-read e.shiftKey on every move so the user can toggle mid-stroke.
      this.straight = !!(e && e.shiftKey);
      this.startPt = { x: pt.x, y: pt.y, p: pt.pressure };
      // One Euro filter state (one per axis). Pencil doesn't drive line
      // width from pressure, but we still smooth all three axes for
      // consistency with the brush -- it makes future per-tool tweaks
      // (e.g. variable-width pencil) trivial.
      initOneEuro(this, pt);
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
      if (this.vec) this._startSnapLoop(app);
      if (this.vec) {
        // Vector live preview goes on the overlay (crisp at any zoom), so we
        // don't need to copy the cel into a base canvas or paint into
        // cel.ctx at all. drawOverlay renders this.raw[] each frame.
        this.base = null;
      } else {
        this.buf = document.createElement('canvas');
        this.buf.width = t.cel.w; this.buf.height = t.cel.h;
        this.bctx = this.buf.getContext('2d');
        this._render(app);
      }
      app.emit('overlayrender');
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
      // One Euro filter smoothing -- adaptive cutoff (see OneEuroFilter).
      const sm = applyOneEuro(this, pt);
      this.sm.x = sm.x; this.sm.y = sm.y;
      this.raw.push({ x: this.sm.x, y: this.sm.y, t: performance.now() });
      // Live cursor tip (raw, not smoothed) so the preview reaches the pen.
      this._liveTip = { x: pt.x, y: pt.y };
      this._schedule(app);
    }
    // Predicted samples drawn ahead of the cursor on the overlay only.
    // Same contract as PaintTool.setPredicted -- transient, NEVER added
    // to raw, cleared on stroke end.
    setPredicted(pts) {
      if (!this.t || !this.vec) { this._predictedPts = null; return; }
      this._predictedPts = (pts && pts.length) ? pts : null;
    }
    // Coalesce the per-event re-render to one per frame -- a tablet pen would
    // otherwise re-stroke the whole polyline dozens of times per frame.
    _schedule(app) {
      if (this._rRAF) return;
      this._rRAF = requestAnimationFrame(() => {
        this._rRAF = 0;
        if (!this.t) return;
        // Shape-snap detection runs once per frame (see PaintTool._rafEmit).
        // Skip while a line snap is locked and we're in drag-to-refine mode
        // — otherwise re-running detection on the now-extended raw[] would
        // clear _snapPreview and break refine. The snap-loop tick owns the
        // refine update.
        const inRefine = this.vec && this._snapPreview
          && this._snapPreview.kind === 'line' && !this._snapAnim;
        if (this.vec && !inRefine) this._snapPreview = this._maybeSnapShape(app);
        // Vector preview: drawOverlay reads this._previewPts every overlayrender,
        // so compute it here before emitting the render.
        if (this.vec) {
          this._computePreview(app);
          app.emit('overlayrender');
        }
        else this._render(app);
      });
    }
    // Compute the would-commit pts from this.raw via OT.StrokeFinalize.
    // Cached as this._previewPts; drawOverlay renders this instead of
    // this.raw. Called per rAF from _schedule and once more at pointerUp so
    // the committed pts equals the last preview pts.
    _computePreview(app) {
      if (!this.raw || !this.raw.length || !this.t) {
        this._previewPts = null;
        this._previewClosed = false;
        return;
      }
      // Skip while shape-snap animation is running -- the snap preview
      // owns drawOverlay during the morph, see drawOverlay for the snap
      // branch.
      if (this._snapAnim || this._snapPreview) return;
      // Append _liveTip so finalize sees the same input shape pointerUp
      // will: pointerUp pushes the actual release point onto this.raw
      // BEFORE finalizing. Without this, wet preview only sees the
      // One-Euro-smoothed rope (~13 px behind cursor) while commit sees
      // an extra point at the cursor -- producing a visible shift on
      // release. Same fix as PaintTool._computePreview.
      let raw = this.raw;
      if (this._liveTip && !this.straight) {
        const tail = raw[raw.length - 1];
        if (tail.x !== this._liveTip.x || tail.y !== this._liveTip.y) {
          raw = raw.concat([{
            x: this._liveTip.x, y: this._liveTip.y,
            p: this._liveTip.p, t: performance.now()
          }]);
        }
      }
      const tol = 0.4 + (this.smooth || 0) * 0.8;
      const fin = OT.StrokeFinalize.finalize(raw, {
        tol,
        snapDist: app.settings.snapDist || 0,
        inkDynamics: !!app.settings.inkDynamics,
        autoClose: !!(app.settings && app.settings.autoClose),
        cel: this.t.cel
      });
      this._previewPts = fin.pts;
      this._previewClosed = fin.closed;
    }
    // Live preview of the in-progress pencil stroke, on the overlay.
    drawOverlay(ctx, app) {
      if (!this.t || !this.vec || !this.raw || this.raw.length < 1) return;
      ctx.save();
      applyLayerXform(ctx, this.t.layer, app.frame, app);
      // Morph animation: smoothly interpolate freehand → snapped shape over
      // ~180 ms (see PaintTool.drawOverlay).
      if (this._snapAnim) {
        const now = performance.now();
        const t = Math.min(1, (now - this._snapAnim.start) / this._snapAnim.duration);
        const eased = t * t * (3 - 2 * t);
        const from = this._snapAnim.fromPts, to = this._snapAnim.toPts;
        const pts = new Array(from.length);
        for (let i = 0; i < from.length; i++) {
          pts[i] = {
            x: from[i].x + (to[i].x - from[i].x) * eased,
            y: from[i].y + (to[i].y - from[i].y) * eased
          };
        }
        const snapStroke = {
          type: 'line', pencil: true, sharp: true,
          color: this.color, width: this.size, opacity: this.opacity,
          pts: pts, closed: this._snapAnim.closed
        };
        V().renderStroke(ctx, snapStroke);
        ctx.restore();
        if (t >= 1) this._snapAnim = null;
        return;
      }
      if (this._snapPreview) {
        const snapStroke = {
          type: 'line', pencil: true, sharp: true,
          color: this.color, width: this.size, opacity: this.opacity,
          pts: this._snapPreview.pts, closed: this._snapPreview.closed
        };
        V().renderStroke(ctx, snapStroke);
        ctx.restore();
        return;
      }
      // Render the FINALIZE output (= the would-commit pts), not this.raw.
      // The finalize pipeline runs per rAF in _computePreview, so what the
      // artist sees is exactly what pointerUp will push to cel.strokes. The
      // _liveTip workaround is no longer needed -- finalize-per-frame
      // keeps the preview within ~one frame of the cursor.
      const pts = this._previewPts;
      if (!pts || pts.length === 0) { ctx.restore(); return; }
      const stroke = {
        type: 'line', pencil: true,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: this._previewClosed
      };
      V().renderStroke(ctx, stroke);
      ctx.restore();
    }
    pointerUp(pt, e, app) {
      if (!this.t) return;
      if (this._rRAF) { cancelAnimationFrame(this._rRAF); this._rRAF = 0; }
      // Freeze snap state at release — see PaintTool._vUp.
      if (this._stopSnapLoop) this._stopSnapLoop();
      const snapAtRelease = this._snapPreview;
      const tNow = performance.now();
      if (this.straight) {
        // Force raw to exactly [startPt, releasePt] so the committed polyline
        // is a single straight segment, regardless of how many move events
        // arrived between Shift-down and pointerUp.
        const t0 = this.raw && this.raw[0] && this.raw[0].t != null ? this.raw[0].t : tNow;
        this.raw = [
          { x: this.startPt.x, y: this.startPt.y, t: t0 },
          { x: pt.x, y: pt.y, t: tNow }
        ];
      } else {
        // Push the actual release point (not this.sm) so the committed stroke
        // ends exactly where the user lifted, matching the live preview which
        // extends past the rope-lagged smoothed tip via _liveTip.
        this.raw.push({ x: pt.x, y: pt.y, t: tNow });
      }
      const cel = this.t.cel;
      if (this.vec) {
        // Procreate-style hold-to-snap — prefer the snap result that was
        // live at release (see PaintTool._vUp for rationale).
        const snapped = snapAtRelease || this._maybeSnapShape(app);
        let pts, closed;
        if (snapped) {
          pts = snapped.pts;
          closed = snapped.closed;
        } else {
          const fin = OT.StrokeFinalize.finalize(this.raw, {
            tol: 0.4 + (this.smooth || 0) * 0.8,
            snapDist: app.settings.snapDist || 0,
            inkDynamics: !!app.settings.inkDynamics,
            autoClose: !!(app.settings && app.settings.autoClose),
            cel: cel
          });
          pts = fin.pts;
          closed = fin.closed;
        }
        // pendingStrokeId comes from a pen-window 'down' message; honour it
        // so the committed stroke matches the wet stroke the pen is showing.
        const stroke = snapped ? {
          id: this.pendingStrokeId || U.uid(), type: 'line', pencil: true, sharp: true,
          color: this.color, width: this.size, opacity: this.opacity,
          pts: pts, closed: closed
        } : {
          id: this.pendingStrokeId || U.uid(), type: 'line', pencil: true,
          color: this.color, width: this.size, opacity: this.opacity,
          pts: pts, closed: closed
        };
        this.pendingStrokeId = null;
        cel.strokes.push(stroke);
        if (app.symmetry && app.symmetry.on) {
          cel.strokes.push(V().mirrorStroke(stroke, app.symmetry.axis,
            app.project.width / 2, app.project.height / 2));
        }
        // Rebuild the cel cache from cel.strokes — drops the in-progress
        // overlay preview's role and gets the new stroke into the raster
        // cache for thumbnails / onion skin / exports.
        cel.rebuild();
      } else {
        this._render(app);
      }
      // Stroke is committed into cel.strokes — let the compositor go back
      // to rendering from strokes (crisper at zoom; no cache).
      cel._liveDrawing = false;
      app.history.pushCelEdit('pencil', cel, this.before);
      this.raw = null;
      this._previewPts = null;
      this._previewClosed = false;
      this._liveTip = null;
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
      if (this._stopSnapLoop) this._stopSnapLoop();
      this._oneEuroX = this._oneEuroY = this._oneEuroP = null;
      this.t = null;
      app.emit('render'); app.emit('celchange');
    }
    // Detect hold-at-end and try to snap to a primitive. Same contract as
    // PaintTool._maybeSnapShape — returns { pts, closed, kind } or null.
    _maybeSnapShape(app) {
      if (!app.settings.shapeSnap) return null;
      if (this.straight) return null;
      if (!this.raw || this.raw.length < 8) return null;
      const holdMs = app.settings.shapeSnapHoldMs || 1300;
      const holdPx = app.settings.shapeSnapHoldPx || 14;
      const holdIdx = detectHold(this.raw, holdMs, holdPx, performance.now());
      if (holdIdx < 0) return null;
      const candidate = this.raw.slice(0, holdIdx + 1);
      const shape = V().detectShape(candidate, { locked: !!this._snapPreview });
      if (!shape) return null;
      const lockedKind = this._snapPreview && this._snapPreview.kind;
      if (lockedKind && lockedKind !== shape.kind) return this._snapPreview;
      const geom = V().shapeToPts(shape);
      geom.kind = shape.kind;
      return geom;
    }
    // See PaintTool._startSnapLoop for the rationale.
    _startSnapLoop(app) {
      if (this._snapLoopId) return;
      const tick = () => {
        if (!this.t || !this.vec) { this._snapLoopId = 0; return; }
        // Drag-to-refine for snapped lines — see PaintTool._startSnapLoop.
        // pts[0] is the path-start anchor; pts[1] is the held-end and
        // follows the cursor. PencilTool.pointerMove also writes _liveTip
        // from the already-mapped `pt`, so it's in the same cel-local
        // space as _snapPreview.pts.
        if (this._snapPreview && this._snapPreview.kind === 'line'
            && !this._snapAnim && this._liveTip) {
          this._snapPreview.pts[1] = { x: this._liveTip.x, y: this._liveTip.y, p: 1 };
          app.emit('overlayrender');
          this._snapLoopId = setTimeout(tick, 16);
          return;
        }
        const prev = this._snapPreview;
        const next = this._maybeSnapShape(app);
        if (next && !prev) this._beginSnapAnim(next);
        else if (!next && this._snapAnim) this._snapAnim = null;
        this._snapPreview = next;
        if (next || this._snapAnim) app.emit('overlayrender');
        this._snapLoopId = setTimeout(tick, 16);
      };
      this._snapLoopId = setTimeout(tick, 16);
    }
    _stopSnapLoop() {
      if (this._snapLoopId) {
        clearTimeout(this._snapLoopId);
        this._snapLoopId = 0;
      }
    }
    _beginSnapAnim(snap) {
      const N = 48;
      const fromPts = resampleByArcLength(this.raw, N, false);
      let toPts = resampleByArcLength(snap.pts, N, snap.closed);
      toPts = snap.closed
        ? V().alignClosedPath(fromPts, toPts)
        : V().alignOpenPath(fromPts, toPts);
      this._snapAnim = {
        start: performance.now(),
        duration: 180,
        fromPts: fromPts,
        toPts: toPts,
        closed: snap.closed
      };
    }
    // Esc mid-stroke: restore the cel and drop the tool's transient state
    // without pushing history.
    cancel(app) {
      if (!this.t) return;
      if (this.t.cel) this.t.cel._liveDrawing = false;
      if (this._rRAF) { cancelAnimationFrame(this._rRAF); this._rRAF = 0; }
      if (this.before) this.t.cel.restore(this.before);
      this.t = null;
      this.buf = null; this.base = null;
      this.raw = null; this.sm = null;
      this._liveTip = null;
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
      if (this._stopSnapLoop) this._stopSnapLoop();
      this._oneEuroX = this._oneEuroY = this._oneEuroP = null;
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
    onDeactivate(app) {
      // If a snippet drag was in-flight (rare — tool switch mid-drag), bake
      // the translation in so the strokes don't end up frozen at the old
      // position with _lassoHidden still set.
      if (this.vmode === 'move') this._vUp(null, app);
      if (this.vcel && this.vcel._liveDrawing) this._clearSelSnippet(app);
      this.commit(app);
      this.vsel = [];
    }
    flush(app) {
      if (this.vmode === 'move') this._vUp(null, app);
      if (this.vcel && this.vcel._liveDrawing) this._clearSelSnippet(app);
      this.commit(app);
    }

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
        // Snippet path (matches LassoTool's fast affine drag): rasterise the
        // selected strokes once into an offscreen canvas, hide them from
        // the cel cache, and blit them through a translate per frame —
        // single drawImage instead of mutating + re-rendering N strokes on
        // every pointer event.
        this._vMoveDx = 0; this._vMoveDy = 0;
        this._buildSelSnippet(app);
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
        if (dx || dy) this.vmoved = true;
        this._vMoveDx = (this._vMoveDx || 0) + dx;
        this._vMoveDy = (this._vMoveDy || 0) + dy;
        this.vstart = { x: pt.x, y: pt.y };
        // No per-event point mutation, no per-event cel rebuild. The
        // overlay blits the snippet at the accumulated translation and the
        // main canvas keeps showing the cached cel.canvas (which excludes
        // the moved strokes).
        app.emit('overlayrender');
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
      } else if (this.vmode === 'move') {
        // Finalise the snippet drag: apply the accumulated translation to
        // every selected stroke's points (one pass, not per-event), then
        // unhide them and rebuild the cel cache so it matches.
        const dx = this._vMoveDx || 0, dy = this._vMoveDy || 0;
        if (this.vmoved && (dx || dy)) {
          for (const st of this.vsel) {
            if (st.type === 'fill')
              st.contour = st.contour.map(p => ({ x: p.x + dx, y: p.y + dy }));
            else
              st.pts = st.pts.map(p => ({ x: p.x + dx, y: p.y + dy, p: p.p }));
          }
        }
        this._clearSelSnippet(app);
        if (this.vmoved) {
          app.history.pushCelEdit('move strokes', this.vcel, this.vbefore);
          app.emit('celchange');
        }
        this._vMoveDx = 0; this._vMoveDy = 0;
      }
      this.vmode = 'idle';
      app.emit('render'); app.emit('overlayrender');
    }
    // Pre-render the currently-selected strokes into an offscreen canvas,
    // then hide them from the cel cache. Mirror of LassoTool's snippet path.
    _buildSelSnippet(app) {
      if (!this.vsel.length || !this.vcel) return;
      const cel = this.vcel;
      const c = document.createElement('canvas');
      c.width = cel.w; c.height = cel.h;
      const cx = c.getContext('2d');
      for (const st of this.vsel) if (st.type === 'fill') V().renderStroke(cx, st);
      for (const st of this.vsel) if (st.type !== 'fill') V().renderStroke(cx, st);
      this._selSnippet = c;
      for (const st of this.vsel) st._lassoHidden = true;
      cel._liveDrawing = true;
      cel.rebuild();
      app.emit('render');
    }
    _clearSelSnippet(app) {
      if (!this.vcel) return;
      if (this.vsel) for (const st of this.vsel) st._lassoHidden = false;
      this.vcel._liveDrawing = false;
      this.vcel.rebuild();
      this._selSnippet = null;
      app.emit('render');
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
      // Live-drag snippet: render the pre-rasterised selected strokes at the
      // accumulated translation. One drawImage regardless of stroke count.
      if (this.vmode === 'move' && this._selSnippet && this.vsel.length) {
        ctx.save();
        ctx.translate(this._vMoveDx || 0, this._vMoveDy || 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this._selSnippet, 0, 0);
        ctx.restore();
      }
      if (this.vsel.length) {
        ctx.save();
        // During a live snippet drag the strokes haven't been mutated yet —
        // offset the bbox outlines by the accumulated translation so they
        // wrap the visible snippet instead of staying at the original spot.
        if (this.vmode === 'move') {
          ctx.translate(this._vMoveDx || 0, this._vMoveDy || 0);
        }
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
    // Recolor every selected vector stroke (Select-tool path). Called from
    // app.setColor — "select strokes → click swatch → strokes recolour".
    recolorSelection(hex, app) {
      if (!this.vsel.length || !this.vcel) return false;
      let anyChange = false;
      for (const st of this.vsel) if (st.color !== hex) { anyChange = true; break; }
      if (!anyChange) return false;
      const before = this.vcel.snapshot();
      for (const st of this.vsel) st.color = hex;
      this.vcel.rebuild();
      app.history.pushCelEdit('Recolor selection', this.vcel, before);
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
      this.vt = null;          // vector free-transform state (cx/cy/sw/sh/scaleX/scaleY/rot + orig snapshot)
      this.raster = null;      // a lifted floating pixel piece
      // 'uniform' | 'freeform' | 'distort' | 'warp'
      // Default to 'uniform' so the artist gets scale + rotate handles
      // immediately on lasso close. Translation is implied: dragging inside
      // the bbox always translates the selection regardless of mode, so we
      // don't surface a separate Move button.
      this.transformMode = 'uniform';
    }
    onDeactivate(app) {
      this._commitRaster(app);
      this._commitVector(app);
      this.vsel = []; this.vcel = null; this.vt = null;
      this.poly = null; this.mode = 'idle';
      this.transformMode = 'uniform';
      this._stopAnts();
      this._hideToolbar();
      app.emit('overlayrender');
    }
    // a frame / layer change drops the selection so it can't act on a hidden cel
    flush(app) {
      this._commitRaster(app);
      this._commitVector(app);
      this.vsel = []; this.vcel = null; this.vt = null;
      this.transformMode = 'uniform';
      this._stopAnts();
      this._hideToolbar();
    }
    setTransformMode(mode, app) {
      // Raster lassos don't yet implement distort / warp mesh rendering —
      // silently bounce to Freeform so the toolbar always does something.
      if ((mode === 'distort' || mode === 'warp') && this.raster && !this.vt) {
        if (app && app.ui) app.ui.status('Distort and Warp are vector-layer only — using Freeform');
        mode = 'freeform';
      }
      if (this.transformMode === mode) return;
      const wasAffine = this.transformMode === 'uniform' || this.transformMode === 'freeform';
      const isAffine = mode === 'uniform' || mode === 'freeform';
      // Rebaseline: snapshot the strokes' CURRENT shape as the new "orig" so
      // each mode starts fresh from where the last one ended.
      if (this.vt) this._rebaselineVT();
      this.transformMode = mode;
      if (this.vt) {
        this._initDistortWarp(this.vt);
        // Multi-cel skips the snippet optimisation entirely — strokes
        // re-render straight from cel.strokes in every mode, so the
        // hide / snippet rebuild dance only matters for single-cel.
        if (!this.vt.multi) {
          if (isAffine && !wasAffine) {
            // entering affine — re-render snippet at the new orig, then hide
            this._buildPreviewSnippet(this.vt);
            this._hideSelectedFromCel(this.vt, app);
          } else if (!isAffine && wasAffine) {
            // leaving affine — show strokes in the cel; distort/warp will
            // re-derive them per frame via _applyVTransform
            this._showSelectedInCel(this.vt, app);
          } else if (isAffine && wasAffine) {
            // re-render snippet because orig changed via rebaseline
            this._buildPreviewSnippet(this.vt);
          }
        }
      }
      this._refreshToolbar();
      if (app) { app.emit('render'); app.emit('overlayrender'); }
    }
    _rebaselineVT() {
      const v = this.vt;
      if (!v || !v.strokes) return;
      if (v.multi) {
        // Multi-cel: each stroke remembers its home layer/cel; the new
        // orig must capture its CURRENT pts in project-space so the
        // next mode starts from where this one left off.
        const app = v._app;
        const fwd = (p, layer) => this._celToProjectFwd(p, layer, v.frame, app);
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        const oldOrig = v.orig;
        const newOrig = [];
        for (const o of oldOrig) {
          const st = o.stroke;
          if (st.type === 'fill') {
            const contour = st.contour.map(p => fwd(p, o.layer));
            for (const p of contour) {
              if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
              if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
            }
            newOrig.push({ stroke: st, layer: o.layer, cel: o.cel, contour });
          } else {
            const pts = st.pts.map(p => {
              const w = fwd(p, o.layer);
              return { x: w.x, y: w.y, p: p.p };
            });
            for (const p of pts) {
              if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
              if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
            }
            newOrig.push({ stroke: st, layer: o.layer, cel: o.cel, pts });
          }
        }
        v.orig = newOrig;
        const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
        v.origCx = x0 + w / 2; v.origCy = y0 + h / 2;
        v.cx = v.origCx; v.cy = v.origCy;
        v.sw = w; v.sh = h;
        v.scaleX = 1; v.scaleY = 1; v.rot = 0;
        return;
      }
      v.orig = v.strokes.map(st => st.type === 'fill'
        ? { stroke: st, contour: st.contour.map(p => ({ x: p.x, y: p.y })) }
        : { stroke: st, pts: st.pts.map(p => ({ x: p.x, y: p.y, p: p.p })) }
      );
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const st of v.strokes) {
        const b = V().strokeBounds(st);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
      }
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      v.origCx = x0 + w / 2; v.origCy = y0 + h / 2;
      v.cx = v.origCx; v.cy = v.origCy;
      v.sw = w; v.sh = h;
      v.scaleX = 1; v.scaleY = 1; v.rot = 0;
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
      // Armed multi-cel transforms run independently of which layer is
      // "active" — the user might have clicked a folder, which is type
      // 'group', not 'vector'. Treat the gate as vector when a multi
      // transform is in flight so handles, drag-to-move and the
      // toolbar pill stay interactive.
      const inMultiTransform = !!(this.vt && this.vt.multi);
      if (this.layerKind === 'vector' || inMultiTransform) {
        if (this.vt && this.vsel.length && this.vcel) {
          const v = this.vt;
          // Multi-cel transforms run in project-space (no per-layer
          // detour); single-cel uses the home layer's local frame.
          const local = v.multi
            ? { x: pt.x, y: pt.y }
            : layerLocal(pt, v.layer || layer, v.frame != null ? v.frame : app.frame, app);
          const zoom = app.stage.view.zoom;
          const thr = 11 / zoom;
          const tm = this.transformMode;

          // Distort: 4 corner handles only.
          if (tm === 'distort' && v.distortC) {
            for (let i = 0; i < 4; i++) {
              const c = v.distortC[i];
              if (U.dist(local.x, local.y, c.x, c.y) < thr) {
                this.mode = 'vdistort'; this.dIdx = i; return;
              }
            }
          }
          // Warp: 4 corners then 4 edge midpoints.
          if (tm === 'warp' && v.warpC && v.warpM) {
            for (let i = 0; i < 4; i++) {
              const c = v.warpC[i];
              if (U.dist(local.x, local.y, c.x, c.y) < thr) {
                this.mode = 'vwarpc'; this.dIdx = i; return;
              }
            }
            for (let i = 0; i < 4; i++) {
              const m = v.warpM[i];
              if (U.dist(local.x, local.y, m.x, m.y) < thr) {
                this.mode = 'vwarpm'; this.dIdx = i; return;
              }
            }
          }
          // Freeform / Uniform: rotation knob, then 8 scale handles.
          if (tm === 'freeform' || tm === 'uniform') {
            const rh = selRotHandleWorld(v, zoom);
            if (U.dist(local.x, local.y, rh.x, rh.y) < thr) {
              this.mode = 'vrotate';
              this.startRot = v.rot;
              this.startAng = Math.atan2(local.y - v.cy, local.x - v.cx);
              return;
            }
            for (let i = 0; i < 8; i++) {
              const a = selAnchor(i, v.sw, v.sh);
              const w = selWorld(v, a.x, a.y);
              if (U.dist(local.x, local.y, w.x, w.y) < thr) {
                this.mode = 'vscale';
                this.hIdx = i;
                const opp = selAnchor((i + 4) % 8, v.sw, v.sh);
                this.fixed = selWorld(v, opp.x, opp.y);
                this.oppA = opp; this.hA = a;
                return;
              }
            }
          }
          // Inside the bbox / quad — translate. Works in every mode (in
          // distort / warp it shifts all control points uniformly).
          const insideAffine = () => {
            const loc = selLocal(v, local.x, local.y);
            return Math.abs(loc.x) <= v.sw / 2 && Math.abs(loc.y) <= v.sh / 2;
          };
          const insideQuad = (poly) => pointInPoly(local.x, local.y, poly);
          let inside = false;
          if (tm === 'distort' && v.distortC) inside = insideQuad(v.distortC);
          else if (tm === 'warp' && v.warpC) inside = insideQuad(v.warpC);
          else inside = insideAffine();
          if (inside) {
            this.mode = 'vmove';
            this.moveLast = { x: local.x, y: local.y };
            this.moveOff = { x: local.x - v.cx, y: local.y - v.cy };
            return;
          }
          // Clicked off the selection — commit any in-flight transform and
          // fall through to start a fresh lasso loop.
          this._commitVector(app);
        }
        this.vsel = []; this.vcel = null; this.vt = null;
        this.transformMode = 'uniform';
        this._hideToolbar();
        // Folder / non-drawable active layer: nothing to lasso into.
        // Bail out instead of starting a phantom lasso loop the user
        // can't actually fill on a group layer.
        if (this.layerKind !== 'vector') {
          this.mode = 'idle';
          app.emit('overlayrender');
          return;
        }
      } else if (this.layerKind === 'drawing') {
        if (this.raster) {
          const r = this.raster;
          const local = layerLocal(pt, r.layer, r.frame, app);
          const zoom = app.stage.view.zoom;
          const thr = 11 / zoom;   // generous on a tablet
          const tm = this.transformMode;
          // Handles are only hit-testable when the user has opted into a
          // transform mode via the toolbar — in Move mode the marquee acts
          // like a Photoshop shift-select (translate inside, nothing else).
          if (tm === 'freeform' || tm === 'uniform') {
            // Rotation knob (sits outside the bbox so check it first)
            const rh = selRotHandleWorld(r, zoom);
            if (U.dist(local.x, local.y, rh.x, rh.y) < thr) {
              this.mode = 'rrotate';
              this.startRot = r.rot;
              this.startAng = Math.atan2(local.y - r.cy, local.x - r.cx);
              return;
            }
            // 8 scale handles
            for (let i = 0; i < 8; i++) {
              const a = selAnchor(i, r.sw, r.sh);
              const w = selWorld(r, a.x, a.y);
              if (U.dist(local.x, local.y, w.x, w.y) < thr) {
                this.mode = 'rscale';
                this.hIdx = i;
                const opp = selAnchor((i + 4) % 8, r.sw, r.sh);
                this.fixed = selWorld(r, opp.x, opp.y);
                this.oppA = opp; this.hA = a;
                return;
              }
            }
          }
          // Inside the bbox/polygon — translate. For lifted state we use the
          // transformed bbox; for unlifted state we test the actual polygon
          // so clicks in the lasso's concave gaps fall through to a new
          // lasso instead of grabbing the selection.
          let inside;
          if (r.lifted) {
            const loc = selLocal(r, local.x, local.y);
            inside = Math.abs(loc.x) <= r.sw / 2 && Math.abs(loc.y) <= r.sh / 2;
          } else {
            inside = pointInPoly(local.x, local.y, r.poly);
          }
          if (inside) {
            this.mode = 'rmove';
            this.moveOff = { x: local.x - r.cx, y: local.y - r.cy };
            return;
          }
          // Clicked clean off the selection — commit anything that was lifted
          // and fall through to start a new lasso loop.
          this._commitRaster(app);
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
      } else if (this.mode === 'vmove' || this.mode === 'vrotate' || this.mode === 'vscale'
                 || this.mode === 'vdistort' || this.mode === 'vwarpc' || this.mode === 'vwarpm') {
        // Vector free-transform: vt.cx/cy/scaleX/scaleY/rot (or distort /
        // warp control points) accumulate; every frame we re-derive each
        // stroke's points from the original snapshot through the current
        // transform. This avoids compounding rounding errors across many
        // small moves.
        const v = this.vt;
        if (!v) return;
        // Multi-cel state lives in project-space; only the single-cel
        // path needs to detour through the home layer's local frame.
        const local = v.multi
          ? { x: pt.x, y: pt.y }
          : layerLocal(pt, v.layer || app.activeLayer(),
              v.frame != null ? v.frame : app.frame, app);
        if (this.mode === 'vmove') {
          const dx = local.x - this.moveLast.x;
          const dy = local.y - this.moveLast.y;
          this.moveLast = { x: local.x, y: local.y };
          if (this.transformMode === 'distort' && v.distortC) {
            for (const c of v.distortC) { c.x += dx; c.y += dy; }
          } else if (this.transformMode === 'warp' && v.warpC && v.warpM) {
            for (const c of v.warpC) { c.x += dx; c.y += dy; }
            for (const m of v.warpM) { m.x += dx; m.y += dy; }
          } else {
            v.cx = local.x - this.moveOff.x;
            v.cy = local.y - this.moveOff.y;
          }
        } else if (this.mode === 'vrotate') {
          const ang = Math.atan2(local.y - v.cy, local.x - v.cx);
          v.rot = this.startRot + (ang - this.startAng);
          if (e && e.shiftKey) v.rot = Math.round(v.rot / (Math.PI / 12)) * (Math.PI / 12);
        } else if (this.mode === 'vscale') {
          const dxA = this.hA.x - this.oppA.x, dyA = this.hA.y - this.oppA.y;
          const c = Math.cos(-v.rot), sn = Math.sin(-v.rot);
          const vx = (local.x - this.fixed.x) * c - (local.y - this.fixed.y) * sn;
          const vy = (local.x - this.fixed.x) * sn + (local.y - this.fixed.y) * c;
          let nsx = dxA !== 0 ? vx / dxA : v.scaleX;
          let nsy = dyA !== 0 ? vy / dyA : v.scaleY;
          // Uniform mode forces aspect-preserving scale on every drag.
          const uniform = this.transformMode === 'uniform' || (e && e.shiftKey);
          if (uniform && dxA !== 0 && dyA !== 0) {
            const m = Math.max(Math.abs(nsx), Math.abs(nsy));
            nsx = Math.sign(nsx) * m; nsy = Math.sign(nsy) * m;
          }
          if (Math.abs(nsx) < 0.01) nsx = 0.01 * Math.sign(nsx || 1);
          if (Math.abs(nsy) < 0.01) nsy = 0.01 * Math.sign(nsy || 1);
          v.scaleX = nsx; v.scaleY = nsy;
          const rc = Math.cos(v.rot), rs = Math.sin(v.rot);
          const ox = -this.oppA.x * nsx, oy = -this.oppA.y * nsy;
          v.cx = this.fixed.x + ox * rc - oy * rs;
          v.cy = this.fixed.y + ox * rs + oy * rc;
        } else if (this.mode === 'vdistort' && v.distortC) {
          v.distortC[this.dIdx].x = local.x;
          v.distortC[this.dIdx].y = local.y;
        } else if (this.mode === 'vwarpc' && v.warpC && v.warpM) {
          // Moving a corner also drags its two adjacent edge midpoints by
          // half the delta, so the edges follow naturally instead of
          // snapping into sharp angles every time you nudge a corner.
          const prev = v.warpC[this.dIdx];
          const dx = local.x - prev.x, dy = local.y - prev.y;
          prev.x = local.x; prev.y = local.y;
          const adj = [this.dIdx, (this.dIdx + 3) % 4]; // edge T,R,B,L starts at corner i for T=0,R=1,B=2,L=3
          for (const i of adj) {
            v.warpM[i].x += dx / 2;
            v.warpM[i].y += dy / 2;
          }
        } else if (this.mode === 'vwarpm' && v.warpM) {
          v.warpM[this.dIdx].x = local.x;
          v.warpM[this.dIdx].y = local.y;
        }
        if (this.vt) this.vt.dirty = true;
        // Coalesce the heavy work to one-per-frame. Without this a tablet
        // pen firing ~200 events/sec would re-derive every selected stroke's
        // points 200 times/sec, allocating thousands of point objects, which
        // is the lag the user feels on a large selection.
        this._scheduleVMove(app);
        this._positionToolbar(app);
        app.emit('overlayrender');
      } else if (this.mode === 'rmove') {
        // First actual drag on an unlifted selection: clip pixels off the cel
        // into a floating canvas now. Doing this lazily means a stray
        // pointerdown-and-release-without-moving never modifies the cel.
        if (this.raster && !this.raster.lifted) this._liftRaster(app);
        const r = this.raster;
        const local = layerLocal(pt, r.layer, r.frame, app);
        r.cx = local.x - this.moveOff.x;
        r.cy = local.y - this.moveOff.y;
        app.emit('render'); app.emit('overlayrender');
      } else if (this.mode === 'rrotate') {
        if (this.raster && !this.raster.lifted) this._liftRaster(app);
        const r = this.raster;
        const local = layerLocal(pt, r.layer, r.frame, app);
        const ang = Math.atan2(local.y - r.cy, local.x - r.cx);
        r.rot = this.startRot + (ang - this.startAng);
        if (e && e.shiftKey) r.rot = Math.round(r.rot / (Math.PI / 12)) * (Math.PI / 12);
        app.emit('render'); app.emit('overlayrender');
      } else if (this.mode === 'rscale') {
        if (this.raster && !this.raster.lifted) this._liftRaster(app);
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
      // Per-frame during a transform drag, coalesce both heavy steps —
      // mutating every selected stroke's points (_applyVTransform) and the
      // composite re-render — into a single RAF tick. Skipping the
      // cel.canvas rebuild entirely is safe because compositeStage renders
      // vector cels straight from cel.strokes; the cache is only stale and
      // gets rebuilt on pointerUp so thumbnails / onion skin / exports
      // catch up.
      if (this._vmoveRAF) return;
      this._vmoveRAF = requestAnimationFrame(() => {
        this._vmoveRAF = 0;
        this._applyVTransform();
        app.emit('render');
      });
    }
    _flushVMove(app) {
      if (this._vmoveRAF) { cancelAnimationFrame(this._vmoveRAF); this._vmoveRAF = 0; }
      // Pointer-up: force a final transform pass + rebuild so each cel's
      // cached canvas (used by thumbnails, onion skin, and exports)
      // matches the visible shape exactly.
      this._applyVTransform();
      if (this.vt && this.vt.multi && this.vt.cels) {
        for (const c of this.vt.cels) c.cel.rebuild();
      } else if (this.vcel) {
        this.vcel.rebuild();
      }
      app.emit('render');
    }
    pointerUp(pt, e, app) {
      if (this.mode === 'lasso') {
        if (this.poly && this.poly.length >= 3) {
          if (this.layerKind === 'vector') this._lassoVector(app);
          else this._lassoRaster(app);
        }
        this.poly = null;
      } else if (this.mode === 'vmove' || this.mode === 'vrotate' || this.mode === 'vscale'
                 || this.mode === 'vdistort' || this.mode === 'vwarpc' || this.mode === 'vwarpm') {
        // Force the final transform pass + cel rebuild before pointer-up
        // returns. _scheduleVMove may have an in-flight RAF that hasn't run
        // yet, so this also catches the last frame's mutation.
        this._flushVMove(app);
      }
      // vmove / vrotate / vscale and rmove / rrotate / rscale leave the
      // selection alive so the artist can chain transformations -- they only
      // commit on click-outside, tool change, or Enter/Esc.
      this.mode = 'idle';
      app.emit('render'); app.emit('overlayrender');
    }

    // Re-derive every selected stroke's points from the original snapshot
    // through the current transform mode. Move / Freeform / Uniform use the
    // affine cx/cy/scaleX/scaleY/rot fields; Distort uses bilinear blend of
    // 4 corner positions; Warp uses a Coons patch with quadratic edges.
    _applyVTransform() {
      const v = this.vt;
      if (!v) return;
      const fwd = this._makeForward(v);
      // Multi-cel: orig pts live in project-space; the forward map
      // produces project-space; each stroke is then projected back
      // into its home layer's cel-local frame so renderCel can draw it
      // at the right spot under that layer's transform.
      if (v.multi) {
        const app = v._app;
        for (const o of v.orig) {
          const st = o.stroke;
          if (st.type === 'fill') {
            st.contour = o.contour.map(p => {
              const w = fwd(p.x, p.y);
              const loc = layerLocal(w, o.layer, v.frame, app);
              return { x: loc.x, y: loc.y };
            });
          } else {
            st.pts = o.pts.map(p => {
              const w = fwd(p.x, p.y);
              const loc = layerLocal(w, o.layer, v.frame, app);
              return { x: loc.x, y: loc.y, p: p.p };
            });
          }
        }
        return;
      }
      for (const o of v.orig) {
        const st = o.stroke;
        if (st.type === 'fill') {
          st.contour = o.contour.map(p => {
            const r = fwd(p.x, p.y); return { x: r.x, y: r.y };
          });
        } else {
          st.pts = o.pts.map(p => {
            const r = fwd(p.x, p.y); return { x: r.x, y: r.y, p: p.p };
          });
        }
      }
    }
    // Build the (original cel-local point) -> (new cel-local point) mapping
    // for the active transform mode. Same shape used for raster commit too.
    _makeForward(s) {
      const mode = this.transformMode;
      if (mode === 'distort' && s.distortC) {
        return (px, py) => {
          const { u, v } = this._uv(s, px, py);
          return this._bilinear(s.distortC, u, v);
        };
      }
      if (mode === 'warp' && s.warpC && s.warpM) {
        return (px, py) => {
          const { u, v } = this._uv(s, px, py);
          return this._coons(s.warpC, s.warpM, u, v);
        };
      }
      // move / freeform / uniform — affine transform around origCx/origCy
      const c = Math.cos(s.rot), sn = Math.sin(s.rot);
      return (px, py) => {
        const lx = (px - s.origCx) * s.scaleX;
        const ly = (py - s.origCy) * s.scaleY;
        return { x: s.cx + lx * c - ly * sn, y: s.cy + lx * sn + ly * c };
      };
    }
    // Bake the current transform as a single history entry, then drop the
    // transform state. The stroke points are already mutated in-place by
    // _applyVTransform, so committing just means snapshotting for undo.
    _commitVector(app) {
      const v = this.vt;
      if (!v) return;
      this.vt = null;
      this.transformMode = 'uniform';
      this._hideToolbar();
      // Strokes might have been hidden from the cel cache for the snippet
      // path — unhide them and ensure pts are at their final transformed
      // positions before rebuilding the cache.
      if (v.strokes) for (const st of v.strokes) st._lassoHidden = false;
      if (v.cel) v.cel._liveDrawing = false;
      // Multi-cel: rebuild + push a single combined history entry across
      // every involved cel, so one Ctrl+Z undoes the whole transform.
      if (v.multi && v.cels) {
        for (const c of v.cels) c.cel.rebuild();
        if (!v.dirty) { app.emit('render'); return; }
        const cels = v.cels.map(c => ({ cel: c.cel, before: c.before, after: c.cel.snapshot() }));
        const label = cels.length > 1 ? 'Transform ' + cels.length + ' layers' : 'Transform selection';
        app.history.push({
          label,
          undo: () => { for (const c of cels) c.cel.restore(c.before); app.emit('render'); app.emit('celchange'); },
          redo: () => { for (const c of cels) c.cel.restore(c.after);  app.emit('render'); app.emit('celchange'); }
        });
        app.emit('render'); app.emit('celchange');
        return;
      }
      // Only push a history entry if the artist actually transformed
      // anything. Dropping a selection that was never touched is a no-op.
      if (!v.dirty) {
        if (v.cel) v.cel.rebuild();
        app.emit('render');
        return;
      }
      if (v.cel) v.cel.rebuild();
      if (v.before) app.history.pushCelEdit('Transform selection', v.cel, v.before);
      app.emit('render'); app.emit('celchange');
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
      // convert the project-space polygon into cel-local space so it lines
      // up with the strokes (whose points are stored cel-local) on a layer
      // that has a transform applied
      const localPoly = this.poly.map(p => layerLocal(p, layer, app.frame, app));
      const sel = [];
      for (const st of cel.strokes) {
        if (this._strokeInLasso(st, localPoly)) sel.push(st);
      }
      this.vsel = sel;
      this.vcel = cel;
      if (!sel.length) {
        this.vt = null;
        app.ui.status('No strokes inside the lasso');
        return;
      }
      // Build the combined bbox of all selected strokes, then snapshot each
      // stroke's points so future transforms can be re-derived from the
      // original (no compounding error across many small drags).
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const st of sel) {
        const b = V().strokeBounds(st);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
      }
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      this.vt = {
        cel, layer, frame: app.frame,
        strokes: sel.slice(),
        orig: sel.map(st => st.type === 'fill'
          ? { stroke: st, contour: st.contour.map(p => ({ x: p.x, y: p.y })) }
          : { stroke: st, pts: st.pts.map(p => ({ x: p.x, y: p.y, p: p.p })) }
        ),
        origCx: x0 + w / 2, origCy: y0 + h / 2,
        cx: x0 + w / 2, cy: y0 + h / 2,
        sw: w, sh: h,
        scaleX: 1, scaleY: 1, rot: 0,
        before: cel.snapshot()
      };
      this._initDistortWarp(this.vt);
      this.vt.dirty = false;
      this.transformMode = 'uniform';
      // Pre-rasterise the selected strokes into an offscreen snippet and
      // hide them from the cel cache. During a transform drag the overlay
      // blits this snippet through the live transform matrix (one drawImage
      // per frame) instead of re-rasterising every selected stroke from
      // scratch — turns O(N points) per frame into O(1).
      this._buildPreviewSnippet(this.vt);
      this._hideSelectedFromCel(this.vt, app);
      this._startAnts(app);
      this._showToolbar(app);
      app.ui.status('Lassoed ' + sel.length + ' stroke' + (sel.length === 1 ? '' : 's')
        + ' — handles scale + rotate, drag inside to move. Toolbar: Freeform · Distort · Warp');
    }
    // Free Transform entry: collect every stroke from every drawable
    // layer in scope (single layer, multi-select, or every vector
    // descendant of a folder) and arm the full lasso transform
    // machinery (Uniform / Freeform / Distort / Warp). The canonical
    // "transform a layer" path — invoked from the chip click, the T
    // hotkey, the context menu, and the pen window's chip.
    // Returns true if transform armed; false on nothing-to-transform.
    transformWholeCel(app) {
      const targets = this._collectTransformTargets(app);
      if (!targets || !targets.entries.length) return false;
      if (targets.entries.length === 1 && !targets.forcedMulti) {
        return this._armSingleCelTransform(app, targets.entries[0]);
      }
      return this._armMultiCelTransform(app, targets);
    }
    // Resolve the set of vector cels that Free Transform should operate
    // on, given the current selection. Returns { entries, layerCount,
    // forcedMulti } or null with a status message on failure.
    _collectTransformTargets(app) {
      const fanOut = (layer) => {
        if (!layer) return [];
        if (layer.type === 'vector') return [layer];
        if (layer.type === 'group' && app.layerDescendants) {
          return app.layerDescendants(layer).filter(l => l.type === 'vector');
        }
        return [];
      };
      let layerList = [];
      let forcedMulti = false;
      let primaryHint = null;
      const sel = app.selectedLayers;
      // Use the selected set as the source of truth: clicking a folder
      // sets selectedLayers={folder} while activeLayer auto-falls
      // through to the top drawable inside (so paint tools land on a
      // leaf). For transform we want the folder itself, not its
      // accidental leaf.
      if (sel && sel.size) {
        const setIds = new Set(Array.from(sel).map(l => l.id));
        const roots = app.project.layers.filter(l => sel.has(l) && !setIds.has(l.parentId));
        for (const r of roots) layerList.push(...fanOut(r));
        if (roots.length > 1 || roots.some(r => r.type === 'group')) forcedMulti = true;
        primaryHint = roots[0];
        if (!layerList.length) {
          const r0 = roots[0];
          if (r0 && r0.type === 'group') {
            app.ui.status('Folder "' + r0.name + '" has no drawing layers inside');
          } else if (r0 && r0.type !== 'vector') {
            app.ui.status('Free transform needs a vector drawing layer');
          } else {
            app.ui.status('No layer selected');
          }
          return null;
        }
      } else {
        const active = app.activeLayer();
        if (active && active.type === 'group') forcedMulti = true;
        layerList = fanOut(active);
        primaryHint = active;
        if (!layerList.length) {
          if (active && active.type === 'group') {
            app.ui.status('Folder "' + active.name + '" has no drawing layers inside');
          } else if (active && active.type !== 'vector') {
            app.ui.status('Free transform needs a vector drawing layer');
          } else {
            app.ui.status('No layer selected');
          }
          return null;
        }
      }
      // De-dupe in case a folder + one of its children both made it in.
      layerList = Array.from(new Set(layerList));
      const entries = [];
      for (const layer of layerList) {
        if (layer.locked) continue;
        const cel = layer.celAt(app.frame);
        if (!cel || !cel.strokes || !cel.strokes.length) continue;
        // Fork held exposures so a transform doesn't mutate every
        // shared frame — same protection _lassoRaster uses on lift.
        const targetCel = (typeof layer.forkAt === 'function')
          ? layer.forkAt(app.frame) : cel;
        entries.push({ layer, cel: targetCel, strokes: targetCel.strokes.slice() });
      }
      if (!entries.length) {
        app.ui.status('No drawings on these layers at frame ' + (app.frame + 1) + ' to transform');
        return null;
      }
      return { entries, layerCount: layerList.length, forcedMulti, primaryHint };
    }
    // Original single-cel path — keeps the optimised snippet route and
    // existing cel-local math intact when only one layer is involved.
    _armSingleCelTransform(app, entry) {
      const layer = entry.layer;
      const targetCel = entry.cel;
      const sel = entry.strokes;
      this.vsel = sel;
      this.vcel = targetCel;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const st of sel) {
        const b = V().strokeBounds(st);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
      }
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      this.vt = {
        cel: targetCel, layer, frame: app.frame,
        strokes: sel.slice(),
        orig: sel.map(st => st.type === 'fill'
          ? { stroke: st, contour: st.contour.map(p => ({ x: p.x, y: p.y })) }
          : { stroke: st, pts: st.pts.map(p => ({ x: p.x, y: p.y, p: p.p })) }
        ),
        origCx: x0 + w / 2, origCy: y0 + h / 2,
        cx: x0 + w / 2, cy: y0 + h / 2,
        sw: w, sh: h,
        scaleX: 1, scaleY: 1, rot: 0,
        before: targetCel.snapshot()
      };
      this._initDistortWarp(this.vt);
      this.vt.dirty = false;
      this.transformMode = 'uniform';
      this._buildPreviewSnippet(this.vt);
      this._hideSelectedFromCel(this.vt, app);
      this._startAnts(app);
      this._showToolbar(app);
      app.emit('overlayrender');
      app.ui.status('Free transform — "' + layer.name + '"  ·  Uniform · Freeform · Distort · Warp');
      return true;
    }
    // Multi-cel path — every involved cel keeps its own strokes; points
    // are stored in PROJECT-space so a single transform matrix
    // (cx/cy/sw/sh/scaleX/scaleY/rot) consistently positions strokes
    // across layers with different per-layer pegs. On each frame we
    // mutate each stroke's pts back into its home cel's local coords
    // via layerLocal(). No snippet path — strokes re-render straight
    // from cel.strokes through their layer's transform, so artwork
    // moves visibly under the bounding box on every drag tick.
    _armMultiCelTransform(app, targets) {
      const entries = targets.entries;
      const allStrokes = [];
      const orig = [];
      const cels = [];
      const fwd = (p, layer) => this._celToProjectFwd(p, layer, app.frame, app);
      for (const e of entries) {
        cels.push({ cel: e.cel, before: e.cel.snapshot(), layer: e.layer });
        for (const st of e.strokes) {
          allStrokes.push(st);
          if (st.type === 'fill') {
            orig.push({
              stroke: st, layer: e.layer, cel: e.cel,
              contour: st.contour.map(p => fwd(p, e.layer))
            });
          } else {
            orig.push({
              stroke: st, layer: e.layer, cel: e.cel,
              pts: st.pts.map(p => {
                const w = fwd(p, e.layer);
                return { x: w.x, y: w.y, p: p.p };
              })
            });
          }
        }
      }
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const o of orig) {
        const pts = o.contour || o.pts;
        for (const p of pts) {
          if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
          if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
        }
      }
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      // Primary layer/cel: prefer the selection's primary hint (the
      // folder or first-selected layer the user actually clicked),
      // fall back to active drawable, then to the first entry. Used
      // by overlay hooks expecting a single (layer, cel) pair —
      // overlay sees v.multi and skips applyLayerXform indirection.
      const hint = targets.primaryHint;
      const active = app.activeLayer();
      const primaryEntry =
        (hint && entries.find(e => e.layer === hint))
        || entries.find(e => e.layer === active)
        || entries[0];
      this.vsel = allStrokes;
      this.vcel = primaryEntry.cel;
      this.vt = {
        multi: true, _app: app,
        cel: primaryEntry.cel, layer: primaryEntry.layer, frame: app.frame,
        cels,
        strokes: allStrokes.slice(),
        orig,
        origCx: x0 + w / 2, origCy: y0 + h / 2,
        cx: x0 + w / 2, cy: y0 + h / 2,
        sw: w, sh: h,
        scaleX: 1, scaleY: 1, rot: 0
      };
      this._initDistortWarp(this.vt);
      this.vt.dirty = false;
      this.transformMode = 'uniform';
      // Direct-stroke path: leave every involved cel rendering from
      // cel.strokes so each frame picks up the freshly mutated pts.
      for (const c of cels) c.cel._liveDrawing = false;
      this._startAnts(app);
      this._showToolbar(app);
      app.emit('overlayrender');
      const hintName = targets.primaryHint && targets.primaryHint.type === 'group'
        ? '📁 ' + targets.primaryHint.name
        : (targets.layerCount === 1 ? '"' + primaryEntry.layer.name + '"' : null);
      const tag = hintName
        ? hintName + ' · ' + targets.layerCount + ' ' + (targets.layerCount === 1 ? 'layer' : 'layers') + ' · ' + allStrokes.length + ' strokes'
        : targets.layerCount + ' layers · ' + allStrokes.length + ' strokes';
      app.ui.status('Free transform — ' + tag + '  ·  Uniform · Freeform · Distort · Warp');
      return true;
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
      // Pre-populate the free-transform fields so handles + rotation knob
      // are visible immediately after the loop closes — even before any
      // pixels are actually lifted. Lifting happens lazily on the first
      // real drag (see pointerMove), so a quick lasso-and-Esc still leaves
      // the cel untouched.
      this.raster = {
        canvas: null, lifted: false,
        poly: localPoly, layer: layer, frame: app.frame,
        x: x0, y: y0, w: w, h: h, cel: cel, before: null,
        sw: w, sh: h, cx: x0 + w / 2, cy: y0 + h / 2,
        scaleX: 1, scaleY: 1, rot: 0
      };
      this.transformMode = 'uniform';
      this._startAnts(app);
      this._showToolbar(app);
      app.ui.status('Lassoed a region — handles scale + rotate, drag inside to move. Toolbar: Freeform (Del / Esc)');
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
      // Free-transform fields (cx/cy/sw/sh/scaleX/scaleY/rot) are
      // pre-populated by `_lassoRaster` so handles are visible before lift.
      // Only initialise here as a fallback in case lift is reached via some
      // other code path — never clobber a live transform.
      if (r.sw == null) {
        r.sw = w; r.sh = h;
        r.cx = x0 + w / 2; r.cy = y0 + h / 2;
        r.scaleX = 1; r.scaleY = 1; r.rot = 0;
      }
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
      // Multi-cel transforms run entirely in project-space; the
      // current transformed bbox is just (cx ± sw·scaleX/2, cy ± …).
      if (this.vt && this.vt.multi) {
        const v = this.vt;
        const loc = selLocal(v, pt.x, pt.y);
        return Math.abs(loc.x) <= v.sw / 2 && Math.abs(loc.y) <= v.sh / 2;
      }
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
      // Multi-cel transform Del: nuke every selected stroke across all
      // involved cels in one combined history entry so Ctrl+Z brings it
      // all back at once.
      if (this.vt && this.vt.multi && this.vt.cels) {
        const v = this.vt;
        const cels = v.cels.map(c => ({
          cel: c.cel, before: c.before || c.cel.snapshot()
        }));
        const selSet = new Set(this.vsel);
        for (const c of cels) {
          c.cel.strokes = c.cel.strokes.filter(s => !selSet.has(s));
          c.cel._liveDrawing = false;
          c.cel.rebuild();
        }
        this.vsel = []; this.vt = null;
        this.transformMode = 'uniform';
        this._hideToolbar();
        const afters = cels.map(c => c.cel.snapshot());
        const label = cels.length > 1 ? 'Delete strokes (' + cels.length + ' layers)' : 'Delete strokes';
        app.history.push({
          label,
          undo: () => { for (let i = 0; i < cels.length; i++) cels[i].cel.restore(cels[i].before); app.emit('render'); app.emit('celchange'); },
          redo: () => { for (let i = 0; i < cels.length; i++) cels[i].cel.restore(afters[i]);     app.emit('render'); app.emit('celchange'); }
        });
        app.emit('render'); app.emit('celchange');
        return true;
      }
      if (this.vsel.length && this.vcel) {
        // Use the pre-transform snapshot if one exists, so Del after a
        // partial transform also undoes the transform in one step.
        const before = (this.vt && this.vt.before) ? this.vt.before : this.vcel.snapshot();
        this.vcel.strokes = this.vcel.strokes.filter(s => this.vsel.indexOf(s) < 0);
        // Drop the snippet-mode cache override (no selection means nothing
        // to hide; future strokes need the normal direct-render path).
        this.vcel._liveDrawing = false;
        this.vsel = []; this.vt = null;
        this.transformMode = 'uniform';
        this._hideToolbar();
        this.vcel.rebuild();
        app.history.pushCelEdit('Delete strokes', this.vcel, before);
        app.emit('render'); app.emit('celchange');
        return true;
      }
      if (this.raster) {
        const r = this.raster;
        this.raster = null;
        this.transformMode = 'uniform';
        this._hideToolbar();
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
    // Esc -> drop the selection, restoring any in-flight transform.
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
      if (this.vt && this.vt.multi && this.vt.cels) {
        // Multi-cel: restore each involved cel from its own pre-arm snapshot.
        for (const c of this.vt.cels) {
          c.cel._liveDrawing = false;
          c.cel.restore(c.before);
        }
        app.emit('celchange'); app.emit('render');
      } else if (this.vt && this.vt.cel && this.vt.before) {
        // Roll back any in-flight scale / rotate / move on a vector lasso.
        // restore() replaces cel.strokes with the pre-lasso snapshot — none
        // of those strokes carry _lassoHidden, so we automatically come out
        // of snippet-mode.
        this.vt.cel._liveDrawing = false;
        this.vt.cel.restore(this.vt.before);
        app.emit('celchange'); app.emit('render');
      }
      this.vsel = []; this.vcel = null; this.vt = null;
      this.transformMode = 'uniform';
      this._hideToolbar();
      app.emit('overlayrender');
    }
    hasSelection() { return this.vsel.length > 0 || !!this.raster; }

    // Recolor every selected vector stroke. Called from app.setColor so a
    // simple "lasso → click a swatch" flow recolours the lines in place.
    // Pushes one history entry so Ctrl+Z restores the previous colours.
    recolorSelection(hex, app) {
      if (!this.vsel.length || !this.vcel) return false;
      // Skip no-op recolours (every selected stroke already this colour).
      let anyChange = false;
      for (const st of this.vsel) {
        if (st.color !== hex) { anyChange = true; break; }
      }
      if (!anyChange) return false;
      const before = this.vcel.snapshot();
      for (const st of this.vsel) st.color = hex;
      // If a transform session has a snippet, the snippet was rendered with
      // the old colour — rebuild it so the live overlay shows the new tint.
      if (this.vt && this.vt.preview && (this.transformMode === 'uniform'
          || this.transformMode === 'freeform')) {
        this._buildPreviewSnippet(this.vt);
      }
      // Refresh the cel cache (whether the strokes are hidden or not the
      // cache needs to reflect any newly-visible colours).
      this.vcel.rebuild();
      app.history.pushCelEdit('Recolor selection', this.vcel, before);
      if (this.vt) this.vt.dirty = true;
      app.emit('render'); app.emit('celchange');
      return true;
    }

    // Marching ants done well: a faint dark halo underneath for legibility on
    // bright artwork, then two interleaved dashed strokes (black + white
    // offset by one dash) on top to produce the classic alternating tick
    // pattern. Rounded line caps soften the otherwise pixel-harsh ticks.
    _ants(ctx, zoom, tracePath) {
      const t = performance.now() / 75;
      const dash = 4.5 / zoom;
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
      // Soft outer halo — only visible on bright artwork; keeps the ants
      // readable without the heavy 2.6 px black underline the old version
      // used (which read as a thick dark line, not "marching ants").
      ctx.lineWidth = 3.2 / zoom;
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.setLineDash([]);
      tracePath();
      ctx.stroke();
      // Alternating black + white ticks
      ctx.lineWidth = 1.1 / zoom;
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = -t;
      ctx.strokeStyle = '#0b0b0c';
      tracePath();
      ctx.stroke();
      ctx.lineDashOffset = -t + dash;
      ctx.strokeStyle = '#fff';
      tracePath();
      ctx.stroke();
      ctx.restore();
    }
    /* ---------------- floating selection toolbar ---------------- */
    _bindToolbar(app) {
      if (this._toolbarBound) return;
      const tb = document.getElementById('lasso-toolbar');
      if (!tb) return;
      this._toolbarBound = true;
      this._toolbarEl = tb;
      // Prevent the canvas pointerdown handler from clearing the selection
      // when the user actually meant to click a toolbar button.
      tb.addEventListener('mousedown', e => e.stopPropagation());
      tb.addEventListener('pointerdown', e => e.stopPropagation());
      tb.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const mode = btn.dataset.mode;
        // Delegate to whichever transform-capable tool currently owns the
        // toolbar. The lasso path stays the fallback so existing flows
        // (drawn-loop selection) keep working unchanged.
        const owner = app.tools.active;
        if (owner && owner !== this && owner.toolbarAction) {
          owner.toolbarAction(mode, app);
          return;
        }
        if (mode === 'commit') {
          this._commitRaster(app); this._commitVector(app);
          this.vsel = []; this.vcel = null;
          this.transformMode = 'uniform';
          this._hideToolbar();
          app.emit('render'); app.emit('overlayrender');
          return;
        }
        if (mode === 'cancel') { this.cancel(app); return; }
        this.setTransformMode(mode, app);
      });
    }
    _showToolbar(app) {
      this._bindToolbar(app);
      if (!this._toolbarEl) return;
      this._toolbarEl.classList.remove('hidden');
      this._refreshToolbar();
      this._positionToolbar(app);
      // Re-position once on next frame so the clamp uses the toolbar's
      // actual rendered width (offsetWidth is 0 right after removing
      // `.hidden` and before the browser has reflowed).
      requestAnimationFrame(() => this._positionToolbar(app));
    }
    _hideToolbar() {
      if (this._toolbarEl) this._toolbarEl.classList.add('hidden');
    }
    _refreshToolbar() {
      if (!this._toolbarEl) return;
      const btns = this._toolbarEl.querySelectorAll('button');
      for (const b of btns) {
        const m = b.dataset.mode;
        b.classList.toggle('active', m === this.transformMode);
        // Reset is a transform-tool-only action (it clears layer keyframes,
        // which the lasso path doesn't use). Hide it on the lasso path.
        if (m === 'reset') { b.style.display = 'none'; continue; }
        else b.style.display = '';
        // Distort and Warp aren't available on raster lassos in this build —
        // grey them out and revert silently to Freeform if clicked.
        if ((m === 'distort' || m === 'warp') && this.raster && !this.vt) {
          b.style.opacity = '0.45';
          b.title = (b.title.split(' — ')[0]) + ' — vector layers only';
        } else if (m === 'distort' || m === 'warp') {
          b.style.opacity = '';
        }
      }
    }
    _positionToolbar(app) {
      if (!this._toolbarEl) return;
      if (!this.vt && !this.raster) { this._hideToolbar(); return; }
      const sel = this.vt || this.raster;
      const tm = this.transformMode;
      // Mode-aware top-mid in cel-local space — for distort / warp we use the
      // ACTUAL current shape (corner-midpoint or curve mid) so the toolbar
      // follows the artwork as it bends, rather than sitting above an
      // outdated affine bbox.
      let topMid;
      if (this.vt && tm === 'distort' && sel.distortC) {
        const a = sel.distortC[0], b = sel.distortC[1];
        topMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      } else if (this.vt && tm === 'warp' && sel.warpC && sel.warpM) {
        // Midpoint of the top quadratic edge: B(0.5) for c0,m,c1
        const c0 = sel.warpC[0], c1 = sel.warpC[1], m = sel.warpM[0];
        topMid = {
          x: 0.25 * c0.x + 0.5 * m.x + 0.25 * c1.x,
          y: 0.25 * c0.y + 0.5 * m.y + 0.25 * c1.y
        };
      } else {
        const a = selAnchor(1, sel.sw, sel.sh);
        topMid = selWorld(sel, a.x, a.y);
      }
      // cel-local -> project space (multi-cel transforms already live
      // in project-space, so skip the per-layer detour).
      const layer = sel.layer || app.activeLayer();
      const frame = sel.frame != null ? sel.frame : app.frame;
      const proj = (this.vt && this.vt.multi)
        ? topMid
        : this._celToProjectFwd(topMid, layer, frame, app);
      // project -> canvas-internal CSS pixels. Because #canvas is positioned
      // at #viewport's (0,0), these coords are *also* the correct CSS values
      // for an absolutely-positioned child of #viewport — no rect subtraction.
      const sc = app.stage.projectToScreen(proj.x, proj.y);
      const viewport = document.getElementById('viewport');
      if (!viewport) return;
      const gap = 22;   // CSS px above the bbox top edge
      let x = sc.x;
      let y = sc.y - gap;
      // Keep the toolbar fully inside the viewport on edge-anchored selections.
      const tbW = this._toolbarEl.offsetWidth || 360;
      x = Math.max(tbW / 2 + 8, Math.min(viewport.clientWidth - tbW / 2 - 8, x));
      y = Math.max(36, y);
      this._toolbarEl.style.left = x + 'px';
      this._toolbarEl.style.top = y + 'px';
    }
    // Forward layer transform applied to a point: cel-local -> project-space.
    _celToProjectFwd(pt, layer, frame, app) {
      if (!layer || !layer.transformAt) return { x: pt.x, y: pt.y };
      const tr = layer.transformAt(frame);
      if (!tr.x && !tr.y && !tr.rot && tr.sx === 1 && tr.sy === 1)
        return { x: pt.x, y: pt.y };
      const p = app.project, px = p.width / 2, py = p.height / 2;
      const lx = (pt.x - px) * tr.sx, ly = (pt.y - py) * tr.sy;
      const rad = tr.rot * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
      return { x: lx * c - ly * s + px + tr.x, y: lx * s + ly * c + py + tr.y };
    }

    /* ---------------- preview snippet (fast affine drag) ---------------- */
    // Render the selected strokes into an offscreen canvas the size of their
    // bbox. Anchored to origCx/origCy so the overlay can place it via
    // translate(cx,cy); rotate(rot); scale(scaleX,scaleY); drawImage(snippet,
    // -origCx, -origCy) — a single drawImage per frame regardless of stroke
    // count or point density.
    _buildPreviewSnippet(v) {
      if (!v || !v.cel || v.multi) return;
      const cw = v.cel.w, ch = v.cel.h;
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Render selected strokes at their current cel-local positions.
      // Fills first so lines sit on top of fills (matches renderCel ordering).
      for (const st of v.strokes) if (st.type === 'fill') V().renderStroke(ctx, st);
      for (const st of v.strokes) if (st.type !== 'fill') V().renderStroke(ctx, st);
      v.preview = c;
      v.previewW = cw;
      v.previewH = ch;
    }
    // Flag the selected strokes as "hidden" so the renderer (both the cache
    // path and the direct-from-strokes path) skips them. The flag is cleared
    // on commit / cancel / mode-switch when the snippet path stops being
    // used.
    _hideSelectedFromCel(v, app) {
      if (!v || !v.cel || v.multi) return;
      for (const st of v.strokes) st._lassoHidden = true;
      // Force the cache route during the transform session so compositeStage
      // uses cel.canvas (which now excludes the hidden strokes) instead of
      // re-rendering every stroke per frame.
      v.cel._liveDrawing = true;
      // One cache rebuild now — every subsequent frame is O(1).
      v.cel.rebuild();
      app.emit('render');
    }
    _showSelectedInCel(v, app) {
      if (!v || !v.cel || v.multi) return;
      for (const st of v.strokes) st._lassoHidden = false;
      v.cel._liveDrawing = false;
      v.cel.rebuild();
      if (app) app.emit('render');
    }

    /* ---------------- distort / warp data ---------------- */
    // Initialise the distort and warp control points so they start from the
    // current bbox shape. Called when entering distort / warp modes (or when
    // a new selection is created). The arrays are: distortC = TL, TR, BR, BL
    // in cel-local coords; warpC = same 4 corners; warpM = T, R, B, L edge
    // midpoints. Subsequent drags update these directly.
    _initDistortWarp(s) {
      if (!s) return;
      // Use the current transformed bbox so toggling modes feels seamless.
      const corners = [
        selWorld(s, -s.sw / 2, -s.sh / 2),
        selWorld(s,  s.sw / 2, -s.sh / 2),
        selWorld(s,  s.sw / 2,  s.sh / 2),
        selWorld(s, -s.sw / 2,  s.sh / 2)
      ];
      s.distortC = corners.map(p => ({ x: p.x, y: p.y }));
      s.warpC    = corners.map(p => ({ x: p.x, y: p.y }));
      s.warpM = [
        { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 },
        { x: (corners[1].x + corners[2].x) / 2, y: (corners[1].y + corners[2].y) / 2 },
        { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 },
        { x: (corners[3].x + corners[0].x) / 2, y: (corners[3].y + corners[0].y) / 2 }
      ];
    }
    // Map a point in [origCx-sw/2, origCx+sw/2] x [origCy-sh/2, origCy+sh/2]
    // to [0,1]² for use by the bilinear / Coons mappings.
    _uv(s, x, y) {
      const u = (x - (s.origCx - s.sw / 2)) / s.sw;
      const v = (y - (s.origCy - s.sh / 2)) / s.sh;
      return { u, v };
    }
    // Bilinear blend of 4 corner positions at (u, v) in [0,1]².
    _bilinear(c, u, v) {
      const um = 1 - u, vm = 1 - v;
      return {
        x: um * vm * c[0].x + u * vm * c[1].x + u * v * c[2].x + um * v * c[3].x,
        y: um * vm * c[0].y + u * vm * c[1].y + u * v * c[2].y + um * v * c[3].y
      };
    }
    // Coons patch with quadratic-bezier edges: 4 corner + 4 edge-midpoint
    // control points let the user curve any edge while preserving the corner
    // positions exactly.
    _coons(c, m, u, v) {
      const um = 1 - u, vm = 1 - v;
      // Quadratic bezier along each edge (control midpoint = m[i])
      const Bt = { x: um*um*c[0].x + 2*u*um*m[0].x + u*u*c[1].x,
                   y: um*um*c[0].y + 2*u*um*m[0].y + u*u*c[1].y };
      const Bb = { x: um*um*c[3].x + 2*u*um*m[2].x + u*u*c[2].x,
                   y: um*um*c[3].y + 2*u*um*m[2].y + u*u*c[2].y };
      const Bl = { x: vm*vm*c[0].x + 2*v*vm*m[3].x + v*v*c[3].x,
                   y: vm*vm*c[0].y + 2*v*vm*m[3].y + v*v*c[3].y };
      const Br = { x: vm*vm*c[1].x + 2*v*vm*m[1].x + v*v*c[2].x,
                   y: vm*vm*c[1].y + 2*v*vm*m[1].y + v*v*c[2].y };
      const Cb = this._bilinear(c, u, v);
      return {
        x: vm * Bt.x + v * Bb.x + um * Bl.x + u * Br.x - Cb.x,
        y: vm * Bt.y + v * Bb.y + um * Bl.y + u * Br.y - Cb.y
      };
    }

    // One polished square handle — soft drop shadow, white fill, thin dark
    // border, slightly larger than the old version so it's easy to grab on a
    // Cintiq. Used for all corner/edge handles in every transform mode.
    _handleSquare(ctx, x, y, zoom) {
      const hs = 5.5 / zoom;
      // Soft offset shadow (slight blur via two passes at different alphas)
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x - hs + 0.6 / zoom, y - hs + 1.2 / zoom, hs * 2, hs * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(x - hs + 0.3 / zoom, y - hs + 0.6 / zoom, hs * 2, hs * 2);
      // Body — crisp white square with thin dark border
      ctx.lineWidth = 1.2 / zoom;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#1a1c20';
      ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
      ctx.strokeRect(x - hs, y - hs, hs * 2, hs * 2);
    }
    _drawCornerHandles(ctx, corners, zoom) {
      ctx.save();
      ctx.lineJoin = 'miter';
      for (const c of corners) this._handleSquare(ctx, c.x, c.y, zoom);
      ctx.restore();
    }
    _drawMidHandles(ctx, mids, zoom) {
      // Diamond — visually distinct from the square corners. Warm cream fill
      // so the eye can tell "this controls the edge curvature" at a glance.
      const hs = 5 / zoom;
      ctx.save();
      ctx.lineJoin = 'miter';
      for (const m of mids) {
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.moveTo(m.x + 0.3 / zoom, m.y - hs + 0.6 / zoom);
        ctx.lineTo(m.x + hs + 0.3 / zoom, m.y + 0.6 / zoom);
        ctx.lineTo(m.x + 0.3 / zoom, m.y + hs + 0.6 / zoom);
        ctx.lineTo(m.x - hs + 0.3 / zoom, m.y + 0.6 / zoom);
        ctx.closePath();
        ctx.fill();
        // Body
        ctx.lineWidth = 1.2 / zoom;
        ctx.fillStyle = '#f7c869';   // warm cream/amber to mark "edge control"
        ctx.strokeStyle = '#1a1c20';
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - hs);
        ctx.lineTo(m.x + hs, m.y);
        ctx.lineTo(m.x, m.y + hs);
        ctx.lineTo(m.x - hs, m.y);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
    // 8 scale handles around the bbox plus a rotation knob hovering above
    // the top edge. The knob is visually distinct — circular, slightly
    // larger, with a curved-arrow tick inside to signal rotation.
    _drawTransformHandles(ctx, r, zoom) {
      const kr = 7 / zoom;
      const tc = selWorld(r, 0, -r.sh / 2);
      const rh = selRotHandleWorld(r, zoom);
      ctx.save();
      ctx.lineCap = 'round';
      // Stem from the top of the bbox to the rotation knob — solid dark
      // base + thin white overlay so it reads on any artwork.
      ctx.lineWidth = 1.4 / zoom;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.moveTo(tc.x, tc.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
      ctx.lineWidth = 0.6 / zoom;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.moveTo(tc.x, tc.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
      ctx.lineCap = 'butt';
      // 8 corner/edge scale handles
      for (let i = 0; i < 8; i++) {
        const a = selAnchor(i, r.sw, r.sh);
        const w = selWorld(r, a.x, a.y);
        this._handleSquare(ctx, w.x, w.y, zoom);
      }
      // Rotation knob: shadow, accent ring, white body, curved arrow icon
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath(); ctx.arc(rh.x + 0.4 / zoom, rh.y + 0.9 / zoom, kr, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.4 / zoom;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#1a1c20';
      ctx.beginPath(); ctx.arc(rh.x, rh.y, kr, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      // Curved rotation arrow inside the knob
      ctx.lineWidth = 1.5 / zoom;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#1a1c20';
      const ir = kr * 0.5;
      const a0 = Math.PI * 0.25, a1 = Math.PI * 1.65;
      ctx.beginPath();
      ctx.arc(rh.x, rh.y, ir, a0, a1);
      ctx.stroke();
      // Tiny arrowhead at the end of the arc
      const tipX = rh.x + Math.cos(a1) * ir;
      const tipY = rh.y + Math.sin(a1) * ir;
      const ah = 2.6 / zoom;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(a1 - Math.PI * 0.75) * ah,
                 tipY + Math.sin(a1 - Math.PI * 0.75) * ah);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(a1 + Math.PI * 0.55) * ah,
                 tipY + Math.sin(a1 + Math.PI * 0.55) * ah);
      ctx.stroke();
      ctx.restore();
    }
    drawOverlay(ctx, app) {
      const zoom = app.stage.view.zoom;
      // Keep the floating toolbar pinned to the live selection on every
      // overlay paint. Cheap (one matrix multiply + DOM style write).
      if (this.vt || this.raster) this._positionToolbar(app);
      else this._hideToolbar();
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
      if (this.vt && this.vsel && this.vsel.length) {
        // Marching ants + handles, drawn through the active layer's
        // transform so the overlay visually wraps the rendered artwork.
        // Multi-cel: orig pts are already in project-space, so the
        // overlay draws straight (skip the per-layer xform).
        const v = this.vt;
        const tm = this.transformMode;
        ctx.save();
        if (!v.multi) {
          applyLayerXform(ctx, v.layer || app.activeLayer(),
            v.frame != null ? v.frame : app.frame, app);
        }
        // Snippet path (affine modes): the selected strokes are hidden from
        // the cel cache; blit the pre-rendered snippet through the live
        // affine transform — one drawImage per frame regardless of stroke
        // count. Distort / Warp can't be expressed as a single affine, so
        // they fall back to the slow path (strokes mutated per frame via
        // _applyVTransform, rendered straight from cel.strokes).
        if (v.preview && (tm === 'uniform' || tm === 'freeform')) {
          ctx.save();
          ctx.translate(v.cx, v.cy);
          ctx.rotate(v.rot || 0);
          ctx.scale(v.scaleX || 1, v.scaleY || 1);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(v.preview, -v.origCx, -v.origCy);
          ctx.restore();
        }
        // Outline trace varies per mode: affine = transformed bbox quad;
        // distort = the 4 user-controlled corners; warp = a sampled curve
        // along each Coons edge so the user actually sees the curvature.
        let trace;
        if (tm === 'distort' && v.distortC) {
          const C = v.distortC;
          trace = () => {
            ctx.beginPath();
            ctx.moveTo(C[0].x, C[0].y);
            for (let i = 1; i < 4; i++) ctx.lineTo(C[i].x, C[i].y);
            ctx.closePath();
          };
        } else if (tm === 'warp' && v.warpC && v.warpM) {
          const C = v.warpC, M = v.warpM;
          trace = () => {
            ctx.beginPath();
            // Each edge as a quadratic bezier through the midpoint control.
            ctx.moveTo(C[0].x, C[0].y);
            ctx.quadraticCurveTo(2 * M[0].x - (C[0].x + C[1].x) / 2,
                                 2 * M[0].y - (C[0].y + C[1].y) / 2,
                                 C[1].x, C[1].y);
            ctx.quadraticCurveTo(2 * M[1].x - (C[1].x + C[2].x) / 2,
                                 2 * M[1].y - (C[1].y + C[2].y) / 2,
                                 C[2].x, C[2].y);
            ctx.quadraticCurveTo(2 * M[2].x - (C[3].x + C[2].x) / 2,
                                 2 * M[2].y - (C[3].y + C[2].y) / 2,
                                 C[3].x, C[3].y);
            ctx.quadraticCurveTo(2 * M[3].x - (C[0].x + C[3].x) / 2,
                                 2 * M[3].y - (C[0].y + C[3].y) / 2,
                                 C[0].x, C[0].y);
            ctx.closePath();
          };
        } else {
          const corners = [0, 2, 4, 6].map(i => {
            const a = selAnchor(i, v.sw, v.sh);
            return selWorld(v, a.x, a.y);
          });
          trace = () => {
            ctx.beginPath();
            ctx.moveTo(corners[0].x, corners[0].y);
            for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
            ctx.closePath();
          };
        }
        this._ants(ctx, zoom, trace);
        // Handles only appear once the artist opts into a transform mode.
        if (tm === 'freeform' || tm === 'uniform') {
          this._drawTransformHandles(ctx, v, zoom);
        } else if (tm === 'distort' && v.distortC) {
          this._drawCornerHandles(ctx, v.distortC, zoom);
        } else if (tm === 'warp' && v.warpC && v.warpM) {
          this._drawCornerHandles(ctx, v.warpC, zoom);
          this._drawMidHandles(ctx, v.warpM, zoom);
        }
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
        // Marching-ants outline: the actual polygon while unlifted, the
        // transformed bbox once the artist starts squashing/rotating.
        if (r.lifted) {
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
        } else if (r.poly) {
          const trace = () => {
            ctx.beginPath();
            ctx.moveTo(r.poly[0].x, r.poly[0].y);
            for (let i = 1; i < r.poly.length; i++) ctx.lineTo(r.poly[i].x, r.poly[i].y);
            ctx.closePath();
          };
          this._ants(ctx, zoom, trace);
        }
        // Handles only appear once the artist opts into a transform mode
        // via the floating toolbar — default is Move-only, like a
        // Photoshop shift-select.
        const tm = this.transformMode;
        if (tm === 'freeform' || tm === 'uniform') {
          this._drawTransformHandles(ctx, r, zoom);
        }
        ctx.restore();
      }
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
    // Forward predicted samples (from PointerEvent.getPredictedEvents) to
    // the active stroke tool. Points arrive in PROJECT space from canvas.js;
    // CEL_TOOLS need them in the active layer's cel-local space, so apply
    // the same transform _map applies to live events. Tools that don't
    // implement setPredicted (selects, fill, etc.) silently drop them.
    setPredicted(pts) {
      const t = this._strokeTool || this.active;
      if (!t || typeof t.setPredicted !== 'function') return;
      if (!pts || !pts.length) { t.setPredicted(null); return; }
      const mapped = pts.map(p => this._map(p, t));
      t.setPredicted(mapped);
    }
    drawOverlay(ctx) { if (this.active.drawOverlay) this.active.drawOverlay(ctx, this.app); }
  }

  OT.ToolManager = ToolManager;
})(window.OT);
