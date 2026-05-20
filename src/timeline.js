/* OpenToon Studio - timeline / xsheet */
(function (OT) {
  'use strict';
  const U = OT.util;

  const ICON = {
    start: '<path d="M7 5v14"/><path d="M18 5l-9 7 9 7z"/>',
    back: '<path d="M15 5l-9 7 9 7z"/>',
    play: '<path d="M8 4l12 8-12 8z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    fwd: '<path d="M9 5l9 7-9 7z"/>',
    end: '<path d="M17 5v14"/><path d="M6 5l9 7-9 7z"/>',
    loop: '<path d="M3 11a7 7 0 0 1 12-5l3 2"/><path d="M21 13a7 7 0 0 1-12 5l-3-2"/><path d="M18 4v4h-4M6 20v-4h4"/>',
    newdraw: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M12 12v6M9 15h6"/>',
    dup: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    extend: '<path d="M4 12h11"/><path d="M12 6l8 6-8 6"/>',
    clearx: '<path d="M6 6l12 12M18 6L6 18"/>',
    addframe: '<path d="M12 5v14M5 12h14"/>',
    onion: '<circle cx="9.5" cy="12" r="6.5"/><circle cx="14.5" cy="12" r="6.5"/>',
    addlayer: '<rect x="3" y="4" width="13" height="13" rx="1.5"/><path d="M19 10v9M14.5 14.5h9"/>',
    thumbs: '<rect x="3" y="5" width="8" height="6" rx="1"/><rect x="13" y="5" width="8" height="6" rx="1"/><rect x="3" y="14" width="8" height="6" rx="1"/><rect x="13" y="14" width="8" height="6" rx="1"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2"/><path d="M6.1 6.1A17 17 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 5.1-1.3"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>'
  };

  class Timeline {
    constructor(app) {
      this.app = app;
      this.root = document.getElementById('timeline');
      this.cellW = 15; this.rowH = 26; this.headerH = 24;
      this.endPad = 18;   // grab zone past the last frame for the length handle
      this.showThumbs = false;
      this._build();
      ['framechange', 'projectchange', 'layerschange', 'celchange',
        'playbackstate', 'onionchange', 'layerselect']
        .forEach(ev => app.on(ev, () => this.render()));
      if (app.timelineHeight) this.setHeight(app.timelineHeight);
    }

    /* rows are displayed top = front-most layer */
    rowToLayer(r) {
      const L = this.app.project.layers;
      return L[L.length - 1 - r];
    }
    layerToRow(layer) {
      const L = this.app.project.layers;
      return L.length - 1 - L.indexOf(layer);
    }

    _btn(title, icon, fn) {
      const b = U.el('button', { class: 'tl-btn', title: title }, [
        icon ? this._svg(icon) : title
      ]);
      b.addEventListener('click', fn);
      return b;
    }
    _svg(icon) {
      const span = document.createElement('span');
      span.innerHTML = U.svg(icon);
      span.style.display = 'flex';
      span.firstChild.style.width = '15px';
      span.firstChild.style.height = '15px';
      return span;
    }

    _build() {
      const app = this.app;
      this.root.innerHTML = '';

      // resize handle - drag the top edge to grow / shrink the timeline
      const resizer = U.el('div', { class: 'tl-resizer', title: 'Drag to resize the timeline' });
      this.root.appendChild(resizer);
      this._installResizer(resizer);

      // toolbar
      const tb = U.el('div', { class: 'tl-toolbar' });
      this.root.appendChild(tb);

      tb.appendChild(this._btn('Go to start (Home)', ICON.start, () => app.playback.gotoStart()));
      tb.appendChild(this._btn('Previous frame (,)', ICON.back, () => app.playback.step(-1)));
      this.playBtn = this._btn('Play / Stop (Enter)', ICON.play, () => app.playback.toggle());
      tb.appendChild(this.playBtn);
      tb.appendChild(this._btn('Next frame (.)', ICON.fwd, () => app.playback.step(1)));
      tb.appendChild(this._btn('Go to end (End)', ICON.end, () => app.playback.gotoEnd()));
      this.loopBtn = this._btn('Loop mode', ICON.loop, () => {
        const modes = ['loop', 'pingpong', 'once'];
        app.playback.loopMode = modes[(modes.indexOf(app.playback.loopMode) + 1) % 3];
        this.loopBtn.classList.toggle('on', app.playback.loopMode !== 'once');
        this.loopBtn.title = 'Loop: ' + app.playback.loopMode;
        app.ui.status('Loop mode: ' + app.playback.loopMode);
      });
      this.loopBtn.classList.add('on');
      tb.appendChild(this.loopBtn);

      tb.appendChild(U.el('div', { class: 'tl-sep' }));
      tb.appendChild(this._btn('Add drawing layer', ICON.addlayer, () => app.addLayer()));
      tb.appendChild(this._btn('New drawing on current frame', ICON.newdraw, () => app.newDrawing()));
      tb.appendChild(this._btn('Duplicate drawing', ICON.dup, () => app.duplicateDrawing()));
      tb.appendChild(this._btn('Extend exposure', ICON.extend, () => app.extendExposure()));
      tb.appendChild(this._btn('Clear exposure (Del frame)', ICON.clearx, () => app.clearExposure()));

      tb.appendChild(U.el('div', { class: 'tl-sep' }));
      tb.appendChild(this._btn('Add 12 frames', ICON.addframe, () => {
        app.project.frameCount += 12; app.emit('projectchange');
      }));
      this.onionBtn = this._btn('Onion skin', ICON.onion, () => {
        app.onion.on = !app.onion.on;
        this.onionBtn.classList.toggle('on', app.onion.on);
        app.emit('onionchange'); app.emit('render');
      });
      tb.appendChild(this.onionBtn);
      this.thumbBtn = this._btn('Show drawing thumbnails', ICON.thumbs, () => {
        this.showThumbs = !this.showThumbs;
        this.rowH = this.showThumbs ? 48 : 26;
        this.thumbBtn.classList.toggle('on', this.showThumbs);
        this.render();
      });
      tb.appendChild(this.thumbBtn);

      tb.appendChild(U.el('div', { class: 'tl-spacer' }));
      this.counter = U.el('div', { class: 'tl-counter' });
      tb.appendChild(this.counter);

      // body
      const body = U.el('div', { class: 'tl-body' });
      this.root.appendChild(body);

      const names = U.el('div', { class: 'tl-names' });
      names.appendChild(U.el('div', { class: 'tl-names-head' }, ['Layers']));
      this.namesList = U.el('div', { class: 'tl-names-list' });
      this.namesInner = U.el('div');
      this.namesList.appendChild(this.namesInner);
      names.appendChild(this.namesList);
      body.appendChild(names);

      this.gridWrap = U.el('div', { class: 'tl-grid-wrap' });
      this.grid = U.el('canvas');
      this.gridWrap.appendChild(this.grid);
      body.appendChild(this.gridWrap);
      this.gctx = this.grid.getContext('2d');

      this.gridWrap.addEventListener('scroll', () => {
        this.namesInner.style.transform = 'translateY(' + (-this.gridWrap.scrollTop) + 'px)';
      });
      this._installGridInput();
    }

    _installResizer(handle) {
      const tl = this.root;
      let drag = null;
      handle.addEventListener('pointerdown', e => {
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        drag = { y: e.clientY, h: tl.getBoundingClientRect().height };
        e.preventDefault();
      });
      handle.addEventListener('pointermove', e => {
        if (!drag) return;
        // dragging up grows the timeline, down shrinks it
        const max = Math.max(160, window.innerHeight - 260);
        const h = U.clamp(drag.h + (drag.y - e.clientY), 120, max);
        tl.style.height = h + 'px';
        tl.style.flexBasis = h + 'px';
        this.app.timelineHeight = h;
        this.render();
      });
      const stop = () => { if (drag) { drag = null; this.app._savePrefs(); } };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    }

    // Set the timeline height (used by the resizer-restore and layout presets).
    setHeight(h) {
      const tl = this.root;
      const max = Math.max(160, window.innerHeight - 260);
      h = U.clamp(h, 120, max);
      tl.style.height = h + 'px';
      tl.style.flexBasis = h + 'px';
      this.app.timelineHeight = h;
      this.render();
    }

    _runAt(layer, f) {
      const num = layer.exposure[f] || 0;
      if (!num) return null;
      let s = f, e = f;
      const fc = this.app.project.frameCount;
      while (s > 0 && (layer.exposure[s - 1] || 0) === num) s--;
      while (e < fc - 1 && (layer.exposure[e + 1] || 0) === num) e++;
      return { num: num, start: s, end: e };
    }

    _installGridInput() {
      const g = this.grid;
      const app = this.app;
      const frameAt = x => U.clamp(Math.floor(x / this.cellW), 0, app.project.frameCount - 1);

      g.addEventListener('pointerdown', e => {
        try { g.setPointerCapture(e.pointerId); } catch (_) {}
        const r = g.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const f = frameAt(x);
        if (e.button === 2) {
          // Right-click should never silently move the playhead -- the artist
          // expects a context menu, not a scrub. Just select the row's layer
          // and open the menu; menu items still operate on the current frame.
          e.preventDefault();
          if (y > this.headerH) {
            const ly = this.rowToLayer(Math.floor((y - this.headerH) / this.rowH));
            if (ly) app.selectLayer(ly);
          }
          this._context(e);
          return;
        }
        if (y <= this.headerH) {
          // grab the handle just past the last frame to set the frame count
          const endX = app.project.frameCount * this.cellW;
          if (x >= endX - 6) {
            // Frame-count drag also actively edits the timeline -- pause any
            // playback so the artist's drag isn't fighting the play loop.
            if (app.playback && app.playback.playing) app.playback.stop();
            this._fcDrag = { before: app._structSnapshot(), changed: false };
            return;
          }
          // Header scrub: explicit playhead drag must stop playback first
          // so the scrub takes over cleanly.
          if (app.playback && app.playback.playing) app.playback.stop();
          this._mode = 'scrub'; app.setFrame(f); return;
        }
        const layer = this.rowToLayer(Math.floor((y - this.headerH) / this.rowH));
        if (layer) app.selectLayer(layer);
        const run = layer ? this._runAt(layer, f) : null;
        if (run && !layer.locked) {
          // About to move / resize an exposure run -- stop playback so the
          // edit isn't chased by the playhead.
          if (app.playback && app.playback.playing) app.playback.stop();
          const edge = (run.end + 1) * this.cellW;
          // a generous 9 px grab zone past the run's right edge -- on a small
          // cellW the original 5 px was effectively invisible to mouse / pen
          this._celDrag = {
            layer: layer, num: run.num, runStart: run.start, runEnd: run.end,
            startFrame: f, mode: (x > edge - 9) ? 'resize' : 'move',
            base: layer.exposure.slice(), before: app._structSnapshot(), moved: false
          };
          app.setFrame(f);
        } else {
          if (app.playback && app.playback.playing) app.playback.stop();
          this._mode = 'scrub'; app.setFrame(f);
        }
      });

      g.addEventListener('pointermove', e => {
        const r = g.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (this._fcDrag) {
          const nf = U.clamp(Math.round(x / this.cellW), 1, 4000);
          if (nf !== app.project.frameCount) {
            app.project.frameCount = nf;
            if (app.frame >= nf) app.frame = nf - 1;
            this._fcDrag.changed = true;
            app.emit('render');
            this.render();
          }
          return;
        }
        const f = frameAt(x);
        if (this._celDrag) this._applyCelDrag(f);
        else if (this._mode === 'scrub') app.setFrame(f);
        else {
          const y = e.clientY - r.top;
          const endX = app.project.frameCount * this.cellW;
          let cur = '';
          if (y <= this.headerH && x >= endX - 6) cur = 'ew-resize';
          else if (y > this.headerH) {
            // hovering near the right edge of an exposure run shows the
            // resize cursor so artists know it's a draggable handle
            const layer = this.rowToLayer(Math.floor((y - this.headerH) / this.rowH));
            if (layer && !layer.locked) {
              const run = this._runAt(layer, frameAt(x));
              if (run) {
                const edge = (run.end + 1) * this.cellW;
                if (x > edge - 9 && x < edge + 2) cur = 'ew-resize';
                else cur = 'grab';
              }
            }
          }
          g.style.cursor = cur;
        }
      });
      // Ctrl + wheel zooms the timeline horizontally, centred on the cursor.
      // Plain wheel falls through to the browser's native scroll on .tl-grid-wrap.
      g.addEventListener('wheel', e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const r = g.getBoundingClientRect();
        const x = e.clientX - r.left;
        const frameUnderCursor = x / this.cellW;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = U.clamp(this.cellW * factor, 4, 80);
        if (next === this.cellW) return;
        this.cellW = next;
        // keep the frame under the cursor stable -- scroll the wrap so the
        // same frame stays under the pointer after the rescale
        const newX = frameUnderCursor * this.cellW;
        const wrap = this.gridWrap;
        wrap.scrollLeft += (newX - x);
        this.render();
      }, { passive: false });

      const end = () => {
        if (this._celDrag) {
          if (this._celDrag.moved) app._commitStruct('Edit exposure', this._celDrag.before);
          this._celDrag = null;
        }
        if (this._fcDrag) {
          if (this._fcDrag.changed) {
            app._commitStruct('Set frame count', this._fcDrag.before);
            app.ui.status('Frame count: ' + app.project.frameCount);
          }
          this._fcDrag = null;
        }
        this._mode = null;
      };
      g.addEventListener('pointerup', end);
      g.addEventListener('pointercancel', end);

      g.addEventListener('dblclick', e => {
        const r = g.getBoundingClientRect();
        const y = e.clientY - r.top;
        if (y <= this.headerH) return;
        const layer = this.rowToLayer(Math.floor((y - this.headerH) / this.rowH));
        const f = frameAt(e.clientX - r.left);
        if (layer && (layer.type === 'drawing' || layer.type === 'vector') && !layer.celNumAt(f)) {
          app.selectLayer(layer);
          app.setFrame(f);
          app.newDrawing();
        }
      });
      g.addEventListener('contextmenu', e => e.preventDefault());
    }

    _applyCelDrag(curFrame) {
      const d = this._celDrag, app = this.app, p = app.project;
      const delta = curFrame - d.startFrame;
      const exp = d.base.slice();
      const len = d.runEnd - d.runStart;
      if (d.mode === 'move') {
        const ns = Math.max(0, d.runStart + delta), ne = ns + len;
        for (let f = d.runStart; f <= d.runEnd; f++) if (exp[f] === d.num) exp[f] = 0;
        if (ne >= p.frameCount) p.frameCount = ne + 1;
        for (let f = ns; f <= ne; f++) exp[f] = d.num;
      } else {
        const ne = Math.max(d.runStart, d.runEnd + delta);
        if (ne >= p.frameCount) p.frameCount = ne + 1;
        for (let f = d.runStart; f <= ne; f++) exp[f] = d.num;
        for (let f = ne + 1; f <= d.runEnd; f++) if (exp[f] === d.num) exp[f] = 0;
      }
      d.layer.exposure = exp;
      if (delta !== 0) d.moved = true;
      app.emit('render');
      this.render();
    }

    _context(e) {
      const app = this.app;
      app.ui.contextMenu(e.clientX, e.clientY, [
        { label: 'New drawing', fn: () => app.newDrawing() },
        { label: 'Duplicate drawing', fn: () => app.duplicateDrawing() },
        { label: 'Extend exposure', fn: () => app.extendExposure() },
        { label: 'Clear exposure', fn: () => app.clearExposure() },
        { sep: 1 },
        { label: 'Copy drawing', fn: () => app.copyDrawing() },
        { label: 'Cut drawing', fn: () => app.cutDrawing() },
        { label: 'Paste drawing', fn: () => app.pasteDrawing() },
        { sep: 1 },
        { label: 'Insert frame', fn: () => app.insertFrame() },
        { label: 'Remove frame', fn: () => app.removeFrame() }
      ]);
    }

    /* ---------------- render ---------------- */
    render() {
      const app = this.app, p = app.project;
      this.counter.innerHTML = 'Frame <b>' + (app.frame + 1) + '</b> / ' + p.frameCount +
        ' &nbsp; ' + p.fps + ' fps &nbsp; · ' + this._smpte(app.frame, p.fps);
      this.playBtn.firstChild.innerHTML = U.svg(app.playback.playing ? ICON.pause : ICON.play);
      this.playBtn.firstChild.firstChild.style.width = '15px';
      this.playBtn.firstChild.firstChild.style.height = '15px';
      this.onionBtn.classList.toggle('on', app.onion.on);

      this._renderNames();
      this._renderGrid();
    }

    _renderNames() {
      const app = this.app, L = app.project.layers;
      this.namesInner.innerHTML = '';
      for (let r = 0; r < L.length; r++) {
        const layer = this.rowToLayer(r);
        const row = U.el('div', {
          class: 'tl-name-row' + (layer === app.activeLayer() ? ' sel' : '')
        });
        row.style.height = this.rowH + 'px';
        row.appendChild(U.el('div', { class: 'dot', style: { background: layer.color } }));
        row.appendChild(U.el('div', { class: 'nm', text: layer.name }));
        // Visibility (eye) and lock toggles -- dim, 12 px inline SVGs that
        // don't trigger the row's selectLayer handler.
        row.appendChild(this._layerIconBtn(
          layer.visible ? 'eye' : 'eyeoff',
          layer.visible ? 'Hide layer' : 'Show layer',
          ev => {
            ev.stopPropagation();
            layer.visible = !layer.visible;
            app.emit('layerschange');
            app.emit('render');
          }
        ));
        row.appendChild(this._layerIconBtn(
          layer.locked ? 'lock' : 'unlock',
          layer.locked ? 'Unlock layer' : 'Lock layer',
          ev => {
            ev.stopPropagation();
            layer.locked = !layer.locked;
            app.emit('layerschange');
          }
        ));
        if (!layer.visible) row.style.opacity = '.45';
        row.addEventListener('click', () => app.selectLayer(layer));
        this.namesInner.appendChild(row);
      }
    }

    // Tiny inline-SVG toggle button for the names column (eye / lock).
    _layerIconBtn(iconKey, title, fn) {
      const b = U.el('button', { class: 'tl-name-icon', title: title });
      b.innerHTML = U.svg(ICON[iconKey]);
      // keep them tiny and dim -- they are secondary controls
      Object.assign(b.style, {
        width: '18px', height: '18px', padding: '0',
        marginLeft: '2px', background: 'transparent', border: '0',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', opacity: '0.55', color: 'inherit'
      });
      const svg = b.firstChild;
      if (svg) { svg.style.width = '13px'; svg.style.height = '13px'; }
      b.addEventListener('pointerdown', ev => ev.stopPropagation());
      b.addEventListener('click', fn);
      return b;
    }

    _renderGrid() {
      const app = this.app, p = app.project, L = p.layers;
      const cw = this.cellW, rh = this.rowH, hh = this.headerH;
      const audioH = app.audioPeaks ? 38 : 0;
      const w = p.frameCount * cw + this.endPad, h = hh + L.length * rh + audioH;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.grid.width = w * dpr; this.grid.height = h * dpr;
      this.grid.style.width = w + 'px'; this.grid.style.height = h + 'px';
      const c = this.gctx;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      // current frame column
      const cf = app.frame;
      c.fillStyle = '#4a9fd422';
      c.fillRect(cf * cw, 0, cw, h);

      // header
      c.fillStyle = '#272b32';
      c.fillRect(0, 0, w, hh);
      // playback range
      if (app.playIn != null || app.playOut != null) {
        const lo = app.playIn != null ? app.playIn : 0;
        const hi = app.playOut != null ? app.playOut : p.frameCount - 1;
        c.fillStyle = '#54b06a33';
        c.fillRect(lo * cw, 0, (hi - lo + 1) * cw, h);
        c.fillStyle = '#54b06a';
        c.fillRect(lo * cw, hh - 4, (hi - lo + 1) * cw, 4);
      }
      c.font = '10px Segoe UI';
      c.textBaseline = 'middle';
      for (let f = 0; f < p.frameCount; f++) {
        const x = f * cw;
        if (f % 5 === 0 || f === p.frameCount - 1) {
          c.strokeStyle = '#0008'; c.lineWidth = 1;
          c.beginPath(); c.moveTo(x + 0.5, hh - 7); c.lineTo(x + 0.5, hh); c.stroke();
          c.fillStyle = (f === cf) ? '#4a9fd4' : '#8b919c';
          c.textAlign = 'left';
          c.fillText(String(f + 1), x + 2, hh / 2);
        }
      }
      // frame-count handle -- drag this to grow / shrink the timeline length
      const endX = p.frameCount * cw;
      c.fillStyle = '#343942';
      c.fillRect(endX, 0, this.endPad, hh);
      c.strokeStyle = '#0008'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(endX + 0.5, 0); c.lineTo(endX + 0.5, hh); c.stroke();
      c.strokeStyle = '#8b919c';
      for (let i = 0; i < 3; i++) {
        const gx = endX + 6 + i * 3 + 0.5;
        c.beginPath(); c.moveTo(gx, 7); c.lineTo(gx, hh - 7); c.stroke();
      }

      // playhead marker
      c.fillStyle = '#4a9fd4';
      c.beginPath();
      c.moveTo(cf * cw, hh); c.lineTo(cf * cw + cw, hh);
      c.lineTo(cf * cw + cw / 2, hh - 6); c.closePath(); c.fill();

      // rows
      for (let r = 0; r < L.length; r++) {
        const layer = this.rowToLayer(r);
        const y = hh + r * rh;
        if (layer === app.activeLayer()) {
          c.fillStyle = '#ffffff0c';
          c.fillRect(0, y, w, rh);
        }
        // light table dim
        if (!layer.visible) { c.fillStyle = '#0003'; c.fillRect(0, y, w, rh); }
        // video layer film strip
        if (layer.type === 'video') {
          const vf = Math.min(layer.videoFrames || p.frameCount, p.frameCount);
          const bx = 1.5, bw = Math.max(4, vf * cw - 3), by = y + 5, bh = rh - 10;
          c.fillStyle = this._alpha(layer.color, 0.72);
          this._roundRect(c, bx, by, bw, bh, 3);
          c.fill();
          c.fillStyle = '#00000055';
          for (let xx = 6; xx < bw - 4; xx += 11) {
            c.fillRect(bx + xx, by + 2, 4, 3);
            c.fillRect(bx + xx, by + bh - 5, 4, 3);
          }
          c.fillStyle = '#fff';
          c.font = '9px Segoe UI'; c.textAlign = 'left'; c.textBaseline = 'middle';
          c.fillText('▶ ' + layer.name, bx + 8, y + rh / 2);
        }
        // exposure runs
        let f = 0;
        while (f < p.frameCount) {
          const num = layer.exposure[f] || 0;
          if (!num) { f++; continue; }
          let e = f;
          while (e + 1 < p.frameCount && (layer.exposure[e + 1] || 0) === num) e++;
          const bx = f * cw + 1.5, bw = (e - f + 1) * cw - 3;
          const by = y + 4, bh = rh - 8;
          const isActive = layer === app.activeLayer();
          const cel = layer.cels[num];
          if (this.showThumbs && cel) {
            c.save();
            this._roundRect(c, bx, by, bw, bh, 3);
            c.fillStyle = '#c6cbd2';
            c.fill();
            c.clip();
            // request the thumb at the actual displayed width so timeline-zoom
            // doesn't upscale a tiny 84 px source into a blurry mess. Round to
            // 64-px steps so the per-cel cache still hits across small zoom
            // deltas. Cap at 384 px to stay memory-frugal for very wide runs.
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const tw = Math.min(384, Math.max(64, Math.ceil(bw * dpr / 64) * 64));
            const tth = Math.max(8, Math.round(tw * p.height / p.width));
            const th = cel.getThumb(tw, tth);
            c.imageSmoothingEnabled = true;
            c.imageSmoothingQuality = 'high';
            c.drawImage(th, bx, by, bw, bh);
            c.restore();
            c.lineWidth = 1.5;
            c.strokeStyle = this._alpha(layer.color, isActive ? 1 : 0.7);
            this._roundRect(c, bx, by, bw, bh, 3);
            c.stroke();
          } else {
            c.fillStyle = this._alpha(layer.color, isActive ? 0.92 : 0.62);
            this._roundRect(c, bx, by, bw, bh, 3);
            c.fill();
          }
          // start key dot
          c.fillStyle = this.showThumbs ? this._alpha(layer.color, 1) : '#fff';
          c.beginPath();
          c.arc(f * cw + cw / 2, y + 8, 3, 0, 7);
          c.fill();
          // right-edge resize handle -- two short vertical bars on the trailing
          // edge of the run, signalling "drag me to extend"
          if (bw > 8) {
            const hx = bx + bw - 2.5;
            c.strokeStyle = isActive ? '#ffffff80' : '#ffffff44';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(hx, by + 3); c.lineTo(hx, by + bh - 3);
            c.moveTo(hx + 2, by + 3); c.lineTo(hx + 2, by + bh - 3);
            c.stroke();
          }
          // drawing number
          if (bw > 16 && !this.showThumbs) {
            c.fillStyle = '#0009';
            c.font = '9px Segoe UI'; c.textAlign = 'left';
            c.fillText(String(num), f * cw + cw / 2 + 5, y + rh / 2);
          }
          f = e + 1;
        }
        // transform (cut-out) keyframes
        if (layer.transform && layer.transform.keyframes.length) {
          c.fillStyle = '#f0a93d';
          for (const k of layer.transform.keyframes) {
            if (k.frame < 0 || k.frame >= p.frameCount) continue;
            const kx = k.frame * cw + cw / 2, ky = y + rh - 5;
            c.beginPath();
            c.moveTo(kx, ky - 4); c.lineTo(kx + 4, ky);
            c.lineTo(kx, ky + 4); c.lineTo(kx - 4, ky);
            c.closePath(); c.fill();
          }
        }
        // row separator
        c.strokeStyle = '#0006'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, y + rh + 0.5); c.lineTo(w, y + rh + 0.5); c.stroke();
      }

      // audio waveform strip
      if (app.audioPeaks) {
        const ay = hh + L.length * rh;
        c.fillStyle = '#14161a';
        c.fillRect(0, ay, w, audioH);
        c.strokeStyle = '#0008'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, ay + 0.5); c.lineTo(w, ay + 0.5); c.stroke();
        const mid = ay + audioH / 2 + 4;
        c.fillStyle = '#4a9fd4cc';
        const peaks = app.audioPeaks;
        for (let f = 0; f < p.frameCount && f < peaks.length; f++) {
          const amp = peaks[f] * (audioH / 2 - 6);
          if (amp > 0.4) c.fillRect(f * cw + cw / 2 - 1, mid - amp, 2, amp * 2);
        }
        c.fillStyle = '#8b919c'; c.font = '9px Segoe UI';
        c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText('♪ ' + (app.project.audio ? app.project.audio.name : 'audio'), 5, ay + 9);
      }
      // 5-frame gridlines
      c.strokeStyle = '#ffffff0a';
      for (let f = 5; f < p.frameCount; f += 5) {
        c.beginPath(); c.moveTo(f * cw + 0.5, hh); c.lineTo(f * cw + 0.5, h); c.stroke();
      }
      // playhead line
      c.strokeStyle = '#4a9fd4'; c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(cf * cw + cw / 2, hh); c.lineTo(cf * cw + cw / 2, h);
      c.stroke();
    }

    // hh:mm:ss:ff zero-padded SMPTE timecode for the current frame.
    _smpte(frame, fps) {
      fps = Math.max(1, Math.round(fps || 24));
      const total = Math.max(0, frame | 0);
      const ff = total % fps;
      const totalSec = Math.floor(total / fps);
      const ss = totalSec % 60;
      const mm = Math.floor(totalSec / 60) % 60;
      const hh = Math.floor(totalSec / 3600);
      const pad = n => (n < 10 ? '0' + n : '' + n);
      return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
    }

    _alpha(hex, a) {
      const rgb = U.hexToRgb(hex);
      return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a + ')';
    }
    _roundRect(c, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }
  }

  OT.Timeline = Timeline;
})(window.OT);
