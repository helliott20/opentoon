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
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const m = await page.evaluate(() => {
    const out = [];
    const W = window.innerWidth;
    document.querySelectorAll('#sidebar *, #timeline *, #statusbar *').forEach(e => {
      const r = e.getBoundingClientRect();
      if (r.right > W + 0.5 || r.left < -0.5) {
        out.push({
          tag: e.tagName + (e.className ? '.' + String(e.className).split(' ')[0] : ''),
          left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
          over: Math.round(r.right - W)
        });
      }
    });
    const sb = document.getElementById('sidebar');
    return { innerWidth: W, sidebarScrollW: sb.scrollWidth, sidebarClientW: sb.clientWidth, overflowers: out };
  });
  console.log(JSON.stringify(m, null, 1));
  await browser.close();
})();
