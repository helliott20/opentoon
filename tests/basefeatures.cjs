/* Test the base-feature additions: cel copy/paste, playback range, flip, grid, symmetry */
const { chromium } = require('playwright-core');
const path = require('path');
const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

async function launch() {
  for (const c of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch(c ? { channel: c, headless: true } : { headless: true }); }
    catch (e) {}
  }
  throw new Error('no browser');
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const box = await page.evaluate(() => {
    const r = document.getElementById('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const P = (fx, fy) => ({ x: box.x + box.w * fx, y: box.y + box.h * fy });
  async function stroke(pts) {
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    for (const p of pts) await page.mouse.move(p.x, p.y);
    await page.mouse.up();
    await page.waitForTimeout(50);
  }

  // draw on frame 0
  await stroke([P(0.4, 0.4), P(0.6, 0.45), P(0.5, 0.6)]);

  // ---- copy / paste / cut ----
  const cp = await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(0); a.copyDrawing();
    const hadClip = !!a.celClipboard;
    a.setFrame(6); a.pasteDrawing();
    const pasted = a.activeLayer().exposure[6];
    a.setFrame(0); a.cutDrawing();
    const cut = a.activeLayer().exposure[0];
    return { hadClip, pastedExposure: pasted || 0, frame0AfterCut: cut || 0 };
  });
  console.log('COPY/PASTE/CUT', JSON.stringify(cp));

  // ---- playback range ----
  const range = await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(3); a.setPlayIn();
    a.setFrame(11); a.setPlayOut();
    const r = a.playback.range();
    return { playIn: a.playIn, playOut: a.playOut, rangeLo: r.lo, rangeHi: r.hi };
  });
  console.log('PLAYBACK RANGE', JSON.stringify(range));

  // ---- flip canvas ----
  const flip = await page.evaluate(() => {
    const a = window.OT.app;
    a.toggleFlipH();
    const pt = a.stage.screenToProject(window.innerWidth / 2, 300);
    a.toggleFlipV();
    return { flipH: a.stage.flipH, flipV: a.stage.flipV, mapsOk: isFinite(pt.x) && isFinite(pt.y) };
  });
  console.log('FLIP', JSON.stringify(flip));

  // ---- grid ----
  const grid = await page.evaluate(() => {
    const a = window.OT.app;
    a.toggleGrid();
    return { gridOn: a.grid.on, gridSize: a.grid.size };
  });
  console.log('GRID', JSON.stringify(grid));

  // ---- symmetry: drawing one stroke should produce a mirrored copy ----
  const sym = await page.evaluate(() => {
    const a = window.OT.app;
    a.toggleFlipH(); a.toggleFlipV();   // reset flips so coords are normal
    a.symmetry.on = true; a.symmetry.axis = 'v';
    a.setFrame(20); a.tools.select('brush');
    return { symOn: a.symmetry.on };
  });
  await stroke([P(0.25, 0.3), P(0.32, 0.4), P(0.28, 0.5)]);
  const symResult = await page.evaluate(() => {
    const cel = window.OT.app.activeLayer().celAt(20);
    return { strokeCount: cel ? cel.strokes.length : 0 };
  });
  console.log('SYMMETRY', JSON.stringify(sym), JSON.stringify(symResult), 'mirrored=' + (symResult.strokeCount === 2));

  // ---- timeline thumbnails toggle + audio API ----
  const misc = await page.evaluate(() => {
    const a = window.OT.app;
    a.timeline.showThumbs = true; a.timeline.render();
    return {
      thumbsRowH: a.timeline.rowH,
      hasAudioApi: typeof a.importAudio === 'function' && typeof a.playAudioFrom === 'function',
      hasVideoApi: typeof a.importVideo === 'function'
    };
  });
  console.log('MISC', JSON.stringify(misc));

  await page.screenshot({ path: path.join(__dirname, 'bf1.png') });
  await browser.close();
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  process.exitCode = errors.length ? 1 : 0;
})().catch(e => { console.error('CRASH', e); process.exitCode = 2; });
