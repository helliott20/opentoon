/* OpenToon Studio - stage renderer, viewport, compositing, input */
(function (OT) {
  'use strict';
  const U = OT.util;

  class Stage {
    constructor(app) {
      this.app = app;
      this.canvas = document.getElementById('canvas');
      this.overlay = document.getElementById('overlay');
      this.viewport = document.getElementById('viewport');
      this.ctx = this.canvas.getContext('2d');
      this.octx = this.overlay.getContext('2d');
      // 4K pen displays (Cintiq Pro / iPad-as-display) often report a DPR
      // between 2.5 and 3, so cap at 3 instead of 2 to avoid a soft canvas.
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.view = { zoom: 1, x: 0, y: 0, rot: 0 };
      this.flipH = false;
      this.flipV = false;
      this.cursorPt = null;       // last project-space pointer pos
      this._tmp = document.createElement('canvas');
      this._flat = document.createElement('canvas');
      this._panning = false;
      this._spaceDown = false;

      this._installResize();
      this._installInput();
      app.on('render', () => this.render());
      app.on('overlayrender', () => this.renderOverlay());
    }

    /* ---------------- sizing ---------------- */
    _installResize() {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.viewport);
      window.addEventListener('resize', () => this.resize());
      // Re-raster when the monitor's pixel ratio changes (e.g. window dragged
      // between a retina laptop and an external 1x display, or OS scaling
      // tweaked) so the canvas backing store stays crisp.
      if (window.matchMedia) {
        try {
          const mq = window.matchMedia('(resolution: 1dppx)');
          const onChange = () => this.resize();
          if (mq.addEventListener) mq.addEventListener('change', onChange);
          else if (mq.addListener) mq.addListener(onChange);
        } catch (_) { /* media query unsupported -- ignore */ }
      }
    }
    resize() {
      // Read DPR fresh each time so cross-monitor moves (or zoom changes)
      // pick up the new value -- capped at 3 for high-DPI pen displays.
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      const r = this.viewport.getBoundingClientRect();
      this.cw = Math.max(1, Math.round(r.width));
      this.ch = Math.max(1, Math.round(r.height));
      for (const c of [this.canvas, this.overlay]) {
        c.style.width = this.cw + 'px';
        c.style.height = this.ch + 'px';
        c.width = Math.round(this.cw * this.dpr);
        c.height = Math.round(this.ch * this.dpr);
      }
      if (!this._fitOnce) { this.fitToCamera(); this._fitOnce = true; }
      this.render();
    }

    fitToCamera() {
      const p = this.app.project;
      const z = Math.min(this.cw / p.width, this.ch / p.height) * 0.86;
      this.view.zoom = U.clamp(z, 0.02, 32);
      this.view.x = (this.cw - p.width * this.view.zoom) / 2;
      this.view.y = (this.ch - p.height * this.view.zoom) / 2;
      this.render();
    }

    /* ---------------- coord mapping ----------------
       Project space maps to screen space in this order: scale + translate
       (zoom / pan), then rotate about the viewport centre, then flip. The
       inverse (screen -> project) un-does flip, then rotation, then pan. */
    _rawView(sx, sy) {
      const r = this.canvas.getBoundingClientRect();
      let x = sx - r.left, y = sy - r.top;
      if (this.flipH) x = this.cw - x;
      if (this.flipV) y = this.ch - y;
      if (this.view.rot) {
        const rad = -this.view.rot * Math.PI / 180;
        const cx = this.cw / 2, cy = this.ch / 2;
        const ox = x - cx, oy = y - cy;
        const cs = Math.cos(rad), sn = Math.sin(rad);
        x = cx + ox * cs - oy * sn;
        y = cy + ox * sn + oy * cs;
      }
      return { x, y };
    }
    screenToProject(sx, sy) {
      const v = this._rawView(sx, sy);
      return {
        x: (v.x - this.view.x) / this.view.zoom,
        y: (v.y - this.view.y) / this.view.zoom
      };
    }
    projectToScreen(px, py) {
      let x = this.view.x + px * this.view.zoom;
      let y = this.view.y + py * this.view.zoom;
      if (this.view.rot) {
        const rad = this.view.rot * Math.PI / 180;
        const cx = this.cw / 2, cy = this.ch / 2;
        const ox = x - cx, oy = y - cy;
        const cs = Math.cos(rad), sn = Math.sin(rad);
        x = cx + ox * cs - oy * sn;
        y = cy + ox * sn + oy * cs;
      }
      if (this.flipH) x = this.cw - x;
      if (this.flipV) y = this.ch - y;
      return { x, y };
    }
    // Un-rotate a screen-space delta into view (pan) space.
    _unrotateDelta(dx, dy) {
      if (this.flipH) dx = -dx;
      if (this.flipV) dy = -dy;
      if (this.view.rot) {
        const rad = -this.view.rot * Math.PI / 180;
        const cs = Math.cos(rad), sn = Math.sin(rad);
        return { dx: dx * cs - dy * sn, dy: dx * sn + dy * cs };
      }
      return { dx, dy };
    }
    _applyView(ctx) {
      const d = this.dpr, z = this.view.zoom;
      if (!this.view.rot) {
        // fast path: pure flip + zoom + pan (the common, un-rotated case)
        const ax = this.flipH ? -d * z : d * z;
        const ex = this.flipH ? d * (this.cw - this.view.x) : d * this.view.x;
        const ay = this.flipV ? -d * z : d * z;
        const ey = this.flipV ? d * (this.ch - this.view.y) : d * this.view.y;
        ctx.setTransform(ax, 0, 0, ay, ex, ey);
        return;
      }
      ctx.setTransform(d, 0, 0, d, 0, 0);          // device px -> CSS px
      if (this.flipH || this.flipV) {
        ctx.translate(this.flipH ? this.cw : 0, this.flipV ? this.ch : 0);
        ctx.scale(this.flipH ? -1 : 1, this.flipV ? -1 : 1);
      }
      ctx.translate(this.cw / 2, this.ch / 2);
      ctx.rotate(this.view.rot * Math.PI / 180);
      ctx.translate(-this.cw / 2, -this.ch / 2);
      ctx.translate(this.view.x, this.view.y);
      ctx.scale(z, z);
    }
    // Rotate the drawing view (degrees) -- handy on a pen display.
    rotateBy(deg) {
      this.view.rot = ((this.view.rot + deg) % 360 + 360) % 360;
      this.render();
    }
    resetRotation() {
      if (!this.view.rot) return;
      this.view.rot = 0;
      this.render();
    }

    zoomAt(sx, sy, factor) {
      const v = this._rawView(sx, sy);
      const before = {
        x: (v.x - this.view.x) / this.view.zoom,
        y: (v.y - this.view.y) / this.view.zoom
      };
      this.view.zoom = U.clamp(this.view.zoom * factor, 0.02, 32);
      this.view.x = v.x - before.x * this.view.zoom;
      this.view.y = v.y - before.y * this.view.zoom;
      this.render();
    }
    panBy(dx, dy) {
      // Reject non-finite deltas defensively — a bogus screen delta would
      // otherwise NaN view.x / view.y permanently and leave the canvas
      // un-pannable until the app is reloaded.
      if (!isFinite(dx) || !isFinite(dy)) return;
      const d = this._unrotateDelta(dx, dy);
      this.view.x += d.dx;
      this.view.y += d.dy;
      this.render();
    }

    /* ---------------- compositing ---------------- */
    // Draw bg + all visible layers at `frame` onto ctx already in project coords.
    compositeStage(frame, ctx, opts) {
      opts = opts || {};
      const p = this.app.project;
      if (opts.bg !== false) {
        ctx.fillStyle = p.bg;
        ctx.fillRect(0, 0, p.width, p.height);
      }
      const px = p.width / 2, py = p.height / 2;
      for (const layer of p.layers) {
        if (!layer.visible) continue;
        if (layer.type === 'video') {
          const v = layer.videoEl;
          if (v && v.readyState >= 2 && v.videoWidth) {
            const tr = layer.transformAt(frame);
            ctx.save();
            ctx.globalAlpha = layer.opacity;
            if (tr.x || tr.y || tr.rot || tr.sx !== 1 || tr.sy !== 1) {
              ctx.translate(tr.x + px, tr.y + py);
              ctx.rotate(tr.rot * Math.PI / 180);
              ctx.scale(tr.sx, tr.sy);
              ctx.translate(-px, -py);
            }
            const sc = Math.min(p.width / v.videoWidth, p.height / v.videoHeight);
            const vw = v.videoWidth * sc, vh = v.videoHeight * sc;
            ctx.drawImage(v, (p.width - vw) / 2, (p.height - vh) / 2, vw, vh);
            ctx.restore();
          }
          continue;
        }
        const cel = layer.celAt(frame);
        if (!cel) continue;
        const tr = layer.transformAt(frame);
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        if (tr.x || tr.y || tr.rot || tr.sx !== 1 || tr.sy !== 1) {
          ctx.translate(tr.x + px, tr.y + py);
          ctx.rotate(tr.rot * Math.PI / 180);
          ctx.scale(tr.sx, tr.sy);
          ctx.translate(-px, -py);
        }
        // Vector cels: re-render strokes directly into the stage instead of
        // upscaling cel.canvas, so the linework stays crisp at any zoom.
        // Skip the direct path while a stroke is being live-drawn (the
        // committed stroke isn't in cel.strokes yet -- live stamps live on
        // cel.canvas) so the brush wet-ink preview stays visible. Raster
        // cels and the cached cel.canvas (used for thumbs/exports/onion) are
        // untouched.
        if (cel.kind === 'vector' && cel.strokes && OT.Vector
            && !opts.useRaster && !cel._liveDrawing) {
          const V = OT.Vector;
          for (const st of cel.strokes) if (st.type === 'fill') V.renderStroke(ctx, st);
          for (const st of cel.strokes) if (st.type !== 'fill') V.renderStroke(ctx, st);
        } else {
          ctx.drawImage(cel.canvas, 0, 0, p.width, p.height);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    _layerXform(ctx, layer, frame) {
      const p = this.app.project, px = p.width / 2, py = p.height / 2;
      const tr = layer.transformAt(frame);
      if (tr.x || tr.y || tr.rot || tr.sx !== 1 || tr.sy !== 1) {
        ctx.translate(tr.x + px, tr.y + py);
        ctx.rotate(tr.rot * Math.PI / 180);
        ctx.scale(tr.sx, tr.sy);
        ctx.translate(-px, -py);
      }
    }

    _tinted(cel, color) {
      const t = this._tmp;
      t.width = cel.w; t.height = cel.h;
      const x = t.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, cel.w, cel.h);
      x.globalCompositeOperation = 'source-over';
      x.drawImage(cel.canvas, 0, 0);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = color;
      x.fillRect(0, 0, cel.w, cel.h);
      x.globalCompositeOperation = 'source-over';
      return t;
    }

    _drawOnion(ctx) {
      const app = this.app, o = app.onion;
      if (!o.on || app.playback.playing) return;
      const layer = app.activeLayer();
      if (!layer) return;
      const f = app.frame;
      const drawSet = (count, dir, color) => {
        for (let i = 1; i <= count; i++) {
          const fr = f + dir * i;
          if (fr < 0 || fr >= app.project.frameCount) break;
          const cel = layer.celAt(fr);
          if (!cel) continue;
          const a = U.lerp(o.maxAlpha, o.minAlpha, (i - 1) / Math.max(1, count - 1));
          ctx.globalAlpha = a;
          ctx.save();
          this._layerXform(ctx, layer, fr);
          ctx.drawImage(this._tinted(cel, color), 0, 0,
            this.app.project.width, this.app.project.height);
          ctx.restore();
        }
      };
      drawSet(o.prev, -1, o.prevColor);
      drawSet(o.next, 1, o.nextColor);
      ctx.globalAlpha = 1;
    }

    /* ---------------- render ---------------- */
    render() {
      const ctx = this.ctx, p = this.app.project;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._applyView(ctx);
      ctx.imageSmoothingEnabled = this.view.zoom < 3;

      // paper drop shadow
      ctx.save();
      ctx.shadowColor = '#000a';
      ctx.shadowBlur = 14 / this.view.zoom;
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, p.width, p.height);
      ctx.restore();

      this._drawOnion(ctx);
      this.compositeStage(this.app.frame, ctx, { bg: false });

      // active tool may draw on the cel directly; nothing else here
      this.renderOverlay();
    }

    renderOverlay() {
      const ctx = this.octx, p = this.app.project;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      this._applyView(ctx);

      // paper border
      ctx.lineWidth = 1 / this.view.zoom;
      ctx.strokeStyle = '#0008';
      ctx.strokeRect(0, 0, p.width, p.height);

      if (this.app.grid && this.app.grid.on) this._drawGrid(ctx);
      if (this.app.symmetry && this.app.symmetry.on) this._drawSymmetry(ctx);
      if (this.app.showCamera !== false) this._drawCameraGuide(ctx);

      // active tool preview
      if (this.app.tools) this.app.tools.drawOverlay(ctx);

      // brush cursor
      this._drawCursor(ctx);
    }

    cameraCorners(frame) {
      const p = this.app.project, c = p.cameraAt(frame);
      const cx = p.width / 2 + c.x, cy = p.height / 2 + c.y;
      const hw = p.width / (2 * c.zoom), hh = p.height / (2 * c.zoom);
      const rad = c.rot * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
      const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
      return pts.map(([x, y]) => ({ x: cx + x * cs - y * sn, y: cy + x * sn + y * cs }));
    }
    _drawCameraGuide(ctx) {
      const co = this.cameraCorners(this.app.frame);
      ctx.save();
      ctx.lineWidth = 1.6 / this.view.zoom;
      ctx.setLineDash([7 / this.view.zoom, 5 / this.view.zoom]);
      ctx.strokeStyle = '#f0a93d';
      ctx.beginPath();
      ctx.moveTo(co[0].x, co[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(co[i].x, co[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      // corner ticks
      ctx.fillStyle = '#f0a93d';
      const r = 3 / this.view.zoom;
      for (const pt of co) { ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, 7); ctx.fill(); }
      ctx.restore();
    }

    _drawGrid(ctx) {
      const p = this.app.project, g = this.app.grid;
      ctx.save();
      ctx.lineWidth = 1 / this.view.zoom;
      ctx.strokeStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath();
      for (let x = g.size; x < p.width; x += g.size) { ctx.moveTo(x, 0); ctx.lineTo(x, p.height); }
      for (let y = g.size; y < p.height; y += g.size) { ctx.moveTo(0, y); ctx.lineTo(p.width, y); }
      ctx.stroke();
      if (g.guides) {
        ctx.strokeStyle = 'rgba(74,159,212,0.55)';
        ctx.beginPath();
        for (let i = 1; i < 3; i++) {
          ctx.moveTo(p.width * i / 3, 0); ctx.lineTo(p.width * i / 3, p.height);
          ctx.moveTo(0, p.height * i / 3); ctx.lineTo(p.width, p.height * i / 3);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    _drawSymmetry(ctx) {
      const p = this.app.project, s = this.app.symmetry, z = this.view.zoom;
      ctx.save();
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = 'rgba(232,162,58,0.85)';
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.beginPath();
      if (s.axis === 'v') { ctx.moveTo(p.width / 2, 0); ctx.lineTo(p.width / 2, p.height); }
      else { ctx.moveTo(0, p.height / 2); ctx.lineTo(p.width, p.height / 2); }
      ctx.stroke();
      ctx.restore();
    }
    _drawCursor(ctx) {
      const t = this.app.tools && this.app.tools.active;
      if (!t || !this.cursorPt || !t.cursorRadius) return;
      const rad = t.cursorRadius(this.app);
      if (!rad) return;
      ctx.save();
      ctx.lineWidth = 1 / this.view.zoom;
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      ctx.arc(this.cursorPt.x, this.cursorPt.y, rad, 0, 7);
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(this.cursorPt.x, this.cursorPt.y, rad + 1 / this.view.zoom, 0, 7);
      ctx.stroke();
      ctx.restore();
    }

    /* ---------------- color sampling ---------------- */
    sampleColor(px, py) {
      const p = this.app.project;
      px = Math.floor(px); py = Math.floor(py);
      if (px < 0 || py < 0 || px >= p.width || py >= p.height) return null;
      this._flat.width = p.width; this._flat.height = p.height;
      const fx = this._flat.getContext('2d', { willReadFrequently: true });
      fx.setTransform(1, 0, 0, 1, 0, 0);
      this.compositeStage(this.app.frame, fx);
      const d = fx.getImageData(px, py, 1, 1).data;
      return U.rgbToHex(d[0], d[1], d[2]);
    }

    /* ---------------- input ---------------- */
    _installInput() {
      const c = this.canvas;

      // Some tablet drivers (notably Wacom on Windows) emit pointer events --
      // especially coalesced ones -- carrying bogus (0,0) or non-finite
      // coordinates. Drawing through those makes strokes spike to the
      // top-left corner, so every event is validated before it is trusted.
      const usable = e => !!e && isFinite(e.clientX) && isFinite(e.clientY) &&
        !(e.clientX === 0 && e.clientY === 0);

      // A stylus flipped to its eraser end reports button 5 on down/up and
      // the 32 bit set in `buttons` -- detect either so the eraser engages.
      const isEraser = e => e.pointerType === 'pen' &&
        ((e.buttons & 32) !== 0 || e.button === 5);

      const evt = e => {
        const pt = this.screenToProject(e.clientX, e.clientY);
        pt.pressure = (e.pointerType === 'pen')
          ? this.app.mapPressure(e.pressure || 0.5) : 1;
        pt.shift = e.shiftKey; pt.alt = e.altKey; pt.ctrl = e.ctrlKey;
        pt.button = e.button; pt.sx = e.clientX; pt.sy = e.clientY;
        pt.penEraser = isEraser(e);
        return pt;
      };

      c.addEventListener('pointerdown', e => {
        if (!usable(e)) return;
        try { c.setPointerCapture(e.pointerId); } catch (_) {}
        const pt = evt(e);
        this.cursorPt = pt;
        // middle / right button = pan
        if (e.button === 1 || e.button === 2) {
          this._panning = { sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
          return;
        }
        this.app.tools.pointerDown(pt, e);
      });

      c.addEventListener('pointermove', e => {
        if (this._panning) {
          const d = this._unrotateDelta(
            e.clientX - this._panning.sx, e.clientY - this._panning.sy);
          this.view.x = this._panning.vx + d.dx;
          this.view.y = this._panning.vy + d.dy;
          this.render();
          return;
        }
        // Prefer coalesced events for smooth high-frequency strokes, but keep
        // only the ones with real coordinates; fall back to the event itself.
        let batch = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
        batch = batch.filter(usable);
        if (!batch.length && usable(e)) batch = [e];
        if (!batch.length) return;            // nothing trustworthy this frame
        let pt;
        for (const ce of batch) {
          pt = this.screenToProject(ce.clientX, ce.clientY);
          pt.pressure = (ce.pointerType === 'pen')
            ? this.app.mapPressure(ce.pressure || 0.5) : 1;
          pt.shift = e.shiftKey; pt.alt = e.altKey; pt.ctrl = e.ctrlKey;
          // Screen-space coords are needed by tools that operate on the
          // viewport (HandTool's pan delta, ZoomTool's anchor). Without
          // these, HandTool.pointerMove would compute NaN deltas and
          // corrupt view.x / view.y, leaving the canvas un-pannable.
          pt.sx = ce.clientX; pt.sy = ce.clientY;
          this.app.tools.pointerMove(pt, e);
        }
        this.cursorPt = pt;
        if (!this.app.tools.dragging) this.renderOverlay();
        this.app.ui.setCoord(this.cursorPt);
      });

      const end = e => {
        if (this._panning) { this._panning = false; return; }
        // A bogus (0,0) pointerup must not drag the final stroke point to the
        // corner -- fall back to the last good position instead.
        let pt;
        if (usable(e)) pt = evt(e);
        else if (this.cursorPt) pt = Object.assign({}, this.cursorPt, { button: e.button });
        else pt = { x: 0, y: 0, pressure: 0, button: e.button };
        this.app.tools.pointerUp(pt, e);
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', e => {
        // If the pen / mouse leaves the canvas mid-stroke we must still tell
        // the active tool the stroke ended -- otherwise it stays "dragging"
        // forever and the next pointerdown looks like a continuation. Use the
        // last known project-space cursor so the synthesised up lands at a
        // sane position rather than (0,0).
        if (this.app.tools && this.app.tools.dragging && this.cursorPt) {
          const pt = Object.assign({}, this.cursorPt, { button: 0 });
          try { this.app.tools.pointerUp(pt, e); } catch (_) {}
        }
        this.cursorPt = null;
        this.renderOverlay();
      });
      c.addEventListener('contextmenu', e => e.preventDefault());

      c.addEventListener('wheel', e => {
        e.preventDefault();
        // Match the pen-window UX: hold Ctrl / Meta for a fine 1.05x step,
        // plain wheel keeps the coarser 1.15x. Zoom centring on cursor is
        // preserved because zoomAt anchors to the screen coords.
        const step = (e.ctrlKey || e.metaKey) ? 1.05 : 1.15;
        const f = e.deltaY < 0 ? step : 1 / step;
        this.zoomAt(e.clientX, e.clientY, f);
      }, { passive: false });

    }
  }

  OT.Stage = Stage;
})(window.OT);
