/* Focused test: the PenCast bridge that drives the canvas from the secondary
   pen-display window (src/pencast.js). The Electron IPC layer can't run
   headless, so this exercises the renderer-side logic directly:
     - pen pointer input -> a real stroke on the active layer
     - pen toolbar commands -> tool / colour / undo
     - the stage-frame encode path (toBlob -> ArrayBuffer) */
const { chromium } = require('playwright-core');
const path = require('path');

const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launch(channel ? { channel, headless: true } : { headless: true });
    } catch (e) { /* try next */ }
  }
  throw new Error('No browser available (msedge/chrome).');
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // ---- PenCast exists and is inert in the browser build ----
  const present = await page.evaluate(() => {
    const a = window.OT.app;
    return { hasPenCast: !!a.penCast, active: a.penCast.active, available: a.penCast.available() };
  });
  console.log('PENCAST', JSON.stringify(present));

  // ---- pen pointer input draws a real stroke on the active layer ----
  const stroke = await page.evaluate(() => {
    const a = window.OT.app;
    a.tools.select('brush');
    const pc = a.penCast;
    pc._onInput({ type: 'down', nx: 0.4, ny: 0.4, pressure: 0.9, isPen: true });
    for (let i = 1; i <= 12; i++) {
      pc._onInput({
        type: 'move', isPen: true,
        pts: [{ nx: 0.4 + i * 0.012, ny: 0.4 + Math.sin(i / 3) * 0.05, pressure: 0.9 }]
      });
    }
    pc._onInput({ type: 'up', nx: 0.55, ny: 0.42, pressure: 0.9, isPen: true });
    const cel = a.activeLayer().celAt(a.frame);
    return {
      strokes: cel && cel.strokes ? cel.strokes.length : -1,
      undoDepth: a.history.undoStack.length
    };
  });
  console.log('PEN STROKE', JSON.stringify(stroke), stroke.strokes > 0 ? 'OK' : 'FAIL');

  // ---- pen toolbar commands ----
  const cmd = await page.evaluate(() => {
    const a = window.OT.app, pc = a.penCast;
    pc._onCommand({ type: 'tool', tool: 'eraser' });
    const toolNow = a.tools.active.name;
    pc._onCommand({ type: 'color', color: '#3d9be0' });
    const colorNow = a.color;
    const before = a.history.undoStack.length;
    pc._onCommand({ type: 'undo' });
    const afterUndo = a.history.undoStack.length;
    pc._onCommand({ type: 'tool', tool: 'brush' });
    pc._onCommand({ type: 'brush-size', delta: 1 });
    // canvas navigation forwarded from the pen window
    const vx0 = a.stage.view.x, z0 = a.stage.view.zoom;
    pc._onCommand({ type: 'pan', dnx: 0.12, dny: 0 });
    pc._onCommand({ type: 'zoom', nx: 0.5, ny: 0.5, factor: 1.3 });
    return {
      toolNow, colorNow, undoWorked: afterUndo < before, brushSize: a.settings.brushSize,
      panned: a.stage.view.x !== vx0, zoomed: a.stage.view.zoom !== z0
    };
  });
  console.log('PEN CMD', JSON.stringify(cmd),
    (cmd.toolNow === 'eraser' && cmd.colorNow === '#3d9be0' && cmd.undoWorked &&
      cmd.panned && cmd.zoomed) ? 'OK' : 'FAIL');

  // ---- coordinate mapping: nx/ny 0..1 -> project space ----
  const coord = await page.evaluate(() => {
    const a = window.OT.app, pc = a.penCast, p = a.project;
    const mid = pc._ptFromNorm(0.5, 0.5, 1, { isPen: true });
    return {
      midInBounds: mid.x > 0 && mid.x < p.width && mid.y > 0 && mid.y < p.height,
      x: Math.round(mid.x), y: Math.round(mid.y), w: p.width, h: p.height
    };
  });
  console.log('PEN COORD', JSON.stringify(coord), coord.midInBounds ? 'OK' : 'FAIL');

  // ---- stage-frame encode path: toBlob -> ArrayBuffer ----
  const frame = await page.evaluate(async () => {
    const a = window.OT.app, pc = a.penCast;
    const got = [];
    pc.bridge = { sendPenFrame: (buf, meta) => got.push({ bytes: buf.byteLength, meta }) };
    pc.active = true;
    pc._dirty = true;
    pc._sendFrame();
    await new Promise(r => setTimeout(r, 500));
    pc.active = false;
    return got.length ? { ok: true, bytes: got[0].bytes, meta: got[0].meta } : { ok: false };
  });
  console.log('PEN FRAME', JSON.stringify(frame),
    (frame.ok && frame.bytes > 0 && frame.meta && frame.meta.tool) ? 'OK' : 'FAIL');

  await browser.close();

  const pass = stroke.strokes > 0 && cmd.toolNow === 'eraser' && cmd.undoWorked &&
    cmd.panned && cmd.zoomed && coord.midInBounds && frame.ok && frame.bytes > 0;
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  if (errors.length || !pass) { console.log(pass ? 'runtime errors' : 'assertions failed'); process.exitCode = 1; }
  else console.log('All pen-bridge checks passed.');
})().catch(e => { console.error('TEST CRASH:', e); process.exitCode = 2; });
