/* Layer transform (cut-out) animation test */
const { chromium } = require('playwright-core');
const path = require('path');
const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch(channel ? { channel, headless: true } : { headless: true }); }
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
    await page.waitForTimeout(40);
  }

  // draw a blob on frame 0
  await page.evaluate(() => window.OT.app.setColor('#2255cc'));
  await stroke([P(0.42, 0.42), P(0.58, 0.42), P(0.58, 0.58), P(0.42, 0.58), P(0.42, 0.42)]);

  // keyframe at frame 0, switch to transform tool
  await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(0);
    a.tools.select('transform');
    a.setLayerKeyHere();
  });
  await page.waitForTimeout(60);

  // at frame 12, drag the layer to move it
  await page.evaluate(() => window.OT.app.setFrame(12));
  await page.mouse.move(P(0.5, 0.5).x, P(0.5, 0.5).y);
  await page.mouse.down();
  await page.mouse.move(P(0.72, 0.34).x, P(0.72, 0.34).y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(80);

  const tk = await page.evaluate(() => {
    const a = window.OT.app, l = a.activeLayer();
    const t6 = l.transformAt(6), t0 = l.transformAt(0), t12 = l.transformAt(12);
    return {
      keyframes: l.transform.keyframes.length,
      t0x: Math.round(t0.x), t12x: Math.round(t12.x),
      t6x: Math.round(t6.x), interpOk: t6.x > Math.min(t0.x, t12.x) && t6.x < Math.max(t0.x, t12.x)
    };
  });
  console.log('TRANSFORM KEYS', JSON.stringify(tk));

  await page.evaluate(() => window.OT.app.setFrame(6));
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(__dirname, 't1-interp.png') });

  // draw on the transformed layer at frame 12, verify round-trip mapping
  const target = await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(12);
    a.tools.select('brush');
    a.settings.brushSize = 60;
    a.setColor('#dd2222');
    const s = a.stage.projectToScreen(960, 540);
    const r = document.getElementById('canvas').getBoundingClientRect();
    return { sx: r.left + s.x, sy: r.top + s.y, projX: 960, projY: 540 };
  });
  await stroke([{ x: target.sx, y: target.sy }, { x: target.sx + 8, y: target.sy + 4 }]);
  await page.waitForTimeout(60);
  const sample = await page.evaluate(o => {
    return { sampled: window.OT.app.stage.sampleColor(o.projX, o.projY) };
  }, target);
  const rgb = sample.sampled ? sample.sampled : '#000000';
  const r = parseInt(rgb.slice(1, 3), 16), g = parseInt(rgb.slice(3, 5), 16), b = parseInt(rgb.slice(5, 7), 16);
  console.log('DRAW-ON-XFORM', JSON.stringify(sample), 'redish=' + (r > 150 && g < 130 && b < 130));

  // undo transform
  const undo = await page.evaluate(() => {
    const a = window.OT.app;
    a.tools.select('transform');
    a.undo(); // undo brush
    a.undo(); // undo transform keyframe
    return { keyframes: a.activeLayer().transform.keyframes.length };
  });
  console.log('AFTER UNDO', JSON.stringify(undo));

  // serialize round-trip with transform
  const io = await page.evaluate(async () => {
    const a = window.OT.app;
    a.redo(); a.redo();
    const data = window.OT.IO.serialize(a);
    const restored = await window.OT.IO.deserialize(JSON.parse(JSON.stringify(data)));
    const l = restored.project.layers[0];
    return { keyframes: l.transform.keyframes.length };
  });
  console.log('IO TRANSFORM', JSON.stringify(io));

  await page.screenshot({ path: path.join(__dirname, 't2-final.png') });
  await browser.close();
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  process.exitCode = errors.length ? 1 : 0;
})().catch(e => { console.error('CRASH', e); process.exitCode = 2; });
