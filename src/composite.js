/* OpenToon Studio - shared stage compositing.

   Pure function used by both the main canvas (Stage.compositeStage) and
   the pen-window slave renderer. Inputs are explicit -- no `this`, no DOM,
   no event bus -- so the SAME compositor runs in both windows. That kills
   any risk of the two renderers drifting apart visually. */
(function (OT) {
  'use strict';

  // Lazy temp canvas for the pen-window eraser-overlay render path.
  // Sized to match the parent ctx's backing-store dimensions so strokes
  // can be rendered at pen-display resolution (sharp, no upscale blur)
  // and blitted pixel-perfect. Reused across renders; resizes on demand.
  let _eraserTemp = null;
  function getEraserTempCanvas(w, h) {
    if (!_eraserTemp) _eraserTemp = document.createElement('canvas');
    if (_eraserTemp.width !== w || _eraserTemp.height !== h) {
      _eraserTemp.width = w;
      _eraserTemp.height = h;
    }
    return _eraserTemp;
  }

  // Draw bg + all visible layers at `frame` into ctx (already in project
  // coords).
  //
  // Inputs:
  //   project        - { width, height, bg, layers: OT.Layer[] }
  //   frame          - integer frame index
  //   ctx            - 2D context (already in project coords)
  //   opts           - object, all fields optional:
  //                      bg          : default true - fill ctx with project.bg first
  //                      useRaster   : force the cached cel.canvas blit path even
  //                                    for vector cels (used by pickColor / flatten)
  //                      wetStroke   : in-progress stroke to render on top of the
  //                                    active layer's committed strokes (pen window
  //                                    uses this for zero-latency wet ink)
  //                      wetLayerId  : id of the layer that owns wetStroke
  //                      includeVideo: default true - video layers are rendered. Pass
  //                                    false on the pen window where the <video>
  //                                    element doesn't exist.
  //                      includeLassoHidden: default false - strokes flagged
  //                                    `_lassoHidden` (the lasso tool's pre-rasterised
  //                                    transform path) are skipped, matching the
  //                                    historical Stage.compositeStage behaviour.
  //                                    Reserved for future overlay paths.
  //   helpers        - { layerAncestors: layer => Layer[] } - the parent chain
  //                    walker (matches main.js's app.layerAncestors).
  function compositeStage(project, frame, ctx, opts, helpers) {
    opts = opts || {};
    helpers = helpers || {};
    const layerAncestors = helpers.layerAncestors || (() => []);
    const wetStroke = opts.wetStroke;
    const wetLayerId = opts.wetLayerId;
    const includeVideo = opts.includeVideo !== false;
    const includeLassoHidden = !!opts.includeLassoHidden;

    if (opts.bg !== false) {
      ctx.fillStyle = project.bg;
      ctx.fillRect(0, 0, project.width, project.height);
    }
    // Multiply a leaf's opacity by every ancestor folder's opacity so
    // folder-level fades cascade through their children (Toon Boom peg /
    // After Effects "Track Matte" parity). A folder that's invisible or
    // 0-opacity hides every descendant.
    const worldOpacity = (layer) => {
      let op = layer.opacity == null ? 1 : layer.opacity;
      for (const a of layerAncestors(layer)) op *= (a.opacity == null ? 1 : a.opacity);
      return op;
    };
    const ancestorVisible = (layer) => {
      for (const a of layerAncestors(layer)) if (!a.visible) return false;
      return true;
    };
    // Tracks whether the wet stroke got rendered during the layer loop
    // (i.e. wetLayerId matched a vector layer). If not, the post-loop
    // fallback draws it so the artist still sees their wet ink in the
    // edge case where activeLayerId isn't known yet on the pen side.
    let wetRendered = false;

    for (const layer of project.layers) {
      if (layer.type === 'group') continue;       // folders don't render
      if (!layer.visible) continue;
      if (!ancestorVisible(layer)) continue;
      if (layer.type === 'video') {
        if (!includeVideo) continue;
        const v = layer.videoEl;
        if (v && v.readyState >= 2 && v.videoWidth) {
          ctx.save();
          ctx.globalAlpha = worldOpacity(layer);
          applyWorldXform(ctx, layer, frame, project, layerAncestors);
          const sc = Math.min(project.width / v.videoWidth, project.height / v.videoHeight);
          const vw = v.videoWidth * sc, vh = v.videoHeight * sc;
          ctx.drawImage(v, (project.width - vw) / 2, (project.height - vh) / 2, vw, vh);
          ctx.restore();
        }
        continue;
      }
      const cel = layer.celAt(frame);
      if (!cel) continue;
      ctx.save();
      ctx.globalAlpha = worldOpacity(layer);
      applyWorldXform(ctx, layer, frame, project, layerAncestors);

      const isActive = wetLayerId && layer.id === wetLayerId;
      const liveOverlay = opts.eraserOverlay
        && opts.eraserOverlay.samples && opts.eraserOverlay.samples.length > 0
        && layer.id === opts.eraserOverlay.layerId;
      const celMarks = cel.eraserMarks && cel.eraserMarks.length ? cel.eraserMarks : null;

      // Vector cels: re-render strokes directly so linework stays crisp at
      // any zoom. Skip if the cel is mid-live-stroke (raster cache owns
      // the wet preview in the main app's tools.js path) or if the caller
      // asked for the cached raster route.
      if (cel.kind === 'vector' && cel.strokes && OT.Vector
          && !opts.useRaster && !cel._liveDrawing) {
        const V = OT.Vector;
        if (liveOverlay || celMarks) {
          // Temp-canvas path for destination-out punches. Used whenever the
          // cel carries permanent non-destructive eraser marks OR a live
          // eraser drag is feeding overlay samples for this layer (pen
          // window). Render strokes to a temp at PARENT BACKING STORE size
          // (no upscale blur), apply destination-out for cel marks +
          // overlay samples, then blit 1:1 onto parent ctx.
          //
          // Why this shape:
          //   * Vector clip(evenodd) with N sample subpaths was O(N)+
          //     per render AND repeated every frame; long drags
          //     accumulated samples and the renderer choked.
          //   * Project-sized temp + upscaled drawImage blurred the
          //     layer (raster scaling) and produced sub-pixel shifts
          //     at commit.
          //   * Temp at parent-backing-store size means strokes render
          //     at pen-display resolution -- sharp. We copy the parent's
          //     current transform onto the temp ctx so cel-local coords
          //     map to the same pen-display pixels they would on the
          //     parent. destination-out punches the rendered active
          //     layer only (no leak to bg). Blit happens at identity
          //     transform = 1:1 pixel copy.
          //   * Per-frame cost is roughly: clearRect + render strokes
          //     (same as the non-eraser path) + O(marks+samples) circle
          //     fills + one drawImage. Constant in clip complexity.
          const tempW = ctx.canvas.width;
          const tempH = ctx.canvas.height;
          const temp = getEraserTempCanvas(tempW, tempH);
          const tctx = temp.getContext('2d');
          tctx.setTransform(1, 0, 0, 1, 0, 0);
          tctx.globalCompositeOperation = 'source-over';
          tctx.globalAlpha = 1;
          tctx.clearRect(0, 0, tempW, tempH);
          tctx.setTransform(ctx.getTransform());
          for (const st of cel.strokes)
            if (st.type === 'fill' && (includeLassoHidden || !st._lassoHidden))
              V.renderStroke(tctx, st);
          for (const st of cel.strokes)
            if (st.type !== 'fill' && (includeLassoHidden || !st._lassoHidden))
              V.renderStroke(tctx, st);
          if (isActive && wetStroke) { V.renderStroke(tctx, wetStroke); wetRendered = true; }
          tctx.globalCompositeOperation = 'destination-out';
          tctx.fillStyle = '#000';
          if (celMarks) {
            for (const m of celMarks) {
              tctx.beginPath();
              tctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
              tctx.fill();
            }
          }
          if (liveOverlay) {
            for (const s of opts.eraserOverlay.samples) {
              tctx.beginPath();
              tctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
              tctx.fill();
            }
          }
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(temp, 0, 0);
          ctx.restore();
        } else {
          // Skip strokes flagged _lassoHidden - the lasso tool renders them
          // separately via the overlay as a pre-rasterised snippet during
          // transform drags (huge perf win for large selections).
          for (const st of cel.strokes)
            if (st.type === 'fill' && (includeLassoHidden || !st._lassoHidden))
              V.renderStroke(ctx, st);
          for (const st of cel.strokes)
            if (st.type !== 'fill' && (includeLassoHidden || !st._lassoHidden))
              V.renderStroke(ctx, st);
          // Wet stroke renders ON TOP of committed strokes, for the active
          // layer only. Pen window uses this; main canvas leaves wetStroke
          // unset and this is a no-op.
          if (isActive && wetStroke) { V.renderStroke(ctx, wetStroke); wetRendered = true; }
        }
      } else if (cel.canvas) {
        // Defensive guard against missing cel.canvas (the original always
        // assumed it existed; on the pen-window raster placeholder it can
        // be undefined). Raster active layer doesn't get a wet stroke in
        // D1 (raster wet preview is deferred to D2).
        ctx.drawImage(cel.canvas, 0, 0, project.width, project.height);
      }
      ctx.restore();
    }
    // Fallback wet render: if wetStroke was provided but no layer matched
    // wetLayerId (e.g. pen window's first stroke fires before init has
    // populated activeLayerId), render it anyway in project coords so the
    // artist sees their wet ink. Better a tiny mis-transform than total
    // invisibility on the first stroke.
    if (wetStroke && !wetRendered && OT.Vector) {
      OT.Vector.renderStroke(ctx, wetStroke);
    }
    ctx.globalAlpha = 1;
  }

  // Apply the full ancestor -> leaf transform chain to ctx. Outermost
  // ancestor first so a parent group's translate/rotate/scale becomes the
  // frame in which every descendant draws (Toon Boom peg model).
  function applyWorldXform(ctx, layer, frame, project, layerAncestors) {
    const px = project.width / 2, py = project.height / 2;
    const chain = [];
    const ancestors = layerAncestors(layer);
    for (let i = ancestors.length - 1; i >= 0; i--) chain.push(ancestors[i]);
    chain.push(layer);
    for (const l of chain) {
      const tr = l.transformAt ? l.transformAt(frame) : null;
      if (!tr) continue;
      if (tr.x || tr.y || tr.rot || tr.sx !== 1 || tr.sy !== 1) {
        ctx.translate(tr.x + px, tr.y + py);
        ctx.rotate(tr.rot * Math.PI / 180);
        ctx.scale(tr.sx, tr.sy);
        ctx.translate(-px, -py);
      }
    }
  }

  OT.compositeStage = compositeStage;
  OT.applyWorldXform = applyWorldXform;
})(window.OT = window.OT || {});
