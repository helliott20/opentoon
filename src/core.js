/* OpenToon Studio - core: utilities, events, data model, history */
window.OT = window.OT || {};
(function (OT) {
  'use strict';

  /* ============================== Utilities ============================== */
  const U = OT.util = {
    uid() {
      return 's' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
    },
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp(a, b, t) { return a + (b - a) * t; },
    dist(x1, y1, x2, y2) { const dx = x2 - x1, dy = y2 - y1; return Math.sqrt(dx * dx + dy * dy); },
    round(v, p) { const m = Math.pow(10, p || 0); return Math.round(v * m) / m; },
    pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; },

    el(tag, attrs, kids) {
      const e = document.createElement(tag);
      attrs = attrs || {};
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      }
      if (kids != null) {
        const arr = Array.isArray(kids) ? kids : [kids];
        for (const c of arr) {
          if (c == null) continue;
          e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
        }
      }
      return e;
    },
    svg(paths, vb) {
      return '<svg viewBox="' + (vb || '0 0 24 24') + '" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
    },

    download(filename, blob) {
      const url = (blob instanceof Blob) ? URL.createObjectURL(blob) : blob;
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      if (blob instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    /* ---- color helpers ---- */
    hexToRgb(hex) {
      hex = hex.replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      const n = parseInt(hex, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    },
    rgbToHex(r, g, b) {
      const h = x => U.clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
      return '#' + h(r) + h(g) + h(b);
    },
    hsvToRgb(h, s, v) {
      h = (h % 360 + 360) % 360; s = U.clamp(s, 0, 1); v = U.clamp(v, 0, 1);
      const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }
      return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
    },
    rgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0;
      if (d) {
        if (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
      }
      return { h, s: mx ? d / mx : 0, v: mx };
    }
  };

  /* ============================== Emitter ============================== */
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    off(ev, fn) {
      if (!this._h[ev]) return;
      this._h[ev] = this._h[ev].filter(f => f !== fn);
    }
    emit(ev, data) {
      const list = this._h[ev];
      if (list) for (const fn of list.slice()) { try { fn(data); } catch (e) { console.error(e); } }
      const all = this._h['*'];
      if (all) for (const fn of all.slice()) { try { fn(ev, data); } catch (e) { console.error(e); } }
    }
  }
  OT.Emitter = Emitter;

  /* ============================== Cel ============================== */
  // A Cel is a single drawing (raster surface) belonging to a layer.
  let _celSeq = 0;
  class Cel {
    constructor(num, w, h, kind) {
      this.num = num;
      this.uid = 'c' + (++_celSeq);
      this.w = w; this.h = h;
      this.kind = kind || 'raster';     // 'raster' | 'vector'
      this.canvas = document.createElement('canvas');
      this.canvas.width = w; this.canvas.height = h;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (this.kind === 'vector') this.strokes = [];
      this.thumb = null;
      this.thumbDirty = true;
    }
    dirty() { this.thumbDirty = true; }
    // Vector cels: re-render all strokes onto the raster cache canvas.
    rebuild() {
      if (this.kind === 'vector' && OT.Vector) OT.Vector.renderCel(this);
    }
    clear() {
      if (this.kind === 'vector') this.strokes = [];
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.dirty();
    }
    getImageData() { return this.ctx.getImageData(0, 0, this.w, this.h); }
    putImageData(d) {
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.ctx.putImageData(d, 0, 0);
      this.dirty();
    }
    snapshot() {
      if (this.kind === 'vector')
        return { strokes: JSON.parse(JSON.stringify(this.strokes)) };
      const c = document.createElement('canvas');
      c.width = this.w; c.height = this.h;
      c.getContext('2d').drawImage(this.canvas, 0, 0);
      return c;
    }
    restore(s) {
      if (this.kind === 'vector') {
        this.strokes = JSON.parse(JSON.stringify((s && s.strokes) || []));
        this.rebuild();
        return;
      }
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.ctx.drawImage(s, 0, 0);
      this.dirty();
    }
    getThumb(tw, th) {
      if (this.thumb && !this.thumbDirty &&
        this.thumb.width === tw && this.thumb.height === th) return this.thumb;
      const c = this.thumb && this.thumb.width === tw ? this.thumb : document.createElement('canvas');
      c.width = tw; c.height = th;
      const x = c.getContext('2d');
      // high-quality downscale -- without this the thumb looks like a
      // poorly resized JPEG at any non-trivial zoom in the timeline / layer panel
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.clearRect(0, 0, tw, th);
      x.drawImage(this.canvas, 0, 0, tw, th);
      this.thumb = c; this.thumbDirty = false;
      return c;
    }
    isBlank() {
      const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
      return true;
    }
    toDataURL() { return this.canvas.toDataURL('image/png'); }
  }
  OT.Cel = Cel;

  /* ============================== Layer ============================== */
  class Layer {
    constructor(name, type) {
      this.id = U.uid();
      this.name = name || 'Drawing';
      this.type = type || 'drawing';
      this.visible = true;
      this.locked = false;
      this.opacity = 1;
      this.color = '#3d9be0';
      this.cels = {};            // num -> Cel
      this.exposure = [];        // frameIndex -> cel num (0 = empty)
      this.nextNum = 1;
      this.transform = { keyframes: [] };  // {frame,x,y,sx,sy,rot}
    }
    // Interpolated layer transform at a frame (cut-out / peg animation).
    transformAt(f) {
      const ID = { x: 0, y: 0, sx: 1, sy: 1, rot: 0 };
      const ks = this.transform.keyframes;
      if (!ks.length) return Object.assign({}, ID);
      const N = k => ({
        x: k.x || 0, y: k.y || 0,
        sx: k.sx == null ? 1 : k.sx, sy: k.sy == null ? 1 : k.sy,
        rot: k.rot || 0
      });
      const s = ks.slice().sort((a, b) => a.frame - b.frame);
      if (f <= s[0].frame) return N(s[0]);
      if (f >= s[s.length - 1].frame) return N(s[s.length - 1]);
      for (let i = 0; i < s.length - 1; i++) {
        const a = s[i], b = s[i + 1];
        if (f >= a.frame && f <= b.frame) {
          let t = (f - a.frame) / (b.frame - a.frame);
          t = t * t * (3 - 2 * t);
          const A = N(a), B = N(b);
          return {
            x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t,
            sx: A.sx + (B.sx - A.sx) * t, sy: A.sy + (B.sy - A.sy) * t,
            rot: A.rot + (B.rot - A.rot) * t
          };
        }
      }
      return N(s[0]);
    }
    hasTransform() { return this.transform.keyframes.length > 0; }
    celNumAt(f) { return this.exposure[f] || 0; }
    celAt(f) { const n = this.exposure[f]; return n ? this.cels[n] || null : null; }
    ensureCel(num, w, h) {
      if (!this.cels[num])
        this.cels[num] = new Cel(num, w, h, this.type === 'vector' ? 'vector' : 'raster');
      return this.cels[num];
    }
    // Get (creating if needed) the cel a frame should draw on.
    drawingAt(f, w, h) {
      let n = this.exposure[f];
      if (!n) {
        n = this.nextNum++;
        this.exposure[f] = n;
      }
      return this.ensureCel(n, w, h);
    }
    newDrawingAt(f, w, h) {
      const n = this.nextNum++;
      this.exposure[f] = n;
      return this.ensureCel(n, w, h);
    }
    usedNums() {
      const s = {};
      for (const n of this.exposure) if (n) s[n] = 1;
      return Object.keys(s).map(Number);
    }
  }
  OT.Layer = Layer;

  /* ============================== Project ============================== */
  class Project {
    constructor(opts) {
      opts = opts || {};
      this.name = opts.name || 'Untitled';
      this.width = opts.width || 1920;
      this.height = opts.height || 1080;
      this.fps = opts.fps || 24;
      this.frameCount = opts.frameCount || 48;
      this.bg = opts.bg || '#ffffff';
      this.layers = [];
      this.camera = { keyframes: [] };  // {frame,x,y,zoom,rot}
      if (!opts.empty) {
        this.layers.push(new Layer('Drawing 1', 'vector'));
      }
    }
    addLayer(layer, index) {
      if (index == null) index = this.layers.length;
      this.layers.splice(index, 0, layer);
      return layer;
    }
    removeLayer(layer) {
      const i = this.layers.indexOf(layer);
      if (i >= 0) this.layers.splice(i, 1);
      return i;
    }
    indexOf(layer) { return this.layers.indexOf(layer); }
    ensureFrames(n) {
      if (n > this.frameCount) this.frameCount = n;
    }
    // Camera transform at a given frame (interpolated keyframes).
    cameraAt(f) {
      const base = { x: 0, y: 0, zoom: 1, rot: 0 };
      const k = this.camera.keyframes;
      if (!k.length) return base;
      const sorted = k.slice().sort((a, b) => a.frame - b.frame);
      if (f <= sorted[0].frame) return cam(sorted[0]);
      if (f >= sorted[sorted.length - 1].frame) return cam(sorted[sorted.length - 1]);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i], b = sorted[i + 1];
        if (f >= a.frame && f <= b.frame) {
          let t = (f - a.frame) / (b.frame - a.frame);
          t = t * t * (3 - 2 * t); // smoothstep ease
          return {
            x: U.lerp(a.x || 0, b.x || 0, t),
            y: U.lerp(a.y || 0, b.y || 0, t),
            zoom: U.lerp(a.zoom || 1, b.zoom || 1, t),
            rot: U.lerp(a.rot || 0, b.rot || 0, t)
          };
        }
      }
      return base;
      function cam(o) { return { x: o.x || 0, y: o.y || 0, zoom: o.zoom || 1, rot: o.rot || 0 }; }
    }
  }
  OT.Project = Project;

  /* ============================== History ============================== */
  class History extends Emitter {
    constructor(limit) {
      super();
      this.limit = limit || 60;
      this.undoStack = [];
      this.redoStack = [];
    }
    push(cmd) {
      // cmd: {label, undo(), redo()}
      this.undoStack.push(cmd);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
      this.emit('change');
    }
    // Convenience for raster cel edits.
    pushCelEdit(label, cel, beforeCanvas) {
      const after = cel.snapshot();
      this.push({
        label,
        undo: () => cel.restore(beforeCanvas),
        redo: () => cel.restore(after)
      });
    }
    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    undo() {
      const c = this.undoStack.pop();
      if (!c) return;
      c.undo();
      this.redoStack.push(c);
      this.emit('change');
      this.emit('applied', { type: 'undo', cmd: c });
    }
    redo() {
      const c = this.redoStack.pop();
      if (!c) return;
      c.redo();
      this.undoStack.push(c);
      this.emit('change');
      this.emit('applied', { type: 'redo', cmd: c });
    }
    clear() { this.undoStack.length = 0; this.redoStack.length = 0; this.emit('change'); }
  }
  OT.History = History;

})(window.OT);
