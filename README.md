# OpenToon Studio

An open-source 2D animation studio for Windows, inspired by Toon Boom Harmony.
Built as a zero-install desktop-style app — no build step, no server required.

## Run it

**Quick look:** double-click `index.html` — opens in your browser, runs fully
offline.

**As a desktop app** (with auto-updates): see `BUILD.md`. In short:

```
npm install
npm run dev      # run it (with live reload)
npm run dist     # build the Windows installer
```

The desktop build is a real Windows program that updates itself over-the-air —
the right way to share OpenToon with someone else.

## Features

**Drawing & animation**
- Paperless frame-by-frame animation
- Pressure-sensitive brush, pencil, eraser
- Shape tools (rectangle, ellipse, line) with fill
- Eyedropper
- Rectangular select with move / scale / rotate (free transform)
- Per-stroke opacity, smoothing
- Vector and bitmap layers (vector is the default)

**Vector drawing (Harmony-style)**
- Resolution-independent strokes, smoothed on release so lines are
  clean rather than rough (adjustable de-jitter)
- Auto-connect — stroke endpoints snap together so line art forms
  closed shapes
- Smart paint bucket — fills the region enclosed by your lines, with
  adjustable gap closing and a live hover highlight of the area
- Stroke-aware eraser (splits strokes) and stroke select / move / delete

**Cut-out animation**
- Per-layer transform keyframes (position / scale / rotation)
- Transform tool with on-canvas handles
- Smooth interpolation between keyframes — drawing, onion skin and
  export all stay transform-aware

**Timeline / Xsheet**
- Multi-layer timeline with exposure cells
- Create / duplicate / extend / clear exposures (held cels)
- Copy / cut / paste drawings between frames and layers
- Drag cels to move them, drag a cel's end to extend exposure
- Drawing thumbnails in the timeline
- Insert / remove frames

**Playback & review**
- Real-time playback, loop / ping-pong, in/out range to loop a section
- Flip canvas horizontally / vertically to check drawings
- Space or Enter to play/stop

**Audio & video**
- Import an audio soundtrack — waveform in the timeline, synced playback
- Import a video as reference frames on the timeline (pulls in its sound too)

**Drawing aids**
- Grid and rule-of-thirds guides
- Symmetry / mirror drawing

**Layers**
- Unlimited drawing layers, reorder, rename
- Per-layer visibility, lock, opacity
- Layer blend opacity in compositing

**Onion skinning**
- Configurable previous / next frame range
- Red / green tinting, opacity falloff

**Color**
- Named color palette with swatches
- HSV picker + hex input
- Add / remove / reorder swatches

**Camera**
- Camera framing guide
- Camera keyframes (pan / zoom / rotate) with interpolation

**Playback**
- Real-time playback at project FPS, loop, ping-pong
- Frame-step, go to start/end

**Project I/O**
- Save / load `.otoon` project files (JSON, self-contained)
- Autosave to browser storage
- Import reference images / image as layer

**Export**
- Animated GIF
- WebM video
- PNG image sequence (ZIP)
- Single-frame PNG

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| V | Select pixels |
| A | Transform layer (cut-out animation) |
| B | Brush |
| N | Pencil |
| E | Eraser |
| G | Paint bucket |
| I | Eyedropper |
| R / O / L | Rectangle / Ellipse / Line |
| H / Space | Pan view |
| Z | Zoom tool |
| `[` / `]` | Brush size down / up |
| , / . | Previous / next frame |
| Enter | Play / stop |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S / Ctrl+O | Save / open project |
| Ctrl+N | New project |
| F | Fit view to camera |
| Del | Clear current drawing / delete selection |

## Status

This is an actively developed open-source clone. Core animation, timeline,
painting, camera, and export pipelines are functional. See `ROADMAP.md` for
what is planned next (vector deformers / bone rigging, node compositing,
multiplane depth, particle effects, lip-sync).

## License

MIT.
