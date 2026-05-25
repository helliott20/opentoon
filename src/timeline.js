/* OpenToon Studio - timeline / xsheet */
(function (OT) {
  'use strict';
  const U = OT.util;

  const ICON = {
    start: '<path d="M7 5v14"/><path d="M18 5l-9 7 9 7z"/>',
    back: '<path d="M15 5l-9 7 9 7z"/>',
    play: '<path d="M8 4l12 8-12 8z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
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
      // multi-selection of exposure runs (Ctrl-click). Each entry is
      // { layer, num, start, end }. Cleared on layer change, tool change,
      // or a fresh non-Ctrl click outside any selected run.
      this.selectedRuns = [];
      this._build();
      ['framechange', 'projectchange', 'layerschange', 'celchange',
        'playbackstate', 'onionchange']
        .forEach(ev => app.on(ev, () => this.render()));
      // layer/tool change clears the multi-selection (suppressed while
      // the timeline itself is mutating selection via Ctrl-click).
      app.on('layerselect', () => {
        if (!this._selBusy) this.selectedRuns = [];
        this.render();
      });
      if (app.timelineHeight) this.setHeight(app.timelineHeight);
    }

    /* rows are displayed top = front-most layer. With folder support,
       a row only exists for layers that aren't hidden under a collapsed
       group — see app.visibleLayers(). */
    _visRows() {
      // Recomputed on each call; cheap O(N). Avoids stale caches when
      // a group is expanded/collapsed mid-render.
      return this.app.visibleLayers();
    }
    rowToLayer(r) {
      const V = this._visRows();
      return V[V.length - 1 - r];
    }
    layerToRow(layer) {
      const V = this._visRows();
      return V.length - 1 - V.indexOf(layer);
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
      tb.appendChild(this._btn('Stop (Esc)', ICON.stop, () => app.playback.stop()));
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
      tb.appendChild(this._btn('Extend frame', ICON.extend, () => app.extendExposure()));
      // "Remove frame" splices the frame column out of every layer (single
      // current frame). Multi-frame selection delete is handled by the Del
      // key handler in main.js which clears the selected runs.
      tb.appendChild(this._btn('Remove frame', ICON.clearx, () => app.removeFrame()));

      tb.appendChild(U.el('div', { class: 'tl-sep' }));
      tb.appendChild(this._btn('Add 12 frames', ICON.addframe, () => {
        app.project.frameCount += 12; app.emit('projectchange');
      }));
      this.onionBtn = this._btn('Onion skin  (right-click for settings)', ICON.onion, () => {
        app.onion.on = !app.onion.on;
        this.onionBtn.classList.toggle('on', app.onion.on);
        app.emit('onionchange'); app.emit('render');
      });
      this.onionBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (app.ui && typeof app.ui._toggleOnionPop === 'function') {
          app.ui._toggleOnionPop(this.onionBtn);
        }
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

      this.names = U.el('div', { class: 'tl-names' });
      this.names.appendChild(U.el('div', { class: 'tl-names-head' }, ['Layers']));
      this.namesList = U.el('div', { class: 'tl-names-list' });
      this.namesInner = U.el('div');
      this.namesList.appendChild(this.namesInner);
      this.names.appendChild(this.namesList);
      body.appendChild(this.names);
      this._applyNamesWidth(this.app.tlNamesWidth || 150);

      // Drag-handle between the layer-names column and the grid. Lets the
      // user widen the column when layer names get long.
      this.namesResizer = U.el('div', {
        class: 'tl-names-resizer', title: 'Drag to resize the layer-names column'
      });
      body.appendChild(this.namesResizer);
      this._installNamesResizer();

      this.gridWrap = U.el('div', { class: 'tl-grid-wrap' });
      this.grid = U.el('canvas');
      this.gridWrap.appendChild(this.grid);
      body.appendChild(this.gridWrap);
      this.gctx = this.grid.getContext('2d');

      this.gridWrap.addEventListener('scroll', () => {
        this.namesInner.style.transform = 'translateY(' + (-this.gridWrap.scrollTop) + 'px)';
      });
      this._installShiftHoverPreview(this.namesInner, '.tl-name-row');
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
    // True if {layer, num, start, end} is already in the selection set.
    _isRunSelected(layer, run) {
      if (!run) return false;
      return this.selectedRuns.some(r =>
        r.layer === layer && r.num === run.num &&
        r.start === run.start && r.end === run.end);
    }
    // Remove a matching entry from selectedRuns (returns true if removed).
    _removeFromSelection(layer, run) {
      const i = this.selectedRuns.findIndex(r =>
        r.layer === layer && r.num === run.num &&
        r.start === run.start && r.end === run.end);
      if (i < 0) return false;
      this.selectedRuns.splice(i, 1);
      return true;
    }
    // True if any selected run on this layer overlaps the given frame
    // range. Used by the renderer to highlight cells covered by a
    // shift-range selection that doesn't align to the underlying run
    // boundaries — and by the run-fragment hit test for shift-drag.
    _rangeIntersectsSelection(layer, num, start, end) {
      for (const r of this.selectedRuns) {
        if (r.layer !== layer || r.num !== num) continue;
        if (r.end < start || r.start > end) continue;
        return { start: Math.max(r.start, start), end: Math.min(r.end, end) };
      }
      return null;
    }
    // Precise per-cell hit test against the multi-selection. Used by the
    // pointerdown logic so a click that falls OUTSIDE a fragment-selected
    // range (even when it's inside the same underlying held run) is
    // treated as "clicked outside the selection" — the selection gets
    // replaced with the full run and the drag moves all of it. Without
    // this, clicking the un-highlighted left half of a held run whose
    // right half is fragment-selected would only drag the right half.
    _cellInSelection(layer, frame) {
      for (const r of this.selectedRuns) {
        if (r.layer === layer && frame >= r.start && frame <= r.end) return r;
      }
      return null;
    }
    // Replace the multi-selection with the rectangle anchored between
    // `(aLayer, aFrame)` and `(bLayer, bFrame)`. Walks every layer in
    // the visible list between the two rows and every frame in the
    // column range; adds one selection fragment per contiguous run of
    // the same exposure num on each row. Empty cells (exposure 0) are
    // skipped — they're not "frames" to copy.
    _selectRectRange(aLayer, aFrame, bLayer, bFrame) {
      this.selectedRuns = this._buildRectRange(aLayer, aFrame, bLayer, bFrame);
    }
    // Ctrl+Shift+click: add the rectangle to the existing selection
    // without clearing what's already there.
    _addRectRange(aLayer, aFrame, bLayer, bFrame) {
      const add = this._buildRectRange(aLayer, aFrame, bLayer, bFrame);
      for (const r of add) {
        if (!this._isRunSelected(r.layer, r)) this.selectedRuns.push(r);
      }
    }
    _buildRectRange(aLayer, aFrame, bLayer, bFrame) {
      const visible = this._visibleLayers();
      const ia = visible.indexOf(aLayer);
      const ib = visible.indexOf(bLayer);
      if (ia < 0 || ib < 0) return [];
      const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
      const f0 = Math.min(aFrame, bFrame), f1 = Math.max(aFrame, bFrame);
      const sel = [];
      for (let i = lo; i <= hi; i++) {
        const layer = visible[i];
        if (!layer || !layer.exposure) continue;
        let f = f0;
        while (f <= f1) {
          const num = layer.exposure[f] || 0;
          if (!num) { f++; continue; }
          let e = f;
          while (e < f1 && (layer.exposure[e + 1] || 0) === num) e++;
          sel.push({ layer, num, start: f, end: e });
          f = e + 1;
        }
      }
      return sel;
    }
    // The layer rows the timeline is currently rendering, in row order.
    // Used by rect-select; mirrors app.visibleLayers() when available.
    _visibleLayers() {
      const a = this.app;
      if (a && typeof a.visibleLayers === 'function') return a.visibleLayers();
      return (a && a.project && a.project.layers) ? a.project.layers.slice() : [];
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
            const run = ly ? this._runAt(ly, f) : null;
            // Right-click outside any selected run clears the multi-selection.
            if (!run || !this._isRunSelected(ly, run)) {
              this.selectedRuns = [];
            }
            if (ly) {
              this._selBusy = true;
              app.selectLayer(ly);
              this._selBusy = false;
            }
          }
          this._context(e);
          this.render();
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
        const run = layer ? this._runAt(layer, f) : null;
        const ctrl = !!(e.ctrlKey || e.metaKey);
        const shift = !!e.shiftKey;
        // Industry-standard multi-select semantics (Finder / Explorer /
        // Photoshop / spreadsheets):
        //   plain        → select one; set anchor
        //   ctrl / cmd   → toggle this item in/out; anchor unchanged
        //   shift        → range from anchor → here, REPLACING current
        //   ctrl+shift   → range from anchor → here, ADDED to current
        // selectLayer fires 'layerselect', which would normally clear
        // selectedRuns -- guard with _selBusy so our own click can mutate
        // the set.
        this._selBusy = true;
        if (layer) app.selectLayer(layer);

        const hasAnchor = !!(this._anchorCell && this._anchorCell.layer && layer);
        const wantRange = shift && hasAnchor;
        if (wantRange) {
          // Range-select rectangle from the anchor to this cell. Works in
          // any diagonal — top-left↔bottom-right, top-right↔bottom-left.
          // Spans every layer between (inclusive) and every frame between
          // (inclusive); empty cells are skipped so the selection contains
          // only real drawings the artist can copy / delete.
          if (ctrl) this._addRectRange(this._anchorCell.layer, this._anchorCell.frame, layer, f);
          else      this._selectRectRange(this._anchorCell.layer, this._anchorCell.frame, layer, f);
          // Anchor stays put — typical of every shipping app; lets the
          // artist refine the range by repeatedly shift+clicking the end.
        } else if (ctrl && !shift) {
          // Toggle. Anchor doesn't move (industry standard).
          if (run) {
            const entry = { layer: layer, num: run.num, start: run.start, end: run.end };
            if (!this._removeFromSelection(layer, run)) this.selectedRuns.push(entry);
          }
        } else {
          // Plain click. If the clicked CELL is already covered by the
          // existing multi-selection (shift-range fragment or whole run),
          // keep the selection — the click is the start of a drag that
          // should move every selected fragment. Otherwise replace the
          // selection. The test is per-cell (not per-run) so clicking a
          // non-highlighted cell of an underlying run whose other cells
          // are fragment-selected still counts as "outside" and the
          // whole run becomes the new selection (so drag moves it all).
          const insideSelection = run ? !!this._cellInSelection(layer, f) : false;
          if (!insideSelection) {
            if (run) {
              this.selectedRuns = [
                { layer: layer, num: run.num, start: run.start, end: run.end }
              ];
            } else {
              this.selectedRuns = [];
            }
          }
          if (layer) this._anchorCell = { layer: layer, frame: f };
        }
        this._selBusy = false;

        // A modifier-click that did selection work (range, toggle, or add)
        // shouldn't also enter the move/resize celDrag mode below.
        if (wantRange || (ctrl && !shift)) { app.setFrame(f); this.render(); return; }

        if (run && !layer.locked) {
          // About to move / resize an exposure run -- stop playback so the
          // edit isn't chased by the playhead.
          if (app.playback && app.playback.playing) app.playback.stop();
          // Resize handle: a narrow band straddling the run's right edge.
          // Previously the inside-the-cell portion was a flat 9 px, which
          // covered ~60% of a 15 px cell — clicking on the right half of a
          // held run accidentally entered resize mode (shrinking the run
          // from the right). Now scales with cellW so the inner hit zone
          // is a small fraction of a single cell; the outer extension keeps
          // it reachable when cells are very narrow.
          const edge = (run.end + 1) * this.cellW;
          const handleIn = Math.min(6, Math.max(2, this.cellW * 0.25));
          const handleOut = 4;
          const isResize = (x > edge - handleIn && x < edge + handleOut);
          // Snapshot per-layer baselines for every selected run so we can
          // apply the same delta to all of them in _applyMultiDrag.
          // Per-cell test: only treat as multi-drag when the click landed
          // inside an actually-highlighted cell. Clicking the unselected
          // part of a held run replaced the selection above, so the new
          // single-run entry passes this test and the whole run drags.
          const draggedSelected = !!this._cellInSelection(layer, f);
          const bases = new Map();
          if (draggedSelected) {
            for (const sr of this.selectedRuns) {
              if (!bases.has(sr.layer)) bases.set(sr.layer, sr.layer.exposure.slice());
            }
          }
          this._celDrag = {
            layer: layer, num: run.num, runStart: run.start, runEnd: run.end,
            startFrame: f, mode: isResize ? 'resize' : 'move',
            base: layer.exposure.slice(), before: app._structSnapshot(), moved: false,
            multi: draggedSelected, bases: bases
          };
          app.setFrame(f);
        } else {
          if (app.playback && app.playback.playing) app.playback.stop();
          this._mode = 'scrub'; app.setFrame(f);
        }
        this.render();
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
        if (this._celDrag) {
          if (this._celDrag.multi) this._applyMultiDrag(f - this._celDrag.startFrame);
          else this._applyCelDrag(f);
        }
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
                const handleIn = Math.min(6, Math.max(2, this.cellW * 0.25));
                const handleOut = 4;
                if (x > edge - handleIn && x < edge + handleOut) cur = 'ew-resize';
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
          if (this._celDrag.moved) {
            app._commitStruct('Edit frame', this._celDrag.before);
            // Refresh selectedRuns to their new on-screen positions so a
            // follow-up drag uses the updated locations as the baseline.
            this.selectedRuns = this.selectedRuns.map(sr => {
              const cur = this._runAt(sr.layer, Math.min(
                sr.start + (Math.max(0, sr.start) - sr.start),
                app.project.frameCount - 1
              ));
              // Find the run that now contains sr.num near where we put it.
              // Scan the layer for a contiguous run of sr.num to be robust.
              const exp = sr.layer.exposure;
              let s = -1, e2 = -1;
              for (let f = 0; f < exp.length; f++) {
                if (exp[f] === sr.num) {
                  if (s < 0) s = f;
                  e2 = f;
                } else if (s >= 0) break;
              }
              if (s < 0) return sr;
              return { layer: sr.layer, num: sr.num, start: s, end: e2 };
            });
          }
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

    // Apply the same frame-delta to every run in selectedRuns. Each layer's
    // baseline exposure was snapshotted at pointerdown so we can re-derive
    // the result on every move without compounding offsets.
    _applyMultiDrag(delta) {
      const d = this._celDrag, app = this.app, p = app.project;
      // start every affected layer from its baseline, clearing runs we own
      const working = new Map();
      d.bases.forEach((base, layer) => working.set(layer, base.slice()));
      // clear the original positions of every selected run on its baseline
      for (const sr of this.selectedRuns) {
        const exp = working.get(sr.layer);
        if (!exp) continue;
        for (let f = sr.start; f <= sr.end; f++) {
          if ((d.bases.get(sr.layer)[f] || 0) === sr.num) exp[f] = 0;
        }
      }
      // now stamp each run at its new position. Resize mode extends only the
      // dragged run's end; move mode shifts all selected runs by delta.
      if (d.mode === 'resize') {
        // resize behaves the same as single drag -- only the dragged run is
        // resized, other selected runs are left in place
        for (const sr of this.selectedRuns) {
          const exp = working.get(sr.layer);
          if (!exp) continue;
          if (sr.layer === d.layer && sr.num === d.num &&
              sr.start === d.runStart && sr.end === d.runEnd) {
            const ne = Math.max(sr.start, sr.end + delta);
            if (ne >= p.frameCount) p.frameCount = ne + 1;
            for (let f = sr.start; f <= ne; f++) exp[f] = sr.num;
          } else {
            for (let f = sr.start; f <= sr.end; f++) exp[f] = sr.num;
          }
        }
      } else {
        for (const sr of this.selectedRuns) {
          const exp = working.get(sr.layer);
          if (!exp) continue;
          const len = sr.end - sr.start;
          const ns = Math.max(0, sr.start + delta), ne = ns + len;
          if (ne >= p.frameCount) p.frameCount = ne + 1;
          for (let f = ns; f <= ne; f++) exp[f] = sr.num;
        }
      }
      // commit working buffers back onto the layers
      working.forEach((exp, layer) => { layer.exposure = exp; });
      if (delta !== 0) d.moved = true;
      app.emit('render');
      this.render();
    }

    _context(e) {
      const app = this.app;
      // If there's an active multi-selection in the timeline, the
      // "Remove frame" entry deletes those cells in one undo.
      const hasMulti = this.selectedRuns && this.selectedRuns.length > 0;
      const removeLabel = hasMulti
        ? ('Remove ' + this._selectedFrameCount() + ' frames')
        : 'Remove frame';
      const removeFn = hasMulti
        ? () => app.clearSelectedRuns()
        : () => app.removeFrame();
      app.ui.contextMenu(e.clientX, e.clientY, [
        { label: 'New drawing', fn: () => app.newDrawing() },
        { label: 'Duplicate drawing', fn: () => app.duplicateDrawing() },
        { label: 'Extend frame', fn: () => app.extendExposure() },
        { sep: 1 },
        { label: 'Copy drawing', fn: () => app.copyDrawing() },
        { label: 'Cut drawing', fn: () => app.cutDrawing() },
        { label: 'Paste drawing', fn: () => app.pasteDrawing() },
        { sep: 1 },
        { label: 'Insert frame', fn: () => app.insertFrame() },
        { label: removeLabel, fn: removeFn }
      ]);
    }
    _selectedFrameCount() {
      let n = 0;
      for (const r of (this.selectedRuns || [])) n += (r.end - r.start + 1);
      return n;
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
      const app = this.app;
      const L = app.visibleLayers();
      const selSet = app.selectedLayers;
      const active = app.activeLayer();
      this.namesInner.innerHTML = '';
      for (let r = 0; r < L.length; r++) {
        const layer = this.rowToLayer(r);
        const isActive = layer === active;
        const isGroup = layer.type === 'group';
        const inSet = selSet.has(layer) || isActive;
        // When the multi-set has more than one member, every selected row
        // gets the .multi-sel cue (so the active layer doesn't visually
        // disappear from the set). The active layer additionally gets .sel
        // and the .primary-in-set variant.
        const isMulti = inSet && selSet.size > 1;
        const row = U.el('div', {
          class: 'tl-name-row'
            + (isActive ? ' sel' : '')
            + (isMulti ? ' multi-sel' : '')
            + (isMulti && isActive ? ' primary-in-set' : '')
            + (isGroup ? ' is-group' : '')
        });
        row.style.height = this.rowH + 'px';
        const depth = app.layerDepth(layer);
        if (depth) row.style.paddingLeft = (6 + depth * 12) + 'px';
        // Eye / lock batch over the multi-set when this row is part of it.
        const batch = (selSet.size > 1 && selSet.has(layer)) ? Array.from(selSet) : [layer];
        // Folder chevron — toggles collapsed state. Drawing layers get a
        // tiny spacer of equal width so the dot/name still align.
        if (isGroup) {
          const chev = U.el('button', {
            class: 'tl-chev' + (layer._collapsed ? '' : ' open'),
            title: layer._collapsed ? 'Expand folder' : 'Collapse folder',
            html: U.svg('<path d="M9 6l6 6-6 6"/>')
          });
          chev.addEventListener('click', ev => {
            ev.stopPropagation();
            app.toggleGroupCollapsed(layer);
            app.emit('render');
          });
          row.appendChild(chev);
        } else {
          row.appendChild(U.el('div', { class: 'tl-chev-spacer' }));
        }
        row.appendChild(U.el('div', { class: 'dot', style: { background: layer.color } }));
        const nm = U.el('div', { class: 'nm', text: layer.name });
        // Double-click the layer name to rename inline — same flow as the
        // context-menu Rename action so users have a familiar shortcut.
        nm.addEventListener('dblclick', ev => {
          ev.stopPropagation();
          this._renameLayer(layer);
        });
        row.appendChild(nm);
        row.appendChild(this._layerIconBtn(
          layer.visible ? 'eye' : 'eyeoff',
          layer.visible ? 'Hide layer' : 'Show layer',
          ev => {
            ev.stopPropagation();
            const v = !layer.visible;
            for (const l of batch) {
              if (l.type === 'group') app.setGroupVisible(l, v);
              else l.visible = v;
            }
            app.emit('layerschange');
            app.emit('render');
          }
        ));
        row.appendChild(this._layerIconBtn(
          layer.locked ? 'lock' : 'unlock',
          layer.locked ? 'Unlock layer' : 'Lock layer',
          ev => {
            ev.stopPropagation();
            const v = !layer.locked;
            for (const l of batch) {
              if (l.type === 'group') app.setGroupLocked(l, v);
              else l.locked = v;
            }
            app.emit('layerschange');
          }
        ));
        if (!layer.visible) row.style.opacity = '.45';
        row.setAttribute('draggable', 'true');
        row.dataset.layerId = layer.id;
        this._installNameDnD(row, layer);
        row.addEventListener('click', (ev) => {
          if (ev.ctrlKey || ev.metaKey) app.toggleLayerSelection(layer);
          else if (ev.shiftKey) app.selectLayerRange(app.activeLayer(), layer);
          else app.selectLayer(layer);
        });
        row.addEventListener('contextmenu', ev => {
          ev.preventDefault();
          this._nameContext(ev, layer);
        });
        this.namesInner.appendChild(row);
      }
    }

    // Context menu for a layer-names row. Mirrors the layer panel's menu in
    // ui.js but is tailored for the timeline (rename, hide/show, lock/unlock).
    _nameContext(ev, layer) {
      const app = this.app;
      const isGroup = layer.type === 'group';
      const multi = app.selectedLayers && app.selectedLayers.size > 1;
      const items = [];
      items.push({ label: 'Rename', fn: () => this._renameLayer(layer) });
      if (!isGroup) items.push({ label: 'Duplicate layer', fn: () => app.duplicateLayer(layer) });
      items.push({
        label: multi && app.selectedLayers.has(layer) ? 'Delete selected layers' : 'Delete layer',
        fn: () => { if (multi && app.selectedLayers.has(layer)) app.deleteSelectedLayers();
                    else if (isGroup) app.ungroupLayer(layer);
                    else app.deleteLayer(layer); }
      });
      items.push({ sep: 1 });
      items.push({ label: layer.visible ? 'Hide' : 'Show', fn: () => {
        if (isGroup) app.setGroupVisible(layer, !layer.visible);
        else { layer.visible = !layer.visible; app.emit('layerschange'); app.emit('render'); }
      }});
      items.push({ label: layer.locked ? 'Unlock' : 'Lock', fn: () => {
        if (isGroup) app.setGroupLocked(layer, !layer.locked);
        else { layer.locked = !layer.locked; app.emit('layerschange'); }
      }});
      items.push({ sep: 1 });
      if (multi && app.selectedLayers.has(layer)) {
        items.push({ label: 'Group selected (Ctrl+G)', fn: () => app.groupSelectedLayers() });
      } else if (!isGroup) {
        items.push({ label: 'New folder', fn: () => app.groupSelectedLayers() });
      }
      if (isGroup) {
        items.push({ label: layer._collapsed ? 'Expand folder' : 'Collapse folder',
                     fn: () => { app.toggleGroupCollapsed(layer); app.emit('render'); } });
        items.push({ label: 'Ungroup', fn: () => app.ungroupLayer(layer) });
      }
      items.push({ sep: 1 });
      items.push({
        label: 'Free transform (T)' + (isGroup ? ' — whole folder' : ''),
        fn: () => { app.selectLayer(layer); app.freeTransform(); }
      });
      if (layer.transform && layer.transform.keyframes && layer.transform.keyframes.length) {
        items.push({ label: 'Reset transform', fn: () => app.resetLayerTransform(layer) });
      }
      app.ui.contextMenu(ev.clientX, ev.clientY, items);
    }

    // Inline rename for a names-row layer. Replaces the row's name <div> with
    // a text input. Commits on blur / Enter, cancels on Esc.
    _renameLayer(layer) {
      const app = this.app;
      // find the row currently displaying this layer
      const row = this.namesInner.querySelector(
        '.tl-name-row[data-layer-id="' + layer.id + '"]'
      );
      const nameDiv = row && row.querySelector('.nm');
      if (!nameDiv) {
        // fallback: prompt-based rename if the row isn't on screen
        const next = window.prompt('Rename layer', layer.name);
        if (next != null && next !== '' && next !== layer.name) {
          layer.name = next;
          app.emit('layerschange');
        }
        return;
      }
      const input = U.el('input', {
        class: 'lname', type: 'text', value: layer.name
      });
      Object.assign(input.style, {
        flex: '1', minWidth: '0', font: 'inherit',
        background: '#0006', color: 'inherit',
        border: '1px solid #4a9fd4', borderRadius: '2px',
        padding: '0 4px', margin: '0'
      });
      nameDiv.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const v = (input.value || '').trim();
        if (v && v !== layer.name) {
          layer.name = v;
          app.emit('layerschange');
        } else {
          this.render();
        }
      };
      const cancel = () => { if (done) return; done = true; this.render(); };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        e.stopPropagation();
      });
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('pointerdown', e => e.stopPropagation());
    }

    _applyNamesWidth(w) {
      w = Math.max(120, Math.min(420, Math.round(w)));
      if (!this.names) return;
      this.names.style.flex = '0 0 ' + w + 'px';
      this.names.style.width = w + 'px';
      this.app.tlNamesWidth = w;
    }
    _installNamesResizer() {
      const h = this.namesResizer;
      if (!h) return;
      let startX = 0, startW = 0, dragging = false;
      h.addEventListener('pointerdown', (e) => {
        dragging = true; startX = e.clientX;
        startW = this.names.getBoundingClientRect().width;
        try { h.setPointerCapture(e.pointerId); } catch (_) {}
        h.classList.add('dragging');
        e.preventDefault();
      });
      h.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        this._applyNamesWidth(startW + (e.clientX - startX));
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        h.classList.remove('dragging');
        try { h.releasePointerCapture(e.pointerId); } catch (_) {}
        if (typeof this.app._savePrefs === 'function') this.app._savePrefs();
      };
      h.addEventListener('pointerup', end);
      h.addEventListener('pointercancel', end);
      h.addEventListener('dblclick', () => this._applyNamesWidth(150));
    }

    /* While Shift is held, hovering a row in `container` lights up every
       row between the current active layer and the hovered row so the user
       can see exactly what a shift-click would select. The listener is
       installed once on the container and uses event delegation — rows
       themselves get rebuilt on every render, but the container is stable.
       Cleared on Shift release, container leave, or selection change. */
    _installShiftHoverPreview(container, rowSel) {
      const app = this.app;
      let shiftDown = false;
      let hoveredLayer = null;

      const allRows = () => container.querySelectorAll(rowSel);
      const clear = () => allRows().forEach(r => r.classList.remove('range-preview', 'range-preview-end'));
      const apply = () => {
        clear();
        if (!shiftDown || !hoveredLayer) return;
        const anchor = app.activeLayer();
        if (!anchor || anchor === hoveredLayer) return;
        const L = app.project.layers;
        const i0 = L.indexOf(anchor), i1 = L.indexOf(hoveredLayer);
        if (i0 < 0 || i1 < 0) return;
        const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
        for (const r of allRows()) {
          const id = r.dataset.layerId;
          if (!id) continue;
          const idx = L.findIndex(l => l.id === id);
          if (idx >= lo && idx <= hi) r.classList.add('range-preview');
          if (idx === i1) r.classList.add('range-preview-end');
        }
      };

      container.addEventListener('mousemove', (e) => {
        const row = e.target.closest(rowSel);
        if (!row) {
          if (hoveredLayer) { hoveredLayer = null; apply(); }
          return;
        }
        const id = row.dataset.layerId;
        const ly = id ? app.project.layers.find(l => l.id === id) : null;
        if (ly === hoveredLayer) return;
        hoveredLayer = ly;
        apply();
      });
      container.addEventListener('mouseleave', () => {
        if (hoveredLayer) { hoveredLayer = null; apply(); }
      });
      const keyCheck = (e) => {
        const ns = !!e.shiftKey;
        if (ns !== shiftDown) { shiftDown = ns; apply(); }
      };
      window.addEventListener('keydown', keyCheck);
      window.addEventListener('keyup', keyCheck);
      window.addEventListener('blur', () => { if (shiftDown) { shiftDown = false; clear(); } });
      app.on && app.on('layerselect', () => { if (shiftDown) apply(); else clear(); });
    }

    /* Drag-to-reorder for the timeline names column. Mirrors the panel's
       behaviour in ui.js. Rows are top = front-most layer. */
    _installNameDnD(row, layer) {
      const app = this.app;
      const cls = 'tl-name-row';
      const clearMarks = () => {
        const parent = row.parentNode;
        if (!parent) return;
        parent.querySelectorAll('.' + cls + '.drop-above, .' + cls + '.drop-below')
          .forEach(n => { n.classList.remove('drop-above'); n.classList.remove('drop-below'); });
      };
      row.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', layer.id); } catch (_) {}
        // When the dragged layer is part of a multi-selection, dim every
        // selected row + any descendants of selected groups so the user
        // sees what's actually moving.
        const sel = app.selectedLayers;
        const parent = row.parentNode;
        if (parent && sel && sel.size > 1 && sel.has(layer)) {
          const moving = new Set();
          for (const l of sel) {
            moving.add(l.id);
            if (l.type === 'group') for (const d of app.layerDescendants(l)) moving.add(d.id);
          }
          parent.querySelectorAll('.' + cls).forEach(n => {
            if (moving.has(n.dataset.layerId)) n.classList.add('dragging');
          });
        } else if (layer.type === 'group') {
          // Drag of a folder pulls its descendants visually too.
          const moving = new Set([layer.id]);
          for (const d of app.layerDescendants(layer)) moving.add(d.id);
          if (parent) parent.querySelectorAll('.' + cls).forEach(n => {
            if (moving.has(n.dataset.layerId)) n.classList.add('dragging');
          });
        } else {
          row.classList.add('dragging');
        }
      });
      row.addEventListener('dragend', () => {
        const parent = row.parentNode;
        if (parent) parent.querySelectorAll('.' + cls + '.dragging')
          .forEach(n => n.classList.remove('dragging'));
        clearMarks();
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        clearMarks();
        row.classList.add(above ? 'drop-above' : 'drop-below');
      });
      row.addEventListener('dragleave', e => {
        if (e.relatedTarget && row.contains(e.relatedTarget)) return;
        row.classList.remove('drop-above');
        row.classList.remove('drop-below');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        const srcId = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
        clearMarks();
        if (!srcId || srcId === layer.id) return;
        const L = app.project.layers;
        const src = L.find(l => l.id === srcId);
        if (!src) return;
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        // Block we're moving:
        //   • if the source is part of a >1 multi-selection, every selected
        //     layer comes along (preserves relative project order);
        //   • any selected group also drags its descendants so folders stay
        //     contiguous;
        //   • otherwise it's just the dragged layer (+ descendants if group).
        const selSet = app.selectedLayers;
        const seed = (selSet && selSet.size > 1 && selSet.has(src))
          ? L.filter(l => selSet.has(l))
          : [src];
        const expanded = new Set(seed);
        for (const m of seed) if (m.type === 'group')
          for (const d of app.layerDescendants(m)) expanded.add(d);
        const block = L.filter(l => expanded.has(l));   // preserves order
        if (block.includes(layer)) return;   // dropping onto self / own child
        const srcIdx = L.indexOf(src);
        let tgtIdx = L.indexOf(layer);
        if (srcIdx < 0 || tgtIdx < 0) return;
        let insert = above ? tgtIdx + 1 : tgtIdx;
        const blockIdxs = block.map(l => L.indexOf(l)).filter(i => i >= 0).sort((a, b) => a - b);
        // Account for block members removed from positions before `insert`.
        const removedBefore = blockIdxs.filter(i => i < insert).length;
        insert -= removedBefore;
        if (insert < 0) insert = 0;
        // Reparent the dragged top-level layers (those in the block whose
        // own parent isn't also in the block). Rule:
        //   • drop above a row → become its sibling (target.parentId)
        //   • drop below a leaf → become its sibling (target.parentId)
        //   • drop below a folder header → join that folder (target.id)
        const newParentId = (!above && layer.type === 'group')
          ? layer.id
          : (layer.parentId || null);
        const movingIds = new Set(block.map(l => l.id));
        const topLevel = block.filter(l => !movingIds.has(l.parentId));
        const apply = () => {
          const sortedBlock = block.slice().sort((a, b) => L.indexOf(a) - L.indexOf(b));
          for (let i = L.length - 1; i >= 0; i--) if (block.includes(L[i])) L.splice(i, 1);
          if (insert > L.length) insert = L.length;
          L.splice(insert, 0, ...sortedBlock);
          for (const l of topLevel) l.parentId = newParentId;
        };
        if (typeof app.doStruct === 'function') app.doStruct('Reorder layer', apply);
        else { apply(); app.emit('layerschange'); app.emit('render'); }
      });
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
      const app = this.app, p = app.project;
      // `L` here is the visible-rows list so the grid height + row mapping
      // stays in sync with the names column when groups are collapsed.
      const L = app.visibleLayers();
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
      // 2D-animation-style ruler: frame-number labels whose stride is a
      // divisor of FPS (so sub-second fractions are meaningful), with
      // second-boundary labels emphasised as the dominant rhythm.
      const ticks = this._rulerStrides(cw, p.fps, p.frameCount);
      const labelStride = ticks.label;
      const tickStride  = ticks.tick;
      const F = Math.max(1, Math.round(p.fps || 24));

      c.font = '10px Segoe UI';
      c.textBaseline = 'middle';
      for (let f = 0; f < p.frameCount; f++) {
        const x = f * cw;
        const onLabel = (f % labelStride === 0) || f === p.frameCount - 1;
        const onTick  = !onLabel && tickStride > 0 && (f % tickStride === 0);
        const onSecond = (f % F === 0);
        if (onLabel) {
          // Long-tick + bright label for the seconds; shorter + dimmer for
          // intermediate frame markers. The current frame still wins colour.
          c.strokeStyle = onSecond ? '#000c' : '#0007';
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(x + 0.5, hh - (onSecond ? 11 : 7));
          c.lineTo(x + 0.5, hh);
          c.stroke();
          c.fillStyle = (f === cf) ? '#4a9fd4' : (onSecond ? '#c8ccd3' : '#7a808b');
          c.textAlign = 'left';
          c.fillText(String(f + 1), x + 2, hh / 2);
        } else if (onTick) {
          c.strokeStyle = '#00000055'; c.lineWidth = 1;
          c.beginPath(); c.moveTo(x + 0.5, hh - 4); c.lineTo(x + 0.5, hh); c.stroke();
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
        // folder rows show a faint banded tint across the whole row to
        // signal "this row groups the rows below" — no cel renders.
        if (layer.type === 'group') {
          c.fillStyle = this._alpha(layer.color || '#c8a04a', 0.10);
          c.fillRect(0, y, w, rh);
          continue;
        }
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
            // Treat the entire run as ONE continuous mini-canvas: thumb at
            // the start at native aspect, the held remainder is the same
            // canvas bg "extending" rather than a coloured stripe. Layer
            // identity moves entirely to the rounded border colour.
            c.save();
            this._roundRect(c, bx, by, bw, bh, 3);
            c.clip();
            c.fillStyle = p.bg || '#f4f1ea';
            c.fillRect(bx, by, bw, bh);
            const thumbW = Math.min(bw, Math.round(bh * p.width / p.height));
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const srcW = Math.min(384, Math.max(64, Math.ceil(thumbW * dpr / 64) * 64));
            const srcH = Math.max(8, Math.round(srcW * p.height / p.width));
            const th = cel.getThumb(srcW, srcH);
            c.imageSmoothingEnabled = true;
            c.imageSmoothingQuality = 'high';
            c.drawImage(th, bx, by, thumbW, bh);
            c.restore();
            // Slim layer-tint border = the only layer-colour cue.
            c.lineWidth = 1;
            c.strokeStyle = this._alpha(layer.color, isActive ? 0.9 : 0.5);
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
          // drawing number — only annotated when thumbnails are on (then
          // the small "N" sits in the run's leading corner as a key-label).
          // With thumbs off, the coloured bar carries the visual info and the
          // ruler above already supplies the frame index.
          if (bw > 16 && this.showThumbs) {
            c.fillStyle = '#0009';
            c.font = '9px Segoe UI'; c.textAlign = 'left';
            c.fillText(String(num), f * cw + cw / 2 + 5, y + rh / 2);
          }
          // Multi-selection accent. Shift-range select can produce
          // selection fragments smaller than the full run — paint the
          // tinted fill + outline over the intersected cells only.
          const inter = this._rangeIntersectsSelection(layer, num, f, e);
          if (inter) {
            const ix = inter.start * cw + 1.5;
            const iw = (inter.end - inter.start + 1) * cw - 3;
            c.save();
            // 1. Translucent fill so the cells *look* highlighted at a
            //    glance — was previously just an outline that disappeared
            //    against dark thumbs.
            this._roundRect(c, ix, by, iw, bh, 3);
            c.fillStyle = 'rgba(74,159,212,0.32)';
            c.fill();
            // 2. Bright outline. 2.5 px reads at any DPR; the inner shadow
            //    line adds depth so the marquee pops on light backgrounds.
            c.lineWidth = 2.5;
            c.strokeStyle = '#4a9fd4';
            c.stroke();
            c.lineWidth = 1;
            c.strokeStyle = 'rgba(255,255,255,0.55)';
            this._roundRect(c, ix + 1, by + 1, iw - 2, bh - 2, 2.2);
            c.stroke();
            // 3. Top + bottom accent bars — wide-edge cue that signals
            //    "this is a range" even when the cells are too narrow to
            //    show the outline corners clearly.
            c.fillStyle = '#4a9fd4';
            c.fillRect(ix, by, iw, 2);
            c.fillRect(ix, by + bh - 2, iw, 2);
            c.restore();
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
      // body gridlines — same FPS-aware stride as the ruler so the vertical
      // guides under each row align with labels above.
      const grid = (tickStride > 0 ? tickStride : labelStride);
      c.strokeStyle = '#ffffff0a';
      for (let f = grid; f < p.frameCount; f += grid) {
        c.beginPath(); c.moveTo(f * cw + 0.5, hh); c.lineTo(f * cw + 0.5, h); c.stroke();
      }
      // playhead line
      c.strokeStyle = '#4a9fd4'; c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(cf * cw + cw / 2, hh); c.lineTo(cf * cw + cw / 2, h);
      c.stroke();
    }

    // Pick label + minor-tick strides for the timeline ruler. The strategy
    // is built for the way 2D animators read a timeline — frame numbers
    // (not timecode) with rhythmically-meaningful spacings:
    //   • Candidate strides are *divisors of FPS* so every label lands on
    //     a clean sub-second fraction (¼ s, ⅓ s, ½ s, 1 s) — unlike the
    //     fixed 5-frame stride Toon Boom uses, which doesn't align to
    //     seconds on 24 fps (5/24 ≈ 0.208 s of meaningless drift).
    //   • At low zoom the candidates extend to whole-second multiples.
    //   • Second-boundary labels are visually emphasised at draw time so
    //     the eye picks up "1 s, 2 s, 3 s …" while still seeing the finer
    //     rhythm in between.
    _rulerStrides(cw, fps, frameCount) {
      const F = Math.max(1, Math.round(fps || 24));
      const divisors = [];
      for (let i = 1; i <= F; i++) if (F % i === 0) divisors.push(i);
      // Append multi-second strides for the zoomed-out case.
      const cand = [...divisors, F * 2, F * 3, F * 5, F * 10, F * 15, F * 30, F * 60];
      const minLabelGap = 48; // a touch tighter than 52 — keeps rhythm visible
      let label = cand[cand.length - 1];
      for (const s of cand) { if (s * cw >= minLabelGap) { label = s; break; } }
      if (label > frameCount) {
        const fit = cand.slice().reverse().find(s => s <= frameCount);
        label = Math.max(1, fit || 1);
      }
      // Subtick: pick the largest divisor of label that's <label and still
      // legible. Falling back to a near-half if no clean divisor fits.
      let tick = 0;
      const labelDivs = [];
      for (let i = 1; i < label; i++) if (label % i === 0) labelDivs.push(i);
      labelDivs.reverse(); // largest first
      for (const d of labelDivs) {
        if (d * cw >= 8) { tick = d; break; }
      }
      if (!tick) {
        const half = Math.max(1, Math.round(label / 2));
        if (half < label && half * cw >= 8) tick = half;
      }
      return { label, tick };
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
