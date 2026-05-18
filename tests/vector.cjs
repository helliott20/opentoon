/* Vector drawing + smart fill test for OpenToon Studio */
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

  const v = await page.evaluate(() => {
    const st = window.OT.app.stage;
    const r = document.getElementById('canvas').getBoundingClientRect();
    return {
      left: r.left, top: r.top, zoom: st.view.zoom, vx: st.view.x, vy: st.view.y,
      layerType: window.OT.app.activeLayer().type
    };
  });
  console.log('DEFAULT LAYER', v.layerType);
  const PS = (px, py) => ({ x: v.left + v.vx + px * v.zoom, y: v.top + v.vy + py * v.zoom });

  async function strokePath(pts) {
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    for (const p of pts) await page.mouse.move(p.x, p.y);
    await page.mouse.up();
    await page.waitForTimeout(50);
  }

  // ---- draw a closed circle with the brush (project space) ----
  const cx = 960, cy = 540, rad = 300;
  const circle = [];
  for (let i = 0; i <= 56; i++) {
    const a = i / 56 * Math.PI * 2;
    // add a little jitter so smoothing has something to clean up
    const rr = rad + Math.sin(i * 1.7) * 6;
    circle.push(PS(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  await page.evaluate(() => { window.OT.app.tools.select('brush'); window.OT.app.setColor('#1a1a1a'); });
  await strokePath(circle);

  const strokeInfo = await page.evaluate(() => {
    const cel = window.OT.app.activeLayer().celAt(0);
    const st = cel.strokes[0];
    return {
      kind: cel.kind, strokeCount: cel.strokes.length,
      type: st.type, ptsCount: st.pts.length, closed: st.closed
    };
  });
  console.log('STROKE', JSON.stringify(strokeInfo), '(raw input was 57 points)');

  await page.screenshot({ path: path.join(__dirname, 've1-line.png') });

  // ---- smart fill inside the circle ----
  await page.evaluate(() => { window.OT.app.tools.select('fill'); window.OT.app.setColor('#e0a020'); });
  // hover to trigger preview
  await page.mouse.move(PS(cx, cy).x, PS(cx, cy).y);
  await page.waitForTimeout(220);
  const hover = await page.evaluate(() => {
    const t = window.OT.app.tools.tools.fill;
    return { hasPreview: !!t.preview, previewPts: t.preview ? t.preview.length : 0 };
  });
  console.log('HOVER PREVIEW', JSON.stringify(hover));
  // click to fill
  await page.mouse.move(PS(cx, cy).x + 1, PS(cx, cy).y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(120);
  const fillInfo = await page.evaluate(() => {
    const cel = window.OT.app.activeLayer().celAt(0);
    const fills = cel.strokes.filter(s => s.type === 'fill');
    const sample = window.OT.app.stage.sampleColor(960, 540);
    return { fillStrokes: fills.length, sample, totalStrokes: cel.strokes.length };
  });
  const fr = parseInt(fillInfo.sample.slice(1, 3), 16);
  console.log('SMART FILL', JSON.stringify(fillInfo), 'filledGold=' + (fr > 180));

  await page.screenshot({ path: path.join(__dirname, 've2-fill.png') });

  // ---- pencil draws a vector line ----
  await page.evaluate(() => { window.OT.app.tools.select('pencil'); window.OT.app.setColor('#2050c0'); });
  await strokePath([PS(500, 800), PS(700, 760), PS(900, 810), PS(1100, 770), PS(1300, 815)]);
  const pencilInfo = await page.evaluate(() => {
    const cel = window.OT.app.activeLayer().celAt(0);
    const p = cel.strokes[cel.strokes.length - 1];
    return { isLine: p.type === 'line', pencil: p.pencil };
  });
  console.log('PENCIL', JSON.stringify(pencilInfo));

  // ---- eraser splits a stroke ----
  const beforeErase = await page.evaluate(() => window.OT.app.activeLayer().celAt(0).strokes.length);
  await page.evaluate(() => { window.OT.app.tools.select('eraser'); window.OT.app.settings.eraserSize = 80; });
  await strokePath([PS(960, 240), PS(960, 240)]);   // erase top of circle
  const afterErase = await page.evaluate(() => window.OT.app.activeLayer().celAt(0).strokes.length);
  console.log('ERASER', JSON.stringify({ before: beforeErase, after: afterErase }));

  // ---- vector select + delete ----
  await page.evaluate(() => window.OT.app.tools.select('select'));
  await page.mouse.move(PS(400, 700).x, PS(400, 700).y);
  await page.mouse.down();
  await page.mouse.move(PS(1400, 900).x, PS(1400, 900).y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(60);
  const sel = await page.evaluate(() => {
    const t = window.OT.app.tools.tools.select;
    return { selected: t.vsel.length };
  });
  console.log('VECTOR SELECT', JSON.stringify(sel));

  // ---- undo/redo + serialize round-trip ----
  const io = await page.evaluate(async () => {
    const a = window.OT.app;
    a.undo(); a.redo();
    const data = window.OT.IO.serialize(a);
    const restored = await window.OT.IO.deserialize(JSON.parse(JSON.stringify(data)));
    const cel = restored.project.layers[0].celAt(0);
    return {
      layerType: restored.project.layers[0].type,
      celKind: cel.kind, strokes: cel.strokes.length
    };
  });
  console.log('IO ROUND-TRIP', JSON.stringify(io));

  await page.screenshot({ path: path.join(__dirname, 've3-final.png') });
  await browser.close();
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  process.exitCode = errors.length ? 1 : 0;
})().catch(e => { console.error('CRASH', e); process.exitCode = 2; });
