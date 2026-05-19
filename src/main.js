/* OpenToon Studio - application bootstrap & wiring */
(function (OT) {
  'use strict';
  const U = OT.util;

  // ---- vector-stroke transforms used when the canvas is resized ----
  function scaleStrokes(strokes, sx, sy) {
    for (const s of strokes) {
      if (s.pts) s.pts = s.pts.map(p => ({ x: p.x * sx, y: p.y * sy, p: p.p }));
      if (s.contour) s.contour = s.contour.map(p => ({ x: p.x * sx, y: p.y * sy }));
      if (s.width != null) s.width *= (sx + sy) / 2;
      if (s.grow != null) s.grow *= (sx + sy) / 2;
    }
  }
  function shiftStrokes(strokes, dx, dy) {
    for (const s of strokes) {
      if (s.pts) s.pts = s.pts.map(p => ({ x: p.x + dx, y: p.y + dy, p: p.p }));
      if (s.contour) s.contour = s.contour.map(p => ({ x: p.x + dx, y: p.y + dy }));
    }
  }

  class App extends OT.Emitter {
    constructor() {
      super();
      OT.app = this;
      this.project = new OT.Project();
      this.palette = new OT.Palette();
      this.frame = 0;
      this.color = '#222222';
      this.dirty = false;
      this.celClipboard = null;
      this.playIn = null;
      this.playOut = null;
      this.audioBuffer = null;   // decoded AudioBuffer (runtime)
      this.audioPeaks = null;    // per-frame amplitude peaks
      this._audioSrc = null;
      this._activeLayer = this.project.layers[this.project.layers.length - 1];

      this.settings = {
        brushSize: 8, brushOpacity: 1, smoothing: 0.5,
        eraserSize: 26, eraserOpacity: 1,
        pencilSize: 3, pencilOpacity: 1,
        fillTolerance: 36, fillContiguous: true, fillGap: 6,
        snapDist: 14,
        shapeFill: false, shapeStroke: true, shapeStrokeWidth: 6
      };
      this.onion = {
        on: false, prev: 2, next: 1,
        prevColor: '#e0533d', nextColor: '#52b669',
        minAlpha: 0.12, maxAlpha: 0.42
      };
      this.showCamera = true;
      this.grid = { on: false, size: 64, guides: false };
      this.symmetry = { on: false, axis: 'v' };

      this.history = new OT.History(60);
      this.history.on('change', () => { this.dirty = true; });
    }

    /* ---------------- start ---------------- */
    start() {
      this.playback = new OT.Playback(this);
      this._loadPrefs();
      this.tools = new OT.ToolManager(this);
      this.stage = new OT.Stage(this);
      this.ui = new OT.UI(this);
      this.colorPanel = new OT.ColorPanel(this, document.getElementById('colorpanel'));
      this.timeline = new OT.Timeline(this);

      this._installKeys();
      this._installGuards();

      this.tools.select('brush');
      this.emitAll();
      this.timeline.render();
      requestAnimationFrame(() => { this.stage.resize(); this.stage.fitToCamera(); });

      setInterval(() => {
        if (this.dirty && OT.IO.autosave(this)) this.dirty = false;
        this._savePrefs();
      }, 20000);
      this._offerAutosave();
      this.ui.status('Welcome to OpenToon Studio - press B to start drawing');
    }

    _offerAutosave() {
      if (!OT.IO.hasAutosave()) return;
      const t = OT.IO.autosaveTime();
      const body = U.el('div', { style: { maxWidth: '320px' } }, [
        'An autosaved project was found' + (t ? ' from ' + t.toLocaleString() : '') +
        '. Restore it?'
      ]);
      this.ui.modal('Restore Autosave', body, [
        { label: 'Start Fresh', fn: () => { OT.IO.clearAutosave(); } },
        {
          label: 'Restore', primary: true, fn: () => {
            OT.IO.loadAutosave().then(d => this.loadProjectData(d))
              .catch(e => this.ui.status('Restore failed: ' + e.message));
          }
        }
      ]);
    }

    /* ---------------- preferences (tool settings persist across sessions) ---- */
    _loadPrefs() {
      try {
        const raw = localStorage.getItem('opentoon.prefs');
        if (!raw) return;
        const pr = JSON.parse(raw);
        if (pr.settings) Object.assign(this.settings, pr.settings);
        if (pr.onion) Object.assign(this.onion, pr.onion);
        if (pr.grid) Object.assign(this.grid, pr.grid);
        if (pr.symmetry) Object.assign(this.symmetry, pr.symmetry);
        if (typeof pr.showCamera === 'boolean') this.showCamera = pr.showCamera;
        if (pr.loopMode && this.playback) this.playback.loopMode = pr.loopMode;
      } catch (e) { /* ignore corrupt prefs */ }
    }
    _savePrefs() {
      try {
        localStorage.setItem('opentoon.prefs', JSON.stringify({
          settings: this.settings, onion: this.onion,
          grid: this.grid, symmetry: this.symmetry,
          showCamera: this.showCamera,
          loopMode: this.playback ? this.playback.loopMode : null
        }));
      } catch (e) { /* ignore */ }
    }

    /* ---------------- state ---------------- */
    activeLayer() {
      if (this._activeLayer && this.project.layers.indexOf(this._activeLayer) >= 0)
        return this._activeLayer;
      this._activeLayer = this.project.layers[this.project.layers.length - 1];
      return this._activeLayer;
    }
    selectLayer(layer) {
      if (!layer || layer === this._activeLayer) {
        if (layer) { this._activeLayer = layer; }
        return;
      }
      if (this.tools) this.tools.flush();
      this._activeLayer = layer;
      this.emit('layerselect');
      this.emit('render');
    }
    setFrame(f, fromPlayback) {
      f = U.clamp(f | 0, 0, this.project.frameCount - 1);
      if (!fromPlayback && this.tools) this.tools.flush();
      this.frame = f;
      if (!fromPlayback) this._syncVideoLayers();
      this.emit('framechange');
      this.emit('render');
    }
    setColor(hex) {
      this.color = hex;
      this.emit('colorchange', hex);
    }
    emitAll() {
      this.emit('projectchange');
      this.emit('layerschange');
      this.emit('layerselect');
      this.emit('framechange');
      this.emit('palettechange');
      this.emit('render');
    }

    /* ---------------- structural history ---------------- */
    _structSnapshot() {
      const p = this.project;
      return {
        frameCount: p.frameCount,
        camera: JSON.parse(JSON.stringify(p.camera)),
        layers: p.layers.slice(),
        activeId: this.activeLayer() ? this.activeLayer().id : null,
        frame: this.frame,
        perLayer: p.layers.map(l => ({
          ref: l, name: l.name, visible: l.visible, locked: l.locked,
          opacity: l.opacity, color: l.color,
          exposure: l.exposure.slice(), nextNum: l.nextNum,
          transform: JSON.parse(JSON.stringify(l.transform)),
          cels: Object.assign({}, l.cels)
        }))
      };
    }
    _restoreStruct(s) {
      const p = this.project;
      p.frameCount = s.frameCount;
      p.camera = JSON.parse(JSON.stringify(s.camera));
      p.layers = s.layers.slice();
      for (const pl of s.perLayer) {
        const l = pl.ref;
        l.name = pl.name; l.visible = pl.visible; l.locked = pl.locked;
        l.opacity = pl.opacity; l.color = pl.color;
        l.exposure = pl.exposure.slice(); l.nextNum = pl.nextNum;
        l.transform = JSON.parse(JSON.stringify(pl.transform || { keyframes: [] }));
        l.cels = Object.assign({}, pl.cels);
      }
      this._activeLayer = p.layers.find(l => l.id === s.activeId) || p.layers[p.layers.length - 1];
      this.frame = U.clamp(s.frame, 0, p.frameCount - 1);
      this.emitAll();
    }
    doStruct(label, fn) {
      if (this.tools) this.tools.flush();
      const before = this._structSnapshot();
      fn();
      this._commitStruct(label, before);
    }
    // Commit a structural change given a snapshot taken before it.
    _commitStruct(label, before) {
      const after = this._structSnapshot();
      this.history.push({
        label,
        undo: () => this._restoreStruct(before),
        redo: () => this._restoreStruct(after)
      });
      this.emitAll();
      this.ui.status(label);
    }

    undo() {
      if (!this.history.canUndo()) { this.ui.status('Nothing to undo'); return; }
      this.history.undo();
      this.emit('render'); this.emit('celchange'); this.emit('layerschange');
    }
    redo() {
      if (!this.history.canRedo()) { this.ui.status('Nothing to redo'); return; }
      this.history.redo();
      this.emit('render'); this.emit('celchange'); this.emit('layerschange');
    }

    /* ---------------- drawing / exposure ops ---------------- */
    _dl() {
      const l = this.activeLayer();
      if (!l || (l.type !== 'drawing' && l.type !== 'vector')) {
        this.ui.status('Select a drawing layer'); return null;
      }
      return l;
    }
    newDrawing() {
      const l = this._dl(); if (!l) return;
      this.doStruct('New drawing', () => {
        l.newDrawingAt(this.frame, this.project.width, this.project.height);
      });
    }
    duplicateDrawing() {
      const l = this._dl(); if (!l) return;
      const src = l.celAt(this.frame);
      this.doStruct('Duplicate drawing', () => {
        const n = l.nextNum++;
        const kind = l.type === 'vector' ? 'vector' : 'raster';
        const c = new OT.Cel(n, this.project.width, this.project.height, kind);
        if (src) {
          if (kind === 'vector') {
            c.strokes = JSON.parse(JSON.stringify(src.strokes || []));
            c.rebuild();
          } else c.ctx.drawImage(src.canvas, 0, 0);
        }
        c.dirty();
        l.cels[n] = c;
        l.exposure[this.frame] = n;
      });
    }
    extendExposure() {
      const l = this._dl(); if (!l) return;
      const num = l.exposure[this.frame];
      if (!num) { this.ui.status('No drawing to extend'); return; }
      this.doStruct('Extend exposure', () => {
        const f = this.frame + 1;
        if (f >= this.project.frameCount) this.project.frameCount = f + 1;
        l.exposure[f] = num;
      });
      this.setFrame(this.frame + 1);
    }
    clearExposure() {
      const l = this._dl(); if (!l) return;
      if (!l.exposure[this.frame]) { this.ui.status('Frame already empty'); return; }
      this.doStruct('Clear exposure', () => { l.exposure[this.frame] = 0; });
    }
    copyDrawing() {
      const l = this._dl(); if (!l) return;
      const cel = l.celAt(this.frame);
      if (!cel) { this.ui.status('No drawing on this frame to copy'); return; }
      const c = document.createElement('canvas');
      c.width = cel.w; c.height = cel.h;
      c.getContext('2d').drawImage(cel.canvas, 0, 0);
      this.celClipboard = {
        kind: cel.kind,
        strokes: cel.kind === 'vector' ? JSON.parse(JSON.stringify(cel.strokes)) : null,
        canvas: c
      };
      this.ui.status('Drawing copied');
    }
    cutDrawing() {
      const l = this._dl(); if (!l) return;
      if (!l.exposure[this.frame]) { this.ui.status('No drawing to cut'); return; }
      this.copyDrawing();
      this.doStruct('Cut drawing', () => { l.exposure[this.frame] = 0; });
    }
    pasteDrawing() {
      const l = this._dl(); if (!l) return;
      const clip = this.celClipboard;
      if (!clip) { this.ui.status('Clipboard is empty'); return; }
      if (l.type === 'vector' && !clip.strokes) {
        this.ui.status('Cannot paste a bitmap drawing onto a vector layer'); return;
      }
      this.doStruct('Paste drawing', () => {
        const n = l.nextNum++;
        const kind = l.type === 'vector' ? 'vector' : 'raster';
        const c = new OT.Cel(n, this.project.width, this.project.height, kind);
        if (kind === 'vector') {
          c.strokes = JSON.parse(JSON.stringify(clip.strokes));
          c.rebuild();
        } else c.ctx.drawImage(clip.canvas, 0, 0);
        c.dirty();
        l.cels[n] = c;
        l.exposure[this.frame] = n;
      });
    }
    insertFrame() {
      this.doStruct('Insert frame', () => {
        for (const l of this.project.layers) l.exposure.splice(this.frame, 0, 0);
        this.project.frameCount++;
        for (const k of this.project.camera.keyframes) if (k.frame >= this.frame) k.frame++;
      });
    }
    removeFrame() {
      if (this.project.frameCount <= 1) { this.ui.status('Cannot remove the last frame'); return; }
      const f = this.frame;
      this.doStruct('Remove frame', () => {
        for (const l of this.project.layers) l.exposure.splice(f, 1);
        this.project.frameCount--;
        this.project.camera.keyframes = this.project.camera.keyframes
          .filter(k => k.frame !== f)
          .map(k => k.frame > f ? Object.assign({}, k, { frame: k.frame - 1 }) : k);
      });
      this.setFrame(Math.min(f, this.project.frameCount - 1));
    }
    clearDrawing() {
      const l = this._dl(); if (!l) return;
      if (this.tools.active.name === 'select') {
        const t = this.tools.tools.select;
        if (t.sel || (t.vsel && t.vsel.length)) { this.deleteSelection(); return; }
      }
      const cel = l.celAt(this.frame);
      if (!cel) { this.ui.status('Nothing to clear'); return; }
      const before = cel.snapshot();
      cel.clear();
      this.history.pushCelEdit('Clear drawing', cel, before);
      this.emit('render'); this.emit('celchange');
      this.ui.status('Drawing cleared');
    }

    /* ---------------- layer ops ---------------- */
    addLayer(type) {
      const kind = type === 'drawing' ? 'drawing' : 'vector';
      this.doStruct('Add layer', () => {
        const n = new OT.Layer((kind === 'vector' ? 'Drawing ' : 'Bitmap ') +
          (this.project.layers.length + 1), kind);
        const idx = this.project.layers.indexOf(this.activeLayer());
        this.project.addLayer(n, idx >= 0 ? idx + 1 : this.project.layers.length);
        this._activeLayer = n;
      });
    }
    deleteLayer(layer) {
      if (!layer) return;
      if (this.project.layers.length <= 1) { this.ui.status('At least one layer is required'); return; }
      this.doStruct('Delete layer', () => {
        const idx = this.project.layers.indexOf(layer);
        this.project.removeLayer(layer);
        this._activeLayer = this.project.layers[U.clamp(idx, 0, this.project.layers.length - 1)];
      });
    }
    duplicateLayer(layer) {
      if (!layer) return;
      this.doStruct('Duplicate layer', () => {
        const c = new OT.Layer(layer.name + ' copy', layer.type);
        c.visible = layer.visible; c.locked = layer.locked;
        c.opacity = layer.opacity; c.color = layer.color;
        c.exposure = layer.exposure.slice(); c.nextNum = layer.nextNum;
        if (layer.type === 'video' && layer.video) {
          c.video = {
            name: layer.video.name, src: layer.video.src, duration: layer.video.duration
          };
          c.videoFrames = layer.videoFrames;
        }
        for (const num in layer.cels) {
          const src = layer.cels[num];
          const nc = new OT.Cel(src.num, src.w, src.h, src.kind);
          if (src.kind === 'vector') {
            nc.strokes = JSON.parse(JSON.stringify(src.strokes || []));
            nc.rebuild();
          } else nc.ctx.drawImage(src.canvas, 0, 0);
          nc.dirty();
          c.cels[num] = nc;
        }
        const idx = this.project.layers.indexOf(layer);
        this.project.addLayer(c, idx + 1);
        this._activeLayer = c;
      });
      this._reattachVideoLayers();
    }
    moveLayer(layer, dir) {
      if (!layer) return;
      const L = this.project.layers;
      const idx = L.indexOf(layer), ni = idx + dir;
      if (ni < 0 || ni >= L.length) { this.ui.status('Layer is already at the edge'); return; }
      this.doStruct('Move layer', () => {
        L.splice(idx, 1); L.splice(ni, 0, layer);
      });
    }
    mergeDown(layer) {
      if (!layer) return;
      const L = this.project.layers;
      const idx = L.indexOf(layer);
      if (idx <= 0) { this.ui.status('No layer below to merge into'); return; }
      const below = L[idx - 1];
      if (layer.type === 'video' || below.type === 'video') {
        this.ui.status('Video layers cannot be merged'); return;
      }
      const W = this.project.width, H = this.project.height;
      this.doStruct('Merge down', () => {
        const cels = {}, exposure = [];
        let n = 1;
        for (let f = 0; f < this.project.frameCount; f++) {
          const tc = layer.celAt(f), bc = below.celAt(f);
          if (!tc && !bc) { exposure[f] = 0; continue; }
          const c = new OT.Cel(n, W, H);
          if (bc) { c.ctx.globalAlpha = below.opacity; c.ctx.drawImage(bc.canvas, 0, 0); }
          if (tc) { c.ctx.globalAlpha = layer.opacity; c.ctx.drawImage(tc.canvas, 0, 0); }
          c.ctx.globalAlpha = 1; c.dirty();
          cels[n] = c; exposure[f] = n; n++;
        }
        below.cels = cels; below.exposure = exposure;
        below.nextNum = n; below.opacity = 1;
        below.type = 'drawing';   // merged result is a flattened bitmap
        this.project.removeLayer(layer);
        this._activeLayer = below;
      });
    }

    /* ---------------- layer transform ---------------- */
    setLayerKeyHere() {
      const l = this._dl(); if (!l) return;
      const c = l.transformAt(this.frame);
      this.doStruct('Set transform keyframe', () => {
        l.transform.keyframes = l.transform.keyframes.filter(k => k.frame !== this.frame);
        l.transform.keyframes.push({ frame: this.frame, x: c.x, y: c.y, sx: c.sx, sy: c.sy, rot: c.rot });
      });
    }
    resetLayerTransform(layer) {
      if (!layer) return;
      if (!layer.transform.keyframes.length) { this.ui.status('Layer has no transform'); return; }
      this.doStruct('Reset layer transform', () => { layer.transform.keyframes = []; });
    }

    /* ---------------- selection helpers ---------------- */
    flipSelection(axis) {
      const t = this.tools.tools.select;
      if (this.tools.active.name !== 'select' || !t.sel) { this.ui.status('No selection to flip'); return; }
      const s = t.sel;
      const c = document.createElement('canvas');
      c.width = s.sw; c.height = s.sh;
      const x = c.getContext('2d');
      x.translate(axis === 'h' ? s.sw : 0, axis === 'v' ? s.sh : 0);
      x.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
      x.drawImage(s.canvas, 0, 0);
      s.canvas = c;
      this.emit('render');
    }
    deleteSelection() {
      const t = this.tools.tools.select;
      if (this.tools.active.name !== 'select') { this.ui.status('No selection'); return; }
      if (t.sel) t.deleteSel(this);
      else if (t.vsel && t.vsel.length) t.deleteVSel(this);
      else this.ui.status('No selection');
    }
    selectAll() {
      const l = this._dl(); if (!l) return;
      const cel = l.celAt(this.frame);
      if (!cel) { this.ui.status('Nothing on this frame'); return; }
      this.tools.select('select');
      const t = this.tools.tools.select;
      if (l.type === 'vector') {
        t.vcel = cel;
        t.vsel = cel.strokes.slice();
        t.layerKind = 'vector';
        this.emit('render'); this.emit('overlayrender');
        this.ui.status('Selected ' + t.vsel.length + ' stroke(s)');
      } else {
        t.commit(this);
        t._lift(this, 0, 0, this.project.width, this.project.height);
        this.emit('render');
      }
    }

    /* ---------------- camera ---------------- */
    addCameraKey() {
      const c = this.project.cameraAt(this.frame);
      this.setCameraKey(this.frame, c);
    }
    setCameraKey(frame, vals) {
      this.doStruct('Camera keyframe', () => {
        this.project.camera.keyframes = this.project.camera.keyframes.filter(k => k.frame !== frame);
        this.project.camera.keyframes.push({
          frame, x: vals.x || 0, y: vals.y || 0,
          zoom: vals.zoom || 1, rot: vals.rot || 0
        });
      });
    }
    clearCameraKeys() {
      if (!this.project.camera.keyframes.length) { this.ui.status('No camera keyframes'); return; }
      this.doStruct('Clear camera keyframes', () => { this.project.camera.keyframes = []; });
    }
    toggleCamera() {
      this.showCamera = !this.showCamera;
      this.emit('render');
      this.ui.status('Camera guide ' + (this.showCamera ? 'on' : 'off'));
    }
    toggleOnion() {
      this.onion.on = !this.onion.on;
      this.emit('onionchange'); this.emit('render');
      this.ui.status('Onion skin ' + (this.onion.on ? 'on' : 'off'));
    }

    /* ---------------- playback range / view flip ---------------- */
    setPlayIn() {
      this.playIn = this.frame;
      if (this.playOut != null && this.playOut < this.playIn) this.playOut = this.playIn;
      this.emit('projectchange');
      this.ui.status('Playback in point: frame ' + (this.frame + 1));
    }
    setPlayOut() {
      this.playOut = this.frame;
      if (this.playIn != null && this.playIn > this.playOut) this.playIn = this.playOut;
      this.emit('projectchange');
      this.ui.status('Playback out point: frame ' + (this.frame + 1));
    }
    clearPlayRange() {
      this.playIn = this.playOut = null;
      this.emit('projectchange');
      this.ui.status('Playback range cleared');
    }
    toggleFlipH() {
      this.stage.flipH = !this.stage.flipH;
      this.emit('render');
      this.ui.status('Flip view horizontal ' + (this.stage.flipH ? 'on' : 'off'));
    }
    toggleFlipV() {
      this.stage.flipV = !this.stage.flipV;
      this.emit('render');
      this.ui.status('Flip view vertical ' + (this.stage.flipV ? 'on' : 'off'));
    }
    toggleGrid() {
      this.grid.on = !this.grid.on;
      this.emit('render');
      this.ui.status('Grid ' + (this.grid.on ? 'on' : 'off'));
    }
    toggleSymmetry() {
      this.symmetry.on = !this.symmetry.on;
      this.emit('render');
      this.ui.status('Symmetry drawing ' + (this.symmetry.on ? 'on' : 'off'));
    }

    /* ---------------- audio ---------------- */
    _audioContext() {
      if (!this._actx) this._actx = new (window.AudioContext || window.webkitAudioContext)();
      return this._actx;
    }
    _computePeaks(ab) {
      const ch = ab.getChannelData(0), sr = ab.sampleRate, fps = this.project.fps;
      const frames = Math.max(1, Math.ceil(ab.duration * fps));
      const spf = sr / fps;
      const peaks = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        const s0 = Math.floor(f * spf), s1 = Math.min(ch.length, Math.floor((f + 1) * spf));
        let mx = 0;
        for (let i = s0; i < s1; i += 16) { const v = Math.abs(ch[i]); if (v > mx) mx = v; }
        peaks[f] = mx;
      }
      return peaks;
    }
    _loadAudioData(dataURL) {
      fetch(dataURL).then(r => r.arrayBuffer())
        .then(buf => this._audioContext().decodeAudioData(buf))
        .then(ab => {
          this.audioBuffer = ab;
          this.audioPeaks = this._computePeaks(ab);
          this.emit('projectchange');
          this.ui.status('Audio ready: ' + (this.project.audio ? this.project.audio.name : ''));
        })
        .catch(e => this.ui.status('Audio decode failed: ' + e.message));
    }
    importAudio(file) {
      const reader = new FileReader();
      reader.onload = () => {
        this.project.audio = { name: file.name, data: reader.result };
        this._loadAudioData(reader.result);
        this.dirty = true;
      };
      reader.readAsDataURL(file);
    }
    removeAudio() {
      this.stopAudio();
      this.project.audio = null;
      this.audioBuffer = null;
      this.audioPeaks = null;
      this.emit('projectchange');
      this.ui.status('Audio track removed');
    }
    playAudioFrom(frame) {
      this.stopAudio();
      if (!this.audioBuffer) return;
      const ctx = this._audioContext();
      if (ctx.state === 'suspended') ctx.resume();
      const off = frame / this.project.fps;
      if (off >= this.audioBuffer.duration) return;
      const src = ctx.createBufferSource();
      src.buffer = this.audioBuffer;
      src.connect(ctx.destination);
      try { src.start(0, Math.max(0, off)); } catch (e) { return; }
      this._audioSrc = src;
    }
    stopAudio() {
      if (this._audioSrc) {
        try { this._audioSrc.stop(); } catch (e) {}
        this._audioSrc = null;
      }
    }

    /* ---------------- video import (plays as a video layer) ---------------- */
    async importVideo(file) {
      const prog = this.ui.progress('Importing video…');
      try {
        const dataURL = await new Promise((res, rej) => {
          const rd = new FileReader();
          rd.onload = () => res(rd.result);
          rd.onerror = () => rej(new Error('could not read the file'));
          rd.readAsDataURL(file);
        });
        prog.update(0.4, 'Loading video…');
        const videoEl = document.createElement('video');
        videoEl.src = dataURL;
        videoEl.muted = true; videoEl.playsInline = true; videoEl.preload = 'auto';
        await new Promise((res, rej) => {
          videoEl.onloadeddata = () => res();
          videoEl.onerror = () => rej(new Error('unsupported video format'));
        });
        // some files (esp. recorded webm) report duration Infinity until sought
        let dur = videoEl.duration;
        if (!isFinite(dur) || dur <= 0) {
          dur = await new Promise(res => {
            let to;
            const cleanup = () => {
              videoEl.removeEventListener('durationchange', onDur);
              videoEl.removeEventListener('seeked', onDur);
            };
            const onDur = () => {
              if (isFinite(videoEl.duration) && videoEl.duration > 0) {
                clearTimeout(to); cleanup(); res(videoEl.duration);
              }
            };
            videoEl.addEventListener('durationchange', onDur);
            videoEl.addEventListener('seeked', onDur);
            try { videoEl.currentTime = 1e6; } catch (e) {}
            to = setTimeout(() => {
              cleanup();
              res(isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : 5);
            }, 2500);
          });
          try { videoEl.currentTime = 0; } catch (e) {}
        }
        const before = this._structSnapshot();
        const layer = new OT.Layer(file.name.replace(/\.[^.]+$/, ''), 'video');
        layer.locked = true;
        layer.color = '#7d838f';
        layer.video = { name: file.name, src: dataURL, duration: dur };
        layer.videoEl = videoEl;
        layer.videoFrames = Math.ceil(dur * this.project.fps);
        videoEl.onseeked = () => this.emit('render');
        this.project.addLayer(layer, 0);
        this._activeLayer = layer;
        if (layer.videoFrames > this.project.frameCount)
          this.project.frameCount = layer.videoFrames;
        prog.update(0.75, 'Loading sound…');
        try {
          const abuf = await fetch(dataURL).then(r => r.arrayBuffer());
          const ab = await this._audioContext().decodeAudioData(abuf);
          this.project.audio = { name: file.name, data: dataURL };
          this.audioBuffer = ab;
          this.audioPeaks = this._computePeaks(ab);
        } catch (e) { /* video may have no decodable audio */ }
        this._commitStruct('Import video', before);
        this._syncVideoLayers();
        this.ui.status('Imported video "' + file.name + '" — press Space to play it');
      } catch (e) {
        this.ui.status('Video import failed: ' + e.message);
      } finally {
        prog.close();
      }
    }
    _reattachVideoLayers() {
      for (const l of this.project.layers) {
        if (l.type === 'video' && l.video && l.video.src && !l.videoEl) {
          const el = document.createElement('video');
          el.src = l.video.src;
          el.muted = true; el.playsInline = true; el.preload = 'auto';
          el.onseeked = () => this.emit('render');
          el.onloadeddata = () => { this.emit('render'); this._syncVideoLayers(); };
          l.videoEl = el;
          l.videoFrames = Math.ceil((l.video.duration || 1) * this.project.fps);
        }
      }
    }
    _videoLayers() {
      return this.project.layers.filter(l => l.type === 'video' && l.videoEl && l.video);
    }
    _syncVideoLayers() {
      for (const l of this._videoLayers()) {
        const t = Math.max(0, Math.min(l.video.duration - 0.04, this.frame / this.project.fps));
        if (Math.abs(l.videoEl.currentTime - t) > 0.03) {
          try { l.videoEl.currentTime = t; } catch (e) {}
        }
      }
    }
    playVideosFrom(frame) {
      for (const l of this._videoLayers()) {
        const t = Math.max(0, Math.min(l.video.duration - 0.04, frame / this.project.fps));
        try {
          l.videoEl.currentTime = t;
          const pr = l.videoEl.play();
          if (pr && pr.catch) pr.catch(() => {});
        } catch (e) {}
      }
    }
    pauseVideos() {
      for (const l of this._videoLayers()) { try { l.videoEl.pause(); } catch (e) {} }
    }
    seekVideosTo(frame) {
      const proms = [];
      for (const l of this._videoLayers()) {
        const t = Math.max(0, Math.min(l.video.duration - 0.04, frame / this.project.fps));
        proms.push(new Promise(res => {
          const el = l.videoEl;
          if (Math.abs(el.currentTime - t) < 0.01) { res(); return; }
          let done;
          const fin = () => { el.removeEventListener('seeked', done); res(); };
          done = fin;
          el.addEventListener('seeked', done);
          try { el.currentTime = t; } catch (e) { fin(); return; }
          setTimeout(fin, 500);
        }));
      }
      return Promise.all(proms);
    }

    /* ---------------- project ops ---------------- */
    newProject(opts) {
      this.stopAudio();
      this.pauseVideos();
      this.audioBuffer = this.audioPeaks = null;
      this.playIn = this.playOut = null;
      this.project = new OT.Project(opts);
      this.palette = new OT.Palette();
      this.frame = 0;
      this._activeLayer = this.project.layers[this.project.layers.length - 1];
      this.history.clear();
      this.dirty = false;
      this.colorPanel._renderSwatches();
      this.emitAll();
      this.stage.fitToCamera();
      this.ui.refreshProjectInfo();
      this.ui.status('New project created');
    }
    loadProjectData(data) {
      this.stopAudio();
      this.pauseVideos();
      this.audioBuffer = this.audioPeaks = null;
      this.playIn = this.playOut = null;
      this.project = data.project;
      if (data.palette) this.palette = OT.Palette.load(data.palette);
      this.frame = 0;
      this._activeLayer = this.project.layers[this.project.layers.length - 1];
      this.history.clear();
      this.dirty = false;
      this.colorPanel._renderSwatches();
      this.emitAll();
      this.stage.fitToCamera();
      this.ui.refreshProjectInfo();
      this._reattachVideoLayers();
      this._syncVideoLayers();
      if (this.project.audio && this.project.audio.data)
        this._loadAudioData(this.project.audio.data);
      this.ui.status('Project loaded');
    }
    openProject() {
      this._pickFile('.otoon,application/json', file => {
        OT.IO.openProjectFile(this, file)
          .then(d => this.loadProjectData(d))
          .catch(e => this.ui.status('Open failed: ' + e.message));
      });
    }
    importImage() {
      this._pickFile('image/*', file => {
        OT.IO.importImageAsLayer(this, file)
          .catch(e => this.ui.status('Import failed: ' + e.message));
      });
    }
    _pickFile(accept, cb) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept;
      inp.addEventListener('change', () => { if (inp.files[0]) cb(inp.files[0]); });
      inp.click();
    }

    /* ---------------- canvas resize ---------------- */
    // Change the project resolution after artwork exists.
    //   mode 'scale' rescales every drawing so the animation looks identical;
    //   mode 'crop'  keeps art at its pixel size, centered, cropping / padding.
    resizeCanvas(nw, nh, mode) {
      const p = this.project;
      const ow = p.width, oh = p.height;
      nw = U.clamp(nw | 0, 16, 8000);
      nh = U.clamp(nh | 0, 16, 8000);
      if (nw === ow && nh === oh) return;
      if (this.tools) this.tools.flush();
      const sx = nw / ow, sy = nh / oh;
      const dx = Math.round((nw - ow) / 2), dy = Math.round((nh - oh) / 2);

      // Snapshot cels + transforms by reference so undo/redo can swap them.
      const capture = () => p.layers.map(l => ({
        layer: l,
        cels: Object.assign({}, l.cels),
        transform: JSON.parse(JSON.stringify(l.transform || { keyframes: [] }))
      }));
      const restore = (saved, w, h, cam) => {
        for (const s of saved) {
          s.layer.cels = Object.assign({}, s.cels);
          s.layer.transform = JSON.parse(JSON.stringify(s.transform));
        }
        p.width = w; p.height = h;
        p.camera = JSON.parse(JSON.stringify(cam));
        this.emitAll();
        this.stage.fitToCamera();
        this.ui.refreshProjectInfo();
      };

      const before = capture();
      const beforeCam = JSON.parse(JSON.stringify(p.camera));

      for (const l of p.layers) {
        const nc = {};
        for (const num in l.cels) {
          const src = l.cels[num];
          const cell = new OT.Cel(src.num, nw, nh, src.kind);
          if (src.kind === 'vector') {
            cell.strokes = JSON.parse(JSON.stringify(src.strokes || []));
            if (mode === 'scale') scaleStrokes(cell.strokes, sx, sy);
            else shiftStrokes(cell.strokes, dx, dy);
            cell.rebuild();
          } else if (mode === 'scale') {
            cell.ctx.drawImage(src.canvas, 0, 0, src.w, src.h, 0, 0, nw, nh);
          } else {
            cell.ctx.drawImage(src.canvas, dx, dy);
          }
          cell.dirty();
          nc[num] = cell;
        }
        l.cels = nc;
        if (mode === 'scale' && l.transform && l.transform.keyframes) {
          for (const k of l.transform.keyframes) {
            k.x = (k.x || 0) * sx; k.y = (k.y || 0) * sy;
          }
        }
      }
      if (mode === 'scale') {
        for (const k of p.camera.keyframes) {
          k.x = (k.x || 0) * sx; k.y = (k.y || 0) * sy;
        }
      }
      p.width = nw; p.height = nh;

      const after = capture();
      const afterCam = JSON.parse(JSON.stringify(p.camera));
      this.history.push({
        label: 'Resize canvas',
        undo: () => restore(before, ow, oh, beforeCam),
        redo: () => restore(after, nw, nh, afterCam)
      });
      this.emitAll();
      this.stage.fitToCamera();
      this.ui.refreshProjectInfo();
      this.ui.status('Canvas resized to ' + nw + ' × ' + nh +
        ' (' + (mode === 'scale' ? 'artwork scaled' : 'cropped / extended') + ')');
    }

    /* ---------------- input ---------------- */
    _installKeys() {
      const TOOLKEYS = {
        v: 'select', a: 'transform', b: 'brush', n: 'pencil', e: 'eraser', g: 'fill',
        i: 'eyedropper', r: 'rect', o: 'ellipse', l: 'line', h: 'hand', z: 'zoom'
      };
      window.addEventListener('keydown', ev => {
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const k = ev.key.toLowerCase();
        const ctrl = ev.ctrlKey || ev.metaKey;

        if (ctrl) {
          if (k === 'z') { ev.preventDefault(); ev.shiftKey ? this.redo() : this.undo(); return; }
          if (k === 'y') { ev.preventDefault(); this.redo(); return; }
          if (k === 's') { ev.preventDefault(); OT.IO.saveProject(this); this.ui.status('Project saved'); return; }
          if (k === 'o') { ev.preventDefault(); this.openProject(); return; }
          if (k === 'n') { ev.preventDefault(); this.ui.newProjectDialog(); return; }
          if (k === 'a') { ev.preventDefault(); this.selectAll(); return; }
          if (k === 'c') { ev.preventDefault(); this.copyDrawing(); return; }
          if (k === 'x') { ev.preventDefault(); this.cutDrawing(); return; }
          if (k === 'v') { ev.preventDefault(); this.pasteDrawing(); return; }
          return;
        }

        if (TOOLKEYS[k] && !ev.repeat) { this.tools.select(TOOLKEYS[k]); return; }
        if (k === 'enter' && !ev.repeat) { ev.preventDefault(); this.playback.toggle(); return; }
        if (k === ' ') { ev.preventDefault(); if (!ev.repeat) this.playback.toggle(); return; }
        if (k === ',') { this.playback.step(-1); return; }
        if (k === '.') { this.playback.step(1); return; }
        if (k === 'home') { this.playback.gotoStart(); return; }
        if (k === 'end') { this.playback.gotoEnd(); return; }
        if (k === 'f') { this.stage.fitToCamera(); return; }
        if (k === 'm') { this.toggleFlipH(); return; }
        if (k === 'delete' || k === 'backspace') { ev.preventDefault(); this.clearDrawing(); return; }
        if (k === 'escape') {
          if (this.tools.active.name === 'select') this.tools.tools.select.cancel(this);
          return;
        }
        if (k === '[' || k === ']') {
          const d = k === ']' ? 1 : -1;
          const sel = this.tools.active.name === 'eraser' ? 'eraserSize'
            : this.tools.active.name === 'pencil' ? 'pencilSize' : 'brushSize';
          this.settings[sel] = U.clamp(this.settings[sel] + d * Math.max(1, this.settings[sel] * 0.12), 1, 300);
          this.ui._buildToolOpts();
          this.emit('overlayrender');
          this.ui.status((sel === 'eraserSize' ? 'Eraser' : sel === 'pencilSize' ? 'Pencil' : 'Brush') +
            ' size: ' + Math.round(this.settings[sel]));
          return;
        }
        if (k === '=' || k === '+') { this.stage.zoomAt(innerWidth / 2, innerHeight / 2, 1.25); return; }
        if (k === '-' || k === '_') { this.stage.zoomAt(innerWidth / 2, innerHeight / 2, 0.8); return; }
      });
    }
    _installGuards() {
      window.addEventListener('beforeunload', e => {
        this._savePrefs();
        if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
      });
      // Blur buttons after click so Space / Enter don't re-trigger the last button.
      document.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('button');
        if (b) b.blur();
      });
      // Suppress the native browser/OS context menu app-wide -- OpenToon has
      // its own right-click menus and the native one would otherwise pop up
      // alongside them.
      window.addEventListener('contextmenu', e => e.preventDefault());
    }
  }

  OT.App = App;

  function boot() {
    const app = new OT.App();
    app.start();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window.OT);
