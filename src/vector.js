/* OpenToon Studio - vector geometry: smoothing, rendering, hit-test, smart fill */
(function (OT) {
  'use strict';
  const U = OT.util;
  const _cache = new WeakMap();   // st.pts array -> sampled smooth path

  /* ----------------------------- geometry ----------------------------- */
  function ptSegDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = a.x + dx * t, cy = a.y + dy * t;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  // Ramer-Douglas-Peucker simplification (keeps pressure on surviving pts).
  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const seg = stack.pop(), a = seg[0], b = seg[1];
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = ptSegDist(pts[i], pts[a], pts[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  // Moving-average smoothing that de-jitters a hand-drawn path (endpoints fixed).
  function smoothPts(pts, iterations) {
    if (pts.length < 3 || iterations <= 0)
      return pts.map(p => ({ x: p.x, y: p.y, p: p.p }));
    let cur = pts.map(p => ({ x: p.x, y: p.y, p: p.p }));
    for (let it = 0; it < iterations; it++) {
      const next = cur.map(p => ({ x: p.x, y: p.y, p: p.p }));
      for (let i = 1; i < cur.length - 1; i++) {
        next[i].x = cur[i - 1].x * 0.25 + cur[i].x * 0.5 + cur[i + 1].x * 0.25;
        next[i].y = cur[i - 1].y * 0.25 + cur[i].y * 0.5 + cur[i + 1].y * 0.25;
      }
      cur = next;
    }
    return cur;
  }

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    const f = (a, b, c, d) =>
      0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    const g = k => k == null ? 1 : k;
    return {
      x: f(p0.x, p1.x, p2.x, p3.x),
      y: f(p0.y, p1.y, p2.y, p3.y),
      p: f(g(p0.p), g(p1.p), g(p2.p), g(p3.p), t)
    };
  }

  // Sample a smooth Catmull-Rom path through control points.
  function smoothPath(pts, closed) {
    if (!pts || !pts.length) return [];
    if (pts.length < 3)
      return pts.map(p => ({ x: p.x, y: p.y, p: p.p == null ? 1 : p.p }));
    const src = closed ? pts.concat([pts[0], pts[1]]) : pts;
    const out = [];
    const n = src.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = src[Math.max(0, i - 1)], p1 = src[i];
      const p2 = src[i + 1], p3 = src[Math.min(n - 1, i + 2)];
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const steps = Math.max(2, Math.min(40, Math.ceil(d / 4)));
      for (let s = 0; s < steps; s++) out.push(catmull(p0, p1, p2, p3, s / steps));
    }
    const last = src[n - 1];
    out.push({ x: last.x, y: last.y, p: last.p == null ? 1 : last.p });
    return out;
  }

  function samplesOf(st) {
    if (st.sharp) return st.pts;        // shapes keep crisp corners
    let c = _cache.get(st.pts);
    if (!c) { c = smoothPath(st.pts, st.closed); _cache.set(st.pts, c); }
    return c;
  }

  /* ----------------------------- rendering ----------------------------- */
  function pathThrough(ctx, pts, closed) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.closePath();
  }

  function stampPolyline(ctx, pts, radiusFn, closed) {
    const n = pts.length;
    if (n === 0) return;
    // Initial dab so a single-point stroke still renders.
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(0.4, radiusFn(pts[0], 0)), 0, 7);
    ctx.fill();
    const segment = (a, b, ia, ib) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ra = radiusFn(a, ia), rb = radiusFn(b, ib);
      // Krita/MyPaint-style 15% spacing for hard brushes -- clean edges.
      const step = Math.max(0.6, Math.min(ra, rb) * 0.15);
      const segN = Math.max(1, Math.ceil(d / step));
      for (let k = 1; k <= segN; k++) {
        const t = k / segN;
        ctx.beginPath();
        ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
          Math.max(0.4, ra + (rb - ra) * t), 0, 7);
        ctx.fill();
      }
    };
    for (let i = 1; i < n; i++) segment(pts[i - 1], pts[i], i - 1, i);
    // Closing segment for closed shapes — without this, brush-rendered
    // circles/squares from QuickShape (or any closed stroke) leave a gap
    // between the last point and the first.
    if (closed && n > 1) segment(pts[n - 1], pts[0], n - 1, 0);
  }

  // Build a taper envelope (values in [0,1]) along the sampled path so the
  // brush ramps in/out smoothly at stroke ends. Returns null when the stroke
  // should not be tapered (too short, closed, sharp shape, or opted out).
  function computeTaperEnv(pts, st) {
    const n = pts.length;
    if (st.taper === false) return null;
    if (st.closed) return null;
    if (st.sharp) return null;
    if (n < 6) return null;
    // arc length per sample
    const cum = new Float64Array(n);
    let L = 0;
    for (let i = 1; i < n; i++) {
      L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      cum[i] = L;
    }
    if (L < 12) return null;
    const maxTaperPx = 60;
    const taperLen = Math.min(0.08 * L, maxTaperPx);
    if (taperLen <= 0) return null;
    // Industry-standard taper has a NON-ZERO tip floor (Photoshop "Minimum
    // Diameter", Procreate's fine-tip setting) — otherwise the very first
    // and last stamps render at radius 0, making the stroke literally begin
    // and end at an invisible point. A 0.35 floor means the tip is 35% of
    // full brush width and ramps up to 100% over the taper region.
    const TIP_FLOOR = 0.35;
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = cum[i];
      let e = 1;
      if (s < taperLen) {
        const t = s / taperLen;
        const ss = t * t * (3 - 2 * t);     // cubic ease-in (smoothstep)
        e = TIP_FLOOR + (1 - TIP_FLOOR) * ss;
      } else if (s > L - taperLen) {
        const t = (L - s) / taperLen;
        const ss = t * t * (3 - 2 * t);     // cubic ease-out (smoothstep)
        e = TIP_FLOOR + (1 - TIP_FLOOR) * ss;
      }
      env[i] = e;
    }
    return env;
  }

  // Two distinct line styles, matching the industry-standard split:
  //
  //   PENCIL (st.pencil === true) — centerline vector line, UNIFORM width
  //     and density. The cleanup-line tool. Drawn as a single antialiased
  //     polyline stroke. Used for: final ink, character outlines, anything
  //     that needs auto-patch / consistent fill-friendly contours.
  //     Reference: Toon Boom Harmony pencil tool, Clip Studio Paint pen.
  //
  //   BRUSH (st.pencil falsy) — contour vector line, VARIABLE width via
  //     pressure (and optional velocity dynamics). Stamped circles. Used
  //     for: sketching, rough animation, painterly work.
  //     Reference: Toon Boom Harmony brush tool, CSP brush.
  //
  // Both tools share the same point-sampling, smoothing, and snapping
  // upstream — the rendering style here is the actual visual distinction.
  function renderLine(ctx, st) {
    const pts = samplesOf(st);
    if (!pts.length) return;
    const op = st.opacity == null ? 1 : st.opacity;
    if (st.pencil) {
      ctx.save();
      // Multiply rather than assign so the ambient globalAlpha (set by the
      // layer composite to layer.opacity) is preserved.
      ctx.globalAlpha *= op;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (pts.length === 1) {
        ctx.fillStyle = st.color;
        ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, st.width / 2, 0, 7); ctx.fill();
      } else { pathThrough(ctx, pts, st.closed); ctx.stroke(); }
      ctx.restore();
      return;
    }
    // brush: stamp circles (variable width by pressure), with auto-taper at ends
    const env = computeTaperEnv(pts, st);
    const radius = env
      ? (p, i) => st.width / 2 * (p.p == null ? 1 : p.p) * env[i]
      : (p)    => st.width / 2 * (p.p == null ? 1 : p.p);
    if (op >= 1) {
      ctx.save();
      ctx.fillStyle = st.color;
      stampPolyline(ctx, pts, radius, st.closed);
      ctx.restore();
    } else {
      const b = document.createElement('canvas');
      b.width = ctx.canvas.width; b.height = ctx.canvas.height;
      const bx = b.getContext('2d');
      bx.fillStyle = st.color;
      stampPolyline(bx, pts, radius, st.closed);
      ctx.save();
      ctx.globalAlpha *= op;
      ctx.drawImage(b, 0, 0);
      ctx.restore();
    }
  }

  function renderFill(ctx, st) {
    if (!st.contour || st.contour.length < 3) return;
    ctx.save();
    ctx.globalAlpha *= st.opacity == null ? 1 : st.opacity;
    ctx.fillStyle = st.color;
    ctx.strokeStyle = st.color;
    pathThrough(ctx, st.contour, true);
    ctx.fill();
    // outward stroke that fattens the fill so it tucks cleanly under the
    // anti-aliased edge of the surrounding line. The contour was already
    // dilated by computeFill; this extra ~1.5 px stroke is the safety net.
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.4, (st.grow || 0) * 2 + 1.8);
    ctx.stroke();
    ctx.restore();
  }

  function renderStroke(ctx, st) {
    if (st.type === 'fill') renderFill(ctx, st);
    else renderLine(ctx, st);
  }

  // Re-render every stroke of a vector cel onto its raster cache.
  function renderCel(cel) {
    const ctx = cel.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cel.w, cel.h);
    // _lassoHidden strokes are skipped from the cache so the lasso tool can
    // render them as a pre-rasterised snippet via the overlay during a
    // transform drag — that turns the per-frame cost from O(N strokes) into
    // O(1) drawImage, which is the difference between smooth and laggy on
    // large selections.
    for (const st of cel.strokes) if (st.type === 'fill' && !st._lassoHidden) renderStroke(ctx, st);
    for (const st of cel.strokes) if (st.type !== 'fill' && !st._lassoHidden) renderStroke(ctx, st);
    cel.dirty();
  }

  /* ----------------------------- hit testing ----------------------------- */
  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function strokeHit(st, x, y, extra) {
    if (st.type === 'fill') return pointInPoly(x, y, st.contour);
    const pts = samplesOf(st);
    const tol = st.width / 2 + (extra || 4);
    if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= tol;
    for (let i = 1; i < pts.length; i++)
      if (ptSegDist({ x, y }, pts[i - 1], pts[i]) <= tol) return true;
    return false;
  }
  function strokeBounds(st) {
    const pts = st.type === 'fill' ? st.contour : st.pts;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const p of pts) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    }
    const pad = st.type === 'fill' ? 0 : st.width / 2 + 1;
    return { x: minx - pad, y: miny - pad, w: maxx - minx + pad * 2, h: maxy - miny + pad * 2 };
  }

  /* ----------------------------- editing ----------------------------- */
  // Erase: returns array of surviving strokes, or null if eraser missed.
  function eraseStroke(st, cx, cy, r) {
    if (st.type === 'fill') {
      for (const p of st.contour)
        if (Math.hypot(p.x - cx, p.y - cy) <= r) return [];
      return pointInPoly(cx, cy, st.contour) ? [] : null;
    }
    // Fast bbox cull: if the eraser's reach can't touch the stroke's
    // bounding box, return immediately. With many strokes scattered
    // across the cel this is the difference between a snappy drag and
    // a stutter — every miss skips the whole densify-and-trim loop.
    // The bbox uses the maximum possible reach (linejoin disc at an
    // original pt = r + wHalf); the per-pt check below is tighter.
    const wHalf = (st.width || 0) / 2;
    const reach = r + wHalf;
    if (st.pts && st.pts.length) {
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const p of st.pts) {
        if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
        if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
      }
      if (cx + reach < minx || cx - reach > maxx
          || cy + reach < miny || cy - reach > maxy) return null;
    }
    // Densify each segment, tagging each dense pt with the segment unit
    // direction so we can do a per-pt band-vs-disc check (more accurate
    // than treating every pt as a disc of radius wHalf).
    //
    // The original eraseStroke used reach = r + wHalf everywhere -- a
    // worst-case disc test that assumed each pt's perpendicular extent
    // always pointed toward the eraser. For segments that run roughly
    // perpendicular to the eraser-to-stroke direction (so the band's
    // perpendicular extent goes ACROSS the stroke, not toward the
    // eraser), this overcut the stroke by wHalf at the edges, and on
    // commit users saw the cut go wider than the destination-out hole.
    //
    // For interpolated pts (interior of a segment), we now use the
    // actual band geometry: if perp_dist (perpendicular from eraser to
    // centerline) <= wHalf the closest band-point is the projection of
    // the eraser onto the perpendicular line, at along-distance from
    // the pt -- cut iff along < r. Otherwise the closest band-point is
    // the perpendicular endpoint w/2 from the centerline, at distance
    // sqrt(along^2 + (perp - wHalf)^2) -- cut iff that < r.
    //
    // For ORIGINAL pts (the polyline corners), lineJoin='round' renders
    // a disc of radius wHalf at the corner regardless of segment dir,
    // so we keep the wider reach = r + wHalf disc test there.
    const P = st.pts, dense = [];
    const spacing = Math.max(2, r * 0.4);
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dLen = Math.hypot(dx, dy) || 1;
      const ndx = dx / dLen, ndy = dy / dLen;
      const n = Math.max(1, Math.ceil(dLen / spacing));
      const pa = a.p == null ? 1 : a.p, pb = b.p == null ? 1 : b.p;
      for (let k = 0; k < n; k++) {
        const t = k / n;
        dense.push({
          x: a.x + dx * t, y: a.y + dy * t,
          p: pa + (pb - pa) * t,
          dx: ndx, dy: ndy,
          orig: k === 0      // original polyline vertex
        });
      }
    }
    // Final pt: original vertex, direction = last segment's direction.
    const last = P[P.length - 1];
    if (P.length >= 2) {
      const a2 = P[P.length - 2];
      const dx = last.x - a2.x, dy = last.y - a2.y;
      const dLen = Math.hypot(dx, dy) || 1;
      dense.push({
        x: last.x, y: last.y, p: last.p == null ? 1 : last.p,
        dx: dx / dLen, dy: dy / dLen, orig: true
      });
    } else {
      dense.push({
        x: last.x, y: last.y, p: last.p == null ? 1 : last.p,
        dx: 1, dy: 0, orig: true
      });
    }
    let any = false;
    const keep = dense.map(p => {
      const ex = cx - p.x, ey = cy - p.y;
      let cut;
      if (p.orig) {
        // Round lineJoin disc test.
        cut = (ex * ex + ey * ey) <= reach * reach;
      } else {
        // Band-vs-disc test using segment direction.
        const perp = Math.abs(ex * (-p.dy) + ey * p.dx);
        const along = Math.abs(ex * p.dx + ey * p.dy);
        let bandDist2;
        if (perp <= wHalf) {
          bandDist2 = along * along;
        } else {
          const dp = perp - wHalf;
          bandDist2 = along * along + dp * dp;
        }
        cut = bandDist2 <= r * r;
      }
      if (cut) any = true;
      return !cut;
    });
    if (!any) return null;
    const runs = [];
    let cur = [];
    for (let i = 0; i < dense.length; i++) {
      if (keep[i]) cur.push(dense[i]);
      else { if (cur.length >= 2) runs.push(cur); cur = []; }
    }
    if (cur.length >= 2) runs.push(cur);
    return runs.map(run => {
      const s = Object.assign({}, st);
      s.id = U.uid();
      s.closed = false;
      // Use the run's first/last (interpolated cut endpoints) plus the
      // ORIGINAL polyline vertices that fell inside the run. The original
      // st.pts were already simplified at commit time, so re-simplifying
      // the densified run produces a different point set -- and a
      // different smoothed curve, which the artist sees as the line
      // "morphing" on release. Reusing the original interior points
      // means samplesOf produces the same smoothed curve away from the
      // cut; only the cut endpoint's neighbourhood necessarily differs.
      const out = [
        { x: run[0].x, y: run[0].y, p: run[0].p }
      ];
      for (let i = 1; i < run.length - 1; i++) {
        if (run[i].orig) out.push({ x: run[i].x, y: run[i].y, p: run[i].p });
      }
      const tail = run[run.length - 1];
      out.push({ x: tail.x, y: tail.y, p: tail.p });
      s.pts = out;
      return s;
    });
  }

  // Mirror a stroke across a symmetry axis ('v' = vertical line at cx, 'h' = horizontal at cy).
  function mirrorStroke(st, axis, cx, cy) {
    const m = JSON.parse(JSON.stringify(st));
    m.id = U.uid();
    const fx = x => axis === 'v' ? 2 * cx - x : x;
    const fy = y => axis === 'h' ? 2 * cy - y : y;
    if (m.type === 'fill') m.contour = m.contour.map(p => ({ x: fx(p.x), y: fy(p.y) }));
    else m.pts = m.pts.map(p => ({ x: fx(p.x), y: fy(p.y), p: p.p }));
    return m;
  }

  // Nearest line-stroke endpoint within radius (for auto-connect).
  function snapPoint(cel, x, y, radius, excludeId) {
    let best = null, bd = radius;
    for (const st of cel.strokes) {
      if (st.type !== 'line' || st.id === excludeId || !st.pts.length) continue;
      const ends = [st.pts[0], st.pts[st.pts.length - 1]];
      for (const e of ends) {
        const d = Math.hypot(e.x - x, e.y - y);
        if (d < bd) { bd = d; best = { x: e.x, y: e.y }; }
      }
    }
    return best;
  }

  /* ----------------------------- smart fill ----------------------------- */
  function traceContour(region, w, h) {
    let sx = -1, sy = -1;
    for (let y = 0; y < h && sy < 0; y++)
      for (let x = 0; x < w; x++)
        if (region[y * w + x]) { sx = x; sy = y; break; }
    if (sx < 0) return null;
    const get = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : region[y * w + x];
    const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    const contour = [{ x: sx, y: sy }];
    let cx = sx, cy = sy, bdir = 0;
    const max = w * h * 4 + 100;
    for (let guard = 0; guard < max; guard++) {
      let found = -1;
      for (let k = 0; k < 8; k++) {
        const d = (bdir + k) % 8;
        if (get(cx + dirs[d][0], cy + dirs[d][1])) { found = d; break; }
      }
      if (found < 0) break;
      cx += dirs[found][0]; cy += dirs[found][1];
      bdir = (found + 5) % 8;
      if (cx === sx && cy === sy) break;
      contour.push({ x: cx, y: cy });
    }
    return contour;
  }

  // Morphological 4-connected dilation of a binary mask by `n` pixels.
  // Used to extend a flood-fill region under the surrounding anti-aliased
  // line edge so no gap is visible between fill and line.
  function dilate(mask, w, h, n) {
    if (n <= 0) return mask;
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
    return cur;
  }

  // Detect the enclosed region at (fx,fy). Returns {contour, count, open} or null.
  function computeFill(cel, fx, fy, opts) {
    opts = opts || {};
    const gap = Math.max(0, opts.gap || 0);
    // `expand` is how many pixels the contour grows past the flood boundary,
    // so the fill tucks under the anti-aliased edge of the surrounding line
    // and there is no visible white sliver between fill and line.
    const expand = opts.expand == null ? 2 : Math.max(0, opts.expand | 0);
    const w = cel.w, h = cel.h;
    fx = Math.round(fx); fy = Math.round(fy);
    if (fx < 0 || fy < 0 || fx >= w || fy >= h) return null;

    const m = document.createElement('canvas');
    m.width = w; m.height = h;
    const mx = m.getContext('2d', { willReadFrequently: true });
    let lines = 0;
    for (const st of cel.strokes) {
      if (st.type !== 'line') continue;
      lines++;
      const pts = samplesOf(st);
      mx.fillStyle = '#000'; mx.strokeStyle = '#000';
      if (st.pencil) {
        mx.lineWidth = st.width + gap * 2;
        mx.lineJoin = 'round'; mx.lineCap = 'round';
        if (pts.length === 1) {
          mx.beginPath(); mx.arc(pts[0].x, pts[0].y, (st.width + gap * 2) / 2, 0, 7); mx.fill();
        } else { pathThrough(mx, pts, st.closed); mx.stroke(); }
      } else {
        stampPolyline(mx, pts, p => st.width / 2 * (p.p == null ? 1 : p.p) + gap);
      }
    }
    if (!lines) return null;

    const data = mx.getImageData(0, 0, w, h).data;
    const wall = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) wall[p] = data[p * 4 + 3] > 40 ? 1 : 0;
    if (wall[fy * w + fx]) return null;

    const region = new Uint8Array(w * h);
    const stack = [fx, fy];
    let count = 0;
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const idx = y * w + x;
      if (region[idx] || wall[idx]) continue;
      region[idx] = 1; count++;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    if (count === 0) return null;
    const open = count > w * h * 0.8;
    // dilate the region by `expand` px so the traced contour extends past
    // the anti-aliased line edge -- prevents the visible gap between fill
    // and surrounding line art
    const grown = expand > 0 && !open ? dilate(region, w, h, expand) : region;
    const raw = traceContour(grown, w, h);
    if (!raw || raw.length < 3) return null;
    return { contour: simplify(raw, 0.9), count, open };
  }

  /* ----------------------- shape recognition ----------------------- */
  // Procreate-style "hold to snap" shape recognition. Takes a stroke's
  // smoothed point array and returns a descriptor for the best-fit primitive
  // — `null` if nothing fits well. Tools call this only after detecting that
  // the user held still at the end of the stroke (Procreate UX). Detection
  // is intentionally conservative: a confident match is more important than
  // catching every approximate sketch.
  function detectShape(pts, opts) {
    // Hysteresis: once a snap is locked, thresholds are looser so the live
    // preview doesn't flicker between freehand and snapped while the artist
    // holds. opts.locked tells us we already had a snap last frame.
    const locked = !!(opts && opts.locked);
    const TLINE   = locked ? 0.10 : 0.07;
    const TCLOSE  = locked ? 0.55 : 0.45;
    const TROT    = locked ? Math.PI * 0.9 : Math.PI * 1.2;
    const TELL    = locked ? 0.42 : 0.30;
    const TRECT   = locked ? 0.14 : 0.10;
    const TELLOR  = locked ? 0.26 : 0.18;
    const TARC    = locked ? 0.16 : 0.10;
    const n = pts ? pts.length : 0;
    if (n < 8) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;  if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;  if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX, h = maxY - minY;
    const span = Math.max(w, h);
    if (span < 20) return null;
    let L = 0;
    for (let i = 1; i < n; i++)
      L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);

    // ---- LINE ---- perpendicular residual of all points vs (p0 -> pn).
    const a = pts[0], b = pts[n - 1];
    const lineLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (lineLen > 20) {
      let maxResid = 0;
      const dx = b.x - a.x, dy = b.y - a.y;
      for (const p of pts) {
        const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
        const d = num / lineLen;
        if (d > maxResid) maxResid = d;
      }
      // Path length close to the straight-line length AND residuals small.
      if (maxResid < span * TLINE && L < lineLen * 1.18) {
        return { kind: 'line', geom: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } };
      }
    }

    // ---- ARC ---- open smooth circular curve (bow shape / partial circle).
    // Fit a circumcircle through start, end, and the path's "midpoint" — the
    // point with maximum perpendicular distance from the start->end chord
    // (more robust than pts[n/2] because drawing speed isn't uniform). If all
    // path points lie close to that circle and the signed angular sweep is
    // somewhere between a slight curve and a near-full loop, snap to an arc.
    // Must run BEFORE the closed-shape gate because arcs are open paths.
    {
      const aArc = pts[0], bArc = pts[n - 1];
      const dxArc = bArc.x - aArc.x, dyArc = bArc.y - aArc.y;
      const chordLen = Math.hypot(dxArc, dyArc);
      if (chordLen > 8) {
        // Find midpoint (max perpendicular distance from chord).
        let midIdx = -1, midDist = -1;
        for (let i = 1; i < n - 1; i++) {
          const p = pts[i];
          const num = Math.abs(dyArc * p.x - dxArc * p.y + bArc.x * aArc.y - bArc.y * aArc.x);
          const d = num / chordLen;
          if (d > midDist) { midDist = d; midIdx = i; }
        }
        // Need a meaningful bow — otherwise the line check would have caught it.
        if (midIdx > 0 && midDist > chordLen * 0.04) {
          const m = pts[midIdx];
          // Circumcircle through (aArc, m, bArc) via the standard 3-point
          // determinant formula. d == 2 * signed area of the triangle * 2,
          // small => near-collinear => bail.
          const ax2 = aArc.x, ay2 = aArc.y;
          const bx2 = m.x,    by2 = m.y;
          const cx2 = bArc.x, cy2 = bArc.y;
          const d2 = 2 * (ax2 * (by2 - cy2) + bx2 * (cy2 - ay2) + cx2 * (ay2 - by2));
          if (Math.abs(d2) > 1e-6) {
            const aSq = ax2 * ax2 + ay2 * ay2;
            const bSq = bx2 * bx2 + by2 * by2;
            const cSq = cx2 * cx2 + cy2 * cy2;
            const ux = (aSq * (by2 - cy2) + bSq * (cy2 - ay2) + cSq * (ay2 - by2)) / d2;
            const uy = (aSq * (cx2 - bx2) + bSq * (ax2 - cx2) + cSq * (bx2 - ax2)) / d2;
            const r = Math.hypot(aArc.x - ux, aArc.y - uy);
            if (r > 5 && isFinite(r)) {
              // Residual: average normalised radial error across all points.
              let acc = 0;
              for (const p of pts) {
                const dr = Math.hypot(p.x - ux, p.y - uy) - r;
                acc += Math.abs(dr);
              }
              const residArc = (acc / n) / r;
              if (residArc < TARC) {
                // Signed angular sweep around the fitted centre.
                let total = 0;
                for (let i = 1; i < n; i++) {
                  const angA = Math.atan2(pts[i - 1].y - uy, pts[i - 1].x - ux);
                  const angB = Math.atan2(pts[i].y     - uy, pts[i].x     - ux);
                  let d = angB - angA;
                  if (d >  Math.PI) d -= 2 * Math.PI;
                  if (d < -Math.PI) d += 2 * Math.PI;
                  total += d;
                }
                const absSweep = Math.abs(total);
                // Reject too-straight (< 30°) and too-closed (> 330°).
                if (absSweep >= Math.PI / 6 && absSweep <= 11 * Math.PI / 6) {
                  return {
                    kind: 'arc',
                    geom: {
                      cx: ux,
                      cy: uy,
                      r: r,
                      startAngle: Math.atan2(pts[0].y - uy, pts[0].x - ux),
                      sweep: total
                    }
                  };
                }
              }
            }
          }
        }
      }
    }

    // ---- CLOSED-SHAPE TEST ---- two complementary signals:
    //  (a) endpoint reasonably close to start (the artist closed the path),
    //  (b) total bearing rotation ≥ 220° (the path wound around enough to
    //      clearly describe a closed shape even if the endpoint didn't quite
    //      meet the start). Either is sufficient. Without (b) users have to
    //      "make the line touch its own start" for the snap to fire, which
    //      Procreate doesn't require.
    const startEnd = Math.hypot(b.x - a.x, b.y - a.y);
    let totalAngle = 0;
    for (let i = 2; i < n; i++) {
      const p0 = pts[i - 2], p1 = pts[i - 1], p2 = pts[i];
      const ax = p1.x - p0.x, ay = p1.y - p0.y;
      const bx = p2.x - p1.x, by_ = p2.y - p1.y;
      const cross = ax * by_ - ay * bx;
      const dot = ax * bx + ay * by_;
      if (cross !== 0 || dot !== 0) totalAngle += Math.atan2(cross, dot);
    }
    const closedByEndpoints = startEnd < span * TCLOSE && L > span * 1.8;
    const closedByRotation = Math.abs(totalAngle) > TROT && L > span * 1.8;
    if (!(closedByEndpoints || closedByRotation)) return null;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = Math.max(1, w / 2);
    const ry = Math.max(1, h / 2);

    // ---- CORNER COUNT via aggressive Ramer-Douglas-Peucker simplification.
    // RDP keeps the points that contribute most to the path's shape — for a
    // polygon those are the corners. The tolerance scales with span so big
    // shapes are noisier than small ones in absolute pixels. Counting
    // corners is a more reliable classifier than residual comparison alone
    // (a small wobbly rectangle had a lower conic residual than rectangle
    // residual, so it was misclassified as a circle).
    let corners = simplify(pts, span * 0.06);
    if (corners.length > 1) {
      const last = corners[corners.length - 1];
      if (Math.hypot(last.x - corners[0].x, last.y - corners[0].y) < span * 0.12) {
        corners = corners.slice(0, -1);
      }
    }
    // Prune near-collinear corners. RDP sometimes retains points along a
    // gently-curved side (e.g. when One Euro lag bends the path inward
    // during the closing edge of a small triangle) — those false corners
    // turned 3-corner shapes into 5+ corner polygons and broke detection.
    // A real triangle corner turns ~120°, a rect corner 90°; 28° (≈ 0.5 rad)
    // is generous enough to catch slow corner roundings without dropping
    // actual vertices.
    corners = pruneCollinearCorners(corners, 0.5);

    // 3 corners → triangle. Verify each side is actually straight (max
    // residual < span * 0.06 — same scale as the RDP tolerance).
    if (corners.length === 3) {
      const v = corners;
      if (sidesAreStraight(pts, [v[0], v[1], v[2]], span)) {
        return { kind: 'triangle', geom: { v: v.slice() } };
      }
    }

    // Ellipse residual: how close every point is to the conic equation
    //   (x - cx)² / rx² + (y - cy)² / ry² = 1
    let ellResid = 0;
    for (const p of pts) {
      const u = (p.x - cx) / rx, v = (p.y - cy) / ry;
      ellResid += Math.abs(u * u + v * v - 1);
    }
    ellResid /= n;

    // Rectangle residual: average distance from each point to the bounding
    // box perimeter.
    let rectResid = 0;
    for (const p of pts) {
      const ddx = Math.abs(p.x - cx) - rx;
      const ddy = Math.abs(p.y - cy) - ry;
      let d;
      if (ddx > 0 && ddy > 0) d = Math.hypot(ddx, ddy);
      else if (ddx > 0)       d = ddx;
      else if (ddy > 0)       d = ddy;
      else                    d = Math.min(-ddx, -ddy);
      rectResid += d;
    }
    rectResid = (rectResid / n) / span;

    const ellGood = ellResid < TELL;
    const rectGood = rectResid < TRECT;

    // Corner-count drives the primary decision. 4 corners + good rect
    // residual + axis-aligned sides = rectangle. The axis-alignment check
    // prevents a noisy circle whose 4 RDP corners happen to land at
    // diagonal positions (NE, SE, SW, NW around the circle) from being
    // misclassified as a square — those sides would be 45° diagonals, not
    // horizontal/vertical edges.
    if (corners.length === 4 && rectGood && isAxisAligned(corners)) {
      if (Math.abs(w - h) / Math.max(w, h) < 0.1) {
        const s = (w + h) / 2;
        const x = cx - s / 2, y = cy - s / 2;
        return { kind: 'square', geom: { x, y, w: s, h: s } };
      }
      return { kind: 'rect', geom: { x: minX, y: minY, w, h } };
    }
    if (ellGood && (!rectGood || ellResid < TELLOR)) {
      const ratio = Math.min(rx, ry) / Math.max(rx, ry);
      if (ratio > 0.85) {
        const r = (rx + ry) / 2;
        return { kind: 'circle', geom: { cx, cy, r } };
      }
      return { kind: 'ellipse', geom: { cx, cy, rx, ry } };
    }
    if (rectGood) {
      if (Math.abs(w - h) / Math.max(w, h) < 0.1) {
        const s = (w + h) / 2;
        const x = cx - s / 2, y = cy - s / 2;
        return { kind: 'square', geom: { x, y, w: s, h: s } };
      }
      return { kind: 'rect', geom: { x: minX, y: minY, w, h } };
    }
    return null;
  }

  // Max perpendicular distance from any point on `pts` to its NEAREST side
  // of the closed polygon defined by `corners`. Each point contributes only
  // its closest-side residual, so a corner of the triangle isn't penalised
  // by its distance to the opposite side. Returns true iff the worst-case
  // residual is below 10% of the bounding span.
  function sidesAreStraight(pts, corners, span) {
    const nc = corners.length;
    let maxResid = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let s = 0; s < nc; s++) {
        const a = corners[s], b = corners[(s + 1) % nc];
        const segLen2 = (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y);
        if (segLen2 < 1) continue;
        const t = Math.max(0, Math.min(1,
          ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / segLen2));
        const cxp = a.x + (b.x - a.x) * t;
        const cyp = a.y + (b.y - a.y) * t;
        const d2 = (p.x - cxp) * (p.x - cxp) + (p.y - cyp) * (p.y - cyp);
        if (d2 < best) best = d2;
      }
      const d = Math.sqrt(best);
      if (d > maxResid) maxResid = d;
    }
    // The One Euro filter rounds corners enough on smooth=0.3 that a tight
    // threshold rejects valid hand-drawn polygons. 15% of span is generous
    // but still discriminates clean polygons from curves.
    return maxResid < span * 0.15;
  }

  // Iteratively drop polygon corners where the interior turn is below
  // `minTurnRad`. Such "corners" sit nearly on the line between their two
  // neighbours and don't represent real shape features. Keeps at least 3
  // corners (the minimum that defines a polygon).
  function pruneCollinearCorners(corners, minTurnRad) {
    let result = corners.slice();
    let changed = true;
    while (changed && result.length > 3) {
      changed = false;
      // Find the corner with the smallest turn — drop it first.
      let worstIdx = -1, worstTurn = Infinity;
      const n = result.length;
      for (let i = 0; i < n; i++) {
        const a = result[(i - 1 + n) % n];
        const b = result[i];
        const c = result[(i + 1) % n];
        const ax = b.x - a.x, ay = b.y - a.y;
        const bx = c.x - b.x, by = c.y - b.y;
        const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
        if (turn < worstTurn) { worstTurn = turn; worstIdx = i; }
      }
      if (worstTurn < minTurnRad) {
        result.splice(worstIdx, 1);
        changed = true;
      }
    }
    return result;
  }

  // Check whether a 4-vertex polygon has approximately axis-aligned sides —
  // each side should be either mostly-horizontal or mostly-vertical. A noisy
  // circle whose RDP-picked "corners" sit at diagonal positions (NE/SE/SW/NW)
  // would otherwise be misclassified as a rotated rect; we don't snap to
  // rotated rects in v1 so this signal lets circles fall through to the
  // ellipse fit.
  function isAxisAligned(corners) {
    if (!corners || corners.length !== 4) return false;
    for (let s = 0; s < 4; s++) {
      const a = corners[s], b = corners[(s + 1) % 4];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      // The smaller dimension should be much smaller than the larger.
      // 0.35 leaves room for jitter but rejects 45° diagonals (where the
      // ratio is 1.0).
      const min = Math.min(dx, dy), max = Math.max(dx, dy);
      if (max < 1) return false;
      if (min / max > 0.35) return false;
    }
    return true;
  }

  // Build the idealized point array for a detected shape. `closed` is set
  // appropriately. Caller is responsible for storing `sharp: true` on the
  // stroke so Catmull-Rom smoothing doesn't round the corners.
  function shapeToPts(detection) {
    const g = detection.geom;
    if (detection.kind === 'line') {
      return { pts: [{ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }], closed: false };
    }
    if (detection.kind === 'rect' || detection.kind === 'square') {
      return {
        pts: [
          { x: g.x,         y: g.y         },
          { x: g.x + g.w,   y: g.y         },
          { x: g.x + g.w,   y: g.y + g.h   },
          { x: g.x,         y: g.y + g.h   }
        ],
        closed: true
      };
    }
    if (detection.kind === 'triangle') {
      return {
        pts: g.v.map(p => ({ x: p.x, y: p.y })),
        closed: true
      };
    }
    if (detection.kind === 'arc') {
      const N = 36;
      const out = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);                       // 0 → 1 inclusive
        const ang = g.startAngle + g.sweep * t;
        out.push({ x: g.cx + Math.cos(ang) * g.r, y: g.cy + Math.sin(ang) * g.r });
      }
      return { pts: out, closed: false };
    }
    // circle / ellipse — sample 48 segments
    const cx = g.cx, cy = g.cy;
    const rx = detection.kind === 'circle' ? g.r : g.rx;
    const ry = detection.kind === 'circle' ? g.r : g.ry;
    const N = 48;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const t = i / N * Math.PI * 2;
      pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
    }
    return { pts, closed: true };
  }

  // Signed polygon area (cross-product sum / 2). Positive = CCW in screen
  // coords (y down treats CCW math direction as CW visually, so the sign
  // convention matches whichever direction the path was sampled in).
  function signedArea(pts) {
    let a = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += (p.x * q.y - q.x * p.y);
    }
    return a / 2;
  }

  // Align `toPts` (the snap target) to `fromPts` (the freehand) so paired
  // points by index sit on matching positions on each path. Without this,
  // a clockwise freehand morphing to a counter-clockwise snap (or vice
  // versa) makes paired points cross through the centre, creating a visible
  // "flip" mid-animation. For closed shapes we also search rotational
  // offsets so the freehand's start aligns with the snap's start.
  function alignClosedPath(fromPts, toPts) {
    const N = fromPts.length;
    if (toPts.length !== N) return toPts.slice();
    let aligned = toPts.slice();
    if (Math.sign(signedArea(fromPts)) !== Math.sign(signedArea(aligned))) {
      aligned.reverse();
    }
    let bestOff = 0, bestCost = Infinity;
    for (let off = 0; off < N; off++) {
      let cost = 0;
      for (let k = 0; k < N; k++) {
        const a = fromPts[k];
        const b = aligned[(k + off) % N];
        const dx = a.x - b.x, dy = a.y - b.y;
        cost += dx * dx + dy * dy;
      }
      if (cost < bestCost) { bestCost = cost; bestOff = off; }
    }
    if (bestOff > 0) {
      aligned = aligned.slice(bestOff).concat(aligned.slice(0, bestOff));
    }
    return aligned;
  }

  // Open-path alignment: just check whether to reverse so the endpoints meet
  // (freehand start → snap start, freehand end → snap end is cheaper than
  // freehand start → snap end and vice versa).
  function alignOpenPath(fromPts, toPts) {
    const N = fromPts.length;
    if (toPts.length !== N) return toPts.slice();
    const normal =
      (fromPts[0].x - toPts[0].x) ** 2 + (fromPts[0].y - toPts[0].y) ** 2 +
      (fromPts[N - 1].x - toPts[N - 1].x) ** 2 + (fromPts[N - 1].y - toPts[N - 1].y) ** 2;
    const reversed =
      (fromPts[0].x - toPts[N - 1].x) ** 2 + (fromPts[0].y - toPts[N - 1].y) ** 2 +
      (fromPts[N - 1].x - toPts[0].x) ** 2 + (fromPts[N - 1].y - toPts[0].y) ** 2;
    if (reversed < normal) {
      const out = toPts.slice();
      out.reverse();
      return out;
    }
    return toPts.slice();
  }

  OT.Vector = {
    simplify, smoothPts, smoothPath, samplesOf,
    renderStroke, renderCel, renderLine,
    strokeHit, strokeBounds, pointInPoly,
    eraseStroke, snapPoint, computeFill, mirrorStroke,
    detectShape, shapeToPts,
    alignClosedPath, alignOpenPath
  };
})(window.OT);
