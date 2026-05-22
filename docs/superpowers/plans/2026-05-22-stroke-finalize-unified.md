# Unified Stroke Finalize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the visible "settle" when a stroke commits on both the main canvas and the pen window by applying the four polish transforms (inkDynamics, simplify, snapEndpoints, autoClose) continuously during the drag — so the wet preview shows exactly what will commit.

**Architecture:** Extract the four transforms into a shared pure module `src/stroke-finalize.js`. The brush + pencil tools on main, and the pen window's wet-stroke handler, all call the same `OT.StrokeFinalize.finalize(rawPts, opts)` once per rAF during the drag, and once more on commit. Identical inputs → identical outputs → invisible hand-off. The four polish parameters (`tol`, `snapDist`, `inkDynamics`, `autoClose`) ride to the pen via `tool-meta`.

**Tech Stack:** Vanilla JS modules attached to `window.OT`. Canvas 2D. `OT.Vector.simplify` (existing) reused; the other three transforms are lifted from `tools.js` into the new shared module.

**Spec:** `docs/superpowers/specs/2026-05-22-stroke-finalize-unified-design.md`

---

## File map

**Created:**
- `src/stroke-finalize.js` — pure module exposing `OT.StrokeFinalize` with `applyInkDynamics`, `snapEndpoints`, `maybeAutoClose`, `finalize`. Loaded by `index.html` (before `tools.js`) and `pen/pen.html` (before `pen.js`).

**Modified:**
- `src/tools.js` — Delete the in-file `applyInkDynamics` (lines 192-220). PaintTool (`_vMove` ~686 / `_vUp` ~735) and PencilTool (`_vMove` ~1792 / `_vUp` ~1809) compute `_previewPts` via `finalize()` per rAF and feed it to `drawOverlay`. Commit path is replaced by a single `finalize()` call.
- `src/pencast.js` — extend `_meta()` to publish `tol`, `snapDist`, `inkDynamics`, `autoClose`. Remove the `phase-2-attic` stash cleanup is folded in here as a separate concern (Task 7).
- `pen/pen.js` — `_extendWetStroke` runs `finalize()` against the pen's mirrored cel. `_applyToolMeta` reads the new fields. Remove the diagnostic `[pen] clearWet from:` console log added in D1.
- `index.html` — add `<script src="src/stroke-finalize.js"></script>` before `tools.js`.
- `pen/pen.html` — add `<script src="../src/stroke-finalize.js"></script>` after `composite.js` and before `pen.js`.

**Untouched:**
- `src/vector.js` — `simplify` and `snapPoint` already exist as pure functions and are reused.
- `src/composite.js` — no rendering changes needed.

---

## Task 1: Create `src/stroke-finalize.js`

**Files:**
- Create: `src/stroke-finalize.js`
- Modify: `index.html` (add script tag)
- Modify: `pen/pen.html` (add script tag)

- [ ] **Step 1.1: Create the new module**

Create `C:\Users\harry\Documents\Projects\opentoon\src\stroke-finalize.js`:

```js
/* OpenToon Studio - shared stroke finalize pipeline.

   Both the main brush/pencil tools and the pen window's wet-stroke
   handler call into this module so the wet preview and the committed
   stroke produce IDENTICAL pts -- which is what eliminates the
   "settle" visible on commit today.

   All exports are pure: no `this`, no DOM, no `app`, no mutation of
   inputs. The pen window depends on this so the per-rAF finalize
   doesn't accidentally mutate state shared with main. */
(function (OT) {
  'use strict';

  // Ink-pen velocity dynamics. Scales each point's pressure by a factor
  // that shrinks with stroke speed. Returns a NEW pts array with new
  // point objects -- does NOT mutate the input. Requires `.t` timestamps
  // in ms on each point (set by the tool's _vMove). Points without `.t`
  // are passed through unmodified.
  function applyInkDynamics(pts) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const out = new Array(n);
    const speed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dt = (b.t - a.t) || 1;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      speed[i] = d / Math.max(0.5, dt);
    }
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = speed[Math.max(0, i - 1)], b = speed[i], c = speed[Math.min(n - 1, i + 1)];
      sm[i] = (a + 2 * b + c) * 0.25;
    }
    const k = 0.2, lo = 0.45;
    for (let i = 0; i < n; i++) {
      const m = Math.max(lo, Math.min(1, 1 - k * sm[i]));
      const src = pts[i];
      const p = src.p == null ? 1 : src.p;
      out[i] = { x: src.x, y: src.y, t: src.t, p: p * m };
    }
    return out;
  }

  // Nearest line-stroke endpoint within `radius`. Mirrors OT.Vector's
  // snapPoint but returns a NEW pts array with first/last point moved
  // to the snap targets (if found). Does not mutate input. `cel` must
  // have a `strokes` array; if cel is null the input passes through.
  function snapEndpoints(pts, cel, radius) {
    if (!cel || !cel.strokes || pts.length < 2 || radius <= 0) return pts;
    const V = OT.Vector;
    if (!V || !V.snapPoint) return pts;
    const first = pts[0], last = pts[pts.length - 1];
    const s0 = V.snapPoint(cel, first.x, first.y, radius);
    const sN = V.snapPoint(cel, last.x, last.y, radius);
    if (!s0 && !sN) return pts;
    const out = pts.slice();
    if (s0) out[0] = { x: s0.x, y: s0.y, p: first.p, t: first.t };
    if (sN) out[out.length - 1] = { x: sN.x, y: sN.y, p: last.p, t: last.t };
    return out;
  }

  // If first/last points are within `radius`, set last := first and
  // return closed=true. Otherwise return closed=false and pts unchanged.
  // Returns `{ pts, closed }`. Requires pts.length > 3 to avoid closing
  // tiny tick marks the artist didn't mean to loop.
  function maybeAutoClose(pts, radius) {
    if (pts.length <= 3 || radius <= 0) return { pts, closed: false };
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) >= radius * 1.3) return { pts, closed: false };
    const out = pts.slice();
    out[out.length - 1] = { x: a.x, y: a.y, p: b.p, t: b.t };
    return { pts: out, closed: true };
  }

  // The full finalize pipeline. Apply in order:
  //   inkDynamics (opt-in)  ->  simplify  ->  snapEndpoints (when cel given)
  //   ->  maybeAutoClose (opt-in)
  //
  // Deterministic and idempotent: finalize(finalize(x).pts).pts has the
  // same shape as finalize(x).pts. Calling per-rAF during a drag and
  // once more at commit produces the SAME pts both times -- which is
  // the entire point of the module.
  //
  // opts: {
  //   tol:         number  (RDP simplify tolerance, e.g. 0.4 + smooth*0.8)
  //   snapDist:    number  (endpoint snap radius)
  //   inkDynamics: bool
  //   autoClose:   bool
  //   cel:         Cel | null  (only used by snapEndpoints; pen window
  //                              passes its mirrored cel; main passes
  //                              the active cel)
  // }
  function finalize(rawPts, opts) {
    if (!rawPts || rawPts.length === 0) return { pts: [], closed: false };
    opts = opts || {};
    const V = OT.Vector;
    let pts = rawPts;
    if (opts.inkDynamics) pts = applyInkDynamics(pts);
    if (V && V.simplify && opts.tol != null) {
      pts = V.simplify(pts, opts.tol);
      if (pts.length < 2 && rawPts.length >= 2) pts = rawPts.slice(0, 2);
    }
    if (opts.cel && opts.snapDist) pts = snapEndpoints(pts, opts.cel, opts.snapDist);
    let closed = false;
    if (opts.autoClose && opts.snapDist) {
      const ac = maybeAutoClose(pts, opts.snapDist);
      pts = ac.pts; closed = ac.closed;
    }
    return { pts, closed };
  }

  OT.StrokeFinalize = { applyInkDynamics, snapEndpoints, maybeAutoClose, finalize };
})(window.OT = window.OT || {});
```

- [ ] **Step 1.2: Wire `stroke-finalize.js` into `index.html`**

Open `C:\Users\harry\Documents\Projects\opentoon\index.html`. Find the existing `<script src="src/tools.js"></script>` line. Insert immediately above it:

```html
<script src="src/stroke-finalize.js"></script>
```

(Order requirement: `vector.js` must be loaded before `stroke-finalize.js` — verify by grep. `composite.js` is already after `vector.js`. The new tag goes after `vector.js` and before `tools.js`.)

- [ ] **Step 1.3: Wire `stroke-finalize.js` into `pen/pen.html`**

Open `C:\Users\harry\Documents\Projects\opentoon\pen\pen.html`. Find the script block (around line 264-267 — `core.js`, `vector.js`, `composite.js`, `pen.js`). Insert one line between `composite.js` and `pen.js`:

```html
<script src="../src/stroke-finalize.js"></script>
```

Resulting order: `core.js`, `vector.js`, `composite.js`, `stroke-finalize.js`, `pen.js`.

- [ ] **Step 1.4: Sanity-check the module parses and exports**

```bash
node -c src/stroke-finalize.js
```
Expected: silent (no syntax error).

- [ ] **Step 1.5: Commit**

```bash
git add src/stroke-finalize.js index.html pen/pen.html
git commit -m "$(cat <<'EOF'
feat: add OT.StrokeFinalize shared module

Pure pipeline used by main's brush/pencil tools (Task 2-3) and the
pen window's wet-stroke handler (Task 5) so the wet preview and the
committed stroke produce identical pts. Eliminates the visible settle
on commit. Logic for applyInkDynamics is lifted from tools.js without
mutation of inputs; snapEndpoints + maybeAutoClose are new wrappers
around OT.Vector.snapPoint and the inline autoClose logic.
EOF
)"
```

---

## Task 2: Refactor `PaintTool` (brush) to use `finalize` for both preview and commit

**Files:**
- Modify: `src/tools.js` (PaintTool class — `_vMove`, `_vUp`, `drawOverlay`, possibly a new `_rafEmit` integration; remove the in-file `applyInkDynamics` function and its `OT.applyInkDynamics` export since the shared module is the source of truth)

- [ ] **Step 2.1: Delete the in-file `applyInkDynamics`**

Open `src/tools.js`. Find the function at lines 192-220 (the function body starts `function applyInkDynamics(raw) {` and ends with `OT.applyInkDynamics = applyInkDynamics;`).

Delete the entire block, INCLUDING its leading comment "Ink-pen velocity dynamics: scale each point's pressure by a factor that shrinks with stroke speed..." (currently at lines 187-191).

Replace the deleted block with a single one-line comment so the reader knows where the logic went:

```js
  // (Ink-pen velocity dynamics now lives in OT.StrokeFinalize.applyInkDynamics
  // — see src/stroke-finalize.js. Pen window and main both call it via
  // OT.StrokeFinalize.finalize() so wet preview matches commit.)
```

- [ ] **Step 2.2: Add `_previewPts` field to `PaintTool`**

Find the `PaintTool` class. Find the constructor or the place where instance fields are first set (look for the existing `this.raw = ...` initialization — somewhere around line 380-420). Add immediately after:

```js
      // _previewPts is the finalize output for the current in-progress
      // stroke, recomputed per rAF in _vMove. drawOverlay renders this
      // (NOT this.raw) so the wet line equals what will commit.
      this._previewPts = null;
      this._previewClosed = false;
```

- [ ] **Step 2.3: Recompute `_previewPts` in `_vMove`**

Find `PaintTool._vMove` (around line 686). The function ends with `this._rafEmit(app)` on a `_rafEmit`-handled path or directly calls `app.emit('overlayrender')` on the straight-line path. Locate the existing `_rafEmit` method (search for `_rafEmit(app)` — it's the per-rAF emitter that already coalesces overlay refreshes).

We need the finalize call to ride that same rAF so we don't double-schedule. Find `_rafEmit` (typically defined elsewhere in PaintTool). Modify its rAF callback to compute `_previewPts` before emitting `overlayrender`.

Concretely: find code like:

```js
    _rafEmit(app) {
      if (this._emitRAF) return;
      this._emitRAF = requestAnimationFrame(() => {
        this._emitRAF = 0;
        // ... existing snap detection or whatever runs here ...
        app.emit('overlayrender');
      });
    }
```

Insert a call to a new method `_computePreview(app)` immediately before `app.emit('overlayrender')`:

```js
        this._computePreview(app);
        app.emit('overlayrender');
```

Then add `_computePreview` as a method on PaintTool (place near `_vMove` / `_vUp`):

```js
    // Compute the would-commit pts from this.raw via OT.StrokeFinalize.
    // Cached as this._previewPts; drawOverlay renders this instead of
    // this.raw. Called per rAF from _rafEmit and once more at _vUp so
    // the committed pts equals the last preview pts.
    _computePreview(app) {
      if (!this.raw || !this.raw.length || !this.t) {
        this._previewPts = null;
        this._previewClosed = false;
        return;
      }
      // Skip while shape-snap animation is running -- the snap preview
      // owns drawOverlay during the morph, see drawOverlay for the snap
      // branch.
      if (this._snapAnim || this._snapPreview) return;
      const tol = 0.4 + (this.smooth || 0) * 0.8;
      const fin = OT.StrokeFinalize.finalize(this.raw, {
        tol,
        snapDist: app.settings.snapDist || 0,
        inkDynamics: !!app.settings.inkDynamics,
        autoClose: !!(app.settings && app.settings.autoClose),
        cel: this.t.cel
      });
      this._previewPts = fin.pts;
      this._previewClosed = fin.closed;
    }
```

- [ ] **Step 2.4: Render `_previewPts` from `drawOverlay`**

Find `PaintTool.drawOverlay` (around line 551). After the snap-animation branches and the snap-preview branch (which both `return` if active), find the section starting:

```js
      // Fresh array each frame: V().samplesOf caches the smoothed path keyed
      // ...
      const pts = this.raw.slice();
      if (this._liveTip && !this.straight) {
        const t = pts[pts.length - 1];
        if (t.x !== this._liveTip.x || t.y !== this._liveTip.y) pts.push(this._liveTip);
      }
      // ...
      const stroke = {
        type: 'line', pencil: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: false
      };
      V().renderStroke(ctx, stroke);
      ctx.restore();
    }
```

Replace that whole tail block (the `this.raw.slice()` + `_liveTip` append + stroke object + `renderStroke` + `ctx.restore` lines) with:

```js
      // Render the FINALIZE output (= the would-commit pts), not this.raw.
      // The finalize pipeline runs per rAF in _computePreview, so what the
      // artist sees is exactly what _vUp will push to cel.strokes. The
      // _liveTip workaround is no longer needed -- finalize-per-frame
      // keeps the preview within ~one frame of the cursor.
      const pts = this._previewPts;
      if (!pts || pts.length === 0) { ctx.restore(); return; }
      const stroke = {
        type: 'line', pencil: false,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: this._previewClosed
      };
      V().renderStroke(ctx, stroke);
      ctx.restore();
    }
```

- [ ] **Step 2.5: Replace `_vUp` commit transforms with a single `finalize` call**

Find `PaintTool._vUp` (around line 735). The current code computes `snapped`, then either uses `snapped.pts/closed` (shape-snap path) OR runs `applyInkDynamics`, `V().simplify`, `V().snapPoint` twice, and the `autoClose` check.

Locate the block:

```js
      // Ink-pen dynamics: skip when shape-snap fired — clean shapes look
      // wrong with velocity-thinned tips.
      if (!snapped && app.settings.inkDynamics && this.raw.length >= 3) {
        applyInkDynamics(this.raw);
      }
      let pts, closed;
      if (snapped) {
        pts = snapped.pts;
        closed = snapped.closed;
      } else {
        const tol = 0.4 + this.smooth * 0.8;
        pts = V().simplify(this.raw, tol);
        if (pts.length < 2) pts = this.raw.slice(0, 2);
        // endpoint auto-connect
        const snap = app.settings.snapDist;
        const s0 = V().snapPoint(cel, pts[0].x, pts[0].y, snap);
        if (s0) { pts[0] = { x: s0.x, y: s0.y, p: pts[0].p }; }
        const li = pts.length - 1;
        const s1 = V().snapPoint(cel, pts[li].x, pts[li].y, snap);
        if (s1) { pts[li] = { x: s1.x, y: s1.y, p: pts[li].p }; }
        closed = false;
        const autoClose = !!(app.settings && app.settings.autoClose);
        if (autoClose && pts.length > 3 &&
            U.dist(pts[0].x, pts[0].y, pts[li].x, pts[li].y) < snap * 1.3) {
          pts[li] = { x: pts[0].x, y: pts[0].y, p: pts[li].p };
          closed = true;
        }
      }
```

Replace it with:

```js
      let pts, closed;
      if (snapped) {
        // Shape-snap path is unaffected: it produced a clean primitive
        // shape and bypasses the inkDynamics/snap/autoClose stack on
        // purpose. (See applyInkDynamics docs: clean shapes look wrong
        // with velocity-thinned tips.)
        pts = snapped.pts;
        closed = snapped.closed;
      } else {
        const fin = OT.StrokeFinalize.finalize(this.raw, {
          tol: 0.4 + this.smooth * 0.8,
          snapDist: app.settings.snapDist || 0,
          inkDynamics: !!app.settings.inkDynamics,
          autoClose: !!(app.settings && app.settings.autoClose),
          cel: cel
        });
        pts = fin.pts;
        closed = fin.closed;
      }
```

- [ ] **Step 2.6: Reset `_previewPts` on commit**

Still in `_vUp`, find the existing cleanup near the end (around line 828):

```js
      this.raw = null;
      this._liveTip = null;
      this._predictedPts = null;
      this._snapPreview = null;
      this._snapAnim = null;
```

Add immediately after:

```js
      this._previewPts = null;
      this._previewClosed = false;
```

- [ ] **Step 2.7: Verify main canvas brush still draws**

Run:
```bash
node tests/visual.cjs
```
Expected: `=== ERRORS (0) ===`. The test draws strokes via the brush; if `_previewPts` is null when `drawOverlay` runs it returns silently (so first-frame is safe). If the test fails, the most likely cause is that `_rafEmit` was named or shaped differently than expected — find the actual rAF-coalesce site and integrate `_computePreview` there.

- [ ] **Step 2.8: Commit**

```bash
git add src/tools.js
git commit -m "$(cat <<'EOF'
refactor(brush): use OT.StrokeFinalize for wet preview and commit

Brush wet preview now renders finalize(this.raw) instead of this.raw,
recomputed per rAF in _computePreview alongside the existing
snap-detection rAF. The commit path is a single finalize() call;
the inline applyInkDynamics/simplify/snapPoint/autoClose stack is
gone. Wet preview and commit produce identical pts -- no settle on
release.

Drops the _liveTip workaround (no longer needed now finalize runs
per frame). Deletes the in-file applyInkDynamics; the shared module
is the source of truth.
EOF
)"
```

---

## Task 3: Refactor `PencilTool` to use `finalize`

**Files:**
- Modify: `src/tools.js` (PencilTool class — same pattern as PaintTool)

- [ ] **Step 3.1: Add `_previewPts` field to `PencilTool`**

Find the `PencilTool` class constructor / first-field-init site (search for `class PencilTool` and the nearest `this.raw =` assignment, typically around line 1041-1070).

Insert:

```js
      this._previewPts = null;
      this._previewClosed = false;
```

- [ ] **Step 3.2: Add `_computePreview` to PencilTool**

Place near `_vMove` / `_vUp` (around line 1792-1860). Use the same body as PaintTool's `_computePreview` from Task 2.3:

```js
    _computePreview(app) {
      if (!this.raw || !this.raw.length || !this.t) {
        this._previewPts = null;
        this._previewClosed = false;
        return;
      }
      if (this._snapAnim || this._snapPreview) return;
      const tol = 0.4 + (this.smooth || 0) * 0.8;
      const fin = OT.StrokeFinalize.finalize(this.raw, {
        tol,
        snapDist: app.settings.snapDist || 0,
        inkDynamics: !!app.settings.inkDynamics,
        autoClose: !!(app.settings && app.settings.autoClose),
        cel: this.t.cel
      });
      this._previewPts = fin.pts;
      this._previewClosed = fin.closed;
    }
```

- [ ] **Step 3.3: Call `_computePreview` from pencil's rAF emit**

Find the pencil's rAF emit site — the same pattern as PaintTool's `_rafEmit`, but inside PencilTool. Search for `requestAnimationFrame` within `class PencilTool` / `PencilTool._` methods.

Add `this._computePreview(app);` immediately before the `app.emit('overlayrender');` call inside that rAF callback.

- [ ] **Step 3.4: Render `_previewPts` from PencilTool.drawOverlay**

Find PencilTool's `drawOverlay` (around line 1150). After the snap-animation and snap-preview branches, find the tail starting with the `this.raw.slice()` block (similar to PaintTool — around lines 1175-1189):

```js
      const pts = this.raw.slice();
      if (this._liveTip && !this.straight) {
        const t = pts[pts.length - 1];
        if (t.x !== this._liveTip.x || t.y !== this._liveTip.y) pts.push(this._liveTip);
      }
      // ...
      const stroke = {
        type: 'line', pencil: true,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: false
      };
      V().renderStroke(ctx, stroke);
      ctx.restore();
    }
```

Replace with:

```js
      const pts = this._previewPts;
      if (!pts || pts.length === 0) { ctx.restore(); return; }
      const stroke = {
        type: 'line', pencil: true,
        color: this.color, width: this.size, opacity: this.opacity,
        pts: pts, closed: this._previewClosed
      };
      V().renderStroke(ctx, stroke);
      ctx.restore();
    }
```

- [ ] **Step 3.5: Replace `_vUp` commit transforms with `finalize`**

Find PencilTool's `_vUp` (around line 1809). The current code is structurally identical to PaintTool's `_vUp` (simplify + snapPoint + autoClose, around lines 1221-1239). Replace the same block with the same finalize call as in Task 2.5:

```js
      let pts, closed;
      if (snapped) {
        pts = snapped.pts;
        closed = snapped.closed;
      } else {
        const fin = OT.StrokeFinalize.finalize(this.raw, {
          tol: 0.4 + this.smooth * 0.8,
          snapDist: app.settings.snapDist || 0,
          inkDynamics: !!app.settings.inkDynamics,
          autoClose: !!(app.settings && app.settings.autoClose),
          cel: cel
        });
        pts = fin.pts;
        closed = fin.closed;
      }
```

PencilTool does NOT currently call `applyInkDynamics` in its commit path (verify by grep — `applyInkDynamics(this.raw)` should appear only once in tools.js, inside PaintTool). The `inkDynamics: !!app.settings.inkDynamics` flag in the finalize opts above WILL apply inkDynamics on the pencil too. This is a behaviour CHANGE that matches the spec's "unified pipeline" goal — pencil now has the same velocity-thinning option as brush. If the user wants pencil to be exempt, override with `inkDynamics: false` instead.

For this plan: keep `inkDynamics: !!app.settings.inkDynamics`. The spec is explicit that both tools share the same pipeline.

- [ ] **Step 3.6: Reset `_previewPts` on commit**

Find the cleanup near the end of `_vUp` (analogous to PaintTool's). Add:

```js
      this._previewPts = null;
      this._previewClosed = false;
```

- [ ] **Step 3.7: Run the visual test**

```bash
node tests/visual.cjs
```
Expected: `=== ERRORS (0) ===`.

- [ ] **Step 3.8: Commit**

```bash
git add src/tools.js
git commit -m "$(cat <<'EOF'
refactor(pencil): use OT.StrokeFinalize for wet preview and commit

Same pattern as the brush refactor: drawOverlay renders the finalize
output (_previewPts) instead of this.raw; _vUp commits via a single
finalize() call. Pencil also now applies inkDynamics when the user
has it enabled -- matches the spec's "unified pipeline" goal where
both tools go through the same polish stack.
EOF
)"
```

---

## Task 4: Publish finalize params via `tool-meta`

**Files:**
- Modify: `src/pencast.js` (`_meta()` method — add four fields)
- Modify: `pen/pen.js` (`_applyToolMeta` — pick up the four fields)

- [ ] **Step 4.1: Extend `_meta()` in pencast.js**

Open `src/pencast.js`. Find `_meta()` (around line 251). Find the `return` statement at the end (it returns an object with `tool`, `color`, `toolSize`, etc.). Add four new fields:

```js
      return {
        tool: t ? t.name : 'brush',
        color: a.color,
        toolSize: t && t.size != null ? t.size : (a.settings.brushSize || 6),
        toolOpacity: t && t.opacity != null ? t.opacity : 1,
        toolRadius: t && t.cursorRadius ? (t.cursorRadius(a) || 0) : 0,
        pencil: t ? t.name === 'pencil' : false,
        brushFrac: st.cw ? rad / st.cw : 0.02,
        // Finalize params -- pen side calls OT.StrokeFinalize.finalize()
        // with these so its wet stroke equals what main will commit.
        // (smooth fallback to 0 so older settings shapes still work.)
        tol: 0.4 + ((a.settings && a.settings.smoothing) || 0) * 0.8,
        snapDist: (a.settings && a.settings.snapDist) || 0,
        inkDynamics: !!(a.settings && a.settings.inkDynamics),
        autoClose: !!(a.settings && a.settings.autoClose),
        frame: a.frame + 1,
        frameCount: a.project.frameCount,
        zoom: Math.round(st.view.zoom * 100),
        activeLayerKind,
        sel: { name: selName, count: selCount, group: selIsGroup, hasXform: selHasXform, color: selColor, colors: selColors },
        transform: { armed: xfArmed, mode: xfMode, isRaster: xfIsRaster }
      };
```

(The exact line of `_meta()`'s return varies by file revision — find it by reading the function. The four new fields are `tol`, `snapDist`, `inkDynamics`, `autoClose`. Place them grouped together with the comment above so a future reader sees they belong together.)

- [ ] **Step 4.2: Pick up the four fields in pen.js `_applyToolMeta`**

Open `pen/pen.js`. Find `_applyToolMeta(meta)` (around line 419). Find the existing field assignments — e.g.:

```js
      if (meta.tool || meta.name) t.name = meta.name || meta.tool;
      if (meta.color) t.color = meta.color;
      if (typeof meta.brushFrac === 'number') t.brushFrac = meta.brushFrac;
      if (typeof meta.toolSize === 'number') t.toolSize = meta.toolSize;
      if (typeof meta.toolOpacity === 'number') t.toolOpacity = meta.toolOpacity;
      if (typeof meta.pencil === 'boolean') t.pencil = meta.pencil;
```

Add the four new field reads alongside (place near `toolSize`/`toolOpacity` since they're all finalize-related):

```js
      if (typeof meta.tol === 'number') t.tol = meta.tol;
      if (typeof meta.snapDist === 'number') t.snapDist = meta.snapDist;
      if (typeof meta.inkDynamics === 'boolean') t.inkDynamics = meta.inkDynamics;
      if (typeof meta.autoClose === 'boolean') t.autoClose = meta.autoClose;
```

Also extend the default `tool` shape at the top of the constructor (around line 51) to include the four new fields with sensible defaults so the first frame doesn't blow up:

```js
        tool: {
          name: 'brush', color: '#222222',
          toolSize: 6, toolOpacity: 1, toolRadius: 0, pencil: false,
          brushFrac: 0.02,
          tol: 0.4, snapDist: 0, inkDynamics: false, autoClose: false,
          activeLayerKind: null, sel: {}, transform: {}
        },
```

- [ ] **Step 4.3: Sanity check**

```bash
node -c src/pencast.js && node -c pen/pen.js
```
Expected: silent (no syntax errors).

- [ ] **Step 4.4: Commit**

```bash
git add src/pencast.js pen/pen.js
git commit -m "feat(pen): publish finalize params via tool-meta

Pen window now receives tol / snapDist / inkDynamics / autoClose so
its wet stroke can call OT.StrokeFinalize.finalize() with the same
inputs main uses. Sets up Task 5 to actually call finalize on the
pen side."
```

---

## Task 5: Pen-side wet stroke runs `finalize`

**Files:**
- Modify: `pen/pen.js` (`_seedWetStroke`, `_extendWetStroke`)

- [ ] **Step 5.1: Add `rawPts` to the wet stroke shape**

Open `pen/pen.js`. Find `_seedWetStroke` (around line 547). The current body creates `this.state.wetStroke = { id, type, pencil, color, width, opacity, closed: false, pts: [projPt] }`.

Replace the body to ALSO maintain `rawPts`:

```js
    _seedWetStroke(id, projPt) {
      const t = this.state.tool;
      // wet.rawPts is the append-only raw input -- post-pointer-event,
      // pre-finalize. wet.pts is the finalize output that the renderer
      // sees. Both start with the single seed point because finalize on
      // a 1-pt array returns that 1-pt array.
      const rawPts = [projPt];
      this.state.wetStroke = {
        id: id, type: 'line',
        pencil: t.name === 'pencil',
        color: t.color || '#222222',
        width: t.toolSize || 6,
        opacity: t.toolOpacity == null ? 1 : t.toolOpacity,
        closed: false,
        rawPts: rawPts,
        pts: rawPts
      };
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
```

- [ ] **Step 5.2: Run `finalize` in `_extendWetStroke`**

Find `_extendWetStroke` (around line 566). Current body appends actualPts to ws.pts (after the D1 cache-stale fix, it builds a fresh pts array via concat). Replace:

```js
    _extendWetStroke(actualPts, predictedPts) {
      const ws = this.state.wetStroke;
      if (!ws || !actualPts || !actualPts.length) return;
      // Append to rawPts (the input), then run finalize() to get the
      // would-commit pts (the output the renderer uses). Building a
      // new rawPts array invalidates OT.Vector.samplesOf's per-array
      // cache; finalize then produces a fresh result pts as well.
      ws.rawPts = ws.rawPts.concat(actualPts);
      const t = this.state.tool;
      const layer = this.state.layersById.get(this.state.activeLayerId);
      const cel = layer ? layer.celAt(this.state.frame) : null;
      const fin = OT.StrokeFinalize.finalize(ws.rawPts, {
        tol: typeof t.tol === 'number' ? t.tol : 0.4,
        snapDist: typeof t.snapDist === 'number' ? t.snapDist : 0,
        inkDynamics: !!t.inkDynamics,
        autoClose: !!t.autoClose,
        cel: cel && cel.kind === 'vector' ? cel : null
      });
      ws.pts = fin.pts;
      ws.closed = fin.closed;
    }
```

- [ ] **Step 5.3: Run the visual test (regression check on main side)**

```bash
node tests/visual.cjs
```
Expected: `=== ERRORS (0) ===`. The pen window isn't exercised by this test, but it confirms main canvas isn't broken by the pencast `_meta()` changes from Task 4.

- [ ] **Step 5.4: Commit**

```bash
git add pen/pen.js
git commit -m "$(cat <<'EOF'
feat(pen): wet stroke runs OT.StrokeFinalize.finalize() per move

The pen's wet stroke now maintains both rawPts (append-only input)
and pts (finalize output, what renders). Every _extendWetStroke
appends to rawPts then re-runs finalize, which means the wet
preview shows EXACTLY what main will commit -- byte-identical
hand-off, no settle.

Uses the active layer's cel from the pen's mirror so snapEndpoints
can magnetize toward existing ink on the pen window the same way
main does.
EOF
)"
```

---

## Task 6: End-to-end smoke test

**Files:** none modified

- [ ] **Step 6.1: Run the existing test suite**

```bash
node tests/visual.cjs
node tests/browsertest.cjs
```
Expected: both report `=== ERRORS (0) ===` (or equivalent pass output). If either regresses from prior baseline, stop and diagnose; do not proceed.

- [ ] **Step 6.2: Manual smoke — main canvas**

Run `npm run dev`. On the main canvas:

- Draw a brush stroke that approaches an existing endpoint. **Expected:** endpoint magnetizes during the drag (you see the wet line "snap" toward the target before you lift). On release: NO geometric jump.
- Draw a brush stroke that loops back near its start (autoClose target). **Expected:** the closing snap visible during drag if you cross the auto-close radius; no jump on release.
- Draw a fast stroke vs a slow stroke with inkDynamics enabled in settings. **Expected:** width modulation visible during the drag, NOT only after release.
- Draw a pencil stroke. **Expected:** same — no jump on release, same magnetize behaviour.

- [ ] **Step 6.3: Manual smoke — pen window**

Open the pen window. Repeat the four brush/pencil tests above on the pen window:

- **Expected:** wet stroke during drag is visually identical to the committed stroke. Specifically, NO visible shift on release. Endpoint magnetize visible on the pen window when approaching existing ink.

- [ ] **Step 6.4: If defects found**

Document each defect, fix in the relevant file (likely tools.js or pen.js or stroke-finalize.js), and commit each fix as `fix(stroke-finalize): <description>`. Re-run the smoke test until all pass.

- [ ] **Step 6.5: Commit (only if Step 6.4 produced any fixes; otherwise nothing to commit here)**

(Skip this step if no fixes were needed in 6.4.)

---

## Task 7: Cleanup — drop diagnostic logging and Phase 2 stash

**Files:**
- Modify: `pen/pen.js` (remove the diagnostic `[pen] clearWet from:` console.log added in D1)

- [ ] **Step 7.1: Remove the diagnostic console.log from `_clearWetStroke`**

Open `pen/pen.js`. Find `_clearWetStroke` (around line 579):

```js
    _clearWetStroke() {
      if (this.state.wetStroke) {
        // D1 diagnostic — temporary, remove once symptom B is confirmed fixed
        console.log('[pen] clearWet from:', new Error().stack.split('\n').slice(2, 5).join(' | '));
      }
      this.state.wetStroke = null;
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
```

Replace with:

```js
    _clearWetStroke() {
      this.state.wetStroke = null;
      if (this._wetTimer) { clearTimeout(this._wetTimer); this._wetTimer = null; }
    }
```

- [ ] **Step 7.2: Drop the phase-2-attic reference branch and stash**

The D1 pre-flight saved Phase 2 in a side branch + stash. Now that D1 + this plan are both complete and smoke-tested, the reference is no longer needed.

```bash
git stash list
```

Expected: shows `stash@{0}: On phase-2-attic: phase-2 work-in-progress (preserved on phase-2-attic for reference)`.

```bash
git stash drop stash@{0}
git branch -D phase-2-attic
```

- [ ] **Step 7.3: Commit the diagnostic removal**

```bash
git add pen/pen.js
git commit -m "chore(pen): drop D1 diagnostic console.log from _clearWetStroke

The clearWet trace was added during D1 to diagnose 'stroke vanishes
when held still'. Root cause was identified (cache-stale samples in
OT.Vector.samplesOf when pts was mutated in place) and fixed in
d12855d. The diagnostic is no longer needed."
```

- [ ] **Step 7.4: Final repo-state check**

```bash
git status --short
git log --oneline -12
git stash list
git branch
```

Expected:
- `status` only shows pre-existing unrelated dirty files (`splash/splash.html`, `src/launcher.js`, untracked `.review-*.md`, `branding/`, `tests/live-debug.cjs`). No D1/D4 source files dirty.
- `log` shows the D1 + D4 commit chain ending at this Task 7 commit.
- `stash list` empty.
- `branch` shows only `main` (no `phase-2-attic`).

---

## Self-review checklist (run before declaring complete)

- [ ] `grep -rn "applyInkDynamics" src/ pen/` → defined once (in `src/stroke-finalize.js`); called from `OT.StrokeFinalize.finalize`. NOT called directly from `tools.js` or anywhere else.
- [ ] `grep -rn "V().simplify\|V\(\).snapPoint" src/tools.js` → 0 (both wrapped by `OT.StrokeFinalize.finalize`).
- [ ] `grep -rn "OT.StrokeFinalize.finalize" src/ pen/` → ≥3 (brush `_vUp`, pencil `_vUp`, pen `_extendWetStroke`; plus once per `_computePreview`).
- [ ] Both `node tests/visual.cjs` and `node tests/browsertest.cjs` pass.
- [ ] Manual smoke: no visible shift on release on either window for brush AND pencil.
- [ ] `git status` only shows unrelated dirty files.
- [ ] `git stash list` empty; `git branch` has no `phase-2-attic`.
