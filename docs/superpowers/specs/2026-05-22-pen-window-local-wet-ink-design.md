# Pen Window — Full Slave Renderer

**Status:** design  
**Date:** 2026-05-22  
**Replaces:** Phase 2 stroke-replay with bg-plate hybrid

## Problem

The current Phase 2 pen-display architecture has three observed defects:

1. **Pixelation** — the bg plate is `image/webp` at quality 0.82. Every non-active layer is rasterised through that and looks fuzzy. Local zoom-in on the pen window makes it worse.
2. **Live stroke invisible / slow** — strokes round-trip pen → main → tools → live-shim → RAF → IPC → pen → composite. Round-trip latency + RAF batching means the stroke isn't visible under the pen tip.
3. **Bad framerate during drag** — every `render` event syncronously encodes a WebP of the full stage *and* writes to the JSON state channel.

The root problem: Phase 2 layered a state-replay channel on top of a lossy bitmap path. We pay the complexity cost of both designs and still inherit pixelation from the first.

## Approach

Eliminate the bitmap plate entirely. The pen window becomes a **full slave renderer** — it holds an authoritative mirror of the project (layers, cels, transforms, palette) and runs its own `compositeStage` from that data every frame. Everything that crosses the IPC is either authoritative source data (vector strokes as JSON, raster cels as lossless bitmaps) or a small state delta.

The pen renders its own in-progress (wet) stroke from local pointer input, with no round trip. Main remains the single source of truth — pen forwards input, main runs the tools, main publishes the resulting state. On commit the wet stroke is replaced by the authoritative stroke from main, matched by client-generated UUID (atomic swap, no ambiguity).

### Relationship to prior art

No consumer drawing app currently ships this architecture — it combines two well-trodden patterns from adjacent domains:

- **State-replay multiplayer canvas** (tldraw sync, Figma, Excalidraw, Linear's sync engine): client mirrors authoritative document state, edits go through optimistic-local + server-authoritative reconciliation.
- **Predicted-touch wet-ink rendering** (Apple PencilKit `UITouch.predicted`, Chromium `pointerEvent.getPredictedEvents()`, ChromeOS low-latency-stylus library): render predicted input ahead of confirmed events to mask OS-level latency.

Commercial pen-display mirroring products (Astropad LIQUID, Sidecar, Duet Display, Spacedesk, Luna) all do **rasterised frame streaming** instead — they target dumb video sinks. Duet's "lead line" feature, which paints a predicted-stroke preview ahead of streamed ink to mask latency, is the closest commercial precedent to our local-wet-ink trick.

## Goals

1. **Vector quality on pen** — no rasterised picture-of-everything; pen can zoom in arbitrarily without pixelation
2. **Zero perceived latency** under the pen for vector brush/pencil/eraser strokes
3. **No width shift** between in-progress and committed strokes (single OT.Vector render path)
4. **WYSIWYG** — what main shows is what pen shows, including overlays for non-brush tools

## Non-goals

- Live preview of raster strokes at zero latency (raster cels update on commit only; cosmetic cursor circle locally during drag)
- Color management / gamma between displays
- Reconnect / first-paint caching

## Architecture

### Channels

`opentoon:pen-state` — all state ops. Tiny JSON for most updates; raster cel payloads carry a bitmap as raw RGBA `ArrayBuffer` (lossless) or PNG bytes (smaller, lossless). RAF-batched and acked by seq.

`opentoon:pen-input` — pointer events from pen to main (unchanged).

`opentoon:pen-command` — toolbar commands from pen to main (unchanged).

**Removed:** `opentoon:pen-frame`. There is no bitmap-of-everything channel.

### Pen-side data model

The pen mirrors enough of the main app's data to run `compositeStage` independently. **It does this by constructing real `Layer` and `Cel` instances from `core.js`** (already loaded on the pen via `pen.html`). That gives us `layer.transformAt(frame)`, `layer.celAt(frame)`, the exposure map, and the interpolated transform peg model **for free** — no porting, no divergence risk.

```
PEN STATE = {
  seq,                      // last ack'd batch seq
  project,                  // { width, height, bg, fps, frameCount }
  palette,
  frame,                    // current frame index
  activeLayerId,
  layers,                   // OT.Layer[] — real instances from core.js
  layersById,               // Map<id, OT.Layer>
  tool,                     // { name, color, size, opacity, pencil, brushFrac, ...}
  overlay,                  // { cursor?, lassoPath?, transformBox?, shapePreview?, ... }
  wetStroke                 // local, populated from pen pointer events (carries client UUID)
}
```

A `Cel` (also a `core.js` class) is one of:
- `{ kind: 'vector', strokes: [...] }`
- `{ kind: 'raster', canvas, w, h }` — pen rebuilds `cel.canvas` from incoming raw RGBA / PNG by drawing the `ImageBitmap` onto an `OffscreenCanvas`

The state-channel ops mutate these real instances directly (e.g. `vector-cel-replace` overwrites `cel.strokes`; `layer-update` patches `layer.transform.keyframes`), keeping the data shape identical to main's project model.

### Pen-side `compositeStage` — shared via refactor

To eliminate the divergence risk between main's renderer and pen's renderer, **extract `Stage.compositeStage` from `canvas.js` into a free function** that both sides call:

```js
// new module, e.g. src/composite.js
OT.compositeStage = function (project, frame, ctx, opts, helpers) {
  // helpers = { layerAncestors }
  // body lifted from canvas.js:184-255, no `this`
};
```

`Stage` becomes a thin wrapper that passes `this.app.project`, `this.app.layerAncestors.bind(this.app)`, etc. Pen calls it directly with its mirror state and a small ported `layerAncestors` helper.

The pen render pipeline:

1. Clear; apply local view (zoom/pan)
2. Call `OT.compositeStage(state.project, state.frame, ctx, { bg: true, wetStroke: state.wetStroke, wetLayerId: state.activeLayerId }, helpers)` — same code as main, with extra `wetStroke`/`wetLayerId` opts so the composite layers the wet stroke onto the active layer in correct z-order
3. Draw paper border / camera guide scaffolding
4. Draw tool overlay (`state.overlay` — interpreted by a small renderer in `pen.js`)

The pen does NOT load `tools.js`; it has a small overlay renderer that interprets the `overlay` shape from `overlay-state` ops.

**Deferred from pen-side compositeStage in D1:** video layers (depend on a host `<video>` element), onion skin (depends on `cel.canvas` for adjacent frames), `_lassoHidden` exclusion (only used during a lasso transform drag; handled via `overlay-state` in D3). The shared `compositeStage` carries opts that suppress these on pen.

### State ops

Project / layers / cels:
- `init` — full snapshot (project, palette, layers w/ transforms, all cels at current frame, active layer, tool meta)
- `frame-change { frame }` — pen updates current frame; lazy-loads any not-yet-mirrored cels via main responding to `request-cel` (deferred — for first cut, init sends every layer's current-frame cel and main re-sends on each frame change)
- `layers-order { layerIds }`, `layer-add`, `layer-remove`, `layer-update { layerId, patch }`
- `project-meta { patch }`, `palette { colors }`
- `active-layer { layerId }`

Cel content:
- `vector-cel-replace { layerId, frame, strokes }` — sent on commit (stroke add/edit/erase, undo/redo). Each stroke object carries the client-generated `id` from the originating pen input (see §Stroke identity below), so pen can identify the committed counterpart of its wet stroke.
- `raster-cel-replace { layerId, frame, w, h, format: 'rgba'|'png', data: ArrayBuffer }` — sent on commit for raster cels. ArrayBuffer payload; main attaches via the transferable IPC path
- `cel-clear { layerId, frame }`

Tool overlays (rendered locally on pen):
- `overlay-state { patch }` — replaces fields of `state.overlay`. Sent on `overlayrender` events (throttled). Shape:
  ```
  {
    cursor?:        { x, y, radius },          // brush/pencil/eraser hover
    lassoPath?:     [ {x,y}, ... ] | null,     // while dragging lasso
    transformBox?:  { matrix: [...], handles: [...], armed: bool } | null,
    shapePreview?:  { kind: 'rect'|'ellipse'|'line', x, y, w, h, rot } | null,
    marquee?:       { x, y, w, h } | null      // select rectangle
  }
  ```

### Wet-ink protocol on the pen

`wetStroke` is **purely local** — never serialised, never sent to main. It exists to remove the round trip for the gestures where vector preview is possible.

**Stroke identity.** When seeding a wet stroke, the pen generates a UUID (`'pen-' + crypto.randomUUID()`). This `id` is attached to:
- the local `wetStroke` object
- the `'down'` input message sent to main

Main uses this `id` as the committed stroke's identity. When `vector-cel-replace` arrives, the pen drops `wetStroke` only if a stroke with the matching id is present in the new strokes array. This makes the swap atomic — no race between "wet still present" and "committed arrived." (Pattern formalised in patent US-9898841 *Synchronizing digital ink stroke rendering*.)

Triggered by pointer events on the pen canvas:

- `pointerdown`
  - Generate `id = 'pen-' + crypto.randomUUID()`
  - Forward `'down'` to main with `id` in the message
  - If `tool.name ∈ {brush, pencil}` AND active layer is `'vector'`:
    - Seed `wetStroke = { id, type:'line', pencil: tool.name==='pencil', color: tool.color, width: tool.size, opacity: tool.opacity, pts: [pt] }`
- `pointermove`
  - Forward `'move'` to main with `event.getCoalescedEvents()` points
  - If `wetStroke`:
    - Append coalesced points to `wetStroke.pts`
    - Append **predicted** points from `event.getPredictedEvents()` to a separate `wetStroke.predicted` array (renderer concatenates the two for paint; predicted is dropped/replaced on each move so it never persists past actual events)
    - rAF-schedule a composite
- `pointerup` / `pointercancel`
  - Forward `'up'` / `'cancel'` to main with `id`
  - Clear `wetStroke.predicted` (no more predicted ahead of a confirmed-finished stroke)
  - **Keep** `wetStroke` until a `vector-cel-replace` op arrives whose strokes array contains an entry with `id === wetStroke.id`; then drop.

Other drop conditions: new pointerdown; tool switched off brush/pencil; active layer kind changed; pen detach; 2-second timeout (defensive — if main never commits, we don't leak the wet stroke forever).

**Predicted-touches rationale.** Even with zero IPC latency, OS event-loop and rAF impose ~10–20ms input-to-paint. `pointerEvent.getPredictedEvents()` returns extrapolated future points (Chromium's implementation of the same idea as Apple PencilKit's `UITouch.predicted`). Rendering them as the leading edge of the wet stroke takes perceived latency from ~20ms → ~5ms. They're dropped/recomputed on every move event so they never persist as committed ink.

**Hand-off "settle" — known limitation in D1.** Main's brush/pencil tools apply One Euro filter smoothing, ink-dynamics width modulation, and stroke simplification on commit (`tools.js:107, 734, 794, 803, 1239`). The wet stroke is raw; the committed stroke is smoothed. The hand-off will visibly *settle* the line — corners soften, point count drops. This is the same effect Procreate / Photoshop have when ink "finalises" after pointer-up; users typically read it as intentional. D1 ships with the settle present. Phase D4 (deferred) extracts the smoothing/simplify pipeline into a shared module both sides use, eliminating the settle for users who find it distracting.

For **eraser** on a vector layer: no wet-stroke seed (eraser commits via `vector-cel-replace` after pointerup); a cursor circle is shown via `state.overlay.cursor` updated by `overlay-state` ops from main on `overlayrender`.

For **raster** active layer + brush/pencil: no local wet preview (no raster brush engine on pen). The cursor circle from `overlay-state` gives feedback; commit is visible via `raster-cel-replace`.

### Main-side publisher (`pencast.js`)

Restructured around per-event publish handlers, no bitmap encoder:

- `framechange` → `frame-change` + `vector-cel-replace` / `raster-cel-replace` for each layer's new current-frame cel
- `layerselect` → `active-layer`
- `layerschange` → `layers-order` / `layer-add` / `layer-remove` / `layer-update` (existing diff machinery — keep)
- `celchange` → `vector-cel-replace` or `raster-cel-replace` for the changed cel
- `projectchange` → `project-meta`
- `palettechange` → `palette`
- `colorchange` / `toolchange` → `tool-meta`
- `overlayrender` (throttled) → `overlay-state` + `tool-meta` (move tool's overlay state into the patch — see below)

A new helper, `_collectOverlayState(app)`, inspects the active tool and returns the `overlay` JSON shape above. Each gesture tool exposes the data we need:
- Lasso: its `raw[]` poly during drag (already exists)
- Transform tools: bounding box + handles (already computed for overlay drawing)
- Shape tools: start/end + kind (already tracked for overlay drawing)

This is data extraction, not behaviour change — tools already compute these to draw their overlay on main; we just serialise the result.

Raster cel transport: main reads pixel data from the cel's source canvas via `getImageData(0,0,w,h).data.buffer` and ships it on the state channel as a `raster-cel-replace` op with `format: 'rgba'`. ArrayBuffer rides as a `Buffer` over `ipcRenderer.send` (structured-cloned in the main process — ~1–3 ms for 1080p). If size becomes a concern, switch to PNG via `toBlob('image/png')`.

### What we remove

`pencast.js`:
- Live-shim code (`_installLiveShim`, `_publishLiveBegin/Extend/End`, `_liveTool`, `_strokeFromRaw`)
- WebP encoder (`_encodeBg`, `_legacySendFrame`, `_off`, `_bgDirty`, `_bgEncoding`, `_bgRevision`)
- `pen-frame` IPC plumbing
- `excludeLayerId` plumbing
- `bg-ready` op

`canvas.js`:
- `opts.excludeLayerId` branch (revert)

`tools.js`:
- The `publishStrokeChange` helper and its 8 hook call sites — replaced by `celchange` event listener in `pencast.js` that emits `vector-cel-replace`/`raster-cel-replace`

`pen.js`:
- `_onFrame` and bitmap-blit path
- Image-bitmap state (`state.bg`)
- All live-* op handlers
- WebP-related fields and timing

`electron/preload.js` and `electron/pen-preload.js`:
- `sendPenFrame` / `onFrame` bridge methods
- The `opentoon:pen-frame` IPC relay in `electron/main.js`

### What we add / change

`pen.js`:
- `_compositeStage` rewritten to render from the layer model (see above)
- Per-layer transform interpolation (reuse `core.js`'s logic if loadable; else port the small interpolator)
- Raster cel reception: convert incoming `{ format:'rgba', data, w, h }` to `ImageBitmap` via `createImageBitmap(new ImageData(...))`
- Overlay renderer that interprets `state.overlay` (cursor, lasso path, transform handles, shape preview, marquee)
- Wet-stroke seed/extend/drop logic in pointer handlers
- `tool` field extended with `size`, `opacity`, `pencil`, `activeLayerKind`

`pen.html`:
- Already loads `core.js` and `vector.js`; verify and add anything else strictly needed (e.g. transform-interpolation helpers if they don't live in `core.js`)

`pencast.js`:
- `_collectOverlayState(app)` helper
- `vector-cel-replace` / `raster-cel-replace` publishers wired to `celchange`
- Raster cel pixel extraction (`getImageData` → ArrayBuffer over IPC)
- `overlay-state` publisher on `overlayrender`

### Encoding choice (raster cels)

For the first cut, ship raster cels as **raw RGBA `ArrayBuffer`** via state-channel IPC. Cost: ~8 MB per 1080p cel, sent only on commit. Electron's structured clone of an 8 MB buffer is ~1–3 ms.

If projects with many raster cels make this expensive, switch to PNG: `canvas.toBlob('image/png').then(b => b.arrayBuffer())`. PNG of 1080p is ~50–150 ms async — the encode runs off the critical path because raster commits are human-paced.

Defer the PNG path until measured.

## What we keep

- All input forwarding (`_onInput`) and command forwarding (`_onCommand`)
- Layer diff machinery (`_diffAndPublishLayers`, `snapshotLayer`, `layerMetaEqual`)
- Tool-meta publishing (extended)
- Pen-size reporting (pen tells main its CSS+DPR so any future encoder targets the right resolution)
- Local view zoom/pan on pen
- Toolbar / lasso toolbar / selection chip on pen
- Palm rejection + multi-touch gesture on pen

## Phased migration

The full design is one consistent target, but implementation lands in phases so each step is testable on its own:

**Phase D1 — Vector quality + zero-latency strokes**
- Extract `compositeStage` from `canvas.js` into shared `OT.compositeStage`
- Strip live-shim, WebP encoder, pen-frame channel
- Pen constructs real `Layer`/`Cel` instances from `core.js`; calls shared `compositeStage`
- Stroke UUID on pen `pointerdown`; carried through `input → tools → vector-cel-replace`
- Predicted-touch wet-stroke rendering on pen
- Wet-stroke pointer flow + atomic swap-by-id on commit
- Layer + transform mirroring
- Raster layers render an empty placeholder
- *Done state:* vector-only projects feel native on the pen; brush/pencil hand-off is atomic; settle effect is present but acceptable

**Phase D2 — Raster cel transport**
- `raster-cel-replace` over state channel (raw RGBA via `MessagePortMain`-backed channel for zero-copy ArrayBuffer transfer between renderers)
- Pen creates `ImageBitmap` from incoming pixels, draws onto cel.canvas
- Bound to `celchange` for raster cels
- *Done state:* raster layers appear on pen; raster strokes commit-only

**Phase D3 — Tool overlays**
- `_collectOverlayState` on main, `overlay-state` op
- Pen overlay renderer (cursor, lasso poly, transform handles, shape preview, marquee)
- Each tool exposes a `getOverlayState(app)` method returning the serialisable shape
- *Done state:* lasso / transform / shape gestures show their live overlay on pen

**Phase D4 (deferred) — Eliminate the settle**
- Extract `tools.js` smoothing pipeline (One Euro filter, ink-dynamics width, simplify) into a shared module
- Pen applies the same smoothing on wet strokes
- *Done state:* hand-off from wet to committed is byte-identical, no visible settle

**Phase D5 (deferred) — Onion skin + video layers**
- Mirror cel.canvas for adjacent frames (onion skin)
- Mirror video element state (frame # → texture)

## Testing

Per-tool manual verification:
- Vector brush stroke: wet ink visible under pen tip with no perceptible lag; on lift, hand-off is invisible (no width / position jump)
- Eraser drag: cursor circle visible locally; erasure visible on commit
- Lasso drag (D3): polygon path visible on pen during drag
- Free Transform drag (D3): handles + marching ants visible during drag
- Shape tool (D3): shape preview visible during drag
- Frame nav: all layers correct on pen
- Layer toggle / reorder / opacity: reflected on pen
- Palette change: reflected on pen
- Pen-window local zoom: vector layers stay crisp at any zoom
- Raster layer (D2): visible on pen; commits visible after stroke

## Named fallback (if D1 proves too costly)

If extracting `compositeStage` + porting the smoothing pipeline + mirroring layer/cel state turns out to be more refactor than the team can absorb, fall back to **Astropad-LIQUID-style architecture**: composite the full stage on main at the pen's native resolution, ship pixels as raw RGBA via `MessagePortMain` with transferable `ArrayBuffer` (zero-copy across renderer processes), pen blits + renders local wet ink on top. Loses pen-side vector zoom (can't zoom past 100% without pixelation) but keeps zero-latency strokes and trivial pen-side code. Industry-proven; Astropad ships it commercially.

## Open questions deferred

- Free-transform of the *active* layer with mid-drag fidelity: visible on commit via `vector-cel-replace`; live mid-drag would need transform-state ops similar to wet-stroke (out of scope this design)
- On-demand cel mirroring (only currently-visible frame) vs full project mirror (lazy `request-cel` op deferred to a later design)
- Color profile / gamma between displays
- Reconnect / first-paint caching
- Multi-pen support (currently single primary pointer assumed)
