/* OpenToon — shared mesh-warp math.

   The lasso/free-transform tool on the main side and the pen-window
   slave renderer both need the same forward-map for distort and warp
   modes. Duplicating the math is a recipe for visual drift between
   the two windows, so it lives here as a tiny standalone module that
   both surfaces include.

   State expected by the forward maps:
     { origCx, origCy, sw, sh,
       distortC?: [P,P,P,P],        // 4 corners (TL,TR,BR,BL) for distort
       warpC?:    [P,P,P,P],        // 4 corners for warp
       warpM?:    [P,P,P,P] }       // 4 edge midpoints (T,R,B,L) for warp
*/
(function (OT) {
  'use strict';

  // Normalise a cel-local point relative to the orig bounding box, yielding
  // (u, v) in [0,1]² for the bilinear / Coons mappings.
  function uvOf(s, x, y) {
    return {
      u: (x - (s.origCx - s.sw / 2)) / s.sw,
      v: (y - (s.origCy - s.sh / 2)) / s.sh
    };
  }

  // Bilinear blend of 4 corner positions at (u, v) in [0,1]². Corners are
  // in TL, TR, BR, BL order — matching LassoTool's distortC layout.
  function bilinear(c, u, v) {
    const um = 1 - u, vm = 1 - v;
    return {
      x: um * vm * c[0].x + u * vm * c[1].x + u * v * c[2].x + um * v * c[3].x,
      y: um * vm * c[0].y + u * vm * c[1].y + u * v * c[2].y + um * v * c[3].y
    };
  }

  // Coons patch with quadratic-bezier edges. 4 corners + 4 edge midpoints
  // let the artist curve any edge while preserving corner positions.
  // Edge midpoints are T, R, B, L — matching LassoTool's warpM layout.
  function coons(c, m, u, v) {
    const um = 1 - u, vm = 1 - v;
    const Bt = { x: um*um*c[0].x + 2*u*um*m[0].x + u*u*c[1].x,
                 y: um*um*c[0].y + 2*u*um*m[0].y + u*u*c[1].y };
    const Bb = { x: um*um*c[3].x + 2*u*um*m[2].x + u*u*c[2].x,
                 y: um*um*c[3].y + 2*u*um*m[2].y + u*u*c[2].y };
    const Bl = { x: vm*vm*c[0].x + 2*v*vm*m[3].x + v*v*c[3].x,
                 y: vm*vm*c[0].y + 2*v*vm*m[3].y + v*v*c[3].y };
    const Br = { x: vm*vm*c[1].x + 2*v*vm*m[1].x + v*v*c[2].x,
                 y: vm*vm*c[1].y + 2*v*vm*m[1].y + v*v*c[2].y };
    const Cb = bilinear(c, u, v);
    return {
      x: vm * Bt.x + v * Bb.x + um * Bl.x + u * Br.x - Cb.x,
      y: vm * Bt.y + v * Bb.y + um * Bl.y + u * Br.y - Cb.y
    };
  }

  // Build a closed-over forward map for the given mode. The returned
  // function takes (x, y) in original cel-local coords and yields the
  // transformed (x, y). Affine modes also accept scaleX/scaleY/rot/cx/cy
  // on the state object so the same caller works for every mode.
  function makeForward(mode, s) {
    if (mode === 'distort' && s.distortC) {
      return (x, y) => {
        const uv = uvOf(s, x, y);
        return bilinear(s.distortC, uv.u, uv.v);
      };
    }
    if (mode === 'warp' && s.warpC && s.warpM) {
      return (x, y) => {
        const uv = uvOf(s, x, y);
        return coons(s.warpC, s.warpM, uv.u, uv.v);
      };
    }
    // affine — same math as LassoTool._makeForward (move / uniform / freeform).
    const cR = Math.cos(s.rot || 0), sR = Math.sin(s.rot || 0);
    const sx = s.scaleX == null ? 1 : s.scaleX;
    const sy = s.scaleY == null ? 1 : s.scaleY;
    return (x, y) => {
      const dx = (x - s.origCx) * sx, dy = (y - s.origCy) * sy;
      return {
        x: s.cx + dx * cR - dy * sR,
        y: s.cy + dx * sR + dy * cR
      };
    };
  }

  OT.MeshWarp = { uvOf, bilinear, coons, makeForward };
})(window.OT);
