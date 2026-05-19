/* OpenToon Studio - generate Windows .ico files from the brand SVGs.
 *
 *   node tools/genicons.cjs
 *
 * Rasterises the app-tile and .otoon document marks with playwright-core
 * (already a devDependency) and packs the PNGs into multi-resolution .ico
 * files with a tiny inline ICO encoder -- no extra dependency needed.
 * Outputs assets/icon.ico and assets/otoon-file.ico. */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* the canonical 3-ring mark (200x200 space) */
const MARK =
  '<circle cx="85" cy="100" r="68" stroke="#DD5038" stroke-width="17" stroke-linecap="round" opacity="0.55" fill="none"/>' +
  '<circle cx="115" cy="100" r="68" stroke="#54B06A" stroke-width="17" stroke-linecap="round" opacity="0.55" fill="none"/>' +
  '<circle cx="100" cy="100" r="68" stroke="#F7F1E5" stroke-width="17" stroke-linecap="round" fill="none"/>';

/* app icon: mark on a rounded-square --panel tile (Windows wants an opaque tile) */
const APP_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
  '<rect width="256" height="256" rx="58" fill="#1f2228"/>' +
  '<g transform="translate(46,46) scale(0.82)">' + MARK + '</g>' +
  '</svg>';

/* .otoon project file: a document with a folded corner + extension band */
const FILE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
  '<path d="M58 26 H162 L206 70 V222 q0 8 -8 8 H58 q-8 0 -8 -8 V34 q0 -8 8 -8 Z" ' +
  'fill="#272b32" stroke="#080a0c" stroke-width="2.5"/>' +
  '<path d="M162 26 L206 70 H162 Z" fill="#3a3f48"/>' +
  '<g transform="translate(128,116) scale(0.42) translate(-100,-100)">' + MARK + '</g>' +
  '<rect x="40" y="170" width="176" height="40" rx="4" fill="#4a9fd4"/>' +
  '<text x="128" y="198" font-family="Segoe UI, sans-serif" font-size="25" font-weight="700" ' +
  'fill="#f7f1e5" text-anchor="middle" letter-spacing="3">.OTOON</text>' +
  '</svg>';

/* pack [{size, buf(PNG)}] into a PNG-embedded .ico (Windows Vista+) */
function encodeIco(pngs) {
  const count = pngs.length;
  const dir = Buffer.alloc(6 + 16 * count);
  dir.writeUInt16LE(0, 0);          // reserved
  dir.writeUInt16LE(1, 2);          // type: icon
  dir.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  pngs.forEach((p, i) => {
    const d = 6 + i * 16;
    const dim = p.size >= 256 ? 0 : p.size;   // 256 is stored as 0
    dir.writeUInt8(dim, d);                   // width
    dir.writeUInt8(dim, d + 1);               // height
    dir.writeUInt8(0, d + 2);                 // palette count
    dir.writeUInt8(0, d + 3);                 // reserved
    dir.writeUInt16LE(1, d + 4);              // colour planes
    dir.writeUInt16LE(32, d + 6);             // bits per pixel
    dir.writeUInt32LE(p.buf.length, d + 8);   // image size
    dir.writeUInt32LE(offset, d + 12);        // image offset
    offset += p.buf.length;
  });
  return Buffer.concat([dir].concat(pngs.map(p => p.buf)));
}

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launch(channel ? { channel, headless: true } : { headless: true });
    } catch (e) { /* try next */ }
  }
  throw new Error('no browser available (msedge/chrome)');
}

async function rasterize(browser, svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const sized = svg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" ');
  await page.setContent('<!doctype html><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0}svg{display:block}</style>' + sized);
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return { size: size, buf: buf };
}

(async () => {
  const browser = await launch();
  for (const job of [[APP_ICON, 'icon.ico'], [FILE_ICON, 'otoon-file.ico']]) {
    const pngs = [];
    for (const s of SIZES) pngs.push(await rasterize(browser, job[0], s));
    const ico = encodeIco(pngs);
    fs.writeFileSync(path.join(ROOT, 'assets', job[1]), ico);
    console.log('wrote assets/' + job[1] + '  (' + ico.length + ' bytes, sizes ' + SIZES.join('/') + ')');
  }
  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'assets', 'brand', 'opentoon-icon-master.svg'), APP_ICON + '\n');
  fs.writeFileSync(path.join(ROOT, 'assets', 'brand', 'opentoon-file-icon.svg'), FILE_ICON + '\n');
  console.log('wrote master SVGs to assets/brand/');
})().catch(e => { console.error('genicons failed:', e); process.exitCode = 1; });
