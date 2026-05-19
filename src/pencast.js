/* OpenToon Studio - PenCast: drive the canvas from a second "pen display"
   window.

   A graphics tablet with a built-in screen (a Wacom pen display, an iPad via
   Sidecar, etc.) is most comfortable when the artist draws on the tablet while
   the panels stay on the main monitor. OpenToon delivers that with a second
   Electron window that is a pure drawing surface.

   The two windows are separate processes, so they cannot share the live
   project. Instead the main window stays the single source of truth and the
   pen window is a thin terminal:

     - main  -> pen : the composited stage, streamed as a WebP frame.
     - pen   -> main: pointer events (normalised 0..1 over the streamed image)
                      and toolbar commands (tool / colour / undo / ...).

   PenCast is inert in the browser build and whenever no pen window is open,
   so it never affects the normal single-window experience. */
(function (OT) {
  'use strict';
  const U = OT.util;

  class PenCast {
    constructor(app) {
      this.app = app;
      this.active = false;                       // a pen window is attached
      this.bridge = window.OpenToonDesktop || null;
      this._dirty = false;                       // stage changed since last send
      this._sending = false;                     // a frame encode is in flight
      this._raf = 0;
      this._off = null;                          // reused downscale canvas

      // Web build / no desktop bridge -> stay completely inert.
      if (!this.bridge || !this.bridge.sendPenFrame) return;

      this.bridge.onPenAttach(() => this._attach());
      this.bridge.onPenDetach(() => this._detach());
      this.bridge.onPenInput(msg => { try { this._onInput(msg); } catch (e) { console.error(e); } });
      this.bridge.onPenCommand(msg => { try { this._onCommand(msg); } catch (e) { console.error(e); } });

      // any visual change to the stage is worth streaming
      app.on('render', () => this._schedule());
      app.on('overlayrender', () => this._schedule());
    }

    /* ---- availability / opening (called by the View menu) ---- */
    available() { return !!(this.bridge && this.bridge.openPenWindow); }
    open() {
      if (!this.available()) {
        this.app.ui.status('The pen drawing window is a desktop-app feature');
        return;
      }
      this.bridge.openPenWindow();
      this.app.ui.status('Opening the drawing window…');
    }

    _attach() {
      this.active = true;
      this.app.ui.status('Drawing window connected — draw on your pen display');
      this._dirty = true;
      this._schedule();
    }
    _detach() {
      this.active = false;
      this.app.ui.status('Drawing window closed');
    }

    /* ---------------- main -> pen : stream the stage ---------------- */
    _schedule() {
      if (!this.active) return;
      this._dirty = true;
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._sendFrame(); });
    }
    _sendFrame() {
      if (!this.active || !this._dirty || this._sending) return;
      const st = this.app.stage;
      const src = st && st.canvas;
      if (!src || !src.width || !src.height) return;
      this._dirty = false;

      // Downscale to a sane cap so the WebP encode + IPC copy stay cheap even
      // on a hi-DPI canvas. Aspect ratio is preserved, so the pen window can
      // map a touch back to project space from a plain 0..1 fraction.
      const CAP = 1680;
      const scale = Math.min(1, CAP / Math.max(src.width, src.height));
      const w = Math.max(2, Math.round(src.width * scale));
      const h = Math.max(2, Math.round(src.height * scale));
      if (!this._off) this._off = document.createElement('canvas');
      if (this._off.width !== w || this._off.height !== h) {
        this._off.width = w; this._off.height = h;
      }
      const ox = this._off.getContext('2d');
      ox.clearRect(0, 0, w, h);
      ox.drawImage(src, 0, 0, w, h);
      // the overlay carries the brush cursor, camera guide, selection handles
      if (st.overlay && st.overlay.width) ox.drawImage(st.overlay, 0, 0, w, h);

      const meta = this._meta();
      this._sending = true;
      this._off.toBlob(blob => {
        this._sending = false;
        if (blob && this.active) {
          blob.arrayBuffer()
            .then(buf => { if (this.active) this.bridge.sendPenFrame(buf, meta); })
            .catch(() => {});
        }
        if (this._dirty) this._schedule();    // coalesced change while encoding
      }, 'image/webp', 0.72);
    }
    // State the pen window needs: which tool is live, the colour, and the
    // brush radius as a fraction of stage width (resolution-independent, so
    // the pen window can draw a matching wet-ink preview).
    _meta() {
      const a = this.app, st = a.stage, t = a.tools.active;
      const rad = (t && t.cursorRadius ? (t.cursorRadius(a) || 0) : 0) * st.view.zoom;
      return {
        tool: t ? t.name : 'brush',
        color: a.color,
        brushFrac: st.cw ? rad / st.cw : 0.02,
        frame: a.frame + 1,
        frameCount: a.project.frameCount,
        zoom: Math.round(st.view.zoom * 100)
      };
    }

    /* ---------------- pen -> main : pointer input ---------------- */
    // Build a project-space point from a 0..1 fraction over the streamed image.
    _ptFromNorm(nx, ny, pressure, msg) {
      const st = this.app.stage;
      const r = st.canvas.getBoundingClientRect();
      const sx = r.left + nx * st.cw;
      const sy = r.top + ny * st.ch;
      const pt = st.screenToProject(sx, sy);
      pt.pressure = msg && msg.isPen
        ? this.app.mapPressure(pressure == null ? 0.5 : pressure) : 1;
      pt.shift = !!(msg && msg.shift);
      pt.alt = !!(msg && msg.alt);
      pt.ctrl = false;
      pt.sx = sx; pt.sy = sy;
      pt.button = (msg && msg.button) || 0;
      pt.penEraser = !!(msg && msg.penEraser);
      return pt;
    }
    _fakeEvt(msg) {
      return {
        pointerType: (msg && msg.isPen) ? 'pen' : 'mouse',
        shiftKey: !!(msg && msg.shift), altKey: !!(msg && msg.alt), ctrlKey: false,
        button: (msg && msg.button) || 0, buttons: (msg && msg.buttons) || 0,
        preventDefault() {}, stopPropagation() {}
      };
    }
    _onInput(msg) {
      if (!msg || !this.app.tools) return;
      const tools = this.app.tools, st = this.app.stage;
      if (msg.type === 'down') {
        const pt = this._ptFromNorm(msg.nx, msg.ny, msg.pressure, msg);
        st.cursorPt = pt;
        tools.pointerDown(pt, this._fakeEvt(msg));
      } else if (msg.type === 'move') {
        const list = (msg.pts && msg.pts.length) ? msg.pts : [msg];
        let pt = null;
        for (const p of list) {
          pt = this._ptFromNorm(p.nx, p.ny, p.pressure, msg);
          tools.pointerMove(pt, this._fakeEvt(msg));
        }
        if (pt) st.cursorPt = pt;
        if (!tools.dragging) st.renderOverlay();
        if (pt) this.app.ui.setCoord(pt);
      } else if (msg.type === 'up') {
        const pt = this._ptFromNorm(msg.nx, msg.ny, msg.pressure, msg);
        tools.pointerUp(pt, this._fakeEvt(msg));
      } else if (msg.type === 'hover') {
        st.cursorPt = this._ptFromNorm(msg.nx, msg.ny, 1, msg);
        st.renderOverlay();
      } else if (msg.type === 'leave') {
        st.cursorPt = null;
        st.renderOverlay();
      }
    }

    /* ---------------- pen -> main : toolbar commands ---------------- */
    _onCommand(msg) {
      if (!msg) return;
      const a = this.app;
      switch (msg.type) {
        case 'tool':
          if (a.tools.tools[msg.tool]) a.tools.select(msg.tool);
          break;
        case 'color':
          if (msg.color) a.setColor(msg.color);
          break;
        case 'undo': a.undo(); break;
        case 'redo': a.redo(); break;
        case 'newdraw': a.newDrawing(); break;
        case 'frame': a.playback.step(msg.dir > 0 ? 1 : -1); break;
        case 'fit': a.stage.fitToCamera(); break;
        case 'brush-size': {
          const t = a.tools.active.name;
          const sel = t === 'eraser' ? 'eraserSize'
            : t === 'pencil' ? 'pencilSize' : 'brushSize';
          const cur = a.settings[sel];
          a.settings[sel] = U.clamp(cur + (msg.delta || 0) * Math.max(1, cur * 0.14), 1, 300);
          a.ui._buildToolOpts();
          a.emit('overlayrender');
          break;
        }
        case 'zoom': {
          const st = a.stage, r = st.canvas.getBoundingClientRect();
          st.zoomAt(r.left + (msg.nx || 0.5) * st.cw,
            r.top + (msg.ny || 0.5) * st.ch, msg.factor || 1);
          break;
        }
        case 'pan': {
          const st = a.stage;
          st.panBy((msg.dnx || 0) * st.cw, (msg.dny || 0) * st.ch);
          break;
        }
        case 'flip': a.toggleFlipH(); break;
      }
    }
  }

  OT.PenCast = PenCast;
})(window.OT);
