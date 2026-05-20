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

  function stampPolyline(ctx, pts, radiusFn) {
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const a = pts[i - 1], b = pts[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const ra = radiusFn(a), rb = radiusFn(b);
        const step = Math.max(0.6, Math.min(ra, rb) * 0.5);
        const n = Math.max(1, Math.ceil(d / step));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
            Math.max(0.4, ra + (rb - ra) * t), 0, 7);
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, Math.max(0.4, radiusFn(pts[i])), 0, 7);
        ctx.fill();
      }
    }
  }

  function renderLine(ctx, st) {
    const pts = samplesOf(st);
    if (!pts.length) return;
    const op = st.opacity == null ? 1 : st.opacity;
    if (st.pencil) {
      ctx.save();
      ctx.globalAlpha = op;
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
    // brush: stamp circles (variable width by pressure)
    const radius = p => st.width / 2 * (p.p == null ? 1 : p.p);
    if (op >= 1) {
      ctx.save();
      ctx.fillStyle = st.color;
      stampPolyline(ctx, pts, radius);
      ctx.restore();
    } else {
      const b = document.createElement('canvas');
      b.width = ctx.canvas.width; b.height = ctx.canvas.height;
      const bx = b.getContext('2d');
      bx.fillStyle = st.color;
      stampPolyline(bx, pts, radius);
      ctx.save();
      ctx.globalAlpha = op;
      ctx.drawImage(b, 0, 0);
      ctx.restore();
    }
  }

  function renderFill(ctx, st) {
    if (!st.contour || st.contour.length < 3) return;
    ctx.save();
    ctx.globalAlpha = st.opacity == null ? 1 : st.opacity;
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
    for (const st of cel.strokes) if (st.type === 'fill') renderStroke(ctx, st);
    for (const st of cel.strokes) if (st.type !== 'fill') renderStroke(ctx, st);
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
    const P = st.pts, dense = [];
    const spacing = Math.max(2, r * 0.4);
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(d / spacing));
      const pa = a.p == null ? 1 : a.p, pb = b.p == null ? 1 : b.p;
      for (let k = 0; k < n; k++) {
        const t = k / n;
        dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: pa + (pb - pa) * t });
      }
    }
    const last = P[P.length - 1];
    dense.push({ x: last.x, y: last.y, p: last.p == null ? 1 : last.p });
    const reach = r + st.width / 2;
    let any = false;
    const keep = dense.map(p => {
      const e = Math.hypot(p.x - cx, p.y - cy) <= reach;
      if (e) any = true;
      return !e;
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
      s.pts = simplify(run, 1.1);
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

  OT.Vector = {
    simplify, smoothPts, smoothPath, samplesOf,
    renderStroke, renderCel, renderLine,
    strokeHit, strokeBounds, pointInPoly,
    eraseStroke, snapPoint, computeFill, mirrorStroke
  };
})(window.OT);
