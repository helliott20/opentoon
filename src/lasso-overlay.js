/* OpenToon — shared lasso / free-transform overlay drawing.

   The selection bounding box, marching ants, corner / edge / rotation
   handles, and toolbar anchor math are identical on the main canvas and
   on the pen-display window. Putting them here is the single source of
   truth so a change to (say) the handle appearance flows to both
   surfaces automatically — no risk of drift.

   Expected selection-state shape (`s`):
     { cx, cy, sw, sh, scaleX, scaleY, rot,
       distortC?: [P,P,P,P],          // distort mode
       warpC?:    [P,P,P,P],          // warp mode corners
       warpM?:    [P,P,P,P] }         // warp mode edge midpoints

   All drawing functions take `zoom` = combined project-px-to-CSS-px
   ratio so line widths and handle sizes stay screen-stable across the
   artist's viewport zoom. */
(function (OT) {
  'use strict';

  // 8 anchor positions around the selection bbox, in cel-local coords
  // (centred on cx,cy). Order: 0=TL 1=T 2=TR 3=R 4=BR 5=B 6=BL 7=L —
  // same convention the lasso/select hit-test code uses.
  function selAnchor(idx, sw, sh) {
    const xs = [-sw / 2, 0, sw / 2, sw / 2, sw / 2, 0, -sw / 2, -sw / 2];
    const ys = [-sh / 2, -sh / 2, -sh / 2, 0, sh / 2, sh / 2, sh / 2, 0];
    return { x: xs[idx], y: ys[idx] };
  }

  // Apply the selection's rotation + scale around (cx, cy) to a local point.
  function selWorld(s, ix, iy) {
    const c = Math.cos(s.rot || 0), sn = Math.sin(s.rot || 0);
    const x = ix * (s.scaleX == null ? 1 : s.scaleX);
    const y = iy * (s.scaleY == null ? 1 : s.scaleY);
    return { x: s.cx + x * c - y * sn, y: s.cy + x * sn + y * c };
  }

  function selLocal(s, wx, wy) {
    const c = Math.cos(-(s.rot || 0)), sn = Math.sin(-(s.rot || 0));
    const dx = wx - s.cx, dy = wy - s.cy;
    return {
      x: (dx * c - dy * sn) / (s.scaleX == null ? 1 : s.scaleX),
      y: (dx * sn + dy * c) / (s.scaleY == null ? 1 : s.scaleY)
    };
  }

  // Rotation pin sits 26 CSS-px above the top-centre handle.
  function selRotHandleWorld(s, zoom) {
    const a = selAnchor(1, s.sw, s.sh);
    const off = 26 / Math.max(0.001, zoom) / Math.abs(s.scaleY || 1);
    return selWorld(s, a.x, a.y - off);
  }

  // All 8 anchors in world space — convenient for HUD drawing.
  function anchorsOf(s) {
    const out = new Array(8);
    for (let i = 0; i < 8; i++) {
      const a = selAnchor(i, s.sw, s.sh);
      out[i] = selWorld(s, a.x, a.y);
    }
    return out;
  }

  // Top-mid for the floating lasso toolbar — mode-aware so it tracks the
  // actual top edge of distort/warp meshes instead of the stale affine bbox.
  function topMidOf(s, mode) {
    if (mode === 'distort' && s.distortC) {
      const a = s.distortC[0], b = s.distortC[1];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    if (mode === 'warp' && s.warpC && s.warpM) {
      const c0 = s.warpC[0], c1 = s.warpC[1], m = s.warpM[0];
      return {
        x: 0.25 * c0.x + 0.5 * m.x + 0.25 * c1.x,
        y: 0.25 * c0.y + 0.5 * m.y + 0.25 * c1.y
      };
    }
    return selWorld(s, 0, -s.sh / 2);
  }

  // Return a `tracePath(ctx)` closure that traces the appropriate outline
  // for the given mode. Caller is responsible for ctx.save / restore.
  function traceForMode(s, mode) {
    if (mode === 'distort' && s.distortC) {
      const C = s.distortC;
      return (ctx) => {
        ctx.beginPath();
        ctx.moveTo(C[0].x, C[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(C[i].x, C[i].y);
        ctx.closePath();
      };
    }
    if (mode === 'warp' && s.warpC && s.warpM) {
      const C = s.warpC, M = s.warpM;
      return (ctx) => {
        ctx.beginPath();
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
    }
    // Affine: 4-corner quad through TL/TR/BR/BL.
    const corners = [selWorld(s, -s.sw / 2, -s.sh / 2),
                     selWorld(s,  s.sw / 2, -s.sh / 2),
                     selWorld(s,  s.sw / 2,  s.sh / 2),
                     selWorld(s, -s.sw / 2,  s.sh / 2)];
    return (ctx) => {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
    };
  }

  // Marching ants — soft halo + alternating black/white dashes that
  // animate so the artist sees the selection is live.
  function ants(ctx, zoom, tracePath) {
    const z = Math.max(0.001, zoom);
    const t = performance.now() / 75;
    const dash = 4.5 / z;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    ctx.lineWidth = 3.2 / z;
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.setLineDash([]);
    tracePath(ctx); ctx.stroke();
    ctx.lineWidth = 1.1 / z;
    ctx.setLineDash([dash, dash]);
    ctx.lineDashOffset = -t;
    ctx.strokeStyle = '#0b0b0c';
    tracePath(ctx); ctx.stroke();
    ctx.lineDashOffset = -t + dash;
    ctx.strokeStyle = '#fff';
    tracePath(ctx); ctx.stroke();
    ctx.restore();
  }

  // Crisp white-square handle with subtle drop shadow. Used for every
  // corner / edge handle across every transform mode.
  function handleSquare(ctx, x, y, zoom) {
    const z = Math.max(0.001, zoom);
    const hs = 5.5 / z;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x - hs + 0.6 / z, y - hs + 1.2 / z, hs * 2, hs * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x - hs + 0.3 / z, y - hs + 0.6 / z, hs * 2, hs * 2);
    ctx.lineWidth = 1.2 / z;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1a1c20';
    ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
    ctx.strokeRect(x - hs, y - hs, hs * 2, hs * 2);
  }

  function drawCornerHandles(ctx, corners, zoom) {
    ctx.save();
    ctx.lineJoin = 'miter';
    for (const c of corners) handleSquare(ctx, c.x, c.y, zoom);
    ctx.restore();
  }

  // Diamond handles for warp edge midpoints — visually distinct so the
  // user knows "this controls the edge curvature".
  function drawMidHandles(ctx, mids, zoom) {
    const z = Math.max(0.001, zoom);
    const hs = 5 / z;
    ctx.save();
    ctx.lineJoin = 'miter';
    for (const m of mids) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.moveTo(m.x + 0.3 / z, m.y - hs + 0.6 / z);
      ctx.lineTo(m.x + hs + 0.3 / z, m.y + 0.6 / z);
      ctx.lineTo(m.x + 0.3 / z, m.y + hs + 0.6 / z);
      ctx.lineTo(m.x - hs + 0.3 / z, m.y + 0.6 / z);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.2 / z;
      ctx.fillStyle = '#f7c869';
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

  // 8 scale handles + rotation knob (stem + circular knob with curved
  // arrow) for the affine modes. Mirrors LassoTool._drawTransformHandles.
  function drawAffineHandles(ctx, s, zoom) {
    const z = Math.max(0.001, zoom);
    const kr = 7 / z;
    const tc = selWorld(s, 0, -s.sh / 2);
    const rh = selRotHandleWorld(s, zoom);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.4 / z;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.moveTo(tc.x, tc.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
    ctx.lineWidth = 0.6 / z;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.moveTo(tc.x, tc.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
    ctx.lineCap = 'butt';
    for (let i = 0; i < 8; i++) {
      const a = selAnchor(i, s.sw, s.sh);
      const w = selWorld(s, a.x, a.y);
      handleSquare(ctx, w.x, w.y, zoom);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath(); ctx.arc(rh.x + 0.4 / z, rh.y + 0.9 / z, kr, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.4 / z;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1a1c20';
    ctx.beginPath(); ctx.arc(rh.x, rh.y, kr, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1.5 / z;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1c20';
    const ir = kr * 0.5;
    const a0 = Math.PI * 0.25, a1 = Math.PI * 1.65;
    ctx.beginPath(); ctx.arc(rh.x, rh.y, ir, a0, a1); ctx.stroke();
    const tipX = rh.x + Math.cos(a1) * ir;
    const tipY = rh.y + Math.sin(a1) * ir;
    const ah = 2.6 / z;
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

  // Full overlay paint: ants + handles for the given mode. Caller paints
  // any wet-stroke / selection-snippet first; this layer goes on top.
  function drawOverlay(ctx, s, mode, zoom) {
    const trace = traceForMode(s, mode);
    ants(ctx, zoom, trace);
    if (mode === 'distort' && s.distortC) {
      drawCornerHandles(ctx, s.distortC, zoom);
    } else if (mode === 'warp' && s.warpC && s.warpM) {
      drawCornerHandles(ctx, s.warpC, zoom);
      drawMidHandles(ctx, s.warpM, zoom);
    } else {
      drawAffineHandles(ctx, s, zoom);
    }
  }

  OT.LassoOverlay = {
    selAnchor, selWorld, selLocal, selRotHandleWorld,
    anchorsOf, topMidOf,
    traceForMode, ants, handleSquare,
    drawCornerHandles, drawMidHandles, drawAffineHandles,
    drawOverlay
  };
})(window.OT);
