# Pen Window Slave Renderer — Phase D1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pen window becomes a full slave renderer for vector content — shared `compositeStage`, local wet ink with predicted touches, atomic commit-by-UUID. Eliminates Phase 2's WebP bg plate and live-shim.

**Architecture:** Extract `compositeStage` from `canvas.js` into a shared `OT.compositeStage` module. Pen mirrors `OT.Layer`/`OT.Cel` instances (via already-loaded `core.js`), runs the shared `compositeStage` itself, and draws a local `wetStroke` on top using `OT.Vector.renderStroke`. Pointer-down generates a client-side UUID; main commits with the same id; pen drops `wetStroke` only when a `vector-cel-replace` arrives containing a stroke with the matching id.

**Tech Stack:** Electron multi-window IPC (`opentoon:pen-state` channel only — no `pen-frame` in D1), Canvas 2D, Chromium `PointerEvent.getCoalescedEvents()` / `getPredictedEvents()`, vanilla JS modules attached to `window.OT`.

**Out of scope for this plan:** D2 (raster cel transport), D3 (tool overlay state for lasso/transform/shapes), D4 (port smoothing pipeline to eliminate settle), D5 (onion skin + video layers). Raster active layers render as an empty placeholder in D1.

**Spec:** `docs/superpowers/specs/2026-05-22-pen-window-local-wet-ink-design.md`

---

## File map

**Created:**
- `src/composite.js` — pure `OT.compositeStage(project, frame, ctx, opts, helpers)` lifted from `canvas.js`. Loaded before `canvas.js` and `pencast.js` in `index.html`; also loaded by `pen/pen.html`.

**Modified:**
- `src/canvas.js` — `Stage.compositeStage` becomes a thin wrapper that calls `OT.compositeStage`. Remove the `opts.excludeLayerId` branch (no longer needed).
- `src/pencast.js` — full rewrite for D1 (much smaller — no WebP encoder, no live-shim, single state channel).
- `src/tools.js` — remove the `publishStrokeChange` helper definition and its 8 call sites. Add a `pendingStrokeId` field on the brush + pencil tools so pen-originated strokes get the UUID supplied via `pen-input`.
- `pen/pen.js` — full rewrite for D1 (full slave renderer, real `OT.Layer` instances, wet stroke with predicted touches).
- `pen/pen.html` — confirm load order: `core.js`, `vector.js`, `composite.js`, `pen.js`.
- `index.html` — add `<script src="src/composite.js"></script>` before `canvas.js`.
- `electron/preload.js` — remove `sendPenFrame` / `onFrame` (D1 doesn't need them; D2 will reintroduce via `MessagePortMain` channel).
- `electron/pen-preload.js` — remove `onFrame`.
- `electron/main.js` — remove the `opentoon:pen-frame` relay; **keep** `backgroundThrottling: false` on both windows, `did-finish-load` reattach, pen dev-tools opener, and `watchForDev` for `pen/` (these are good regardless of architecture).

**Untouched:**
- `src/core.js` — `Layer`/`Cel` already complete and reusable on pen.
- `src/main.js` — `app.layerAncestors` stays (we'll port a copy to pen).
- `splash/splash.html`, `src/launcher.js` — unrelated dirty changes, leave alone.

---

## Pre-flight: cleaning the working tree

The disk currently contains a large Phase 2 implementation that this plan supersedes. Before starting Task 1, normalize the working tree:

- [ ] **Step P.1: Snapshot the current state on a backup branch**

```bash
cd /c/Users/harry/Documents/Projects/opentoon
git checkout -b phase-2-attic
git add -A src/ pen/ electron/
git stash push -m "phase-2 work-in-progress (preserved on phase-2-attic for reference)" -- src/ pen/ electron/
git checkout main
```

This keeps the Phase 2 dirty diffs as a stashed reference under a side branch you can `git stash show -p` if you want to copy any code. **Do not delete this stash until the plan is complete.**

- [ ] **Step P.2: Re-apply the parts of Phase 2 that are still wanted in D1**

Three Electron preload changes ARE wanted in D1 (state channel + dev helpers). Cherry-pick them by hand from the stash:

Get the diff to read from:

```bash
git stash show -p stash@{0} -- electron/main.js electron/preload.js electron/pen-preload.js > /tmp/phase2-electron.patch
```

Edit each of the three files to add only these changes:

`electron/preload.js` — add inside the `contextBridge.exposeInMainWorld('OpenToonDesktop', { ... })` object:

```js
// STATE CHANNEL for the pen window
sendPenState: msg => ipcRenderer.send('opentoon:pen-state', msg),
onPenStateAck: cb => ipcRenderer.on('opentoon:pen-state-ack', (_e, seq) => cb(seq)),
```

DO NOT add `sendPenFrame` or `onFrame` — D1 doesn't need them.

`electron/pen-preload.js` — add inside the `contextBridge.exposeInMainWorld('OpenToonPen', { ... })` object:

```js
// STATE CHANNEL
onState: cb => ipcRenderer.on('opentoon:pen-state', (_e, msg) => cb(msg)),
sendStateAck: seq => ipcRenderer.send('opentoon:pen-state-ack', seq),
```

DO NOT add `onFrame`.

`electron/main.js` — keep four Phase 2 changes:

1. `webPreferences.backgroundThrottling: false` on **both** main window and pen window
2. `webContents.on('did-finish-load', ...)` re-fires `pen-attach` to the (just-reloaded) main window if a pen window exists
3. Pen window dev-tools auto-open in dev mode: `if (isDev) penWin.webContents.openDevTools({ mode: 'detach' })`
4. `watchForDev` (or equivalent file-watcher) watches the `pen/` directory and reloads the pen window
5. **State channel relay**: forward `opentoon:pen-state` from main → pen, and `opentoon:pen-state-ack` from pen → main

DO NOT keep the `opentoon:pen-frame` relay or the `sendPenFrame` plumbing.

- [ ] **Step P.3: Verify clean baseline for the source files we're about to write**

Make sure these are at clean main state (no Phase 2 diffs leaking in):

```bash
git status --short src/canvas.js src/pencast.js src/tools.js pen/pen.js pen/pen.html
```

Expected: empty (all four files at HEAD). If any show as modified, that's leftover stash — `git checkout HEAD -- <path>` to clear.

- [ ] **Step P.4: Commit the pre-flight state**

```bash
git add electron/
git commit -m "feat(pen): keep Phase 2 electron wiring for state channel + dev helpers

Pre-flight for the D1 slave-renderer migration. Drops the pen-frame
bitmap relay; keeps the state channel and backgroundThrottling:false
on both windows."
```

---

## Task 1: Extract `compositeStage` into a shared pure function

**Files:**
- Create: `src/composite.js`
- Modify: `src/canvas.js:184-255` (function body becomes a delegation; remove `excludeLayerId` branch)
- Modify: `index.html` (load `composite.js` before `canvas.js`)

- [ ] **Step 1.1: Create the new shared module**

Create `C:\Users\harry\Documents\Projects\opentoon\src\composite.js`:

```js
/* OpenToon Studio - shared stage compositing.

   Pure function used by both the main canvas (Stage.compositeStage) and
   the pen-window slave renderer. Inputs are explicit -- no `this`, no DOM,
   no event bus -- so the SAME compositor runs in both windows. That kills
   any risk of the two renderers drifting apart visually. */
(function (OT) {
  'use strict';

  // Draw bg + all visible layers at `frame` into ctx (already in project
  // coords). Inputs:
  //   project    - { width, height, bg, layers: OT.Layer[] }
  //   frame      - integer frame index
  //   ctx        - 2D context
  //   opts       - { bg?: bool default true,
  //                  useRaster?: bool,
  //                  wetStroke?: stroke object,
  //                  wetLayerId?: string,
  //                  skipVideo?: bool default false,
  //                  skipLassoHidden?: bool default false }
  //   helpers    - { layerAncestors: layer => Layer[] }
  function compositeStage(project, frame, ctx, opts, helpers) {
    opts = opts || {};
    helpers = helpers || {};
    const layerAncestors = helpers.layerAncestors || (() => []);
    const wetStroke = opts.wetStroke;
    const wetLayerId = opts.wetLayerId;

    if (opts.bg !== false) {
      ctx.fillStyle = project.bg;
      ctx.fillRect(0, 0, project.width, project.height);
    }
    const worldOpacity = (layer) => {
      let op = layer.opacity == null ? 1 : layer.opacity;
      for (const a of layerAncestors(layer)) op *= (a.opacity == null ? 1 : a.opacity);
      return op;
    };
    const ancestorVisible = (layer) => {
      for (const a of layerAncestors(layer)) if (!a.visible) return false;
      return true;
    };

    for (const layer of project.layers) {
      if (layer.type === 'group') continue;
      if (!layer.visible) continue;
      if (!ancestorVisible(layer)) continue;
      if (layer.type === 'video') {
        if (opts.skipVideo) continue;
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

      if (cel.kind === 'vector' && cel.strokes && OT.Vector
          && !opts.useRaster && !cel._liveDrawing) {
        const V = OT.Vector;
        const skipHidden = opts.skipLassoHidden;
        // fills first, then lines (matches the historical draw order)
        for (const st of cel.strokes)
          if (st.type === 'fill' && (!skipHidden || !st._lassoHidden))
            V.renderStroke(ctx, st);
        for (const st of cel.strokes)
          if (st.type !== 'fill' && (!skipHidden || !st._lassoHidden))
            V.renderStroke(ctx, st);
        // wet stroke renders on top of committed strokes for the active layer
        if (isActive && wetStroke) {
          V.renderStroke(ctx, wetStroke);
        }
      } else if (cel.canvas) {
        ctx.drawImage(cel.canvas, 0, 0, project.width, project.height);
        // raster active layer doesn't get a wet stroke in D1 (D2)
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

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
```

- [ ] **Step 1.2: Add `<script>` tag in `index.html` to load composite.js**

Find the line that loads `src/canvas.js`. Add this line immediately above it:

```html
<script src="src/composite.js"></script>
```

- [ ] **Step 1.3: Refactor `Stage.compositeStage` to delegate**

Open `src/canvas.js`. Replace the entire body of the `compositeStage(frame, ctx, opts)` method (currently `canvas.js:184-255`) with:

```js
    compositeStage(frame, ctx, opts) {
      OT.compositeStage(this.app.project, frame, ctx, opts, {
        layerAncestors: layer => this.app.layerAncestors
          ? this.app.layerAncestors(layer) : []
      });
    }
```

Also DELETE the `_applyWorldXform` method (currently `canvas.js:265-282`) — it's now inside `composite.js`. The `_layerXform(ctx, layer, frame)` method (`canvas.js:256-261`) used by onion skin should be updated to delegate too:

```js
    _layerXform(ctx, layer, frame) {
      OT.applyWorldXform(ctx, layer, frame, this.app.project,
        l => this.app.layerAncestors ? this.app.layerAncestors(l) : []);
    }
```

- [ ] **Step 1.4: Smoke test — launch the app, draw on the main canvas**

Run `npm run dev`. Draw a few strokes on a vector layer in the main canvas. Toggle layer visibility. Switch frames. Confirm the canvas still renders identically to before the refactor.

If anything looks wrong: the `excludeLayerId` branch was deliberately not ported (no D1 caller needs it). Search the codebase for `excludeLayerId` — if there's a non-pencast caller, port it back; otherwise leave it out.

- [ ] **Step 1.5: Commit**

```bash
git add src/composite.js src/canvas.js index.html
git commit -m "refactor: extract compositeStage into shared OT.compositeStage

Pure function used by main canvas and (soon) pen window so both
renderers run identical code."
```

---

## Task 2: Strip Phase 2 from `pencast.js` (clean slate for D1)

**Files:**
- Modify: `src/pencast.js` (full rewrite, ~250 lines down from ~989)

- [ ] **Step 2.1: Replace `src/pencast.js` entirely with the D1 publisher skeleton**

Overwrite `src/pencast.js` with:

```js
/* OpenToon Studio - PenCast: drive the canvas from a second "pen display"
   window.

   D1 architecture (slave-renderer): the pen window holds a real mirror of
   the project (OT.Layer / OT.Cel instances) and runs OT.compositeStage
   itself. We publish small JSON ops over `opentoon:pen-state`; no bitmap
   channel exists. */
(function (OT) {
  'use strict';
  const U = OT.util;

  function serializeStroke(st) {
    const out = { id: st.id, type: st.type };
    if (st.pts) out.pts = st.pts.slice();
    if (st.contour) out.contour = st.contour.slice();
    if (st.color != null) out.color = st.color;
    if (st.width != null) out.width = st.width;
    if (st.opacity != null) out.opacity = st.opacity;
    if (st.pencil) out.pencil = true;
    if (st.sharp) out.sharp = true;
    if (st.closed) out.closed = true;
    if (st.taper != null) out.taper = st.taper;
    if (st.grow != null) out.grow = st.grow;
    return out;
  }
  OT._serializeStroke = serializeStroke;

  function snapshotLayer(l) {
    return {
      id: l.id, name: l.name, type: l.type,
      visible: !!l.visible,
      opacity: l.opacity == null ? 1 : l.opacity,
      color: l.color || '',
      parentId: l.parentId || null,
      transform: {
        keyframes: (l.transform && l.transform.keyframes)
          ? l.transform.keyframes.slice() : []
      },
      shadeOf: l.shadeOf || null,
      _collapsed: !!l._collapsed,
      // exposure: needed so pen's Layer.celAt(frame) works
      exposure: (l.exposure || []).slice()
    };
  }

  function snapshotCelForLayer(layer, frame) {
    const cel = layer.celAt ? layer.celAt(frame) : null;
    if (!cel) return null;
    if (cel.kind === 'vector') {
      return {
        celNum: layer.celNumAt(frame),
        kind: 'vector',
        w: cel.w, h: cel.h,
        strokes: (cel.strokes || []).map(serializeStroke)
      };
    }
    // raster cels are placeholder in D1 (D2 sends pixel data)
    return { celNum: layer.celNumAt(frame), kind: 'raster', w: cel.w, h: cel.h };
  }

  class PenCast {
    constructor(app) {
      this.app = app;
      this.active = false;
      this.bridge = window.OpenToonDesktop || null;
      this._stateSeq = 0;
      this._pendingOps = [];
      this._lastAckSeq = 0;
      this._raf = 0;
      this._overlayLastPump = 0;
      this._pendingStrokeId = null;   // UUID supplied by the pen on 'down'
      if (!this.bridge || !this.bridge.sendPenState) return;
      this.bridge.onPenAttach(() => this._attach());
      this.bridge.onPenDetach(() => this._detach());
      this.bridge.onPenInput(msg => { try { this._onInput(msg); } catch (e) { console.error(e); } });
      this.bridge.onPenCommand(msg => { try { this._onCommand(msg); } catch (e) { console.error(e); } });
      if (this.bridge.onPenStateAck)
        this.bridge.onPenStateAck(seq => { this._lastAckSeq = seq | 0; });

      app.on('render', () => {
        // no-op in D1: there is no bitmap to re-encode; the pen pulls
        // changes via cel/layer/transform events below.
      });
      app.on('overlayrender', () => {
        if (!this.active) return;
        const now = performance.now();
        if (now - this._overlayLastPump < 33) return;
        this._overlayLastPump = now;
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
      app.on('framechange', () => {
        if (!this.active) return;
        this._publish({ op: 'frame-change', frame: app.frame });
        this._publishCelsForFrame();
        this._schedule();
      });
      app.on('layerselect', () => {
        if (!this.active) return;
        const al = app.activeLayer && app.activeLayer();
        this._publish({ op: 'active-layer', layerId: al ? al.id : null });
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
      app.on('layerschange', () => {
        if (!this.active) return;
        // Phase D1 simplification: ship the full layers snapshot. The pen
        // diffs locally. Layer count is small (typically <20); this is
        // cheaper than maintaining a diff cache here.
        this._publish({
          op: 'layers-replace',
          layers: (app.project.layers || []).map(snapshotLayer),
          activeLayerId: app.activeLayer && app.activeLayer() ? app.activeLayer().id : null
        });
        this._publishCelsForFrame();
        this._schedule();
      });
      app.on('celchange', () => {
        if (!this.active) return;
        // active layer cel changed -- publish the new cel content
        const al = app.activeLayer && app.activeLayer();
        if (!al) return;
        const cel = snapshotCelForLayer(al, app.frame);
        this._publish({
          op: 'vector-cel-replace',
          layerId: al.id,
          frame: app.frame,
          cel: cel
        });
        this._schedule();
      });
      app.on('projectchange', () => {
        if (!this.active) return;
        const p = app.project;
        this._publish({
          op: 'project-meta',
          patch: { width: p.width, height: p.height, bg: p.bg, fps: p.fps, frameCount: p.frameCount }
        });
        this._schedule();
      });
      app.on('palettechange', () => {
        if (!this.active) return;
        this._publish({ op: 'palette', colors: this._paletteColors() });
        this._schedule();
      });
      app.on('colorchange', () => {
        if (!this.active) return;
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
      app.on('toolchange', () => {
        if (!this.active) return;
        this._publish({ op: 'tool-meta', meta: this._meta() });
        this._schedule();
      });
    }

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
      this._stateSeq = 0;
      this._pendingOps = [];
      this._publishInit();
      this._schedule();
    }
    _detach() {
      this.active = false;
      this._pendingStrokeId = null;
      this.app.ui.status('Drawing window closed');
    }

    _paletteColors() {
      const p = this.app.palette;
      if (!p) return [];
      if (Array.isArray(p.colors)) return p.colors.slice();
      if (p.swatches) return p.swatches.map(s => s.color);
      return [];
    }

    _publish(op) {
      if (!this.active || !this.bridge || !this.bridge.sendPenState) return;
      this._pendingOps.push(op);
    }
    _schedule() {
      if (!this.active) return;
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._flushStateBatch('patch');
      });
    }
    _flushStateBatch(kind) {
      if (!this.bridge || !this.bridge.sendPenState) {
        this._pendingOps.length = 0;
        return;
      }
      if (!this._pendingOps.length) return;
      const ops = this._pendingOps.splice(0);
      const seq = ++this._stateSeq;
      try {
        this.bridge.sendPenState({ seq, kind: kind || 'patch', ops });
      } catch (e) { console.error('pen-state send failed', e); }
    }

    _publishInit() {
      const a = this.app, p = a.project;
      if (!p) return;
      const layers = (p.layers || []).map(snapshotLayer);
      const activeLayer = a.activeLayer && a.activeLayer();
      const cels = {};
      for (const layer of (p.layers || [])) {
        const snap = snapshotCelForLayer(layer, a.frame);
        if (snap) cels[layer.id] = snap;
      }
      this._pendingOps.unshift({
        op: 'init',
        project: { width: p.width, height: p.height, bg: p.bg, fps: p.fps, frameCount: p.frameCount },
        palette: this._paletteColors(),
        layers,
        activeLayerId: activeLayer ? activeLayer.id : null,
        frame: a.frame,
        cels,
        toolMeta: this._meta()
      });
      this._flushStateBatch('snapshot');
    }

    _publishCelsForFrame() {
      const a = this.app, p = a.project;
      if (!p) return;
      for (const layer of (p.layers || [])) {
        const cel = snapshotCelForLayer(layer, a.frame);
        if (cel) this._publish({
          op: 'vector-cel-replace', layerId: layer.id, frame: a.frame, cel
        });
      }
    }

    _meta() {
      const a = this.app, st = a.stage, t = a.tools.active;
      const rad = (t && t.cursorRadius ? (t.cursorRadius(a) || 0) : 0) * st.view.zoom;
      // selection HUD + transform-armed flags
      let selName = '', selCount = 0, selIsGroup = false, selHasXform = false, selColor = '';
      const sel = a.selectedLayers;
      const setIds = sel && sel.size ? new Set(Array.from(sel).map(l => l.id)) : new Set();
      let targets = [];
      if (sel && sel.size > 1) {
        targets = a.project.layers.filter(l => sel.has(l) && !setIds.has(l.parentId));
      } else if (a.activeLayer && a.activeLayer()) {
        targets = [a.activeLayer()];
      }
      if (targets.length === 1) {
        selName = targets[0].name || '';
        selIsGroup = targets[0].type === 'group';
        selColor = targets[0].color || '';
      } else if (targets.length > 1) selColor = targets[0].color || '';
      const selColors = targets.slice(0, 3).map(t => t.color || '#3d9be0');
      selCount = targets.length;
      selHasXform = targets.some(t => t.transform && t.transform.keyframes && t.transform.keyframes.length);
      const lasso = a.tools && a.tools.tools && a.tools.tools.lasso;
      let xfArmed = false, xfMode = '', xfIsRaster = false;
      if (lasso) {
        if (lasso.vt) { xfArmed = true; xfIsRaster = false; xfMode = lasso.transformMode || 'uniform'; }
        else if (lasso.raster) { xfArmed = true; xfIsRaster = true; xfMode = lasso.transformMode || 'uniform'; }
      }
      // active-layer kind: vector / drawing(raster) / group / video
      const al = a.activeLayer && a.activeLayer();
      const activeLayerKind = al ? al.type : null;
      return {
        tool: t ? t.name : 'brush',
        color: a.color,
        toolSize: t && t.size != null ? t.size : (a.settings.brushSize || 6),
        toolOpacity: t && t.opacity != null ? t.opacity : 1,
        pencil: t ? t.name === 'pencil' : false,
        brushFrac: st.cw ? rad / st.cw : 0.02,
        frame: a.frame + 1,
        frameCount: a.project.frameCount,
        zoom: Math.round(st.view.zoom * 100),
        activeLayerKind,
        sel: { name: selName, count: selCount, group: selIsGroup, hasXform: selHasXform, color: selColor, colors: selColors },
        transform: { armed: xfArmed, mode: xfMode, isRaster: xfIsRaster }
      };
    }

    /* ----- pen -> main : pointer input ----- */
    // The pen ships normalized 0..1 fractions over the *project rect*.
    // (Pen knows the project size via its mirror, computes nx/ny from
    // local fit + view; same math regardless of pen-window zoom.)
    _ptFromNorm(nx, ny, pressure, msg) {
      const a = this.app, st = a.stage, p = a.project;
      const pt = { x: nx * p.width, y: ny * p.height };
      pt.pressure = msg && msg.isPen
        ? a.mapPressure(pressure == null ? 0.5 : pressure) : 1;
      pt.shift = !!(msg && msg.shift);
      pt.alt = !!(msg && msg.alt);
      pt.ctrl = false;
      const r = st.canvas.getBoundingClientRect();
      const sc = st.projectToScreen(pt.x, pt.y);
      pt.sx = r.left + sc.x;
      pt.sy = r.top + sc.y;
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
        // Stash the pen-supplied UUID so the brush/pencil tool's stroke
        // commit picks it up instead of generating its own.
        this._pendingStrokeId = msg.id || null;
        if (tools.active) tools.active.pendingStrokeId = this._pendingStrokeId;
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
        // pointerUp may have committed a stroke -- celchange already fired.
        // Clear the pending id so the NEXT stroke from a non-pen source
        // doesn't accidentally inherit it.
        this._pendingStrokeId = null;
        if (tools.active) tools.active.pendingStrokeId = null;
      } else if (msg.type === 'cancel') {
        if (tools.active && tools.active.cancel) tools.active.cancel(this.app);
        this._pendingStrokeId = null;
        if (tools.active) tools.active.pendingStrokeId = null;
      } else if (msg.type === 'hover') {
        st.cursorPt = this._ptFromNorm(msg.nx, msg.ny, 1, msg);
        st.renderOverlay();
      } else if (msg.type === 'leave') {
        st.cursorPt = null;
        st.renderOverlay();
      }
    }

    /* ----- pen -> main : toolbar commands ----- */
    _onCommand(msg) {
      if (!msg) return;
      const a = this.app, U = OT.util;
      switch (msg.type) {
        case 'tool':       if (a.tools.tools[msg.tool]) a.tools.select(msg.tool); break;
        case 'color':      if (msg.color) a.setColor(msg.color); break;
        case 'undo':       a.undo(); break;
        case 'redo':       a.redo(); break;
        case 'newdraw':    a.newDrawing(); break;
        case 'frame':      a.playback.step(msg.dir > 0 ? 1 : -1); break;
        case 'fit':        a.stage.fitToCamera(); break;
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
          if (msg.absolute && msg.absolute > 0) {
            const sx = r.left + st.cw / 2, sy = r.top + st.ch / 2;
            const factor = msg.absolute / (st.view.zoom || 1);
            st.zoomAt(sx, sy, factor);
          } else {
            st.zoomAt(r.left + (msg.nx || 0.5) * st.cw,
              r.top + (msg.ny || 0.5) * st.ch, msg.factor || 1);
          }
          break;
        }
        case 'pan': { const st = a.stage; st.panBy((msg.dnx || 0) * st.cw, (msg.dny || 0) * st.ch); break; }
        case 'flip':              a.toggleFlipH(); break;
        case 'free-transform':    if (typeof a.freeTransform === 'function') a.freeTransform(); break;
        case 'reset-transform': {
          const sel = a.selectedLayers;
          const setIds = sel && sel.size ? new Set(Array.from(sel).map(l => l.id)) : new Set();
          let targets = [];
          if (sel && sel.size > 1) {
            targets = a.project.layers.filter(l => sel.has(l) && !setIds.has(l.parentId));
          } else if (a.activeLayer && a.activeLayer()) {
            targets = [a.activeLayer()];
          }
          const dirty = targets.filter(t => t.transform && t.transform.keyframes && t.transform.keyframes.length);
          if (!dirty.length) { a.ui.status('No transform to reset'); break; }
          a.doStruct(dirty.length > 1 ? 'Reset transforms' : 'Reset transform', () => {
            for (const t of dirty) t.transform.keyframes = [];
          });
          a.emit('layerschange'); a.emit('render');
          break;
        }
        case 'lasso-mode':
          if (a.tools && a.tools.tools && a.tools.tools.lasso
              && a.tools.tools.lasso.handleToolbarMode) {
            a.tools.tools.lasso.handleToolbarMode(msg.mode, a);
          }
          break;
        case 'pen-size':
          // D1 doesn't ship pixels to the pen, but we record the value in
          // case D2's raster transport wants it.
          this.penSize = {
            cssW: Math.max(1, msg.cssW | 0),
            cssH: Math.max(1, msg.cssH | 0),
            dpr: Math.max(1, Math.min(3, msg.dpr || 1))
          };
          break;
      }
    }
  }

  OT.PenCast = PenCast;
})(window.OT);
```

- [ ] **Step 2.2: Commit**

```bash
git add src/pencast.js
git commit -m "feat(pen): rewrite pencast as D1 state-channel publisher

Drops WebP encoder, live-shim, layer-diff cache, excludeLayerId
plumbing. State-only channel; cels published as snapshots on
celchange / framechange / layerschange / init."
```

---

## Task 3: Remove `publishStrokeChange` from `tools.js`; thread UUID through brush/pencil

**Files:**
- Modify: `src/tools.js`

- [ ] **Step 3.1: Delete the `publishStrokeChange` helper**

Open `src/tools.js`. Find this function around line 68:

```js
function publishStrokeChange(app, layer, cel) {
  // ... existing body ...
}
```

DELETE the entire function.

- [ ] **Step 3.2: Delete all 8 call sites**

Search the file for `publishStrokeChange(`. Delete each call (it'll be a single line each). They are at approximately these lines:

```
850  publishStrokeChange(app, this.t && this.t.layer, cel);
1030 publishStrokeChange(pending.app, this.t && this.t.layer, pending.cel);
1281 publishStrokeChange(app, this.t && this.t.layer, cel);
1492 publishStrokeChange(app, app.activeLayer && app.activeLayer(), cel);
1715 publishStrokeChange(app, app.activeLayer && app.activeLayer(), cel);
1931 publishStrokeChange(app, app.activeLayer && app.activeLayer(), this.vcel);
3205 publishStrokeChange(app, app.activeLayer && app.activeLayer(), c.cel);
3233 publishStrokeChange(app, app.activeLayer && app.activeLayer(), this.vcel);
```

The replacement is the `celchange` event — already emitted alongside each of these by the same code blocks. Pencast listens to that event now.

After deleting, run a `grep -n "publishStrokeChange" src/tools.js` — expected output: empty.

- [ ] **Step 3.3: Thread `pendingStrokeId` through brush stroke commit**

Open `src/tools.js`. Find the brush's stroke commit (around line 823):

```js
      const stroke = snapped ? {
        id: U.uid(), type: 'line', pencil: false, sharp: true, taper: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: closed
      } : {
        id: U.uid(), type: 'line', pencil: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: closed
      };
```

Replace `id: U.uid()` (both occurrences) with `id: this.pendingStrokeId || U.uid()`. Immediately after the stroke object is constructed, add a line clearing the pending id so it isn't reused on a subsequent stroke that didn't come from the pen:

```js
      // pendingStrokeId comes from a pen-window 'down' message; honour it
      // so the committed stroke matches the wet stroke the pen is showing.
      const stroke = snapped ? {
        id: this.pendingStrokeId || U.uid(), type: 'line', pencil: false, sharp: true, taper: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: closed
      } : {
        id: this.pendingStrokeId || U.uid(), type: 'line', pencil: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: closed
      };
      this.pendingStrokeId = null;
```

- [ ] **Step 3.4: Do the same for the pencil tool**

Find the pencil tool's stroke commit (around line 1265):

```js
        cel.strokes.push(stroke);
        if (app.symmetry && app.symmetry.on) {
          cel.strokes.push(V().mirrorStroke(stroke, app.symmetry.axis,
```

Scroll up ~20 lines to find where `stroke` is constructed (look for the second `id: U.uid()` after line 1100). Apply the same replacement: `id: this.pendingStrokeId || U.uid()`, followed by `this.pendingStrokeId = null;`.

- [ ] **Step 3.5: Smoke test — main canvas drawing still works**

Run `npm run dev`. Draw a brush stroke and a pencil stroke on a vector layer in the **main canvas** (not pen). They should commit normally. Open DevTools, inspect the resulting `cel.strokes` array — each stroke should have an `id` field (generated by `U.uid()` since `pendingStrokeId` was null).

- [ ] **Step 3.6: Commit**

```bash
git add src/tools.js
git commit -m "refactor(tools): drop publishStrokeChange; honour pendingStrokeId

publishStrokeChange's 8 call sites all sit next to a celchange emit,
which pencast now listens to directly. The pendingStrokeId field
lets the pen window supply a UUID so the committed stroke matches
the wet stroke pen is rendering locally."
```

---

## Task 4: Rewrite `pen/pen.js` as the D1 slave renderer

**Files:**
- Modify: `pen/pen.js` (full rewrite, ~500 lines down from ~1000)
- Modify: `pen/pen.html` (verify load order)

- [ ] **Step 4.1: Verify `pen/pen.html` script load order**

Open `pen/pen.html`. Ensure the script tags load in this order, **before** `pen.js`:

```html
<script src="../src/util.js"></script>
<script src="../src/core.js"></script>
<script src="../src/vector.js"></script>
<script src="../src/composite.js"></script>
<script src="pen.js"></script>
```

(`util.js` is a prerequisite of `core.js`. Check if your tree calls it something else; load whatever `core.js` needs.) Adjust paths if `pen.html` is at `pen/pen.html` and `src/` is one level up (`../src/`).

- [ ] **Step 4.2: Replace `pen/pen.js` entirely with the D1 slave renderer**

Overwrite `pen/pen.js` with:

```js
/* OpenToon Studio - pen-display window (D1 slave renderer).

   The pen window holds a real mirror of the project (OT.Layer / OT.Cel
   from core.js) and runs OT.compositeStage itself. The artist's wet
   stroke is drawn locally from pointer events; the committed stroke
   arrives via vector-cel-replace and is matched by UUID. */
(function () {
  'use strict';
  const PEN = window.OpenToonPen || null;
  const OT = window.OT;

  const TOOL_ICON = {
    select: '<path d="M5 3l15 8-7 1.6L11 20z"/>',
    brush: '<path d="M4 21c3.2 0 5-1.8 5-5l-3-3c-3.2 0-5 1.8-5 5z"/><path d="M8 13L19 2.2a2 2 0 0 1 3 3L11 16z"/>',
    pencil: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 6l3 3"/>',
    eraser: '<path d="M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M21 21H7"/><path d="M5 11l9 9"/>',
    fill:   '<path d="M11 3l8 8-7.5 7.5L4 11z"/><path d="M9 5l-5 6"/><path d="M20 13c0 0 2.4 3 2.4 4.8a2.4 2.4 0 1 1-4.8 0c0-1.8 2.4-4.8 2.4-4.8z"/>'
  };
  const TOOL_NAME = {
    select: 'Select', brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser', fill: 'Paint Bucket'
  };
  function svg(p) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  // Tiny UUID-ish generator if crypto.randomUUID isn't available. Doesn't
  // need to be cryptographically strong -- it just needs to not collide
  // with U.uid()'s output on the main side.
  function makeStrokeId() {
    if (window.crypto && crypto.randomUUID) return 'pen-' + crypto.randomUUID();
    return 'pen-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  class PenWindow {
    constructor() {
      this.canvas = document.getElementById('screen');
      this.ctx = this.canvas.getContext('2d');
      this.bar = document.getElementById('bar');
      this.hint = document.getElementById('hint');
      this.actions = null;
      this.state = {
        seq: 0,
        project: { width: 1920, height: 1080, bg: '#ffffff', fps: 24, frameCount: 1, layers: [] },
        // 'layers' is a duplicate inside project to satisfy compositeStage()
        layers: [],
        layersById: new Map(),
        palette: [],
        activeLayerId: null,
        frame: 0,
        tool: { name: 'brush', color: '#222222', toolSize: 6, toolOpacity: 1, pencil: false, brushFrac: 0.02, activeLayerKind: null, sel: {}, transform: {} },
        wetStroke: null
      };
      this.fit = { x: 0, y: 0, w: 0, h: 0 };
      this.view = { scale: 1, x: 0, y: 0 };
      this.stroking = false;
      this.toolBtns = {};
      this._lastHover = 0;
      this._wetTimer = null;

      this._buildBar();
      this._buildLassoTb();
      this._resize();
      this._installInput();
      this._installKeys();
      window.addEventListener('resize', () => { this._resize(); this.draw(); });

      if (PEN) {
        if (PEN.onState) PEN.onState(msg => this._onState(msg));
        PEN.ready();
        this._reportSize();
      }
    }

    _cmd(msg) { if (PEN) PEN.sendCommand(msg); }

    /* ---------------- toolbar (lifted from Phase 2 verbatim) ---------------- */
    // (Keep _buildBar / _buildLassoTb / _applyTransform / _refreshActions
    // exactly as Phase 2 had them -- they're UI-only and not affected by
    // the renderer change. The full text is reproduced from the prior
    // pen.js. If you stashed Phase 2 in Step P.1, copy lines ~97-622 from
    // the stash output into this file unchanged. The functions are:
    //   _buildBar, _buildLassoTb, _applyTransform, _zoomLocal, _panLocal,
    //   _resetView, _updateZoomLabel, _togglePan, _refreshActions.
    // None of them call any renderer code -- they only mutate this.view,
    // dispatch _cmd() commands, and rebuild DOM. They were not the source
    // of any of D1's defects.)

    /* ---------------- sizing ---------------- */
    _resize() {
      const barH = this.bar.offsetHeight || 48;
      const w = window.innerWidth;
      const h = Math.max(1, window.innerHeight - barH);
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.cssW = w; this.cssH = h;
      const c = this.canvas;
      c.style.width = w + 'px'; c.style.height = h + 'px';
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      this._computeFit();
      this._reportSize();
    }
    _reportSize() {
      if (!PEN) return;
      const k = this.cssW + 'x' + this.cssH + '@' + this.dpr;
      if (k === this._lastSizeKey) return;
      this._lastSizeKey = k;
      this._cmd({ type: 'pen-size', cssW: this.cssW, cssH: this.cssH, dpr: this.dpr });
    }
    _computeFit() {
      const pw = this.state.project.width || 1920;
      const ph = this.state.project.height || 1080;
      const s = Math.min(this.cssW / pw, this.cssH / ph);
      const w = pw * s, h = ph * s;
      this.fit = { x: (this.cssW - w) / 2, y: (this.cssH - h) / 2, w: w, h: h };
    }

    /* ---------------- incoming state ---------------- */
    _onState(msg) {
      if (!msg || !Array.isArray(msg.ops)) return;
      for (const op of msg.ops) {
        try { this._applyOp(op); }
        catch (e) { console.error('pen: bad op', op, e); }
      }
      if (typeof msg.seq === 'number') {
        this.state.seq = msg.seq;
        if (PEN && PEN.sendStateAck) {
          try { PEN.sendStateAck(msg.seq); } catch (_) {}
        }
      }
      // After applying ops, see if our wet stroke has been committed.
      this._checkWetCommit();
      this._scheduleComposite();
    }

    // Construct an OT.Layer from a snapshot and put it in state.layers.
    _hydrateLayer(snap) {
      const L = new OT.Layer(snap.name, snap.type);
      L.id = snap.id;
      L.visible = !!snap.visible;
      L.opacity = snap.opacity == null ? 1 : snap.opacity;
      L.color = snap.color || '';
      L.parentId = snap.parentId || null;
      L._collapsed = !!snap._collapsed;
      L.shadeOf = snap.shadeOf || null;
      L.transform = { keyframes: (snap.transform && snap.transform.keyframes) ? snap.transform.keyframes.slice() : [] };
      L.exposure = (snap.exposure || []).slice();
      L.cels = {};
      L.nextNum = 1;
      return L;
    }
    _hydrateCel(layer, frame, celSnap) {
      if (!celSnap) return;
      const num = celSnap.celNum || 1;
      let cel = layer.cels[num];
      if (!cel) {
        cel = new OT.Cel(num, celSnap.w, celSnap.h, celSnap.kind);
        layer.cels[num] = cel;
        if (num >= layer.nextNum) layer.nextNum = num + 1;
      }
      if (celSnap.kind === 'vector') {
        cel.strokes = Array.isArray(celSnap.strokes) ? celSnap.strokes.slice() : [];
      }
      // raster cels: D1 keeps the placeholder; D2 wires bmp data
      layer.exposure[frame] = num;
    }

    _applyOp(op) {
      if (!op || !op.op) return;
      const s = this.state;
      switch (op.op) {
        case 'init': {
          if (op.project) {
            Object.assign(s.project, op.project);
            this._computeFit();
          }
          if (Array.isArray(op.palette)) s.palette = op.palette.slice();
          if (Array.isArray(op.layers)) {
            s.layers = op.layers.map(snap => this._hydrateLayer(snap));
            s.layersById = new Map();
            for (const L of s.layers) s.layersById.set(L.id, L);
          }
          s.project.layers = s.layers;
          if (op.activeLayerId != null) s.activeLayerId = op.activeLayerId;
          if (typeof op.frame === 'number') s.frame = op.frame;
          if (op.cels && typeof op.cels === 'object') {
            for (const layerId in op.cels) {
              const layer = s.layersById.get(layerId);
              if (layer) this._hydrateCel(layer, s.frame, op.cels[layerId]);
            }
          }
          if (op.toolMeta) this._applyToolMeta(op.toolMeta);
          if (this.hint) this.hint.style.display = 'none';
          break;
        }
        case 'layers-replace': {
          if (!Array.isArray(op.layers)) break;
          // Preserve already-hydrated cels by id so a layer reorder/
          // visibility flip doesn't drop strokes.
          const oldById = s.layersById;
          s.layers = op.layers.map(snap => {
            const fresh = this._hydrateLayer(snap);
            const old = oldById.get(snap.id);
            if (old) {
              fresh.cels = old.cels;
              fresh.nextNum = old.nextNum;
            }
            return fresh;
          });
          s.layersById = new Map();
          for (const L of s.layers) s.layersById.set(L.id, L);
          s.project.layers = s.layers;
          if (op.activeLayerId != null) s.activeLayerId = op.activeLayerId;
          break;
        }
        case 'vector-cel-replace': {
          const layer = s.layersById.get(op.layerId);
          if (!layer || !op.cel) break;
          this._hydrateCel(layer, op.frame, op.cel);
          break;
        }
        case 'frame-change': {
          if (typeof op.frame === 'number') s.frame = op.frame;
          break;
        }
        case 'active-layer': {
          if (op.layerId != null) s.activeLayerId = op.layerId;
          break;
        }
        case 'project-meta': {
          if (op.patch) {
            Object.assign(s.project, op.patch);
            this._computeFit();
          }
          break;
        }
        case 'palette': {
          if (Array.isArray(op.colors)) s.palette = op.colors.slice();
          break;
        }
        case 'tool-meta': {
          if (op.meta) this._applyToolMeta(op.meta);
          break;
        }
        default: break;     // forward-compatible: unknown ops are ignored
      }
    }

    _applyToolMeta(meta) {
      if (!meta) return;
      const t = this.state.tool;
      if (meta.tool || meta.name) t.name = meta.name || meta.tool;
      if (meta.color) t.color = meta.color;
      if (typeof meta.brushFrac === 'number') t.brushFrac = meta.brushFrac;
      if (typeof meta.toolSize === 'number') t.toolSize = meta.toolSize;
      if (typeof meta.toolOpacity === 'number') t.toolOpacity = meta.toolOpacity;
      if (typeof meta.pencil === 'boolean') t.pencil = meta.pencil;
      if (meta.sel) t.sel = meta.sel;
      if (meta.transform) t.transform = meta.transform;
      if (typeof meta.activeLayerKind === 'string') t.activeLayerKind = meta.activeLayerKind;
      // toolbar visuals
      for (const n in this.toolBtns)
        this.toolBtns[n].classList.toggle('active', n === t.name);
      if (t.color && /^#[0-9a-fA-F]{6}$/.test(t.color))
        this.colorInput.value = t.color;
      if (this.colorWrap) this.colorWrap.style.background = t.color || '#222222';
      const f = (this.state.frame || 0) + 1;
      const total = this.state.project.frameCount || 1;
      if (this.frameLabel) this.frameLabel.textContent = f + ' / ' + total;
      this._refreshActions(t.sel || {}, t.transform);
      this._applyTransform(t.transform);
      // If the tool/layer is no longer wet-stroke-eligible, drop any wet
      if (this.state.wetStroke
          && (t.activeLayerKind !== 'vector'
              || (t.name !== 'brush' && t.name !== 'pencil'))) {
        this._clearWetStroke();
      }
    }

    /* ---------------- wet stroke lifecycle ---------------- */
    _wetEligible() {
      const t = this.state.tool;
      return t.activeLayerKind === 'vector'
        && (t.name === 'brush' || t.name === 'pencil');
    }
    _seedWetStroke(id, projPt) {
      const t = this.state.tool;
      this.state.wetStroke = {
        id: id, type: 'line',
        pencil: t.name === 'pencil',
        color: t.color || '#222222',
        width: t.toolSize || 6,
        opacity: t.toolOpacity == null ? 1 : t.toolOpacity,
        closed: false,
        pts: [projPt],
        predicted: []          // rendered alongside pts; cleared on each move
      };
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
    _extendWetStroke(actualPts, predictedPts) {
      const ws = this.state.wetStroke;
      if (!ws) return;
      for (const p of actualPts) ws.pts.push(p);
      ws.predicted = predictedPts || [];
    }
    // Defensive timer: started on pointerup, NOT on seed. While the artist
    // is still dragging, the wet stroke must stay alive arbitrarily long.
    // Once the artist lifts, main has 2 seconds to commit (via celchange)
    // or we drop the wet stroke to avoid a phantom that never clears.
    _armWetTimer() {
      if (this._wetTimer) clearTimeout(this._wetTimer);
      this._wetTimer = setTimeout(() => this._clearWetStroke(), 2000);
    }
    _clearWetStroke() {
      this.state.wetStroke = null;
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
    // After applying any state batch, see if our wet stroke has been
    // committed -- if a cel now contains a stroke with our wet id, drop.
    _checkWetCommit() {
      const ws = this.state.wetStroke;
      if (!ws) return;
      const layer = this.state.layersById.get(this.state.activeLayerId);
      if (!layer) return;
      const cel = layer.celAt(this.state.frame);
      if (!cel || cel.kind !== 'vector' || !Array.isArray(cel.strokes)) return;
      for (const st of cel.strokes) {
        if (st.id === ws.id) {
          this._clearWetStroke();
          return;
        }
      }
    }

    /* ---------------- draw ---------------- */
    draw() { this._compositeStage(); }
    _scheduleComposite() {
      if (this._compositeRAF) return;
      this._compositeRAF = requestAnimationFrame(() => {
        this._compositeRAF = 0;
        this._compositeStage();
      });
    }
    _layerAncestors(layer) {
      const out = [];
      let cur = layer;
      while (cur && cur.parentId) {
        const next = this.state.layersById.get(cur.parentId);
        if (!next || next === layer || out.includes(next)) break;
        out.push(next);
        cur = next;
      }
      return out;
    }
    _compositeStage() {
      const s = this.state;
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cssW, this.cssH);
      c.fillStyle = '#0c0d10';
      c.fillRect(0, 0, this.cssW, this.cssH);
      // local view (zoom/pan on pen, doesn't touch main)
      c.save();
      c.translate(this.view.x, this.view.y);
      c.scale(this.view.scale, this.view.scale);
      // map the project rect into the fit rectangle
      if (this.fit.w > 0) {
        const projScale = this.fit.w / Math.max(1, s.project.width);
        c.translate(this.fit.x, this.fit.y);
        c.scale(projScale, projScale);
        // wet stroke renderer: concatenate predicted onto pts inside a
        // synthetic stroke object (don't mutate the canonical wetStroke).
        const wet = s.wetStroke;
        let wetForRender = null;
        if (wet) {
          if (wet.predicted && wet.predicted.length) {
            wetForRender = Object.assign({}, wet, {
              pts: wet.pts.concat(wet.predicted)
            });
          } else {
            wetForRender = wet;
          }
        }
        OT.compositeStage(s.project, s.frame, c, {
          bg: true,
          wetStroke: wetForRender,
          wetLayerId: s.activeLayerId,
          skipVideo: true,             // D1: no video on pen
          skipLassoHidden: false
        }, {
          layerAncestors: layer => this._layerAncestors(layer)
        });
      }
      c.restore();   // local view
    }

    /* ---------------- pointer input ---------------- */
    _installInput() {
      const cv = this.canvas;
      const rect = () => cv.getBoundingClientRect();
      const norm = (clientX, clientY, r) => {
        const v = this.view;
        const ox = (clientX - r.left - v.x) / v.scale;
        const oy = (clientY - r.top - v.y) / v.scale;
        return {
          nx: (ox - this.fit.x) / (this.fit.w || 1),
          ny: (oy - this.fit.y) / (this.fit.h || 1)
        };
      };
      // Convert a 0..1 fraction to a project-space pt the wet stroke can
      // render at (matches the main side's _ptFromNorm math).
      const toProjPt = (n, pressure) => ({
        x: n.nx * this.state.project.width,
        y: n.ny * this.state.project.height,
        p: pressure == null ? 1 : pressure
      });
      const isPenEraser = e =>
        e.pointerType === 'pen' && (((e.buttons & 32) !== 0) || e.button === 5);
      const mods = e => ({
        isPen: e.pointerType === 'pen',
        shift: e.shiftKey, alt: e.altKey,
        button: e.button, buttons: e.buttons,
        penEraser: isPenEraser(e)
      });

      // (multi-touch palm rejection / gesture state from Phase 2 stays the
      // same -- copy from your Phase 2 stash. The bits below are the parts
      // that change for D1: UUID + wet stroke + predicted touches.)

      cv.addEventListener('pointerdown', e => {
        if (!this.fit.w) return;
        // (palm rejection / pan / gesture handling from Phase 2 first)
        if (e.pointerType === 'touch' && this.stroking) return;
        // (... palm/gesture logic copied from your Phase 2 stash ...)
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        if (e.button === 1 || e.button === 2 || this.panLock) {
          this.panning = { x: e.clientX, y: e.clientY };
          this.canvas.style.cursor = 'grabbing';
          return;
        }
        const r = rect();
        const n = norm(e.clientX, e.clientY, r);
        const pressure = e.pointerType === 'pen' ? e.pressure : 1;
        this.stroking = true;
        const strokeId = makeStrokeId();
        if (PEN) PEN.sendInput(Object.assign({
          type: 'down', id: strokeId, nx: n.nx, ny: n.ny, pressure
        }, mods(e)));
        if (this._wetEligible()) {
          this._seedWetStroke(strokeId, toProjPt(n, pressure));
          this._scheduleComposite();
        }
      });

      cv.addEventListener('pointermove', e => {
        if (!this.fit.w) return;
        const r = rect();
        if (this.panning) {
          this._panLocal(e.clientX - this.panning.x, e.clientY - this.panning.y);
          this.panning = { x: e.clientX, y: e.clientY };
          return;
        }
        if (this.stroking) {
          // actual coalesced points (everything since last move event)
          let coalesced = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
          if (!coalesced.length) coalesced = [e];
          const actualPts = [];
          const wirePts = [];
          for (const ce of coalesced) {
            const n = norm(ce.clientX, ce.clientY, r);
            const pr = ce.pointerType === 'pen' ? ce.pressure : 1;
            actualPts.push(toProjPt(n, pr));
            wirePts.push({ nx: n.nx, ny: n.ny, pressure: pr });
          }
          // predicted points -- never sent on the wire, never persist
          let predictedPts = [];
          if (e.getPredictedEvents) {
            const predicted = e.getPredictedEvents();
            for (const pe of predicted) {
              const n = norm(pe.clientX, pe.clientY, r);
              const pr = pe.pointerType === 'pen' ? pe.pressure : 1;
              predictedPts.push(toProjPt(n, pr));
            }
          }
          if (this.state.wetStroke) {
            this._extendWetStroke(actualPts, predictedPts);
            this._scheduleComposite();
          }
          if (PEN) PEN.sendInput(Object.assign({ type: 'move', pts: wirePts }, mods(e)));
        } else {
          const now = performance.now();
          if (now - this._lastHover < 55) return;
          this._lastHover = now;
          const n = norm(e.clientX, e.clientY, r);
          if (PEN) PEN.sendInput(Object.assign({ type: 'hover', nx: n.nx, ny: n.ny }, mods(e)));
        }
      });

      const end = e => {
        if (this.panning) { this.panning = null; this.canvas.style.cursor = this.panLock ? 'grab' : ''; return; }
        if (!this.stroking) return;
        this.stroking = false;
        // clear predicted on the wet (no more predicting past finished input)
        if (this.state.wetStroke) {
          this.state.wetStroke.predicted = [];
          this._armWetTimer();           // 2-second defensive cleanup
          this._scheduleComposite();
        }
        const r = rect();
        const n = norm(e.clientX, e.clientY, r);
        const pressure = e.pointerType === 'pen' ? e.pressure : 1;
        const id = this.state.wetStroke ? this.state.wetStroke.id : null;
        if (PEN) PEN.sendInput(Object.assign({
          type: 'up', id, nx: n.nx, ny: n.ny, pressure
        }, mods(e)));
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', e => {
        if (this.stroking) {
          this.stroking = false;
          this._clearWetStroke();
          if (PEN) PEN.sendInput({ type: 'cancel' });
        }
        this._scheduleComposite();
      });
      cv.addEventListener('pointerleave', e => {
        if (this.stroking) return;
        if (PEN) PEN.sendInput({ type: 'leave' });
      });
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const r = rect();
        const fine = e.ctrlKey || e.metaKey;
        const step = fine ? 1.05 : 1.15;
        const factor = e.deltaY < 0 ? step : 1 / step;
        this._zoomLocal(factor, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
    }

    _installKeys() {
      const TOOLKEY = { v: 'select', b: 'brush', n: 'pencil', e: 'eraser', g: 'fill' };
      window.addEventListener('keydown', ev => {
        const k = ev.key.toLowerCase();
        if (ev.ctrlKey || ev.metaKey) {
          if (k === 'z') { ev.preventDefault(); this._cmd({ type: ev.shiftKey ? 'redo' : 'undo' }); }
          else if (k === 'y') { ev.preventDefault(); this._cmd({ type: 'redo' }); }
          return;
        }
        if (TOOLKEY[k]) { this._cmd({ type: 'tool', tool: TOOLKEY[k] }); return; }
        if (k === '[') this._cmd({ type: 'brush-size', delta: -1 });
        else if (k === ']') this._cmd({ type: 'brush-size', delta: 1 });
        else if (k === 'f') this._cmd({ type: 'fit' });
        else if (k === ',') this._cmd({ type: 'frame', dir: -1 });
        else if (k === '.') this._cmd({ type: 'frame', dir: 1 });
        else if (k === '+' || k === '=') this._zoomLocal(1.18);
        else if (k === '-' || k === '_') this._zoomLocal(1 / 1.18);
        else if (k === '0') this._resetView();
      });
    }
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => new PenWindow());
  else new PenWindow();
})();
```

The toolbar / lasso-toolbar / chip / palm-rejection blocks are intentionally elided above. **Open the Phase 2 stash** (`git stash show -p stash@{0} -- pen/pen.js`), find the methods `_buildBar`, `_buildLassoTb`, `_applyTransform`, `_zoomLocal`, `_panLocal`, `_resetView`, `_updateZoomLabel`, `_togglePan`, `_refreshActions`, and paste them into the appropriate spot in the class. Also paste the multi-touch palm rejection branches in `pointerdown` / `pointermove` / `pointerup` / `pointerleave` (everything related to `this._pendingTouch`, `this.pointers`, `this.gesture`, `beginGesture`, `updateGesture`). These weren't a source of any D1 defect — they're correct UI/input code that just doesn't appear in the skeleton above to keep this plan readable.

- [ ] **Step 4.3: Smoke test — open the pen window**

Run `npm run dev`. Open the pen window (View menu or whatever your shortcut is). Expected behaviour:

- Pen window opens, shows toolbar, hint disappears
- Main canvas content (vector layers) renders on the pen at native resolution — no pixelation, layers visible
- Raster (`drawing`-type) layers render as empty placeholder (D2 will fix)
- DevTools console (pen window) shows no errors

If the pen is black or blank: check `OT.compositeStage` is defined (`composite.js` loaded?), `OT.Layer` is defined (`core.js` loaded?), and `state.layersById` has entries after the init op.

- [ ] **Step 4.4: Commit**

```bash
git add pen/pen.js pen/pen.html
git commit -m "feat(pen): rewrite pen window as D1 slave renderer

Real OT.Layer/OT.Cel instances; calls shared OT.compositeStage with
a layerAncestors helper. Wet stroke seeded on pointerdown with
client UUID; extended on pointermove with coalesced + predicted
points; dropped atomically on commit by matching UUID."
```

---

## Task 5: End-to-end smoke test — vector brush stroke on the pen

**Files:** none modified

- [ ] **Step 5.1: Active layer is vector, run a brush stroke**

Run `npm run dev`. Open the pen window. On the main app, create a new project with a single vector layer (or use an existing one — make sure the active layer is `type === 'vector'`). Pick the **brush** tool.

On the pen window, draw a stroke with the pen or mouse.

**Expected behaviour:**
1. While dragging: wet ink appears **on the pen window** under your pointer, with very low perceived latency (~5-20ms)
2. Wet ink also appears **on the main window** (synchronous; runs through `tools.pointerMove`)
3. On pointer-up: the wet stroke smoothly transitions to the committed stroke (you may see a slight "settle" where corners round — that's the One Euro / inkDynamics / simplify smoothing on main side, expected per spec)
4. After the swap, no flicker, no stroke disappearing, no doubled stroke

If the wet ink doesn't appear on pen: check `_wetEligible()` returns true (DevTools: `pen window's app.state.tool.activeLayerKind` should be `'vector'`).

If the committed stroke replaces with a visible jump: that's the smoothing settle — known D1 limitation. Verify by checking that the stroke `id` in `cel.strokes` on the main side begins with `pen-` — that confirms the UUID flowed end-to-end.

- [ ] **Step 5.2: Pencil stroke**

Switch to the pencil tool. Draw on the pen. Same expectations as brush.

- [ ] **Step 5.3: Eraser, fill, select**

Switch to eraser, draw on the pen. There's no local wet preview (eraser doesn't seed a wet stroke). The committed erasure should appear after pointer-up via `vector-cel-replace`.

Switch to fill, tap on a closed area. Filled stroke appears after commit.

Switch to select, tap a layer. No drawing, just selection.

- [ ] **Step 5.4: Frame navigation, layer toggle, palette change**

- Press `,` / `.` on the pen window to nav frames. Pen should reflect each frame's content.
- On main, toggle a layer's visibility. Pen reflects.
- On main, swap palette colors. Pen reflects.

- [ ] **Step 5.5: Pen-window zoom**

Press `+` on the pen window several times to zoom in past 200%. Vector strokes should remain crisp (they're re-rendered at zoom by `compositeStage` via `OT.Vector.renderStroke`). Raster placeholder layers stay blank — expected in D1.

- [ ] **Step 5.6: Commit a fixes-after-smoke-test pass (if any)**

If you found bugs in the smoke test: fix them and commit each fix as a separate commit with a clear message like `fix(pen): <description>`. Re-run the smoke test until all pass.

---

## Task 6: Drop the `phase-2-attic` reference branch and stash

**Files:** none

Once Task 5 passes end-to-end and you're confident the D1 implementation is working:

- [ ] **Step 6.1: Verify nothing in the stash is still needed**

```bash
git stash list
```

The Phase 2 stash should still be there. If you've copied everything you needed (the UI helpers in pen.js, the palm rejection block), the stash is now reference material you no longer need.

- [ ] **Step 6.2: Drop the stash and the attic branch**

Only if Step 5 fully passed:

```bash
git stash drop stash@{0}
git branch -D phase-2-attic
```

- [ ] **Step 6.3: Push if applicable**

If this branch is going to a PR, push it:

```bash
git push origin HEAD
```

---

## Self-review checklist (do this before declaring D1 done)

- [ ] `grep -rn "publishStrokeChange\|_legacySendFrame\|_encodeBg\|excludeLayerId\|opentoon:pen-frame\|sendPenFrame" src/ pen/ electron/`
   Expected: empty
- [ ] `grep -rn "_installLiveShim\|_publishLiveBegin\|_publishLiveExtend\|_publishLiveEnd" src/`
   Expected: empty
- [ ] `OT.compositeStage` is defined and used by both `canvas.js` and `pen/pen.js`
- [ ] Pen-originated strokes have `id` starting with `pen-` in the committed `cel.strokes` array
- [ ] No console errors when drawing on pen at 60 Hz for ~10 seconds continuous
- [ ] Vector layers on pen stay crisp at 200%+ pen-window zoom
- [ ] Raster layers render empty (placeholder — D2)
- [ ] Settle effect on commit is present but minor (D4 will eliminate)
