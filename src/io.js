/* OpenToon Studio - project save/load + export */
(function (OT) {
  'use strict';
  const U = OT.util;

  const wait = ms => new Promise(r => setTimeout(r, ms || 0));

  /* ---------------- CRC32 + store-only ZIP ---------------- */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  class Zip {
    constructor() { this.files = []; }
    add(name, data) { this.files.push({ name, data }); }
    build() {
      const enc = new TextEncoder();
      const u16 = v => [v & 255, (v >> 8) & 255];
      const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
      const chunks = [], central = [];
      let offset = 0;
      for (const f of this.files) {
        const nb = enc.encode(f.name);
        const crc = crc32(f.data), size = f.data.length;
        const lh = new Uint8Array([].concat(
          u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
          u32(crc), u32(size), u32(size), u16(nb.length), u16(0)));
        chunks.push(lh, nb, f.data);
        central.push(new Uint8Array([].concat(
          u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
          u32(crc), u32(size), u32(size),
          u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), nb);
        offset += lh.length + nb.length + size;
      }
      let cdSize = 0;
      for (const c of central) cdSize += c.length;
      const end = new Uint8Array([].concat(
        u32(0x06054b50), u16(0), u16(0),
        u16(this.files.length), u16(this.files.length),
        u32(cdSize), u32(offset), u16(0)));
      return new Blob(chunks.concat(central, [end]), { type: 'application/zip' });
    }
  }

  /* ---------------- helpers ---------------- */
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('image load failed'));
      img.src = src;
    });
  }
  function dataURLtoBytes(dataURL) {
    const b = atob(dataURL.split(',')[1]);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function canvasToBlob(cv, type, q) {
    return new Promise(res => cv.toBlob(res, type || 'image/png', q));
  }

  /* ---------------- serialize / deserialize ---------------- */
  function serialize(app) {
    const p = app.project;
    return {
      format: 'otoon', version: 1,
      name: p.name, width: p.width, height: p.height,
      fps: p.fps, frameCount: p.frameCount, bg: p.bg,
      palette: app.palette.serialize(),
      camera: { keyframes: p.camera.keyframes.map(k => ({ ...k })) },
      audio: p.audio || null,
      layers: p.layers.map(l => {
        const cels = {};
        for (const num in l.cels) {
          const c = l.cels[num];
          cels[num] = (c.kind === 'vector')
            ? { k: 'v', strokes: c.strokes }
            : { k: 'r', png: c.toDataURL() };
        }
        return {
          id: l.id, name: l.name, type: l.type,
          visible: l.visible, locked: l.locked, opacity: l.opacity, color: l.color,
          exposure: l.exposure.slice(), nextNum: l.nextNum,
          transform: JSON.parse(JSON.stringify(l.transform || { keyframes: [] })),
          video: l.video || null,
          cels: cels
        };
      })
    };
  }

  async function deserialize(data) {
    const p = new OT.Project({
      name: data.name, width: data.width, height: data.height,
      fps: data.fps, frameCount: data.frameCount, bg: data.bg, empty: true
    });
    p.camera = data.camera || { keyframes: [] };
    p.audio = data.audio || null;
    for (const ld of data.layers || []) {
      const layer = new OT.Layer(ld.name, ld.type);
      layer.id = ld.id || layer.id;
      layer.visible = ld.visible !== false;
      layer.locked = !!ld.locked;
      layer.opacity = ld.opacity == null ? 1 : ld.opacity;
      layer.color = ld.color || '#3d9be0';
      layer.exposure = (ld.exposure || []).slice();
      layer.nextNum = ld.nextNum || 1;
      layer.transform = ld.transform && ld.transform.keyframes ? ld.transform : { keyframes: [] };
      if (ld.video) layer.video = ld.video;
      const isVec = ld.type === 'vector';
      for (const num in (ld.cels || {})) {
        const cd = ld.cels[num];
        const cel = new OT.Cel(Number(num), p.width, p.height, isVec ? 'vector' : 'raster');
        try {
          if (typeof cd === 'string') {
            const img = await loadImage(cd);          // legacy raster format
            cel.ctx.drawImage(img, 0, 0);
          } else if (cd.k === 'v') {
            cel.strokes = cd.strokes || [];
            cel.rebuild();
          } else {
            const img = await loadImage(cd.png);
            if (img.width !== cel.w || img.height !== cel.h) {
              cel.w = img.width; cel.h = img.height;
              cel.canvas.width = img.width; cel.canvas.height = img.height;
            }
            cel.ctx.drawImage(img, 0, 0);
          }
        } catch (e) { /* skip broken cel */ }
        cel.dirty();
        layer.cels[num] = cel;
      }
      p.layers.push(layer);
    }
    if (!p.layers.length) p.layers.push(new OT.Layer('Drawing 1'));
    return { project: p, palette: data.palette };
  }

  /* ---------------- frame rendering (camera-aware) ---------------- */
  function renderFrame(app, frame, outW, outH) {
    const p = app.project;
    const cam = p.cameraAt(frame);
    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = outH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, outW, outH);
    const cx = p.width / 2 + cam.x, cy = p.height / 2 + cam.y;
    const viewW = p.width / cam.zoom, viewH = p.height / cam.zoom;
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(-cam.rot * Math.PI / 180);
    ctx.scale(outW / viewW, outH / viewH);
    ctx.translate(-cx, -cy);
    ctx.imageSmoothingEnabled = true;
    app.stage.compositeStage(frame, ctx, { bg: false });
    ctx.restore();
    return cv;
  }

  /* ---------------- export ---------------- */
  const Export = {
    renderFrame,
    async sequence(app, opts, onProgress) {
      const zip = new Zip();
      const { outW, outH, from, to } = opts;
      for (let f = from; f <= to; f++) {
        await app.seekVideosTo(f);
        const cv = renderFrame(app, f, outW, outH);
        const blob = await canvasToBlob(cv, 'image/png');
        const buf = new Uint8Array(await blob.arrayBuffer());
        zip.add('frame_' + U.pad(f + 1, 4) + '.png', buf);
        if (onProgress) onProgress((f - from + 1) / (to - from + 1), 'Frame ' + (f + 1));
        await wait(0);
      }
      return zip.build();
    },
    async gif(app, opts, onProgress) {
      const { outW, outH, from, to } = opts;
      const enc = new OT.GIFEncoder(outW, outH, {
        delay: 1000 / app.project.fps, repeat: 0
      });
      for (let f = from; f <= to; f++) {
        await app.seekVideosTo(f);
        const cv = renderFrame(app, f, outW, outH);
        const id = cv.getContext('2d').getImageData(0, 0, outW, outH);
        enc.addFrame(id);
        if (onProgress) onProgress((f - from + 1) / (to - from + 1), 'Encoding frame ' + (f + 1));
        await wait(0);
      }
      return enc.finish();
    },
    async webm(app, opts, onProgress) {
      const { outW, outH, from, to } = opts;
      const fps = app.project.fps;
      const cv = document.createElement('canvas');
      cv.width = outW; cv.height = outH;
      const ctx = cv.getContext('2d');
      const stream = cv.captureStream(0);
      const track = stream.getVideoTracks()[0];
      let mime = 'video/webm;codecs=vp9';
      if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const done = new Promise(r => { rec.onstop = r; });
      rec.start();
      const dur = 1000 / fps;
      for (let f = from; f <= to; f++) {
        await app.seekVideosTo(f);
        const fr = renderFrame(app, f, outW, outH);
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(fr, 0, 0);
        if (track.requestFrame) track.requestFrame();
        else if (cv.requestFrame) cv.requestFrame();
        if (onProgress) onProgress((f - from + 1) / (to - from + 1), 'Recording frame ' + (f + 1));
        await wait(dur);
      }
      await wait(250);
      rec.stop();
      await done;
      return new Blob(chunks, { type: 'video/webm' });
    }
  };

  /* ---------------- autosave (localStorage) ---------------- */
  const AUTO_KEY = 'opentoon.autosave';
  const IO = {
    serialize, deserialize, renderFrame, Export, loadImage,

    saveProject(app) {
      const data = serialize(app);
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const name = (app.project.name || 'untitled').replace(/[^\w\-]+/g, '_');
      U.download(name + '.otoon', blob);
      app.dirty = false;
    },
    openProjectFile(app, file) {
      return file.text().then(txt => {
        const data = JSON.parse(txt);
        if (data.format !== 'otoon') throw new Error('Not an OpenToon project');
        return deserialize(data);
      });
    },
    autosave(app) {
      try {
        localStorage.setItem(AUTO_KEY, JSON.stringify(serialize(app)));
        localStorage.setItem(AUTO_KEY + '.time', Date.now().toString());
        return true;
      } catch (e) { return false; }
    },
    hasAutosave() { return !!localStorage.getItem(AUTO_KEY); },
    autosaveTime() {
      const t = localStorage.getItem(AUTO_KEY + '.time');
      return t ? new Date(Number(t)) : null;
    },
    loadAutosave() {
      const raw = localStorage.getItem(AUTO_KEY);
      if (!raw) return Promise.reject(new Error('no autosave'));
      return deserialize(JSON.parse(raw));
    },
    clearAutosave() {
      localStorage.removeItem(AUTO_KEY);
      localStorage.removeItem(AUTO_KEY + '.time');
    },

    async importImageAsLayer(app, file) {
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const layer = new OT.Layer(file.name.replace(/\.[^.]+$/, ''));
        const cel = layer.drawingAt(app.frame, app.project.width, app.project.height);
        // fit image centered
        const s = Math.min(app.project.width / img.width, app.project.height / img.height);
        const w = img.width * s, h = img.height * s;
        cel.ctx.drawImage(img, (app.project.width - w) / 2, (app.project.height - h) / 2, w, h);
        cel.dirty();
        app.project.addLayer(layer);
        app.selectLayer(layer);
        app.history.clear();
        app.emit('layerschange'); app.emit('render');
        app.ui.status('Imported ' + file.name);
      } finally { URL.revokeObjectURL(url); }
    }
  };

  OT.IO = IO;
  OT.Zip = Zip;
})(window.OT);
