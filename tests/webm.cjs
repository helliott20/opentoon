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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const r = await page.evaluate(async () => {
    const a = window.OT.app;
    try {
      const blob = await window.OT.IO.Export.webm(a, { outW: 160, outH: 90, from: 0, to: 3 }, () => {});
      return { ok: true, size: blob.size, type: blob.type };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  console.log('WEBM', JSON.stringify(r));
  await browser.close();
  console.log('errors', errors.length);
  process.exitCode = (r.ok && !errors.length) ? 0 : 1;
})().catch(e => { console.error(e); process.exitCode = 2; });
