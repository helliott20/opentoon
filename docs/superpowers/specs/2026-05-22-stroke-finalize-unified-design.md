# Unified Stroke Finalize — Eliminate the Wet-to-Commit Settle

**Status:** design
**Date:** 2026-05-22
**Supersedes:** the D4 placeholder in `2026-05-22-pen-window-local-wet-ink-design.md` (which only covered the pen side; this design covers both windows)

## Problem

When the artist lifts the pen, the rendered stroke visibly shifts:

- On the **main canvas**, the wet preview during drag uses `this.raw` (post-One-Euro raw points) rendered via `OT.Vector.renderStroke`. On commit, `tools.js` applies four extra transforms (`applyInkDynamics`, `V().simplify`, `V().snapPoint` for endpoints, `autoClose`) to produce the committed stroke's `pts`. The two paths feed `OT.Vector.renderStroke` with different `pts` → different rendered curves → visible geometric settle (corners soften, endpoints snap, point count drops, widths re-modulate by velocity).
- On the **pen window** (D1 slave renderer), the wet stroke is raw points. The committed stroke arrives via `vector-cel-replace` carrying the post-transform `pts`. Same root cause, same settle on hand-off.

The settle is small but distinctly perceptible. Research across Procreate, Apple PencilKit, Krita, Photoshop, Affinity Designer, and Adobe Illustrator (2025) confirms the "polish on commit" pattern is universally perceived as a UX bug, not as intentional polish. Adobe's 2025 release of Illustrator's "Live Curve Fitting" feature is direct evidence — it ships specifically because a decade of users complained about the same effect we have today.

## Goals

1. **Zero perceptible settle** on both the main canvas and the pen window. The last wet frame and the first committed frame must render identical pixels.
2. **Match industry-standard behaviour** — apply commit transforms continuously during drag (Affinity/Procreate/PencilKit/Illustrator 2025 pattern).
3. **Single source of truth** for stroke finalization: one pure function used by main's drag, main's commit, and the pen's wet preview.
4. **Preserve all existing features** — auto-connect endpoints, auto-close, ink-dynamics width modulation, point-count reduction. They become visible during drag instead of jumping at commit.

## Non-goals

- User-facing toggle for "polish on commit" vs "live polish" — research showed users overwhelmingly prefer live polish; deferred unless artists ask for it.
- Changing the One Euro filter, simplification algorithm, or snap behaviour itself. We only relocate WHEN they run, not WHAT they do.
- Eliminating the One Euro mid-stroke lag (the trailing "rope" the artist sees while drawing). That lag is a different design choice from the commit settle.

## Architecture

### Shared module `src/stroke-finalize.js`

Pure functions, no `this`, no DOM, no `app`. Called by both `tools.js` (main side) and `pen.js` (pen side).

```js
// Velocity-based pressure modulation. Returns a NEW pts array; does not
// mutate the input. (Pure for cache friendliness on the pen side.)
OT.StrokeFinalize.applyInkDynamics(pts)

// Endpoint magnetize. Returns a NEW pts array. `cel` must expose a
// `strokes` array (used to find candidate endpoints). Returns input
// unchanged if no nearby endpoint within `snapDist`.
OT.StrokeFinalize.snapEndpoints(pts, cel, snapDist)

// Auto-close loop if first/last pts are within `snapDist`. Returns
// { pts, closed }; copies pts if a change was made.
OT.StrokeFinalize.maybeAutoClose(pts, snapDist)

// The pipeline. Takes raw pts (post-One-Euro), returns the stroke's
// final shape. Deterministic and idempotent: finalize(finalize(x)) === finalize(x).
OT.StrokeFinalize.finalize(rawPts, opts)
  // opts: {
  //   tol:           number — RDP tolerance (mirrors current 0.4 + smooth * 0.8)
  //   snapDist:      number — endpoint snap radius (mirrors app.settings.snapDist)
  //   inkDynamics:   boolean — mirrors app.settings.inkDynamics
  //   autoClose:     boolean — mirrors app.settings.autoClose
  //   cel:           Cel — optional; only used by snapEndpoints
  // }
  // returns { pts, closed }
```

`finalize` internally calls (in order):
1. `applyInkDynamics(rawPts)` if `opts.inkDynamics`
2. `V().simplify(_, opts.tol)` (re-uses the existing `OT.Vector.simplify`)
3. `snapEndpoints(_, opts.cel, opts.snapDist)` if `opts.cel`
4. `maybeAutoClose(_, opts.snapDist)` if `opts.autoClose`

### Main-side refactor (`src/tools.js`)

**Brush (`PaintTool`)** and **Pencil (`PencilTool`)** both gain the same pattern:

- New field: `this._previewPts` — last finalize output. Recomputed at most once per `rAF`.
- New field: `this._previewClosed`.
- `_vMove` (or equivalent) schedules a finalize via `requestAnimationFrame`. The RAF callback computes `finalize(this.raw, opts)` and stores into `_previewPts` / `_previewClosed`.
- `drawOverlay()` renders a stroke object built from `_previewPts` (was `this.raw`).
- `_vUp` (commit) calls `finalize` once more on the final `raw`, pushes the resulting `pts` + `closed` into `cel.strokes`. **Drops the special-case logic that currently lives in `_vUp` (simplify call, snapPoint calls, autoClose check, applyInkDynamics call)** — all of it migrates to `finalize`.
- `cel.rebuild()` still runs (raster cache for thumbnails / onion skin / exports), but the rendered output is byte-identical to the last `drawOverlay()` frame, so the on-screen visual doesn't change.

### Pen-side refactor (`pen/pen.js`)

- `_extendWetStroke(actualPts)` (already builds a fresh `pts` array — see commit `d12855d`) calls `OT.StrokeFinalize.finalize(rawPts, opts)` and stores the result as `wet.pts` / `wet.closed`. The wet stroke object's `pts` IS the finalized output; no separate "raw" field.
  - Equivalent to: `wet.rawPts.push(...actualPts); const fin = finalize(wet.rawPts, opts); wet.pts = fin.pts; wet.closed = fin.closed;`
  - This means we maintain TWO arrays per wet stroke: `rawPts` (append-only) and `pts` (rebuilt per move).
- Pen needs the active cel for `snapEndpoints` — already mirrored as `state.layersById.get(activeLayerId).celAt(state.frame)`.
- Pen needs `tol`, `snapDist`, `inkDynamics`, `autoClose` from main. Sent via `tool-meta`: extend the existing `_meta()` in `pencast.js` with these four fields, applied in `_applyToolMeta`.

### Data flow per pointermove (during drag)

```
Main canvas pointer event
  → ToolManager.pointerMove
  → PaintTool._vMove → OneEuroFilter → append to this.raw
  → schedule rAF (coalesces multiple moves into one finalize)
  → rAF tick: this._previewPts = finalize(this.raw, opts).pts
  → app.emit('overlayrender')
  → drawOverlay paints V().renderStroke(ctx, {pts: _previewPts, ...})

Same gesture, on the pen
  → pen pointer event
  → forward as 'move' to main (so main computes its own preview + would-commit)
  → locally also append to wet.rawPts
  → finalize → wet.pts (with pen's local cel for snap)
  → composite redraws wet via OT.Vector.renderStroke

Pointer release
  → Main pointerUp → finalize once more (same opts) → push to cel.strokes → cel.rebuild()
  → main emits celchange → pencast publishes vector-cel-replace with same pts
  → pen receives, _checkWetCommit matches by id, drops wet
  → no visible change because the committed stroke = the last wet frame
```

## Components and interfaces

| Unit | Owns | Inputs | Outputs |
|---|---|---|---|
| `OT.StrokeFinalize.finalize` (new, `src/stroke-finalize.js`) | The pipeline | `(rawPts, opts)` | `{pts, closed}` |
| `OT.StrokeFinalize.applyInkDynamics` (new) | Pressure modulation | `pts` | new pts |
| `OT.StrokeFinalize.snapEndpoints` (new) | Endpoint auto-connect | `(pts, cel, snapDist)` | new pts |
| `OT.StrokeFinalize.maybeAutoClose` (new) | Auto-close loop | `(pts, snapDist)` | `{pts, closed}` |
| `OT.Vector.simplify` (existing) | RDP simplification | `(pts, tol)` | new pts |
| `PaintTool._previewPts` (new field) | Drag-time preview cache | finalize output | rendered by drawOverlay |
| `PencilTool._previewPts` (new field) | Drag-time preview cache | finalize output | rendered by drawOverlay |
| `PenWindow wet.pts` (existing, semantics change) | The actually-renders array | finalize output | rendered by `OT.compositeStage` |
| `PenWindow wet.rawPts` (new field) | Append-only input to finalize | pointer events | input to finalize |
| `_meta().tol / snapDist / inkDynamics / autoClose` (new tool-meta fields) | Pen's polish parameters | main settings | pen's finalize opts |

## Error handling

- `finalize([])` returns `{pts: [], closed: false}`. Empty input is safe.
- `finalize` with no `opts.cel` skips `snapEndpoints` cleanly (no auto-connect, but pipeline still works).
- A bad `pts` entry (missing `x`/`y`) lets the existing `V().simplify` reject — same error surface as today.
- The rAF throttle in main's drawOverlay means a runaway pointer move can't burn the main thread.

## Testing

Existing tests:
- `tests/visual.cjs` and `tests/browsertest.cjs` should still pass — main canvas brush/pencil drawing is exercised by them.

New tests (added during implementation):
- Unit-style: `finalize([])` returns empty. `finalize([p])` returns single-point. `finalize(circular)` with autoClose closes. `finalize(line)` with snap returns endpoints snapped.
- Idempotency: `finalize(finalize(x).pts)` should equal `finalize(x).pts` modulo identical inputs.

Manual smoke test:
- Main canvas: brush stroke + pencil stroke → no visible settle on release.
- Main canvas: stroke endpoint near an existing endpoint → snap "magnetizes" during drag, no jump on release.
- Pen window: brush + pencil → wet stroke + commit visually identical at hand-off.
- Pen window: endpoint snap also magnetizes during drag (pen has access to mirrored cel).
- Both: inkDynamics width modulation visible during drag, doesn't jump on release.

## Migration notes

- `tools.js`: the existing `applyInkDynamics`, simplify-call, and snapPoint-call sites inside `_vUp` are deleted (their logic moved into `finalize`).
- Symmetry strokes (`V().mirrorStroke`) still happen at commit time and get the finalized pts as input. No change.
- The history `pushCelEdit` recorded `this.before` (cel snapshot). Still works — `cel.rebuild()` after the commit is the snapshot point.
- `cel._liveDrawing` flag: currently set/cleared by the brush in raster mode. **Not affected** by this change; vector drawing already doesn't touch `_liveDrawing` for its preview path.

## What we keep

- One Euro filter inside `tools.js` — still owns the smoothing of incoming pointer events into `this.raw`. The rope-lag feel during drag is unchanged.
- `_liveTip` (the "raw tip" appended to the wet preview so it reaches the actual cursor). Still relevant — finalize sees `this.raw` which doesn't include `_liveTip`. The wet preview's pts is `[...finalize(this.raw).pts, _liveTip]` if `_liveTip` exists and differs from the tail.

Actually — including `_liveTip` after finalize re-introduces a tiny settle on commit (because the committed pts is `finalize(this.raw + _liveTip)` which slightly differs from `finalize(this.raw) + _liveTip` due to interaction with simplify). Two choices:

- **A:** Append `_liveTip` to `this.raw` before finalize. Cost: simplify sees the lagged-vs-current diff and may behave slightly differently than the current code.
- **B:** Drop `_liveTip` entirely now that finalize runs every frame. The rope lag is already small (~13 px at smooth 0.5 per the existing comment), and on commit `_vUp` pushes the actual release point into `this.raw` anyway.

**Pick B.** Cleaner data flow, eliminates the only remaining special case. Document the rope-lag tolerance in the implementation plan.

## Open questions deferred

- Per-tool snap radii (currently `app.settings.snapDist` is global). Could expose per-tool override later.
- Showing the snap "target indicator" (a glyph at the nearby endpoint when the snap would fire). Nice UX detail but separate work.
- Adding an `applyInkDynamics` velocity window-size parameter to `opts` (currently it computes from the whole `this.raw`; this matters when finalize is called mid-stroke with N=10 vs N=100). Spec leaves this as default-to-current-behaviour, revisit if width pulsing is visible.
