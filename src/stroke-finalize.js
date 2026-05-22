/* OpenToon Studio - shared stroke finalize pipeline.

   Both the main brush/pencil tools and the pen window's wet-stroke
   handler call into this module so the wet preview and the committed
   stroke produce IDENTICAL pts -- which is what eliminates the
   "settle" visible on commit today.

   All exports are pure: no `this`, no DOM, no `app`, no mutation of
   inputs. The pen window depends on this so the per-rAF finalize
   doesn't accidentally mutate state shared with main. */
(function (OT) {
  'use strict';

  // Ink-pen velocity dynamics. Scales each point's pressure by a factor
  // that shrinks with stroke speed. Returns a NEW pts array with new
  // point objects -- does NOT mutate the input. Requires `.t` timestamps
  // in ms on each point (set by the tool's _vMove). Points without `.t`
  // are passed through unmodified.
  function applyInkDynamics(pts) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const out = new Array(n);
    const speed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dt = (b.t - a.t) || 1;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      speed[i] = d / Math.max(0.5, dt);
    }
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = speed[Math.max(0, i - 1)], b = speed[i], c = speed[Math.min(n - 1, i + 1)];
      sm[i] = (a + 2 * b + c) * 0.25;
    }
    const k = 0.2, lo = 0.45;
    for (let i = 0; i < n; i++) {
      const m = Math.max(lo, Math.min(1, 1 - k * sm[i]));
      const src = pts[i];
      const p = src.p == null ? 1 : src.p;
      out[i] = { x: src.x, y: src.y, t: src.t, p: p * m };
    }
    return out;
  }

  // Nearest line-stroke endpoint within `radius`. Mirrors OT.Vector's
  // snapPoint but returns a NEW pts array with first/last point moved
  // to the snap targets (if found). Does not mutate input. `cel` must
  // have a `strokes` array; if cel is null the input passes through.
  function snapEndpoints(pts, cel, radius) {
    if (!cel || !cel.strokes || pts.length < 2 || radius <= 0) return pts;
    const V = OT.Vector;
    if (!V || !V.snapPoint) return pts;
    const first = pts[0], last = pts[pts.length - 1];
    const s0 = V.snapPoint(cel, first.x, first.y, radius);
    const sN = V.snapPoint(cel, last.x, last.y, radius);
    if (!s0 && !sN) return pts;
    const out = pts.slice();
    if (s0) out[0] = { x: s0.x, y: s0.y, p: first.p, t: first.t };
    if (sN) out[out.length - 1] = { x: sN.x, y: sN.y, p: last.p, t: last.t };
    return out;
  }

  // If first/last points are within `radius`, set last := first and
  // return closed=true. Otherwise return closed=false and pts unchanged.
  // Returns `{ pts, closed }`. Requires pts.length > 3 to avoid closing
  // tiny tick marks the artist didn't mean to loop.
  function maybeAutoClose(pts, radius) {
    if (pts.length <= 3 || radius <= 0) return { pts, closed: false };
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) >= radius * 1.3) return { pts, closed: false };
    const out = pts.slice();
    out[out.length - 1] = { x: a.x, y: a.y, p: b.p, t: b.t };
    return { pts: out, closed: true };
  }

  // The full finalize pipeline. Apply in order:
  //   inkDynamics (opt-in)  ->  simplify  ->  snapEndpoints (when cel given)
  //   ->  maybeAutoClose (opt-in)
  //
  // Deterministic and idempotent: finalize(finalize(x).pts).pts has the
  // same shape as finalize(x).pts. Calling per-rAF during a drag and
  // once more at commit produces the SAME pts both times -- which is
  // the entire point of the module.
  //
  // opts: {
  //   tol:         number  (RDP simplify tolerance, e.g. 0.4 + smooth*0.8)
  //   snapDist:    number  (endpoint snap radius)
  //   inkDynamics: bool
  //   autoClose:   bool
  //   cel:         Cel | null  (only used by snapEndpoints; pen window
  //                              passes its mirrored cel; main passes
  //                              the active cel)
  // }
  function finalize(rawPts, opts) {
    if (!rawPts || rawPts.length === 0) return { pts: [], closed: false };
    opts = opts || {};
    const V = OT.Vector;
    let pts = rawPts;
    if (opts.inkDynamics) pts = applyInkDynamics(pts);
    if (V && V.simplify && opts.tol != null) {
      pts = V.simplify(pts, opts.tol);
      if (pts.length < 2 && rawPts.length >= 2) pts = rawPts.slice(0, 2);
    }
    if (opts.cel && opts.snapDist) pts = snapEndpoints(pts, opts.cel, opts.snapDist);
    let closed = false;
    if (opts.autoClose && opts.snapDist) {
      const ac = maybeAutoClose(pts, opts.snapDist);
      pts = ac.pts; closed = ac.closed;
    }
    return { pts, closed };
  }

  OT.StrokeFinalize = { applyInkDynamics, snapEndpoints, maybeAutoClose, finalize };
})(window.OT = window.OT || {});
