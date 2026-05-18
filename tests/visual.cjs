/* Visual + feature test for OpenToon Studio */
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
  function arc(cx, cy, r, n) {
    const a = [];
    for (let i = 0; i <= n; i++) { const t = i / n * Math.PI * 2; a.push(P(cx + Math.cos(t) * r, cy + Math.sin(t) * r)); }
    return a;
  }

  // ---- frame 0: brush a circle ----
  await page.evaluate(() => window.OT.app.setColor('#2244aa'));
  await stroke(arc(0.5, 0.5, 0.12, 40));

  // ---- animate a bouncing ball across 5 consecutive frames ----
  for (let f = 1; f <= 4; f++) {
    await page.evaluate(fr => { const a = window.OT.app; a.setFrame(fr); a.newDrawing(); }, f);
    const y = 0.5 - Math.abs(2 - f) * 0.13;
    await page.evaluate(() => window.OT.app.setColor('#2244aa'));
    await stroke(arc(0.3 + f * 0.09, y, 0.1, 36));
  }

  await page.evaluate(() => window.OT.app.setFrame(0));
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(__dirname, 'v1-draw.png') });

  // ---- onion skin at frame 2 ----
  const onion = await page.evaluate(() => {
    const a = window.OT.app;
    a.onion.on = true; a.onion.prev = 2; a.onion.next = 2;
    a.setFrame(2);
    a.emit('onionchange'); a.emit('render');
    return { on: a.onion.on, frame: a.frame };
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(__dirname, 'v2-onion.png') });
  console.log('ONION', JSON.stringify(onion));

  // ---- playback ----
  const pb = await page.evaluate(() => {
    return new Promise(res => {
      const a = window.OT.app;
      a.onion.on = false;
      a.setFrame(0);
      a.playback.play();
      setTimeout(() => {
        const f = a.frame, playing = a.playback.playing;
        a.playback.stop();
        res({ advancedTo: f, wasPlaying: playing });
      }, 600);
    });
  });
  console.log('PLAYBACK', JSON.stringify(pb));

  // ---- camera keyframes ----
  const cam = await page.evaluate(() => {
    const a = window.OT.app;
    a.setCameraKey(0, { x: 0, y: 0, zoom: 1, rot: 0 });
    a.setCameraKey(12, { x: 200, y: -80, zoom: 1.6, rot: 8 });
    a.setFrame(6);
    const c = a.project.cameraAt(6);
    return { keys: a.project.camera.keyframes.length, midZoom: Math.round(c.zoom * 100) / 100 };
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(__dirname, 'v3-camera.png') });
  console.log('CAMERA', JSON.stringify(cam));

  // ---- select + transform ----
  const sel = await page.evaluate(() => {
    const a = window.OT.app;
    a.setFrame(0);
    a.tools.select('select');
    return { tool: a.tools.active.name };
  });
  // marquee a box around the circle
  await page.mouse.move(P(0.34, 0.34).x, P(0.34, 0.34).y);
  await page.mouse.down();
  await page.mouse.move(P(0.66, 0.66).x, P(0.66, 0.66).y);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const selState = await page.evaluate(() => {
    const t = window.OT.app.tools.tools.select;
    return { hasSel: !!t.sel, w: t.sel ? Math.round(t.sel.sw) : 0 };
  });
  console.log('SELECT', JSON.stringify(sel), JSON.stringify(selState));
  // move the selection
  await page.mouse.move(P(0.5, 0.5).x, P(0.5, 0.5).y);
  await page.mouse.down();
  await page.mouse.move(P(0.62, 0.40).x, P(0.62, 0.40).y);
  await page.mouse.up();
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(__dirname, 'v4-select.png') });

  // ---- GIF validity ----
  const gif = await page.evaluate(async () => {
    const a = window.OT.app;
    a.tools.select('brush');
    const blob = await window.OT.IO.Export.gif(a, { outW: 240, outH: 135, from: 0, to: 4 }, () => {});
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im); im.onerror = () => rej(new Error('GIF decode failed'));
        im.src = url;
      });
      return { ok: true, size: blob.size, w: img.width, h: img.height };
    } catch (e) { return { ok: false, err: e.message }; } finally { URL.revokeObjectURL(url); }
  });
  console.log('GIF', JSON.stringify(gif));

  // ---- ZIP / PNG sequence validity ----
  const zip = await page.evaluate(async () => {
    const a = window.OT.app;
    const blob = await window.OT.IO.Export.sequence(a, { outW: 160, outH: 90, from: 0, to: 2 }, () => {});
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { ok: buf[0] === 0x50 && buf[1] === 0x4b, size: blob.size };
  });
  console.log('ZIP', JSON.stringify(zip));

  await browser.close();
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  process.exitCode = errors.length ? 1 : 0;
})().catch(e => { console.error('CRASH', e); process.exitCode = 2; });
