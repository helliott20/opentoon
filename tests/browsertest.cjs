/* Headless browser smoke test for OpenToon Studio */
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
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    const t = m.type();
    logs.push('[' + t + '] ' + m.text());
    if (t === 'error') errors.push('CONSOLE: ' + m.text());
  });

  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // ---- inspect initial state ----
  const init = await page.evaluate(() => {
    const a = window.OT && window.OT.app;
    return {
      hasApp: !!a,
      layers: a ? a.project.layers.length : -1,
      frameCount: a ? a.project.frameCount : -1,
      tool: a ? a.tools.active.name : null,
      menus: document.querySelectorAll('#menubar .menu-item').length,
      toolBtns: document.querySelectorAll('#toolbar .tool-btn').length,
      canvasW: document.getElementById('canvas').width
    };
  });
  console.log('INIT', JSON.stringify(init));
  await page.screenshot({ path: path.join(__dirname, 'shot-1-load.png') });

  // ---- draw a brush stroke on the canvas ----
  const box = await page.evaluate(() => {
    const r = document.getElementById('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await page.mouse.move(cx - 120, cy - 60);
  await page.mouse.down();
  for (let i = 0; i <= 24; i++) {
    await page.mouse.move(cx - 120 + i * 10, cy - 60 + Math.sin(i / 3) * 50);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);

  // ---- draw a second stroke with a different colour ----
  await page.evaluate(() => window.OT.app.setColor('#e0533d'));
  await page.mouse.move(cx - 100, cy + 40);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(cx - 100 + i * 9, cy + 40 + Math.cos(i / 3) * 35);
  await page.mouse.up();
  await page.waitForTimeout(150);

  const afterDraw = await page.evaluate(() => {
    const a = window.OT.app;
    const layer = a.activeLayer();
    const cel = layer.celAt(a.frame);
    return {
      celExists: !!cel,
      celBlank: cel ? cel.isBlank() : null,
      undoDepth: a.history.undoStack.length
    };
  });
  console.log('AFTER DRAW', JSON.stringify(afterDraw));

  // ---- new drawing on frame 2, advance, check timeline ----
  const anim = await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(4);
    a.newDrawing();
    const layer = a.activeLayer();
    return { exposureAt4: layer.exposure[4], frameCount: a.project.frameCount, frame: a.frame };
  });
  console.log('ANIM', JSON.stringify(anim));

  // ---- exercise tools, undo/redo, fill ----
  const ops = await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(0);
    a.tools.select('fill');
    a.undo(); a.redo();
    a.tools.select('rect');
    a.addLayer();
    const layers = a.project.layers.length;
    a.undo();
    const afterUndo = a.project.layers.length;
    a.redo();
    return { layersAfterAdd: layers, afterUndo, afterRedo: a.project.layers.length };
  });
  console.log('OPS', JSON.stringify(ops));

  await page.screenshot({ path: path.join(__dirname, 'shot-2-draw.png') });

  // ---- test GIF export pipeline (small) ----
  const gif = await page.evaluate(async () => {
    const a = window.OT.app;
    try {
      const blob = await window.OT.IO.Export.gif(a,
        { outW: 160, outH: 90, from: 0, to: Math.min(5, a.project.frameCount - 1) }, () => {});
      return { ok: true, size: blob.size, type: blob.type };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  console.log('GIF', JSON.stringify(gif));

  // ---- test project serialize/deserialize ----
  const io = await page.evaluate(async () => {
    const a = window.OT.app;
    try {
      const data = window.OT.IO.serialize(a);
      const restored = await window.OT.IO.deserialize(JSON.parse(JSON.stringify(data)));
      return { ok: true, layers: restored.project.layers.length, json: JSON.stringify(data).length };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  console.log('IO', JSON.stringify(io));

  await browser.close();

  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  if (errors.length) { process.exitCode = 1; }
  else console.log('No runtime errors.');
})().catch(e => { console.error('TEST CRASH:', e); process.exitCode = 2; });
